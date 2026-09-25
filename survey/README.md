# Import-graph survey

Measures which dependency-boundary patterns popular TypeScript repositories keep in their real import graph, whether or not they declare any boundary config.

Nothing from an analyzed repository is ever installed, built, or run. Each one is cloned with `--depth 1` into a scratch directory, parsed with archstrict's own graph builder (the TypeScript compiler API), and deleted.

## Run

```sh
npm ci && npm run build          # archstrict itself; the scripts import dist/
survey/run.sh                    # fetch the top 200 with gh api, measure the first 50 that qualify
node survey/aggregate.mjs        # survey-out/report.md and survey-out/summary.json
node survey/followup.mjs         # survey-out/followup.md and followup.json (after aggregate)
```

- `survey/run.sh <list-file>` measures from an existing list (one `owner/repo` per line, in star order) instead of fetching one.
- `survey/remeasure.sh <owner/repo> <sha> [timeout-seconds]` re-measures one repository at a recorded commit, for example after an analyzer fix or with a longer time limit. The aggregator uses the last log line for each repository.
- `SURVEY_STAGE_LOG=<file>` makes `analyze.mjs` append one line per finished stage with its time and memory, written synchronously so a run killed for memory still shows the last stage it finished.
- `SURVEY_SAMPLE_SIZE` (default 50) and `SURVEY_WORK` (default `/tmp/survey`) override the defaults.

## Files

- `analyze.mjs`: measures one clone and writes `survey-out/<owner>__<repo>.json`. It writes into the clone only `node_modules/<workspace-name>` symlinks and a throwaway `archstrict.config.ts`.
- `run.sh`: walks the list in order, records each skip with its reason (a fixed list of non-codebase repositories, or fewer than 50 `.ts` files), and appends every outcome to `survey-out/_log.jsonl`.
- `declared.mjs`: flags root-level config files that hold import-restriction rules, by content rather than by file name. A flag is a lead to read by hand, not a verdict: rules that restrict only third-party packages match too. The hand reading goes in `survey-out/declared-verified.json`, which the aggregator uses when present.
- `aggregate.mjs`: applies the pattern thresholds (stated in the report) and writes the report.
- `followup.mjs`: four follow-up tables over the same sample: public-surface bypasses by test naming convention and test colocation, two-module cycles with edge counts each way, size against time and peak memory per stage, and a `.tsx` import baseline.
- `rss-on-exit.cjs`: preloaded into the `archstrict check` child so it reports its own peak memory.
- `top200-<date>.txt`: the list a run used.

Per-repository JSON records the measured projects' own package and directory names as they are; some of those names contain the name of a lint tool. Replace them before publishing if the output must name no tool.
