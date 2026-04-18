import type { SearchResult } from "./types.js";

const RRF_K = 60;
const USER_CITE_ALPHA = Number(process.env.CAN_USER_CITE_ALPHA ?? 0.4);
// BM25-style saturation constant for user_cite (v1.9.7+). Linear boost blew up
// at high citation counts; saturation prevents runaway while keeping linear
// sensitivity at low end. sat(x) = x*(1+k)/(x+k).
const USER_CITE_K = Number(process.env.CAN_USER_CITE_K ?? 2.0);
const LLM_USE_ALPHA = Number(process.env.CAN_LLM_USE_ALPHA ?? 0.3);
// Per Schegloff repair analysis: chunks explicitly corrected by the user are
// NEGATIVE evidence. Annotate-only was wrong. Downweight (don't hide) so the
// corrected content still surfaces on strong keyword hits but yields to
// better answers when any exist. Set to 1.0 via env to disable for ablation.
const CORRECTION_PENALTY = Number(process.env.CAN_CORRECTION_PENALTY ?? 0.5);
// Yi 2014 dwell-time boost. dwell_norm = dwell_sec / (chunk_chars / 10),
// where 10 chars/sec is a careful-read baseline. norm ≈ 1 = expected pace;
// >1 = deliberate engagement; <0.3 = skim.
const DWELL_ALPHA = Number(process.env.CAN_DWELL_ALPHA ?? 0.3);
// Hyperbolic decay half-life (hours). Replaces exponential 0.5^(t/T) with
// 1/(1 + t/T). Same half-life at t=T, but much slower tail — models human
// Ebbinghaus power-law forgetting better than exponential (Ainslie 1975
// hyperbolic discounting; Wixted & Ebbesen 1991 on retention curves).
// Also aligns with CAN's mission: older chunks are the retrieval target.
const DECAY_HALFLIFE_HOURS = Number(process.env.CAN_DECAY_HALFLIFE_HOURS ?? 24);

function userCiteSaturate(x: number): number {
  if (x <= 0) return 0;
  return (x * (1 + USER_CITE_K)) / (x + USER_CITE_K);
}

function dwellScore(dwellMs: number | null | undefined, chunkChars: number): number {
  if (!dwellMs || dwellMs <= 0 || chunkChars <= 0) return 0;
  const dwellSec = dwellMs / 1000;
  const expectedSec = chunkChars / 10;
  const dwellNorm = dwellSec / Math.max(1, expectedSec);
  // Map [0.3, 2.3] -> [0, 1]; clip outside. Skim gives 0, AFK saturates at 1.
  return Math.max(0, Math.min(1, (dwellNorm - 0.3) / 2.0));
}

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
      const hoursAgo = Math.max(0, (compactTime - msgTime) / (1000 * 60 * 60));
      const decay = 1 / (1 + hoursAgo / DECAY_HALFLIFE_HOURS);
      const priorityBoost = r.priority ? 2.0 : 1.0;
      const userCiteBoost = 1 + USER_CITE_ALPHA * userCiteSaturate(r.user_cite_score ?? 0);
      const llmUseBoost = 1 + LLM_USE_ALPHA * (r.llm_use_score ?? 0);
      const correctionPenalty = r.corrected_at ? CORRECTION_PENALTY : 1.0;
      const dwellBoost = 1 + DWELL_ALPHA * dwellScore(r.dwell_ms, r.chunk_text.length);
      return {
        ...r,
        score:
          r.score *
          decay *
          priorityBoost *
          userCiteBoost *
          llmUseBoost *
          correctionPenalty *
          dwellBoost,
      };
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
