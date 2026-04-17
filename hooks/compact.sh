#!/bin/bash
# ContextAlign: PostCompact hook
# Records compact timestamp
SOCK="$HOME/.claude/contextalign/ctx.sock"
INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

if [ -z "$SESSION_ID" ]; then
  exit 0
fi

curl -s --max-time 3 \
  --unix-socket "$SOCK" \
  -X POST http://localhost/compact \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"compact\",\"sessionId\":\"$SESSION_ID\",\"timestamp\":\"$TIMESTAMP\"}" \
  >/dev/null 2>&1

exit 0
