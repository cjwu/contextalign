#!/bin/bash
# ContextAlign: PostToolUse hook
# Triggers async indexing of new tool metadata
SOCK="$HOME/.claude/contextalign/ctx.sock"
INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""')
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // ""')

if [ -z "$SESSION_ID" ] || [ -z "$TRANSCRIPT" ]; then
  exit 0
fi

curl -s --max-time 3 \
  --unix-socket "$SOCK" \
  -X POST http://localhost/tool_use \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"tool_use\",\"sessionId\":\"$SESSION_ID\",\"transcriptPath\":\"$TRANSCRIPT\"}" \
  >/dev/null 2>&1

exit 0
