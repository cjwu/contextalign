import { createHash } from "crypto";
import type { SearchResult } from "./types.js";

const CONTEXT_HEADER =
  "[ContextAlign: compact 前的相關歷史，以下為原始對話記錄，若與摘要衝突請以此為準]";

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
  const correction = r.corrected_at
    ? ` [已被使用者於 ${formatTimestamp(r.corrected_at)} 糾正]`
    : "";
  return `[${roleLabel} ${ts} ${shortId}${correction}]: ${text}\n`;
}

function contentHash(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex");
}

// Populated by formatContext, consumed by stop handler for llm_use scoring.
const lastInjection = new Map<
  string,
  Array<{ jsonl_offset: number; chunk_text: string; session_id: string }>
>();

export function getLastInjection(
  sessionId: string
): Array<{ jsonl_offset: number; chunk_text: string; session_id: string }> {
  return lastInjection.get(sessionId) ?? [];
}

export function formatContext(
  currentResults: SearchResult[],
  otherResults: SearchResult[],
  maxChars: number,
  chronological: boolean = false,
  sessionId?: string
): { output: string; truncated: boolean; rendered: number; total: number } {
  // Dedup ASC-first-wins: earliest version is guaranteed compacted away;
  // latest may still be in live ctx — CAN keeps what Claude can't see.
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
  const emitted: Array<{ jsonl_offset: number; chunk_text: string; session_id: string }> = [];
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
    emitted.push({
      jsonl_offset: r.jsonl_offset,
      chunk_text: r.chunk_text,
      session_id: r.session_id,
    });
  }

  if (sessionId) lastInjection.set(sessionId, emitted);

  return { output: output.trim(), truncated, rendered, total: renderOrder.length };
}
