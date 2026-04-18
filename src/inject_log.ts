import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { SearchResult } from "./types.js";

export interface Timing {
  fts: number;
  vec: number;
  temporal: number;
  format: number;
  total: number;
}

export interface LogEntry {
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
  timing?: Timing;
  vecRan?: boolean;
}

const DEBUG_LOG_PATH = `${process.env.HOME}/.claude/contextalign/inject.log`;

export function logInject(entry: LogEntry): void {
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
    const t = entry.timing;
    const tms = t
      ? {
          fts: Math.round(t.fts),
          vec: Math.round(t.vec),
          temporal: Math.round(t.temporal),
          format: Math.round(t.format),
          total: Math.round(t.total),
        }
      : undefined;
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
      vec_ran: entry.vecRan ?? false,
      ts_ms: tms,
      scores,
      preview: previews,
    });
    mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true });
    appendFileSync(DEBUG_LOG_PATH, line + "\n");
  } catch {}
}
