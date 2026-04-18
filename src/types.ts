// ContextAlign shared types

export interface Config {
  enabled: boolean;
  maxContextChars: number;
  dbPath: string;
  socketPath: string;
  stopWords: string[];
  embeddingBatchSize: number;   // chunks per batch
  embeddingDelayMs: number;     // ms between each chunk in a batch
  embeddingBatchDelayMs: number; // ms between batches
}

export const DEFAULT_CONFIG: Config = {
  enabled: true,
  maxContextChars: 10000,
  dbPath: `${process.env.HOME}/.claude/contextalign/contextalign.db`,
  socketPath: `${process.env.HOME}/.claude/contextalign/ctx.sock`,
  embeddingBatchSize: 5,        // 5 chunks per batch (single ONNX forward pass)
  embeddingDelayMs: 0,          // unused: batch mode has no per-chunk delay
  embeddingBatchDelayMs: 2000,  // 2s pause between batches
  stopWords: [
    "好", "對", "ok", "OK", "Ok", "yes", "Yes", "y", "Y",
    "繼續", "continue", "go", "Go", "嗯", "恩",
    "是", "no", "No", "n", "N", "不", "不是",
  ],
};

// JSONL message types we care about
export interface JournalUser {
  type: "user";
  message: { role: "user"; content: string };
  timestamp: string;
  uuid: string;
  sessionId: string;
}

export interface JournalAssistantBlock {
  type: "text" | "tool_use" | "thinking";
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  thinking?: string;
}

export interface JournalAssistant {
  type: "assistant";
  message: {
    role: "assistant";
    content: JournalAssistantBlock[] | string;
  };
  timestamp: string;
  uuid: string;
  sessionId: string;
}

export type JournalEntry = JournalUser | JournalAssistant | { type: string };

// Chunk stored in SQLite
export interface Chunk {
  id?: number;
  jsonl_offset: number;
  role: "user" | "assistant" | "tool_meta";
  message_text: string;
  chunk_text: string;
  embedding: Buffer | null;
  priority: number;
  timestamp: string;
}

// Search result
export interface SearchResult {
  session_id: string;
  jsonl_offset: number;
  role: string;
  message_text: string;
  chunk_text: string;
  score: number;
  timestamp: string;
  priority: number;
  corrected_at?: string | null;
  correction_reason?: string | null;
  user_cite_score?: number;
  llm_use_score?: number;
  dwell_ms?: number | null;
}

// Hook request types
export interface PromptRequest {
  type: "prompt";
  sessionId: string;
  prompt: string;
  transcriptPath: string;
}

export interface CompactRequest {
  type: "compact";
  sessionId: string;
  timestamp: string;
}

export interface StopRequest {
  type: "stop";
  sessionId: string;
  transcriptPath: string;
}

export interface ToolUseRequest {
  type: "tool_use";
  sessionId: string;
  transcriptPath: string;
}

export type HookRequest = PromptRequest | CompactRequest | StopRequest | ToolUseRequest;

export interface HookResponse {
  additionalContext?: string;
  ok?: boolean;
}
