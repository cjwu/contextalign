#!/usr/bin/env bash
# Claude Code multi-line status line script

input=$(cat)

# Line 1: current directory only
cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // empty')
[ -z "$cwd" ] && cwd="$(pwd)"

# Line 2: model, context usage, and rate limits
model=$(echo "$input" | jq -r '.model.display_name // empty')
used_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
five_hour=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
seven_day=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')

# Build context info
ctx_info=""
if [ -n "$used_pct" ]; then
  ctx_info="ctx:$(printf '%.0f' "$used_pct")%"
fi

# Build rate limit info
rate_info=""
if [ -n "$five_hour" ]; then
  rate_info="5h:$(printf '%.0f' "$five_hour")%"
fi
if [ -n "$seven_day" ]; then
  [ -n "$rate_info" ] && rate_info="$rate_info "
  rate_info="${rate_info}7d:$(printf '%.0f' "$seven_day")%"
fi

# Build line 2 segments
line2=""
[ -n "$model" ] && line2="$model"
[ -n "$ctx_info" ] && line2="$line2 | $ctx_info"
[ -n "$rate_info" ] && line2="$line2 | $rate_info"

# Line 3: ContextAlign status + ctx warning (merged)
if [ -f "$HOME/.claude/contextalign/.alive" ]; then
  can_state="can:UP"
  line3_color="\033[0;32m"
elif [ -f "$HOME/.claude/contextalign/.loading" ]; then
  can_state="can:RUMBLINGR"
  line3_color="\033[0;33m"
else
  can_state="can:DOWN"
  line3_color="\033[0;31m"
fi

ctx_warn=""
if [ -n "$used_pct" ]; then
  pct_int=$(printf '%.0f' "$used_pct")
  if [ "$pct_int" -gt 30 ]; then
    ctx_warn=" | ctx:${pct_int}%, compact ctx"
    line3_color="\033[0;31m"   # override to red when warning present
  fi
fi

# Hallucination risk nudge (v1.9.9). File content is "N/M" (unmatched/total anchors).
# Severity = N*100/M. Flag fires only when severity>=40%; colour yellow in
# [40,70) and red at >=70.
# mtime freshness: if flag is >60s old, treat as stale. This guards against
# cases where UserPromptSubmit cleared the file but statusline hasn't re-
# rendered yet; eventual refresh self-heals within a minute.
halluc_warn=""
flag_file="$HOME/.claude/contextalign/.hallucination_risk"
if [ -f "$flag_file" ]; then
  mtime=$(stat -f %m "$flag_file" 2>/dev/null)
  now=$(date +%s)
  age=$((now - mtime))
  if [ -n "$mtime" ] && [ "$age" -lt 60 ]; then
    risk=$(cat "$flag_file" 2>/dev/null)
  else
    risk=""
  fi
  if [ -n "$risk" ]; then
    halluc_warn=" | hallucination risk ${risk} unverified, pls challenge claude"
    n=$(echo "$risk" | cut -d/ -f1)
    m=$(echo "$risk" | cut -d/ -f2)
    if [ -n "$n" ] && [ -n "$m" ] && [ "$m" -gt 0 ] 2>/dev/null; then
      sev=$((n * 100 / m))
      if [ "$sev" -ge 70 ]; then
        line3_color="\033[0;31m"   # red
      else
        line3_color="\033[0;33m"   # yellow (default flag tier)
      fi
    else
      line3_color="\033[0;33m"
    fi
  fi
fi

line3="[${can_state}${ctx_warn}${halluc_warn}]"

# Output multi-line status
printf "\033[0;34m%s\033[0m" "$cwd"
if [ -n "$line2" ]; then
  printf "\n\033[0;33m%s\033[0m" "$line2"
fi
printf "\n${line3_color}%s\033[0m" "$line3"
