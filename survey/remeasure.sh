#!/usr/bin/env bash
# Re-measures one repository at a recorded commit (after an analyzer fix, or
# with a longer time limit) and appends its outcome to the log; the
# aggregator takes the last line per repository.
# usage: survey/remeasure.sh <owner/repo> <sha> [timeout-seconds]
set -u
repo=$1; sha=$2; limit=${3:-900}
HERE=$(cd "$(dirname "$0")" && pwd); OUT="$HERE/../survey-out"; WORK=/tmp/survey
key=${repo/\//__}; dir="$WORK/$key"; rm -rf "$dir"; mkdir -p "$dir"; t0=$(date +%s)
git -C "$dir" init -q && git -C "$dir" remote add origin "https://github.com/$repo" &&
  GIT_LFS_SKIP_SMUDGE=1 timeout 900 git -C "$dir" fetch -q --depth 1 origin "$sha" && git -C "$dir" -c advice.detachedHead=false checkout -q FETCH_HEAD || {
  echo "{\"repo\": \"$repo\", \"status\": \"error\", \"reason\": \"fetch of $sha failed\", \"sha\": \"$sha\"}" >> "$OUT/_log.jsonl"; rm -rf "$dir"; exit 1; }
nts=$(find "$dir" \( -name node_modules -o -name dist -o -name .git \) -prune -o -type f -name '*.ts' ! -name '*.d.ts' -print | wc -l)
ntsx=$(find "$dir" \( -name node_modules -o -name dist -o -name .git \) -prune -o -type f -name '*.tsx' -print | wc -l)
if timeout "$limit" node --max-old-space-size=12000 "$HERE/analyze.mjs" "$dir" "$repo" "$OUT/$key.json" > "$WORK/an.out" 2> "$WORK/an.err"; then
  echo "{\"repo\": \"$repo\", \"status\": \"measured\", \"sha\": \"$sha\", \"ts\": $nts, \"tsx\": $ntsx, \"seconds\": $(( $(date +%s)-t0 )), \"note\": \"re-measured, limit ${limit}s\"}" >> "$OUT/_log.jsonl"
else
  rc=$?; why=$([ $rc -eq 124 ] && echo "timeout after ${limit}s" || tail -c 300 "$WORK/an.err" | tr '\n"' "  ")
  echo "{\"repo\": \"$repo\", \"status\": \"error\", \"reason\": \"analysis: $why\", \"sha\": \"$sha\", \"ts\": $nts, \"tsx\": $ntsx, \"note\": \"re-measured\"}" >> "$OUT/_log.jsonl"
fi
rm -rf "$dir"; echo "$repo done"
