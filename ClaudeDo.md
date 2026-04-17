# ClaudeDo.md — ContextAlign / CAN 自動安裝說明（給 Claude 讀的）

你是 Claude。使用者在 terminal 裡把這個 repo 的 GitHub 連結丟給你，請求你幫他裝起來並跑 ContextAlign（縮寫 CAN）。

CAN 是一個 Claude Code 的 MCP server + hook 組合，用來在每次 compaction 後自動撈回 compact 前的對話歷史，注入到 additionalContext。完整背景看 `README.md`。

請你依照下面步驟**自動**完成安裝。能用工具直接做的就做，遇到需要使用者確認的地方才停下來問。

---

## 0. 先確認

先問使用者**這個 repo 要裝在哪裡**（預設 `~/ContextAlign`）。以下把該絕對路徑記為 `$CAN_DIR`。

`$HOME` 下這些檔案會被 CAN 使用／建立，動手前先列給使用者看一眼：
- `~/.claude/contextalign/`（DB、socket、log、狀態檔）
- `~/.claude/statusline-command.sh`（要修改/新增第三行）
- `<project>/.mcp.json`（要新增或合併 MCP server 設定）
- `<project>/.claude/settings.local.json`（要新增或合併 hooks 設定）

---

## 1. 環境檢查

必要依賴：
```bash
node --version   # 需要 >= 22
which jq
which curl
which sqlite3
which lockf      # macOS 內建於 /usr/bin/lockf（Linux 上用 flock 替代，見第 4 步備註）
```

若 `node` 版本 <22，建議走 Homebrew：
```bash
brew install node@22
# 之後 CAN 會用 /usr/local/opt/node@22/bin/node 或 /opt/homebrew/opt/node@22/bin/node
```
找出實際 node@22 路徑並記下，以下稱 `$NODE22`。

---

## 2. 取得程式碼

如果使用者只給了 GitHub URL 還沒 clone：
```bash
git clone <url> "$CAN_DIR"
cd "$CAN_DIR"
```

如果已經 clone，直接 `cd "$CAN_DIR"`。

---

## 3. 安裝 + build

```bash
cd "$CAN_DIR"
"$NODE22" $(which npm) install     # 或直接 npm install 如果 npm 已指向 node22
"$NODE22" node_modules/typescript/bin/tsc
ls dist/index.js                    # 應該存在
```

---

## 4. 建狀態目錄 + 檢查 hook

```bash
mkdir -p "$HOME/.claude/contextalign"
chmod +x "$CAN_DIR/hooks/"*.sh
```

`hooks/prompt.sh` 會自動推斷 `SERVER` 路徑（相對 script 位置）、自動尋找 `node`。
若使用者有多版 node 且預設 `node` 不是 22，讓使用者 export：
```bash
export CAN_NODE="/usr/local/opt/node@22/bin/node"  # 或 brew 的對應路徑
```

Linux 上沒有 `lockf` 的話，把 `hooks/prompt.sh` 裡 `/usr/bin/lockf -t 0 "$LOCK" /bin/bash -c '...'` 換成：
```bash
( flock -n 9 || exit 0; ... ) 9>"$LOCK"
```

---

## 5. 設定 Claude Code — `.mcp.json`

在使用者的**專案目錄**根下（使用者會告訴你是哪個，或就是當前 `pwd`）新增/合併 `.mcp.json`：

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

如果已有 `.mcp.json`，只合併 `mcpServers.contextalign` 這一條，不要覆蓋使用者其他設定。

---

## 6. 設定 Hooks — `.claude/settings.local.json`

同一個專案目錄，建立或合併 `.claude/settings.local.json`：

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

已有 settings 就合併 `hooks` 區塊，不要覆蓋使用者其他 hooks。

---

## 7. Statusline 第三行（可選但建議）

`~/.claude/statusline-command.sh` — 如果使用者沒有這個檔案，建議直接建一個簡單版。如果有，append 一段：

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

並讓 `~/.claude/settings.json` 裡 `statusLine.command` 指向這個腳本。

---

## 8. 驗證

告訴使用者：
> 請重開一個 **新** Claude Code session（不要用 `--continue`），在當前專案目錄啟動。新 session 應該會透過 `.mcp.json` 自動啟動 MCP server。

然後你（Claude）檢查：
```bash
# 1. Server 跑了沒
pgrep -fl "ContextAlign/dist/index.js"

# 2. Socket 存在
ls "$HOME/.claude/contextalign/ctx.sock"

# 3. Log 正常（應看到 "Embedding model loaded."）
tail -20 "$HOME/.claude/contextalign/server.log"

# 4. DB 有建起來
ls -la "$HOME/.claude/contextalign/contextalign.db"
```

讓使用者隨便打一句話，然後你觀察：
- statusline 有無 `[can:UP]`（綠色）
- `~/.claude/contextalign/.alive` 檔時間有無更新

首次執行需要下載 embedding model（~1.3GB）到 `~/.cache/huggingface/`，第一次啟動要等 1–2 分鐘。

---

## 9. 常見問題

| 症狀 | 原因 | 處理 |
|---|---|---|
| `[can:DOWN]` 一直不變 | Server 沒啟動或 socket 不存在 | 看 `server.log`；檢查 `hooks/prompt.sh` 的 `NODE` / `SERVER` 路徑是否正確；手動 `$NODE22 $CAN_DIR/dist/index.js &` 試跑 |
| 每次 prompt 都 spawn 新 server | pgrep pattern 大小寫不對 | 確認 `ContextAlign`（大寫） |
| 首次回應很慢 | Embedding model 下載中 | 等 1–2 分鐘，之後從 cache 載入 ~1.2 秒 |
| `libc++abi` crash | FTS5 空 query bug（v1.7 已修）或 better-sqlite3 native 狀態被汙染 | 確認 build 的是 v1.7+ 的 dist/；重啟 server |
| Context-continuation session 沒 auto-start MCP | Claude Code 限制，只有**全新** session 才會讀 `.mcp.json` | hook self-rescue 會在下一個 prompt 自動 spawn；或手動 `$NODE22 $CAN_DIR/dist/index.js &` |

---

## 10. 完成後回報給使用者

告訴使用者：
- `$CAN_DIR` 在哪
- MCP server 的 PID
- Statusline 當前狀態（UP / RUMBLINGR / DOWN）
- 要看 log：`tail -f ~/.claude/contextalign/server.log`
- 要看狀態：`ls -la ~/.claude/contextalign/`

安裝完。
