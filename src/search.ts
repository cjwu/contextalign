import { createHash } from "crypto";
import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import * as chrono from "chrono-node";
import {
  searchFTS,
  getAllEmbeddings,
  getCompactTimestamp,
  listSessionIds,
  getSessionStartTime,
} from "./db.js";
import { embed, isEmbeddingReady, bufferToFloat32Array } from "./embedding.js";
import type { SearchResult, Config } from "./types.js";

const CONTEXT_HEADER =
  "[ContextAlign: compact 前的相關歷史，以下為原始對話記錄，若與摘要衝突請以此為準]";

const FAR_FUTURE = "9999-12-31T23:59:59Z";
const MIN_VEC_CHUNK_CHARS = 100; // exclude short Q-like chunks from vector search to reduce noise
const TEMPORAL_BOOST = 3.0;       // multiply score for chunks whose timestamp falls in query's parsed time range

export async function searchAndFormat(
  sessionId: string,
  query: string,
  config: Config
): Promise<string> {
  const compactTs = getCompactTimestamp(sessionId);
  if (!compactTs) {
    logInject({ sessionId, query, status: "no_compact" });
    return "";
  }

  const trimmed = query.trim();
  if (isStopWord(trimmed, config.stopWords)) {
    logInject({ sessionId, query: trimmed, status: "stopword" });
    return "";
  }

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

  if (currentResults.length === 0 && otherResults.length === 0) {
    logInject({ sessionId, query: trimmed, status: "no_results" });
    return "";
  }

  currentResults = applyTimeDecay(currentResults, compactTs);
  otherResults = applyTimeDecay(otherResults, compactTs);

  const timeRanges = extractTimeRanges(trimmed, sessionId);
  if (timeRanges.length > 0) {
    currentResults = applyTemporalBoost(currentResults, timeRanges);
    otherResults = applyTemporalBoost(otherResults, timeRanges);
  }

  const chronological = timeRanges.length > 0 || hasUpdateIndicator(trimmed);
  const { output, truncated, rendered, total } = formatContext(
    currentResults,
    otherResults,
    config.maxContextChars,
    chronological
  );
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
  });
  return output;
}

// --- Debug-mode inject log ---

const DEBUG_LOG_PATH = `${process.env.HOME}/.claude/contextalign/inject.log`;

interface LogEntry {
  sessionId: string;
  query: string;
  status: "ok" | "no_compact" | "stopword" | "no_results";
  chronological?: boolean;
  currentResults?: SearchResult[];
  otherResults?: SearchResult[];
  chars?: number;
  truncated?: boolean;
  rendered?: number;
  total?: number;
}

function logInject(entry: LogEntry): void {
  if (process.env.CAN_DEBUG !== "1") return;
  try {
    const scores: number[] = [];
    const previews: string[] = [];
    if (entry.currentResults || entry.otherResults) {
      const merged = [...(entry.currentResults ?? []), ...(entry.otherResults ?? [])];
      for (const r of merged.slice(0, 5)) {
        scores.push(Number(r.score.toFixed(4)));
      }
      for (const r of merged.slice(0, 3)) {
        const text = r.message_text.length <= 500 ? r.message_text : r.chunk_text;
        previews.push(text.slice(0, 80).replace(/\s+/g, " "));
      }
    }
    const line = JSON.stringify({
      t: new Date().toISOString(),
      sid: entry.sessionId.slice(0, 8),
      q: entry.query.slice(0, 120),
      status: entry.status,
      chrono: entry.chronological ?? false,
      n_cur: entry.currentResults?.length ?? 0,
      n_oth: entry.otherResults?.length ?? 0,
      chars: entry.chars ?? 0,
      truncated: entry.truncated ?? false,
      rendered: entry.rendered ?? 0,
      total: entry.total ?? 0,
      scores,
      preview: previews,
    });
    mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true });
    appendFileSync(DEBUG_LOG_PATH, line + "\n");
  } catch {}
}

function hasUpdateIndicator(query: string): boolean {
  return /現況|最新|現在|改用|改成|最終決定|目前|當前|latest|current state/i.test(query);
}

function extractTimeRanges(
  query: string,
  sessionId?: string
): Array<{ start: Date; end: Date }> {
  const now = new Date();
  const ranges: Array<{ start: Date; end: Date }> = [];
  const seen = new Set<string>();
  const DAY = 24 * 60 * 60 * 1000;
  const MIN = 60 * 1000;

  const addRange = (start: Date, end: Date) => {
    const key = `${start.toISOString()}|${end.toISOString()}`;
    if (seen.has(key)) return;
    seen.add(key);
    ranges.push({ start, end });
  };

  const addResult = (r: any) => {
    if (!r?.start) return;
    const start = r.start.date();
    const end = r.end?.date() ?? new Date(start.getTime() + DAY);
    addRange(start, end);
  };

  try {
    chrono.parse(query, now, { forwardDate: false }).forEach(addResult);
  } catch {}
  try {
    (chrono as any).zh?.parse?.(query, now, { forwardDate: false })?.forEach(addResult);
  } catch {}

  // Chinese regex fallback for patterns chrono-node zh misses
  const startOfDay = (d: Date) => {
    const t = new Date(d);
    t.setHours(0, 0, 0, 0);
    return t;
  };
  const endOfDay = (d: Date) => {
    const t = new Date(d);
    t.setHours(23, 59, 59, 999);
    return t;
  };

  // 上週 / 上星期 → last Mon–Sun
  if (/上週|上星期|上禮拜/.test(query)) {
    const day = now.getDay() || 7; // Sun=0 → 7
    const lastSun = startOfDay(new Date(now.getTime() - day * DAY));
    const lastMon = new Date(lastSun.getTime() - 6 * DAY);
    addRange(lastMon, endOfDay(lastSun));
  }
  // 這週 / 本週 → this Mon–now
  if (/這週|本週|這星期|本星期|這禮拜|本禮拜/.test(query)) {
    const day = now.getDay() || 7;
    const mon = startOfDay(new Date(now.getTime() - (day - 1) * DAY));
    addRange(mon, now);
  }
  // N 天前 / N 小時前 / N 週前 / N 個月前
  const mDays = query.match(/(\d+)\s*天前/);
  if (mDays) {
    const n = parseInt(mDays[1], 10);
    const target = new Date(now.getTime() - n * DAY);
    addRange(startOfDay(target), endOfDay(target));
  }
  const mHours = query.match(/(\d+)\s*(小時|個小時|鐘頭)前/);
  if (mHours) {
    const n = parseInt(mHours[1], 10);
    const end = new Date(now.getTime() - n * 60 * 60 * 1000);
    const start = new Date(end.getTime() - 60 * 60 * 1000);
    addRange(start, end);
  }
  const mWeeks = query.match(/(\d+)\s*(週|星期|禮拜)前/);
  if (mWeeks) {
    const n = parseInt(mWeeks[1], 10);
    const end = new Date(now.getTime() - n * 7 * DAY);
    addRange(startOfDay(new Date(end.getTime() - 7 * DAY)), endOfDay(end));
  }
  const mMonths = query.match(/(\d+)\s*(個月|月)前/);
  if (mMonths) {
    const n = parseInt(mMonths[1], 10);
    const end = new Date(now);
    end.setMonth(end.getMonth() - n);
    const start = new Date(end);
    start.setMonth(start.getMonth() - 1);
    addRange(startOfDay(start), endOfDay(end));
  }
  // 上個月
  if (/上個月|上月/.test(query)) {
    const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    addRange(start, end);
  }
  // 這個月 / 本月
  if (/這個月|本月/.test(query)) {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    addRange(start, now);
  }

  // Session-relative patterns
  // 「剛才」「剛剛」→ 最近 30 分鐘
  if (/剛才|剛剛|just now/i.test(query)) {
    addRange(new Date(now.getTime() - 30 * MIN), now);
  }
  // 「一開始」「最初」「開頭」「起初」「session 頭」「beginning」→ session 開頭 ±30 分鐘
  if (sessionId && /一開始|最初|開頭|起初|session\s*(頭|開頭|開始|start|beginning)|從頭|beginning of session/i.test(query)) {
    const startIso = getSessionStartTime(sessionId);
    if (startIso) {
      const sessionStart = new Date(startIso);
      addRange(
        new Date(sessionStart.getTime() - 30 * MIN),
        new Date(sessionStart.getTime() + 30 * MIN)
      );
    }
  }
  // 「前面」「前面幾分鐘」→ 最近 N 分鐘（N 預設 60）
  const mRecentMin = query.match(/前面\s*(\d+)?\s*分鐘?/);
  if (mRecentMin) {
    const n = mRecentMin[1] ? parseInt(mRecentMin[1], 10) : 60;
    addRange(new Date(now.getTime() - n * MIN), now);
  }

  return ranges;
}

function applyTemporalBoost(
  results: SearchResult[],
  ranges: Array<{ start: Date; end: Date }>
): SearchResult[] {
  return results
    .map((r) => {
      const ts = new Date(r.timestamp).getTime();
      const inRange = ranges.some(
        (rng) => ts >= rng.start.getTime() && ts <= rng.end.getTime()
      );
      return inRange ? { ...r, score: r.score * TEMPORAL_BOOST } : r;
    })
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.score - a.score;
    });
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
  maxChars: number,
  chronological: boolean = false
): { output: string; truncated: boolean; rendered: number; total: number } {
  // Dedup pass: sort by timestamp ASC and take first-wins.
  // Rationale: the earliest occurrence is guaranteed to be compacted away; the latest
  // may still be in the live context window — so CAN keeps the version Claude can't see.
  const byTimeAsc = [...currentResults, ...otherResults].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  const seenHashes = new Set<string>();
  const kept = new Set<SearchResult>();
  for (const r of byTimeAsc) {
    const text = r.message_text.length <= 500 ? r.message_text : r.chunk_text;
    const hash = contentHash(text);
    if (seenHashes.has(hash)) continue;
    seenHashes.add(hash);
    kept.add(r);
  }

  const renderOrder = chronological
    ? byTimeAsc.filter((r) => kept.has(r))
    : [...currentResults, ...otherResults].filter((r) => kept.has(r));

  let output = CONTEXT_HEADER + "\n";
  let remaining = maxChars - output.length;
  let rendered = 0;
  let truncated = false;
  for (const r of renderOrder) {
    const line = formatResultLine(r);
    if (line.length > remaining) {
      if (remaining > 50) {
        output += line.slice(0, remaining - 4) + "...\n";
      }
      truncated = true;
      break;
    }
    output += line;
    remaining -= line.length;
    rendered++;
  }

  return { output: output.trim(), truncated, rendered, total: renderOrder.length };
}
