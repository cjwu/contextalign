import {
  searchFTS,
  getAllEmbeddings,
  getCompactTimestamp,
  listSessionIds,
} from "./db.js";
import { embed, isEmbeddingReady, bufferToFloat32Array } from "./embedding.js";
import type { SearchResult, Config } from "./types.js";
import { extractTimeRanges, applyTemporalBoost, hasUpdateIndicator } from "./temporal.js";
import {
  cosineSimilarity,
  toRrfScored,
  rrfMerge,
  applyTimeDecay,
  wasChunkCited,
} from "./ranking.js";
import { formatContext, getLastInjection } from "./format.js";
import { logInject, type Timing } from "./inject_log.js";

export { getLastInjection, wasChunkCited };

const FAR_FUTURE = "9999-12-31T23:59:59Z";
const MIN_VEC_CHUNK_CHARS = 100;
// mxbai-embed-large-v1 query-side instruction (doc side raw). Aligns query intent with document space.
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
const INTERROGATIVE_RE = /什麼|甚麼|哪一?個|哪些|怎樣|怎麼樣|怎麼|如何|為什麼|為何|嗎|呢|吧|\?|？/g;

function stripInterrogatives(q: string): string {
  return q.replace(INTERROGATIVE_RE, " ").replace(/\s+/g, " ").trim();
}

export async function searchAndFormat(
  sessionId: string,
  query: string,
  config: Config
): Promise<string> {
  const t0 = performance.now();
  const timing: Timing = { fts: 0, vec: 0, temporal: 0, format: 0, total: 0 };

  const compactTs = getCompactTimestamp(sessionId);
  if (!compactTs) {
    timing.total = performance.now() - t0;
    logInject({ sessionId, query, status: "no_compact", timing });
    return "";
  }

  const trimmed = query.trim();
  if (isStopWord(trimmed, config.stopWords)) {
    timing.total = performance.now() - t0;
    logInject({ sessionId, query: trimmed, status: "stopword", timing });
    return "";
  }

  const ftsQuery = escapeFtsQuery(trimmed);

  let currentFts: SearchResult[] = [];
  let otherFts: SearchResult[] = [];
  const otherSessionIds = listSessionIds().filter((id) => id !== sessionId);

  const tFts = performance.now();
  if (ftsQuery) {
    try {
      currentFts = searchFTS(sessionId, ftsQuery, compactTs, 10);
    } catch {}
    for (const sid of otherSessionIds) {
      try {
        otherFts.push(...searchFTS(sid, ftsQuery, FAR_FUTURE, 5));
      } catch {}
    }
  }
  timing.fts = performance.now() - tFts;

  // Conditional RRF: if FTS signal is weak (<3 total hits), also run vector and merge.
  let currentResults: SearchResult[];
  let otherResults: SearchResult[];
  const ftsTotal = currentFts.length + otherFts.length;
  let vecRan = false;

  if (ftsTotal < 3 && isEmbeddingReady()) {
    vecRan = true;
    const tVec = performance.now();
    const currentVec = await vectorSearch(sessionId, trimmed, compactTs, 10);
    const otherVec: SearchResult[] = [];
    for (const sid of otherSessionIds) {
      try {
        otherVec.push(...(await vectorSearch(sid, trimmed, FAR_FUTURE, 5)));
      } catch {}
    }
    timing.vec = performance.now() - tVec;
    currentResults = rrfMerge(currentFts, currentVec);
    otherResults = rrfMerge(otherFts, otherVec);
  } else {
    currentResults = toRrfScored(currentFts);
    otherResults = toRrfScored(otherFts);
  }

  if (currentResults.length === 0 && otherResults.length === 0) {
    timing.total = performance.now() - t0;
    logInject({ sessionId, query: trimmed, status: "no_results", timing, vecRan });
    return "";
  }

  const tTemp = performance.now();
  currentResults = applyTimeDecay(currentResults, compactTs);
  otherResults = applyTimeDecay(otherResults, compactTs);

  const timeRanges = extractTimeRanges(trimmed, sessionId);
  if (timeRanges.length > 0) {
    currentResults = applyTemporalBoost(currentResults, timeRanges);
    otherResults = applyTemporalBoost(otherResults, timeRanges);
  }
  timing.temporal = performance.now() - tTemp;

  const chronological = timeRanges.length > 0 || hasUpdateIndicator(trimmed);

  const tFmt = performance.now();
  const { output, truncated, rendered, total } = formatContext(
    currentResults,
    otherResults,
    config.maxContextChars,
    chronological,
    sessionId
  );
  timing.format = performance.now() - tFmt;
  timing.total = performance.now() - t0;

  logInject({
    sessionId,
    query: trimmed,
    status: "ok",
    chronological,
    currentResults,
    otherResults,
    chars: output.length,
    truncated,
    rendered,
    total,
    timing,
    vecRan,
  });
  return output;
}

function isStopWord(text: string, stopWords: string[]): boolean {
  if (text.length > 20) return false;
  return stopWords.some((sw) => text.toLowerCase() === sw.toLowerCase());
}

function escapeFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .map((w) => `"${w.replace(/"/g, '""')}"`)
    .join(" OR ");
}

async function vectorSearch(
  sessionId: string,
  query: string,
  beforeTimestamp: string,
  limit: number
): Promise<SearchResult[]> {
  const queryEmbedding = await embed(QUERY_PREFIX + query);
  if (!queryEmbedding) return [];

  const queryVec = bufferToFloat32Array(queryEmbedding);

  // Multi-query: embed the stripped form too if non-trivially different.
  // Addresses query-doc asymmetry: 「向量模型叫什麼名字」→「向量模型叫 名字」 lands closer to fact chunks.
  const stripped = stripInterrogatives(query);
  let strippedVec: Float32Array | null = null;
  if (stripped.length >= 2 && stripped !== query) {
    const se = await embed(QUERY_PREFIX + stripped);
    if (se) strippedVec = bufferToFloat32Array(se);
  }

  const allChunks = getAllEmbeddings(sessionId, beforeTimestamp, MIN_VEC_CHUNK_CHARS);

  if (allChunks.length === 0) return [];

  const scored = allChunks.map((chunk) => {
    const chunkVec = bufferToFloat32Array(chunk.embedding);
    const simOrig = cosineSimilarity(queryVec, chunkVec);
    const sim = strippedVec
      ? Math.max(simOrig, cosineSimilarity(strippedVec, chunkVec))
      : simOrig;
    return { ...chunk, score: sim };
  });

  scored.sort((a, b) => b.score - a.score);

  const seen = new Set<number>();
  const results: SearchResult[] = [];
  for (const item of scored) {
    if (seen.has(item.jsonl_offset)) continue;
    seen.add(item.jsonl_offset);
    results.push({
      session_id: sessionId,
      jsonl_offset: item.jsonl_offset,
      role: item.role,
      message_text: item.message_text,
      chunk_text: item.chunk_text,
      score: item.score,
      timestamp: item.timestamp,
      priority: item.priority,
      corrected_at: item.corrected_at ?? null,
      correction_reason: item.correction_reason ?? null,
      user_cite_score: item.user_cite_score ?? 0,
      llm_use_score: item.llm_use_score ?? 0,
    });
    if (results.length >= limit) break;
  }

  return results;
}
