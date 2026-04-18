import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

// Separate from inject.log because events have different cadence and schema.
// inject.log: one line per search (at UserPromptSubmit).
// outcome.log: one line per post-turn outcome (at Stop) + challenge events.
const OUTCOME_LOG_PATH = `${process.env.HOME}/.claude/contextalign/outcome.log`;

function writeLine(obj: unknown): void {
  try {
    mkdirSync(dirname(OUTCOME_LOG_PATH), { recursive: true });
    appendFileSync(OUTCOME_LOG_PATH, JSON.stringify(obj) + "\n");
  } catch {}
}

export interface OutcomeEntry {
  sessionId: string;
  injTime?: string;
  topN: number;
  cited: number;
}

export function logOutcome(entry: OutcomeEntry): void {
  if (process.env.CAN_DEBUG !== "1") return;
  // Save rate is a lower bound: wasChunkCited only catches 20-char verbatim hits;
  // paraphrase is counted as "ignored" even when Claude effectively used the chunk.
  const outcome =
    entry.cited === 0 ? "ignored" : entry.cited >= 2 ? "save" : "partial";
  writeLine({
    t: new Date().toISOString(),
    sid: entry.sessionId.slice(0, 8),
    event: "outcome",
    inj_t: entry.injTime ?? null,
    top_n: entry.topN,
    cited: entry.cited,
    outcome,
  });
}

export interface ChallengeEntry {
  sessionId: string;
  prevInjTime?: string;
  prompt: string;
  kind: "correction" | "confidence";
}

export function logChallenge(entry: ChallengeEntry): void {
  if (process.env.CAN_DEBUG !== "1") return;
  writeLine({
    t: new Date().toISOString(),
    sid: entry.sessionId.slice(0, 8),
    event: "challenge",
    kind: entry.kind,
    prev_inj_t: entry.prevInjTime ?? null,
    prompt_head: entry.prompt.slice(0, 120),
  });
}
