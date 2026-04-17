import { createHash } from "crypto";
import {
  searchFTS,
  getAllEmbeddings,
  getCompactTimestamp,
  listSessionIds,
} from "./db.js";
import { embed, isEmbeddingReady, bufferToFloat32Array } from "./embedding.js";
import type { SearchResult, Config } from "./types.js";

const CONTEXT_HEADER =
  "[ContextAlign: compact 前的相關歷史，以下為原始對話記錄，若與摘要衝突請以此為準]";

const FAR_FUTURE = "9999-12-31T23:59:59Z";
const MIN_VEC_CHUNK_CHARS = 100; // exclude short Q-like chunks from vector search to reduce noise

export async function searchAndFormat(
  sessionId: string,
  query: string,
  config: Config
): Promise<string> {
  const compactTs = getCompactTimestamp(sessionId);
  if (!compactTs) return "";

  const trimmed = query.trim();
  if (isStopWord(trimmed, config.stopWords)) return "";

  const ftsQuery = escapeFtsQuery(trimmed);

  let currentFts: SearchResult[] = [];
  let otherFts: SearchResult[] = [];
  const otherSessionIds = listSessionIds().filter((id) => id !== sessionId);

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

  // Conditional RRF: if FTS signal is weak (<3 total hits), also run vector and merge
  let currentResults: SearchResult[];
  let otherResults: SearchResult[];
  const ftsTotal = currentFts.length + otherFts.length;

  if (ftsTotal < 3 && isEmbeddingReady()) {
    const currentVec = await vectorSearch(sessionId, trimmed, compactTs, 10);
    const otherVec: SearchResult[] = [];
    for (const sid of otherSessionIds) {
      try {
        otherVec.push(...(await vectorSearch(sid, trimmed, FAR_FUTURE, 5)));
      } catch {}
    }
    currentResults = rrfMerge(currentFts, currentVec);
    otherResults = rrfMerge(otherFts, otherVec);
  } else {
    currentResults = toRrfScored(currentFts);
    otherResults = toRrfScored(otherFts);
  }

  if (currentResults.length === 0 && otherResults.length === 0) return "";

  currentResults = applyTimeDecay(currentResults, compactTs);
  otherResults = applyTimeDecay(otherResults, compactTs);

  return formatContext(currentResults, otherResults, config.maxContextChars);
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
  const queryEmbedding = await embed(query);
  if (!queryEmbedding) return [];

  const queryVec = bufferToFloat32Array(queryEmbedding);
  const allChunks = getAllEmbeddings(sessionId, beforeTimestamp, MIN_VEC_CHUNK_CHARS);

  if (allChunks.length === 0) return [];

  const scored = allChunks.map((chunk) => {
    const chunkVec = bufferToFloat32Array(chunk.embedding);
    const sim = cosineSimilarity(queryVec, chunkVec);
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
    });
    if (results.length >= limit) break;
  }

  return results;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

const RRF_K = 60;

function resultKey(r: SearchResult): string {
  return `${r.session_id}:${r.jsonl_offset}`;
}

function toRrfScored(results: SearchResult[]): SearchResult[] {
  return results.map((r, i) => ({ ...r, score: 1 / (RRF_K + i + 1) }));
}

function rrfMerge(a: SearchResult[], b: SearchResult[]): SearchResult[] {
  const merged = new Map<string, SearchResult>();
  const addList = (list: SearchResult[]) => {
    list.forEach((r, i) => {
      const k = resultKey(r);
      const add = 1 / (RRF_K + i + 1);
      const existing = merged.get(k);
      if (existing) {
        merged.set(k, { ...existing, score: existing.score + add });
      } else {
        merged.set(k, { ...r, score: add });
      }
    });
  };
  addList(a);
  addList(b);
  return Array.from(merged.values()).sort((x, y) => y.score - x.score);
}

function applyTimeDecay(results: SearchResult[], compactTs: string): SearchResult[] {
  const compactTime = new Date(compactTs).getTime();

  return results
    .map((r) => {
      const msgTime = new Date(r.timestamp).getTime();
      const hoursAgo = (compactTime - msgTime) / (1000 * 60 * 60);
      const decay = Math.pow(0.5, hoursAgo / 24);
      const priorityBoost = r.priority ? 2.0 : 1.0;
      return { ...r, score: r.score * decay * priorityBoost };
    })
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.score - a.score;
    });
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

function formatResultLine(r: SearchResult): string {
  const roleLabel =
    r.role === "user" ? "User" : r.role === "assistant" ? "Assistant" : "Tool";
  const ts = formatTimestamp(r.timestamp);
  const shortId = r.session_id.slice(0, 8);
  const text = r.message_text.length <= 500 ? r.message_text : r.chunk_text;
  return `[${roleLabel} ${ts} ${shortId}]: ${text}\n`;
}

function contentHash(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex");
}

function formatContext(
  currentResults: SearchResult[],
  otherResults: SearchResult[],
  maxChars: number
): string {
  let output = CONTEXT_HEADER + "\n";
  let remaining = maxChars - output.length;

  const seenHashes = new Set<string>();
  const ordered = [...currentResults, ...otherResults];
  for (const r of ordered) {
    const text = r.message_text.length <= 500 ? r.message_text : r.chunk_text;
    const hash = contentHash(text);
    if (seenHashes.has(hash)) continue;
    seenHashes.add(hash);

    const line = formatResultLine(r);
    if (line.length > remaining) {
      if (remaining > 50) {
        output += line.slice(0, remaining - 4) + "...\n";
      }
      break;
    }
    output += line;
    remaining -= line.length;
  }

  return output.trim();
}
