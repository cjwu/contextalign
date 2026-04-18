import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createServer } from "http";
import { unlinkSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

import { initDb, setCompactTimestamp, listSessions, deleteSession, getCompactTimestamp, getEmbeddingProgress } from "./db.js";
import { initEmbedding, embed, isEmbeddingReady } from "./embedding.js";
import { indexNewMessages } from "./indexer.js";
import { searchAndFormat, getLastInjection, wasChunkCited } from "./search.js";
import { insertPriorityChunk, ensureSessionTables, markLastAssistantCorrected, incrementLastAssistantUserCite, updateLlmUseScore, setLastAssistantDwell } from "./db.js";
import { readFileSync } from "fs";
import { DEFAULT_CONFIG } from "./types.js";
import type { Config } from "./types.js";

const config: Config = { ...DEFAULT_CONFIG };

// --- HTTP server on Unix socket (for hooks) ---

function startSocketServer(): void {
  const socketPath = config.socketPath;
  mkdirSync(dirname(socketPath), { recursive: true });

  // Clean up stale socket
  if (existsSync(socketPath)) {
    try { unlinkSync(socketPath); } catch {}
  }

  const server = createServer(async (req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      res.setHeader("Content-Type", "application/json");

      try {
        const data = JSON.parse(body);
        const result = await handleHookRequest(data);
        res.writeHead(200);
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error("[ContextAlign] Hook handler error:", err);
        res.writeHead(200); // Still 200 — don't break hooks
        res.end(JSON.stringify({ additionalContext: "", ok: true }));
      }
    });
  });

  server.listen(socketPath, () => {
    console.error(`[ContextAlign] Unix socket server listening on ${socketPath}`);
  });

  // Cleanup on exit
  process.on("exit", () => {
    try { unlinkSync(socketPath); } catch {}
  });
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

async function handleHookRequest(data: any): Promise<any> {
  const { type, sessionId, transcriptPath, prompt, timestamp } = data;

  switch (type) {
    case "prompt": {
      // Ensure session exists
      if (transcriptPath) {
        ensureSessionTables(sessionId, transcriptPath);
      }

      // Yi 2014 dwell-time: gap between latest assistant turn and this prompt.
      // Normalizes by response length downstream. Capped inside DB at 5 min to
      // discount AFK gaps. Fires before correction/citation so those updates
      // still hit the intended chunk.
      if (sessionId && transcriptPath) {
        try {
          const lastTs = readLatestAssistantTimestamp(transcriptPath);
          if (lastTs) {
            const dwellMs = Date.now() - new Date(lastTs).getTime();
            if (dwellMs > 0) setLastAssistantDwell(sessionId, dwellMs);
          }
        } catch (err) {
          console.error("[ContextAlign] dwell measurement error:", err);
        }
      }

      // Correction detection: if user prompt signals rejection of previous AI
      // response, annotate the last assistant chunk so future retrievals carry
      // the "被糾正" marker. Annotate only — do not suppress.
      if (prompt && sessionId && /不對|錯了|不是這樣|改成|這不是我要的|重來|錯誤|這不對|wrong|incorrect/i.test(prompt)) {
        try {
          markLastAssistantCorrected(sessionId, prompt);
        } catch (err) {
          console.error("[ContextAlign] markLastAssistantCorrected error:", err);
        }
      }

      // User-citation detection (v1.9.3): if the user references earlier content,
      // treat it as evidence that chunk is in the user's cognitive model.
      // Increment user_cite_score on the most recent assistant chunk.
      if (prompt && sessionId && /剛才|剛剛|之前|上面|上次|先前|你提到|我們說|我們討論|我們決定|earlier you|above/i.test(prompt)) {
        try {
          incrementLastAssistantUserCite(sessionId);
        } catch (err) {
          console.error("[ContextAlign] incrementLastAssistantUserCite error:", err);
        }
      }

      // Build status line
      const status = buildStatus(sessionId);

      // Synchronous: search for relevant context
      let additionalContext = "";
      if (config.enabled && prompt) {
        additionalContext = await searchAndFormat(sessionId, prompt, config);
      }

      // Prepend status to context (always show, even if no search results)
      if (status) {
        additionalContext = additionalContext
          ? `${status}\n${additionalContext}`
          : status;
      }

      // Async: index new messages (don't await — non-blocking)
      if (transcriptPath) {
        indexNewMessages(sessionId, transcriptPath).catch((err) =>
          console.error("[ContextAlign] Async indexing error:", err)
        );
      }

      return { additionalContext };
    }

    case "compact": {
      const ts = timestamp || new Date().toISOString();
      if (sessionId) {
        setCompactTimestamp(sessionId, ts);
        console.error(`[ContextAlign] Compact recorded for session ${sessionId} at ${ts}`);
      }
      return { ok: true };
    }

    case "stop":
    case "tool_use": {
      // Async: index new messages
      if (sessionId && transcriptPath) {
        ensureSessionTables(sessionId, transcriptPath);
        indexNewMessages(sessionId, transcriptPath).catch((err) =>
          console.error("[ContextAlign] Async indexing error:", err)
        );
      }

      // 2a: on stop, score last-injection chunks by citation in latest assistant response
      if (type === "stop" && sessionId && transcriptPath) {
        try {
          scoreLastInjection(sessionId, transcriptPath);
        } catch (err) {
          console.error("[ContextAlign] scoreLastInjection error:", err);
        }
      }

      return { ok: true };
    }

    default:
      return { ok: true };
  }
}

function readLatestAssistantTimestamp(transcriptPath: string): string | null {
  try {
    const content = readFileSync(transcriptPath, "utf-8");
    const lines = content.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === "assistant" && entry.timestamp) return entry.timestamp;
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function readLatestAssistantText(transcriptPath: string): string | null {
  try {
    const content = readFileSync(transcriptPath, "utf-8");
    const lines = content.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "assistant" || entry.message?.role !== "assistant") continue;
        const blocks = Array.isArray(entry.message.content)
          ? entry.message.content
          : [{ type: "text", text: String(entry.message.content ?? "") }];
        const texts: string[] = [];
        for (const b of blocks) {
          if (b.type === "text" && b.text) texts.push(b.text);
        }
        if (texts.length > 0) return texts.join("\n");
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function scoreLastInjection(sessionId: string, transcriptPath: string): void {
  const injection = getLastInjection(sessionId);
  if (!injection.length) return;
  const response = readLatestAssistantText(transcriptPath);
  if (!response) return;
  for (const item of injection) {
    const cited = wasChunkCited(item.chunk_text, response);
    updateLlmUseScore(item.session_id, item.jsonl_offset, cited);
  }
}

function buildStatus(sessionId: string): string {
  const compact = getCompactTimestamp(sessionId);
  const { total, embedded } = getEmbeddingProgress(sessionId);
  const embReady = isEmbeddingReady();

  const parts: string[] = ["[ctx"];

  // Compact state
  if (compact) {
    parts.push("compact:Y");
  }

  // Chunks indexed
  if (total > 0) {
    parts.push(`chunks:${total}`);
  }

  // Embedding progress
  if (total > 0) {
    const pct = Math.round((embedded / total) * 100);
    if (pct >= 100) {
      parts.push("emb:done");
    } else if (!embReady) {
      parts.push("emb:loading");
    } else {
      parts.push(`emb:${pct}%`);
    }
  } else if (!embReady) {
    parts.push("emb:loading");
  }

  parts[0] = parts.length > 1 ? "[ctx" : "[ctx:ready";
  return parts.join(" ") + "]";
}

// --- MCP Server (stdio) ---

function startMcpServer(): void {
  const server = new McpServer({
    name: "contextalign",
    version: "0.1.0",
  });

  // Tool: search
  server.tool(
    "search",
    "Search conversation history for relevant context",
    {
      query: z.string().describe("Search query"),
      sessionId: z.string().describe("Session ID to search in"),
    },
    async ({ query, sessionId }) => {
      const result = await searchAndFormat(sessionId, query, config);
      return {
        content: [{ type: "text" as const, text: result || "No relevant history found." }],
      };
    }
  );

  // Tool: session_list
  server.tool(
    "session_list",
    "List all tracked sessions",
    {},
    async () => {
      const sessions = listSessions();
      if (sessions.length === 0) {
        return { content: [{ type: "text" as const, text: "No sessions tracked." }] };
      }
      const lines = sessions.map(
        (s) =>
          `- ${s.session_id} (created: ${s.created_at}, compact: ${s.compact_timestamp || "none"})`
      );
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // Tool: session_delete
  server.tool(
    "session_delete",
    "Delete a tracked session and its index data",
    {
      sessionId: z.string().describe("Session ID to delete"),
    },
    async ({ sessionId }) => {
      const ok = deleteSession(sessionId);
      return {
        content: [{ type: "text" as const, text: ok ? `Session ${sessionId} deleted.` : `Failed to delete session ${sessionId}.` }],
      };
    }
  );

  // Tool: session_addctx
  server.tool(
    "session_addctx",
    "Mark important information to be prioritized in future context retrieval",
    {
      sessionId: z.string().describe("Session ID"),
      text: z.string().describe("Important text to remember"),
    },
    async ({ sessionId, text }) => {
      const embedding = isEmbeddingReady() ? await embed(text) : null;
      insertPriorityChunk(sessionId, text, embedding, new Date().toISOString());
      return {
        content: [{ type: "text" as const, text: `Marked as important: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"` }],
      };
    }
  );

  const transport = new StdioServerTransport();
  server.connect(transport);
  console.error("[ContextAlign] MCP server started on stdio.");
}

// --- Main ---

async function main(): Promise<void> {
  console.error("[ContextAlign] Starting...");

  // Initialize SQLite
  initDb(config.dbPath);
  console.error(`[ContextAlign] Database initialized at ${config.dbPath}`);

  // Start HTTP Unix socket server for hooks
  startSocketServer();

  // Start MCP server on stdio
  startMcpServer();

  // Load embedding model in background (non-blocking)
  initEmbedding().catch((err) =>
    console.error("[ContextAlign] Embedding init error:", err)
  );
}

main().catch((err) => {
  console.error("[ContextAlign] Fatal error:", err);
  process.exit(1);
});
