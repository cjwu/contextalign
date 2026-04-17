# ContextAlign (CAN)

[English](#english) · [繁體中文](#繁體中文)

Architect: **CJWU** · License: **MIT**

---

## English

A Claude Code MCP server + hooks combo that **recovers conversation memory lost to compaction**.

### Why

LLM conversations have a context window cap (e.g. 1M tokens). The system silently compacts (lossy summarization) in the background. What gets kept vs. dropped is decided unilaterally by the system — it **does not align with the user's mental model**. Things the user thinks Claude still remembers may already be gone.

CAN indexes the full conversation JSONL into SQLite (FTS5 + vector embeddings). On every user prompt it auto-searches the pre-compact history and injects relevant snippets back via the hook's `additionalContext`.

### Architecture

```
Claude Code ──stdio── MCP Server (Node.js, long-running)
                         ├── SQLite (FTS5 + embedding BLOB)
                         ├── Transformers.js (mxbai-embed-large)
                         └── HTTP over Unix Socket ←── Hooks (bash + curl)
                                                          ├── UserPromptSubmit → search + index
                                                          ├── PostCompact     → record timestamp
                                                          ├── Stop            → index
                                                          └── PostToolUse     → index
```

- **Source of truth**: Claude Code's JSONL transcript. CAN only builds an index; it never stores conversations itself.
- **Compact-aware**: no search until a compact has happened (Claude can still see everything in the live window).
- **Hybrid search**: FTS5 first. If FTS5 returns <3 hits, vector search runs and results are merged via RRF.
- **Zero external services**: 3 npm deps, Node 22.

### Install

**Automated** (recommended): hand the repo URL to Claude Code and have it follow [`ClaudeDo.md`](./ClaudeDo.md).

**Manual**: follow sections 1–8 of `ClaudeDo.md`. Requires Node 22, jq, curl, sqlite3, and `lockf` (macOS) / `flock` (Linux).

### Status indicators

The third statusline row shows CAN's liveness:
- `[can:UP]` (green) — hook successfully reached the server
- `[can:RUMBLINGR]` (yellow) — server is being spawned (self-rescue in progress)
- `[can:DOWN]` (red) — server died and spawn also failed

Every injected `additionalContext` starts with `[ctx compact:Y chunks:N emb:X%]` showing the current index state.

### Features

| | |
|---|---|
| Index speed | 54ms / 557 chunks (fast path) |
| Embedding backfill | ~1.2 chunks/sec, CPU capped around 200% |
| Scope | What the user sees: user prompts, Assistant text, Tool metadata. Thinking blocks and tool outputs are NOT indexed. |
| Cross-session | On by default. Current session prioritized; others fill remaining budget. |
| Dedup | SHA-256 content hash (removes duplicates from branched sessions). |
| Self-rescue | Hook detects dead server → `lockf`-protected `nohup` spawn → logs to `~/.claude/contextalign/server.log`. |
| MCP tools | `search` / `session_list` / `session_delete` / `session_addctx` |

### Known limitations

- Context-continuation sessions (`claude --continue`) do NOT auto-start the MCP server; the first prompt triggers hook self-rescue (no injection on that prompt, UP from the next one).
- Encoder query-doc asymmetry: paraphrased questions ("what is the vector model called?") may fail to retrieve the fact chunk ("mxbai-embed-large"); keyword queries work better for factual lookup.
- Each session has its own per-session table. Deleting a session = deleting its index.
- macOS `pgrep` is case-sensitive; the hook's pattern must be exactly `ContextAlign/dist/index.js`.

### License

MIT License — see [`LICENSE`](./LICENSE).

---

## 繁體中文

Claude Code MCP server + hooks，用來補回 **compaction 壓掉的對話記憶**。

### Why

LLM 對話有 context window 上限（如 1M tokens）。系統會在背景做 compaction（有損壓縮）。但壓哪些、留哪些是系統單方面決定的，**不會跟使用者記憶對齊**——使用者以為 AI 還記得的東西，可能已經不見了。

CAN 把完整對話 JSONL 索引成 SQLite（FTS5 + 向量），每次 prompt 自動搜 compact 前的相關片段，透過 hook `additionalContext` 注入回去。

### Architecture

```
Claude Code ──stdio── MCP Server (Node.js, 常駐)
                         ├── SQLite (FTS5 + embedding BLOB)
                         ├── Transformers.js (mxbai-embed-large)
                         └── HTTP over Unix Socket ←── Hooks (bash + curl)
                                                          ├── UserPromptSubmit → 搜尋 + 索引
                                                          ├── PostCompact     → 記錄時間點
                                                          ├── Stop            → 索引
                                                          └── PostToolUse     → 索引
```

- **Source of truth**：Claude Code 的 JSONL transcript，CAN 只建索引不自己存對話
- **Compact-aware**：沒 compact 過就不搜（Claude 本來就看得到）
- **Hybrid search**：FTS5 優先；FTS5 命中 <3 才用 vector 並 RRF 合併
- **零外部服務**：3 個 npm 依賴，Node 22

### Install

**自動安裝**（推薦）：把這個 repo 的 URL 丟給 Claude Code，讓它讀 [`ClaudeDo.md`](./ClaudeDo.md) 自動完成。

**手動**：參考 `ClaudeDo.md` 第 1–8 節步驟。需要 Node 22、jq、curl、sqlite3、lockf（macOS）/ flock（Linux）。

### Status indicators

Statusline 第三行會顯示：
- `[can:UP]`（綠）— hook 成功打到 server
- `[can:RUMBLINGR]`（黃）— server 正在 spawn 中（self-rescue）
- `[can:DOWN]`（紅）— server 死且 spawn 也失敗

additionalContext 最前方會有 `[ctx compact:Y chunks:N emb:X%]`，顯示當前索引狀態。

### Features

| | |
|---|---|
| Index 速度 | 54ms / 557 chunks（fast path） |
| Embedding | 背景補填，~1.2 chunks/sec，CPU ~200% |
| 索引範圍 | 使用者看得到的內容（user prompts、Assistant 文字、Tool metadata）；thinking blocks 與 tool outputs 不存 |
| 跨 session | 預設開，當前 session 優先 + 其他 session 填剩餘 |
| 去重 | SHA-256 content hash（branch session 重複內容過濾） |
| Self-rescue | Hook 偵測 server 死 → lockf 保護 spawn → log 到 `~/.claude/contextalign/server.log` |
| 三個 MCP tools | `search` / `session_list` / `session_delete` / `session_addctx` |

### Known limitations

- Context-continuation session（`claude --continue`）不會 auto-start MCP server，要等第一個 prompt 觸發 hook self-rescue（那一次不注入，下一個 prompt 才會是 UP）
- Encoder query-doc 語意非對稱：paraphrased 問句（「向量模型叫什麼名字」）可能撈不到事實 chunk（「mxbai-embed-large」），這時用關鍵字反而精準
- 每個 session 的索引獨立一張表，session 刪除 = 索引刪除
- macOS pgrep 大小寫敏感；hook pattern 必須是 `ContextAlign/dist/index.js`

### License

MIT License — 見 [`LICENSE`](./LICENSE)。
