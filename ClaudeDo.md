# ClaudeDo.md — ContextAlign / CAN automated install guide (for Claude)

[English](#english) · [繁體中文](#繁體中文)

---

## English

You are Claude. The user has handed you this repo's GitHub URL in their terminal and asked you to install and run ContextAlign (abbreviated **CAN**).

CAN is a Claude Code MCP server + hook combo that automatically retrieves conversation history lost to compaction and injects it back via `additionalContext`. Full background: see `README.md`.

Follow the steps below **automatically**. Use your tools directly whenever possible; only stop to ask the user at decision points.

### 0. Pre-flight

Ask the user **where to install** (default `~/ContextAlign`). Call that absolute path `$CAN_DIR` below.

These `$HOME` paths will be used/created — show them to the user before proceeding:
- `~/.claude/contextalign/` (DB, socket, log, state files)
- `~/.claude/statusline-command.sh` (add/modify line 3)
- `<project>/.mcp.json` (add/merge MCP server config)
- `<project>/.claude/settings.local.json` (add/merge hooks config)

### 1. Environment check

```bash
node --version   # must be >= 22
which jq
which curl
which sqlite3
which lockf      # macOS: /usr/bin/lockf. Linux: use flock — see step 4.
```

If `node` is <22:
```bash
brew install node@22
# CAN will use /usr/local/opt/node@22/bin/node or /opt/homebrew/opt/node@22/bin/node
```
Find and record the actual `node@22` absolute path. Call it `$NODE22` below.

### 2. Get the code

```bash
git clone <url> "$CAN_DIR"
cd "$CAN_DIR"
```

### 3. Install + build

```bash
cd "$CAN_DIR"
"$NODE22" $(which npm) install
"$NODE22" node_modules/typescript/bin/tsc
ls dist/index.js                    # must exist
```

### 4. Create state dir + check hooks

```bash
mkdir -p "$HOME/.claude/contextalign"
chmod +x "$CAN_DIR/hooks/"*.sh
```

`hooks/prompt.sh` auto-derives `SERVER` (relative to script) and auto-discovers `node`. If default `node` isn't 22:
```bash
export CAN_NODE="/usr/local/opt/node@22/bin/node"
```

On Linux without `lockf`, replace `/usr/bin/lockf -t 0 "$LOCK" /bin/bash -c '...'` in `hooks/prompt.sh` with:
```bash
( flock -n 9 || exit 0; ... ) 9>"$LOCK"
```

### 5. `.mcp.json`

In the project root, create or merge:
```json
{
  "mcpServers": {
    "contextalign": {
      "command": "<NODE22 absolute path>",
      "args": ["<CAN_DIR>/dist/index.js"]
    }
  }
}
```
Merge only the `contextalign` entry — do NOT overwrite other servers.

### 6. `.claude/settings.local.json`

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "<CAN_DIR>/hooks/prompt.sh" }] }
    ],
    "PostCompact": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "<CAN_DIR>/hooks/compact.sh" }] }
    ],
    "Stop": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "<CAN_DIR>/hooks/stop.sh" }] }
    ],
    "PostToolUse": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "<CAN_DIR>/hooks/tool_use.sh" }] }
    ]
  }
}
```
Merge only the `hooks` block — do NOT overwrite existing hooks.

### 7. Statusline third row (optional, recommended)

Append to `~/.claude/statusline-command.sh`:
```bash
# Line 3: ContextAlign status
if [ -f "$HOME/.claude/contextalign/.alive" ]; then
  line3="[can:UP]"; line3_color="\033[0;32m"
elif [ -f "$HOME/.claude/contextalign/.loading" ]; then
  line3="[can:RUMBLINGR]"; line3_color="\033[0;33m"
else
  line3="[can:DOWN]"; line3_color="\033[0;31m"
fi
printf "\n${line3_color}%s\033[0m" "$line3"
```

Ensure `statusLine.command` in `~/.claude/settings.json` points to this script.

### 8. Verify

Tell the user:
> Open a **brand-new** Claude Code session (do NOT use `--continue`) in the project directory. MCP server should auto-start via `.mcp.json`.

Then check:
```bash
pgrep -fl "ContextAlign/dist/index.js"                        # 1. server running
ls "$HOME/.claude/contextalign/ctx.sock"                       # 2. socket exists
tail -20 "$HOME/.claude/contextalign/server.log"               # 3. "Embedding model loaded."
ls -la "$HOME/.claude/contextalign/contextalign.db"            # 4. DB created
```

Ask the user to send any prompt, then observe:
- Does the statusline show `[can:UP]` (green)?
- Did `~/.claude/contextalign/.alive` timestamp just update?

First run downloads the embedding model (~1.3 GB) to `~/.cache/huggingface/`. Allow 1–2 minutes on very first launch.

### 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `[can:DOWN]` stuck | Server didn't start or socket missing | Read `server.log`; check `hooks/prompt.sh` `NODE`/`SERVER` paths; manual `$NODE22 $CAN_DIR/dist/index.js &` |
| New server on every prompt | pgrep pattern case mismatch | Must be exactly `ContextAlign` |
| First response slow | Embedding model downloading | Wait 1–2 min; subsequent cache loads ~1.2 s |
| `libc++abi` crash | FTS5 empty-query bug (fixed v1.7+) or better-sqlite3 native state | Ensure built `dist/` is ≥ v1.7; restart server |
| Context-continuation no auto-start | Claude Code only reads `.mcp.json` in brand-new sessions | Hook self-rescue spawns on next prompt; or manual start |

### 10. Report back

Tell the user:
- Where `$CAN_DIR` is
- MCP server PID
- Current statusline state (UP / RUMBLINGR / DOWN)
- Log: `tail -f ~/.claude/contextalign/server.log`
- State: `ls -la ~/.claude/contextalign/`

Done.

---

## 繁體中文

你是 Claude。使用者在 terminal 裡把這個 repo 的 GitHub 連結丟給你，請求你幫他裝起來並跑 ContextAlign（縮寫 **CAN**）。

CAN 是一個 Claude Code 的 MCP server + hook 組合，用來在每次 compaction 後自動撈回 compact 前的對話歷史，注入到 additionalContext。完整背景看 `README.md`。

請依照下面步驟**自動**完成安裝。能用工具直接做的就做，遇到需要使用者確認的地方才停下來問。

### 0. 先確認

先問使用者**這個 repo 要裝在哪裡**（預設 `~/ContextAlign`）。以下把該絕對路徑記為 `$CAN_DIR`。

`$HOME` 下這些檔案會被 CAN 使用／建立，動手前先列給使用者看一眼：
- `~/.claude/contextalign/`（DB、socket、log、狀態檔）
- `~/.claude/statusline-command.sh`（要修改/新增第三行）
- `<project>/.mcp.json`（要新增或合併 MCP server 設定）
- `<project>/.claude/settings.local.json`（要新增或合併 hooks 設定）

### 1. 環境檢查

```bash
node --version   # 需要 >= 22
which jq
which curl
which sqlite3
which lockf      # macOS 內建於 /usr/bin/lockf（Linux 上用 flock 替代，見第 4 步備註）
```

若 `node` 版本 <22：
```bash
brew install node@22
# 之後 CAN 會用 /usr/local/opt/node@22/bin/node 或 /opt/homebrew/opt/node@22/bin/node
```
找出實際 node@22 絕對路徑並記下，以下稱 `$NODE22`。

### 2. 取得程式碼

```bash
git clone <url> "$CAN_DIR"
cd "$CAN_DIR"
```

### 3. 安裝 + build

```bash
cd "$CAN_DIR"
"$NODE22" $(which npm) install
"$NODE22" node_modules/typescript/bin/tsc
ls dist/index.js                    # 應該存在
```

### 4. 建狀態目錄 + 檢查 hook

```bash
mkdir -p "$HOME/.claude/contextalign"
chmod +x "$CAN_DIR/hooks/"*.sh
```

`hooks/prompt.sh` 會自動推斷 `SERVER` 路徑、自動尋找 `node`。若預設 `node` 不是 22：
```bash
export CAN_NODE="/usr/local/opt/node@22/bin/node"
```

Linux 上沒有 `lockf` 的話，把 `hooks/prompt.sh` 裡 `/usr/bin/lockf -t 0 "$LOCK" /bin/bash -c '...'` 換成：
```bash
( flock -n 9 || exit 0; ... ) 9>"$LOCK"
```

### 5. `.mcp.json`

在使用者的**專案目錄**根下，新增/合併：
```json
{
  "mcpServers": {
    "contextalign": {
      "command": "<NODE22 absolute path>",
      "args": ["<CAN_DIR>/dist/index.js"]
    }
  }
}
```
只合併 `contextalign` 這一條，不要覆蓋使用者其他 MCP servers。

### 6. `.claude/settings.local.json`

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "<CAN_DIR>/hooks/prompt.sh" }] }
    ],
    "PostCompact": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "<CAN_DIR>/hooks/compact.sh" }] }
    ],
    "Stop": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "<CAN_DIR>/hooks/stop.sh" }] }
    ],
    "PostToolUse": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "<CAN_DIR>/hooks/tool_use.sh" }] }
    ]
  }
}
```
只合併 `hooks` 區塊，不要覆蓋使用者其他 hooks。

### 7. Statusline 第三行（可選但建議）

Append 到 `~/.claude/statusline-command.sh`：
```bash
# Line 3: ContextAlign status
if [ -f "$HOME/.claude/contextalign/.alive" ]; then
  line3="[can:UP]"; line3_color="\033[0;32m"
elif [ -f "$HOME/.claude/contextalign/.loading" ]; then
  line3="[can:RUMBLINGR]"; line3_color="\033[0;33m"
else
  line3="[can:DOWN]"; line3_color="\033[0;31m"
fi
printf "\n${line3_color}%s\033[0m" "$line3"
```

確認 `~/.claude/settings.json` 裡的 `statusLine.command` 指向這個腳本。

### 8. 驗證

告訴使用者：
> 請重開一個 **全新** Claude Code session（不要用 `--continue`），在專案目錄啟動。新 session 會透過 `.mcp.json` 自動啟動 MCP server。

然後檢查：
```bash
pgrep -fl "ContextAlign/dist/index.js"                        # 1. server 跑了沒
ls "$HOME/.claude/contextalign/ctx.sock"                       # 2. socket 存在
tail -20 "$HOME/.claude/contextalign/server.log"               # 3. "Embedding model loaded."
ls -la "$HOME/.claude/contextalign/contextalign.db"            # 4. DB 建起來
```

讓使用者打一句話，觀察：
- statusline 有無 `[can:UP]`（綠色）
- `~/.claude/contextalign/.alive` 檔時間有無更新

首次啟動需下載 embedding model（~1.3GB）到 `~/.cache/huggingface/`，等 1–2 分鐘。

### 9. 常見問題

| 症狀 | 原因 | 處理 |
|---|---|---|
| `[can:DOWN]` 一直不變 | Server 沒啟動或 socket 不存在 | 看 `server.log`；檢查 `hooks/prompt.sh` 路徑；手動 `$NODE22 $CAN_DIR/dist/index.js &` |
| 每次 prompt 都 spawn 新 server | pgrep pattern 大小寫錯 | 必須是大寫 `ContextAlign` |
| 首次回應很慢 | Embedding model 下載中 | 等 1–2 分鐘；之後 cache 載入 ~1.2 秒 |
| `libc++abi` crash | FTS5 空 query bug（v1.7 已修）或 better-sqlite3 native 狀態 | 確認 build 是 v1.7+；重啟 server |
| Context-continuation 不 auto-start | Claude Code 限制，只有**全新** session 才讀 `.mcp.json` | Hook self-rescue 會在下一個 prompt 自動 spawn；或手動啟 |

### 10. 完成後回報

告訴使用者：
- `$CAN_DIR` 在哪
- MCP server PID
- Statusline 狀態（UP / RUMBLINGR / DOWN）
- 看 log：`tail -f ~/.claude/contextalign/server.log`
- 看狀態：`ls -la ~/.claude/contextalign/`

安裝完。
