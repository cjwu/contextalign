import type { SearchResult } from "./types.js";

const RRF_K = 60;
const USER_CITE_ALPHA = Number(process.env.CAN_USER_CITE_ALPHA ?? 0.4);
const LLM_USE_ALPHA = Number(process.env.CAN_LLM_USE_ALPHA ?? 0.3);

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
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

function resultKey(r: SearchResult): string {
  return `${r.session_id}:${r.jsonl_offset}`;
}

export function toRrfScored(results: SearchResult[]): SearchResult[] {
  return results.map((r, i) => ({ ...r, score: 1 / (RRF_K + i + 1) }));
}

export function rrfMerge(a: SearchResult[], b: SearchResult[]): SearchResult[] {
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

export function applyTimeDecay(results: SearchResult[], compactTs: string): SearchResult[] {
  const compactTime = new Date(compactTs).getTime();

  return results
    .map((r) => {
      const msgTime = new Date(r.timestamp).getTime();
      const hoursAgo = (compactTime - msgTime) / (1000 * 60 * 60);
      const decay = Math.pow(0.5, hoursAgo / 24);
      const priorityBoost = r.priority ? 2.0 : 1.0;
      const userCiteBoost = 1 + USER_CITE_ALPHA * (r.user_cite_score ?? 0);
      const llmUseBoost = 1 + LLM_USE_ALPHA * (r.llm_use_score ?? 0);
      return { ...r, score: r.score * decay * priorityBoost * userCiteBoost * llmUseBoost };
    })
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.score - a.score;
    });
}

// Sliding 20-char window, step 5. Catches verbatim quotes; paraphrases slip (accepted).
export function wasChunkCited(chunkText: string, responseText: string): boolean {
  if (!chunkText || !responseText || chunkText.length < 20) return false;
  const win = 20;
  const step = 5;
  for (let i = 0; i + win <= chunkText.length; i += step) {
    const sub = chunkText.substring(i, i + win);
    if (responseText.includes(sub)) return true;
  }
  return false;
}
