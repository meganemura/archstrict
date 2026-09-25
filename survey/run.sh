#!/usr/bin/env bash
# Walks survey/top200.txt in star order: skip by stated reason or by .ts
# count, measure until 50 are measured. Never runs anything from a clone.
#
# usage: survey/run.sh [list-file]
#   With no list file, fetches the top 200 by stars with `gh api` into
#   survey/top200-<date>.txt first. SURVEY_SAMPLE_SIZE (default 50) and
#   SURVEY_WORK (default /tmp/survey) override the defaults.
set -u
HERE=$(cd "$(dirname "$0")" && pwd); OUT="$HERE/../survey-out"; WORK=${SURVEY_WORK:-/tmp/survey}
SAMPLE=${SURVEY_SAMPLE_SIZE:-50}
mkdir -p "$OUT" "$WORK"; LOG="$OUT/_log.jsonl"; touch "$LOG"
LIST=${1:-}
if [ -z "$LIST" ]; then
  LIST="$HERE/top200-$(date +%F).txt"
  if [ ! -s "$LIST" ]; then
    : > "$LIST"
    for page in 1 2; do
      gh api -X GET search/repositories -f q='language:TypeScript stars:>5000' -f sort=stars -f order=desc \
        -f per_page=100 -f page=$page --jq '.items[].full_name' >> "$LIST" || { echo "gh api failed" >&2; exit 1; }
    done
  fi
fi
declare -A SKIP=(
  [yangshun/tech-interview-handbook]="study-guide content site (tutorial)"
  [iptv-org/iptv]="playlist collection (list)"
  [realworld-apps/realworld]="spec and reference for tutorial demo apps (tutorial)"
  [DefinitelyTyped/DefinitelyTyped]="type-definition collection"
  [justjavac/wechat-miniapp-radar]="curated list (list)"
  [type-challenges/type-challenges]="type exercise collection (tutorial)"
  [typescript-cheatsheets/react]="cheatsheet docs (tutorial)"
  [fastapi/full-stack-fastapi-template]="starter template (tutorial)"
  [JCodesMore/ai-website-cloner-template]="starter template (tutorial)"
  [alan2207/bulletproof-react]="architecture example app (tutorial)"
)
measured=$(grep -c '"status": *"measured"' "$LOG" || true)
while read -r repo; do
  [ "$measured" -ge "$SAMPLE" ] && break
  grep -q "\"repo\": *\"$repo\"" "$LOG" && continue
  key=${repo/\//__}; dir="$WORK/$key"
  if [ -n "${SKIP[$repo]:-}" ]; then
    echo "{\"repo\": \"$repo\", \"status\": \"skipped\", \"reason\": \"${SKIP[$repo]}\"}" >> "$LOG"; continue
  fi
  rm -rf "$dir"; t0=$(date +%s)
  if ! GIT_LFS_SKIP_SMUDGE=1 timeout 900 git clone -q --depth 1 "https://github.com/$repo" "$dir" 2>"$WORK/clone.err"; then
    echo "{\"repo\": \"$repo\", \"status\": \"error\", \"reason\": \"clone failed: $(tail -1 "$WORK/clone.err" | tr '"' "'")\"}" >> "$LOG"; rm -rf "$dir"; continue
  fi
  sha=$(git -C "$dir" rev-parse HEAD)
  nts=$(find "$dir" \( -name node_modules -o -name dist -o -name .git \) -prune -o -type f -name '*.ts' ! -name '*.d.ts' -print | wc -l)
  ntsx=$(find "$dir" \( -name node_modules -o -name dist -o -name .git \) -prune -o -type f -name '*.tsx' -print | wc -l)
  if [ "$nts" -lt 50 ]; then
    echo "{\"repo\": \"$repo\", \"status\": \"skipped\", \"reason\": \"fewer than 50 .ts files ($nts .ts, $ntsx .tsx)\", \"sha\": \"$sha\"}" >> "$LOG"; rm -rf "$dir"; continue
  fi
  if timeout 900 node --max-old-space-size=12000 "$HERE/analyze.mjs" "$dir" "$repo" "$OUT/$key.json" > "$WORK/an.out" 2> "$WORK/an.err"; then
    measured=$((measured+1))
    echo "{\"repo\": \"$repo\", \"status\": \"measured\", \"sha\": \"$sha\", \"ts\": $nts, \"tsx\": $ntsx, \"seconds\": $(( $(date +%s)-t0 ))}" >> "$LOG"
  else
    rc=$?; why=$([ $rc -eq 124 ] && echo "timeout after 900s" || tail -c 300 "$WORK/an.err" | tr '\n"' "  ")
    echo "{\"repo\": \"$repo\", \"status\": \"error\", \"reason\": \"analysis: $why\", \"sha\": \"$sha\", \"ts\": $nts, \"tsx\": $ntsx}" >> "$LOG"
  fi
  rm -rf "$dir"
  echo "$(date +%T) $repo done ($measured measured)"
done < "$LIST"
echo "finished: $measured measured"
