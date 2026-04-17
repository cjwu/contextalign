#!/bin/bash
# ContextAlign: UserPromptSubmit hook
# Sends prompt to MCP server, gets additionalContext back.
# Self-rescues by spawning MCP server when socket is unreachable.

BASE="$HOME/.claude/contextalign"
SOCK="$BASE/ctx.sock"
ALIVE="$BASE/.alive"
LOADING="$BASE/.loading"
LOCK="$BASE/.spawnlock"
LOG="$BASE/server.log"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/dist"
SERVER="${CAN_SERVER:-$DIST_DIR/index.js}"

# Prefer Node 22 via Homebrew (CAN needs >=18). Only fall back to $PATH if node@22 absent.
if [ -n "$CAN_NODE" ]; then
  NODE="$CAN_NODE"
elif [ -x "/opt/homebrew/opt/node@22/bin/node" ]; then
  NODE="/opt/homebrew/opt/node@22/bin/node"
elif [ -x "/usr/local/opt/node@22/bin/node" ]; then
  NODE="/usr/local/opt/node@22/bin/node"
else
  NODE="$(command -v node 2>/dev/null)"
fi

mkdir -p "$BASE"

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""')
PROMPT=$(echo "$INPUT" | jq -r '.prompt // ""')
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // ""')

if [ -z "$SESSION_ID" ] || [ -z "$PROMPT" ]; then
  exit 0
fi

PAYLOAD=$(jq -n \
  --arg type "prompt" \
  --arg sid "$SESSION_ID" \
  --arg p "$PROMPT" \
  --arg tp "$TRANSCRIPT" \
  '{type: $type, sessionId: $sid, prompt: $p, transcriptPath: $tp}')

RESPONSE=$(curl -s --max-time 5 \
  --unix-socket "$SOCK" \
  -X POST http://localhost/prompt \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" 2>/dev/null)
CURL_RC=$?

if [ $CURL_RC -eq 0 ] && [ -n "$RESPONSE" ]; then
  touch "$ALIVE"
  rm -f "$LOADING"
  CTX=$(echo "$RESPONSE" | jq -r '.additionalContext // ""')
  if [ -z "$CTX" ]; then
    exit 0
  fi
  jq -n --arg ctx "$CTX" '{
    "hookSpecificOutput": {
      "hookEventName": "UserPromptSubmit",
      "additionalContext": $ctx
    }
  }'
  exit 0
fi

# curl failed -> self-rescue
rm -f "$ALIVE"

if [ ! -x "$NODE" ] || [ ! -f "$SERVER" ]; then
  rm -f "$LOADING"
  exit 0
fi

export NODE SERVER LOG
/usr/bin/lockf -t 0 "$LOCK" /bin/bash -c '
  if ! pgrep -f "ContextAlign/dist/index.js" > /dev/null 2>&1; then
    nohup "$NODE" "$SERVER" >> "$LOG" 2>&1 </dev/null &
    disown $!
  fi
' 2>/dev/null

if pgrep -f "ContextAlign/dist/index.js" > /dev/null 2>&1; then
  touch "$LOADING"
else
  rm -f "$LOADING"
fi

exit 0
