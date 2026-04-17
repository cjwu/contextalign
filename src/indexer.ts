import { createReadStream } from "fs";
import { createInterface } from "readline";
import { stat } from "fs/promises";
import {
  ensureSessionTables,
  getLastIndexedOffset,
  setLastIndexedOffset,
  insertChunks,
} from "./db.js";
import { embedBatch, isEmbeddingReady } from "./embedding.js";
import { chunkText } from "./chunker.js";
import { DEFAULT_CONFIG, type Chunk, type JournalAssistantBlock } from "./types.js";

// Track in-progress indexing per session to avoid concurrent runs
const indexingInProgress = new Set<string>();

// Track in-progress embedding backfill per session to avoid concurrent chains
const backfillInProgress = new Set<string>();

export async function indexNewMessages(
  sessionId: string,
  transcriptPath: string
): Promise<void> {
  if (indexingInProgress.has(sessionId)) return;
  indexingInProgress.add(sessionId);

  try {
    ensureSessionTables(sessionId, transcriptPath);

    const lastOffset = getLastIndexedOffset(sessionId);
    const fileStat = await stat(transcriptPath);
    if (fileStat.size <= lastOffset) return; // Nothing new

    const chunks: Chunk[] = [];
    let currentOffset = 0;
    let lineNumber = 0;

    const stream = createReadStream(transcriptPath, {
      encoding: "utf-8",
      start: lastOffset,
    });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      lineNumber++;
      currentOffset = lastOffset + Buffer.byteLength(line, "utf-8") + 1; // +1 for newline

      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line);
        const parsed = parseEntry(entry, currentOffset);
        if (parsed.length > 0) {
          chunks.push(...parsed);
        }
      } catch {
        // Skip unparseable lines
      }
    }

    // Batch insert WITHOUT embeddings first (fast path)
    if (chunks.length > 0) {
      insertChunks(sessionId, chunks);
    }

    // Update offset to end of file
    setLastIndexedOffset(sessionId, fileStat.size);

    // Backfill embeddings in background (slow path, non-blocking)
    if (isEmbeddingReady() && chunks.length > 0) {
      backfillEmbeddings(sessionId).catch((err) =>
        console.error(`[ContextAlign] Embedding backfill error:`, err)
      );
    }
  } catch (err) {
    console.error(`[ContextAlign] Indexing error for session ${sessionId}:`, err);
  } finally {
    indexingInProgress.delete(sessionId);
  }
}

async function backfillEmbeddings(sessionId: string): Promise<void> {
  if (backfillInProgress.has(sessionId)) return;
  backfillInProgress.add(sessionId);

  try {
    const { getChunksWithoutEmbedding, updateChunkEmbedding } = await import("./db.js");
    const { embeddingBatchSize, embeddingBatchDelayMs } = DEFAULT_CONFIG;
    const rows = getChunksWithoutEmbedding(sessionId, embeddingBatchSize);
    if (rows.length === 0) return;

    // Single ONNX forward pass for the whole batch
    const embeddings = await embedBatch(rows.map((r) => r.chunk_text));
    for (let i = 0; i < rows.length; i++) {
      const emb = embeddings[i];
      if (emb) updateChunkEmbedding(sessionId, rows[i].id, emb);
    }

    // If more remain, schedule next batch with throttle pause
    const remaining = getChunksWithoutEmbedding(sessionId, 1);
    if (remaining.length > 0) {
      setTimeout(() => {
        backfillEmbeddings(sessionId).catch(() => {});
      }, embeddingBatchDelayMs);
    }
  } finally {
    backfillInProgress.delete(sessionId);
  }
}

function parseEntry(entry: any, offset: number): Chunk[] {
  const chunks: Chunk[] = [];
  const timestamp = entry.timestamp || new Date().toISOString();

  if (entry.type === "user" && entry.message?.content) {
    const content = entry.message.content;
    if (typeof content === "string" && content.trim()) {
      for (const ct of chunkText(content)) {
        chunks.push({
          jsonl_offset: offset,
          role: "user",
          message_text: content,
          chunk_text: ct,
          embedding: null,
          priority: 0,
          timestamp,
        });
      }
    }
  } else if (entry.type === "assistant" && entry.message?.content) {
    const content = entry.message.content;

    if (Array.isArray(content)) {
      for (const block of content as JournalAssistantBlock[]) {
        if (block.type === "text" && block.text?.trim()) {
          for (const ct of chunkText(block.text)) {
            chunks.push({
              jsonl_offset: offset,
              role: "assistant",
              message_text: block.text,
              chunk_text: ct,
              embedding: null,
              priority: 0,
              timestamp,
            });
          }
        } else if (block.type === "tool_use" && block.name) {
          const summary = formatToolMeta(block.name, block.input);
          chunks.push({
            jsonl_offset: offset,
            role: "tool_meta",
            message_text: summary,
            chunk_text: summary,
            embedding: null,
            priority: 0,
            timestamp,
          });
        }
        // Skip "thinking" blocks
      }
    } else if (typeof content === "string" && content.trim()) {
      for (const ct of chunkText(content)) {
        chunks.push({
          jsonl_offset: offset,
          role: "assistant",
          message_text: content,
          chunk_text: ct,
          embedding: null,
          priority: 0,
          timestamp,
        });
      }
    }
  }

  return chunks;
}

function formatToolMeta(name: string, input?: Record<string, unknown>): string {
  if (!input) return `[Tool: ${name}]`;

  // Extract key info based on tool type
  switch (name) {
    case "Read":
      return `[Tool: Read ${input.file_path || ""}]`;
    case "Write":
      return `[Tool: Write ${input.file_path || ""}]`;
    case "Edit":
      return `[Tool: Edit ${input.file_path || ""}]`;
    case "Bash":
      return `[Tool: Bash] ${(input.description || input.command || "").toString().slice(0, 200)}`;
    case "Grep":
      return `[Tool: Grep "${input.pattern || ""}"] in ${input.path || ""}`;
    case "Glob":
      return `[Tool: Glob "${input.pattern || ""}"] in ${input.path || ""}`;
    case "WebFetch":
      return `[Tool: WebFetch ${input.url || ""}]`;
    case "WebSearch":
      return `[Tool: WebSearch "${input.query || ""}"]`;
    case "Agent":
      return `[Tool: Agent] ${(input.description || "").toString().slice(0, 200)}`;
    default:
      return `[Tool: ${name}]`;
  }
}
