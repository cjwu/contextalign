// Hallucination-risk detection kept as observation-only (v1.9.10): log the
// per-turn unmatched/total anchor stats into outcome.log for ablation/paper
// analysis. The statusline flag display was withdrawn because per-turn
// nudges became noisy and lost signal value — user preferred clean UI over
// real-time warnings. Measurement plumbing preserved for research.
const MIN_ANCHORS = Number(process.env.CAN_HALLUC_MIN_ANCHORS ?? 3);
// Single-track trigger (v1.9.9 final): severity >= 40% fires, else silent.
// Statusline colors yellow in [40, 70), red at >= 70.
const MIN_SEVERITY = Number(process.env.CAN_HALLUC_MIN_SEVERITY ?? 0.4);

// Extract anchor-like tokens from Claude's response. Tighter than search-side
// ANCHOR_PATTERNS: only specific factual claims (versions, filenames, paths,
// CamelCase identifiers, git SHAs). Abstract nouns and common words skipped.
const RESPONSE_ANCHOR_PATTERNS: RegExp[] = [
  /\bv?\d+\.\d+(?:\.\d+)*(?:-[\w.]+)?\b/g,
  /\b[\w-]+\.(?:ts|tsx|js|jsx|py|sh|json|jsonl|log|md|yml|yaml|sql|toml)\b/gi,
  /\b[a-zA-Z][\w-]*\/[\w./-]+/g,
  /\b[0-9a-f]{7,40}\b/g,
  /\b[a-z]+[A-Z][\w]*\b/g,
  // ALLCAPS tokens (e.g. EXPLORING, PAUSE-META, DEBUGGING) — catches the
  // enumerated-identifier hallucination pattern that triggered this nudge.
  /\b[A-Z][A-Z0-9]{2,}(?:[-_][A-Z0-9]{2,})*\b/g,
  // Single-word Title Case, 4+ chars (e.g. Ebbinghaus, Anthropic, React,
  // Claude, Python). FP on sentence-starter common words (Today, Later) is
  // accepted — nudge cost is low.
  /\b[A-Z][a-z]{3,}\b/g,
  // Lowercase hyphenated identifiers with 3+ segments (e.g. mxbai-embed-large,
  // bge-small-zh, better-sqlite3). 2-segment words (`top-down`, `bge-large`)
  // deliberately excluded to avoid common English-phrase FP.
  /\b[a-z][a-z0-9]*(?:-[a-z0-9]+){2,}\b/g,
];

export function extractAnchors(text: string): string[] {
  const seen = new Set<string>();
  for (const re of RESPONSE_ANCHOR_PATTERNS) {
    const matches = text.match(re);
    if (matches) {
      for (const m of matches) seen.add(m);
    }
  }
  return Array.from(seen);
}

export interface RiskResult {
  risk: boolean;
  unmatched: number;
  total: number;
}

export function detectHallucinationRisk(
  response: string,
  injection: Array<{ chunk_text: string }>
): RiskResult {
  const anchors = extractAnchors(response);
  const total = anchors.length;
  if (total < MIN_ANCHORS || injection.length === 0) {
    return { risk: false, unmatched: 0, total };
  }
  const corpus = injection.map((c) => c.chunk_text).join("\n");
  let matched = 0;
  for (const a of anchors) {
    if (corpus.includes(a)) matched++;
  }
  const unmatched = total - matched;
  const severity = unmatched / total;
  return { risk: severity >= MIN_SEVERITY, unmatched, total };
}

