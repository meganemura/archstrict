# Maintenance

The checks, the dependency rule, and release ownership are in [AGENTS.md](../AGENTS.md).

`npm run mutation` is the entry point. [mutation-runner.md](mutation-runner.md) describes the runner.

Stryker copies the project into a sandbox with `copyFile`. That call throws on the directory
symlinks `hooks` and `mcp`, and it would replace `.claude-plugin/plugin.json` with a regular file.
`ignorePatterns` leaves those three paths out of the copy. `test/global-setup.ts` recreates the
symlinks when they are missing, which is a no-op in a normal checkout.

The count increments in `src/rules/constraints.ts` are additions (`x = x! + 1`), not `x!++`.
The instrumenter's update-operator mutator rebuilds `++`/`--` with Babel's `updateExpression`,
and Babel 8 rejects a non-null assertion as that argument. Excluding the mutator does not help:
the mutator still runs, and the throw aborts the run before any mutant is tested.

## Node.js

archstrict analyzes with `typescript` pinned at `6.0.3`. CI (`.github/workflows/ci.yml`) runs the
`test` job and the `windows-paths` job on Node.js 22, and it probes typescript 7 (`ci:ts7-probe`)
without changing the pinned dependency. The publish workflow (`.github/workflows/publish.yml`)
requires Node.js 24.10 and npm 11.5.1 or newer before it runs `npm publish`. `package.json` sets
`engines.node` to `>=22`.

## Add a rule or a verb

Preserve the violation contract when you add a rule:

- A violation carries a rule id, `path:line:col`, the evidence, a `because` reason, and a `do:`
  command that runs, in both text and JSON output.
- A violation's text never uses the words "strict" or "typed" - a name must not mislead about what
  fixes it.
- Text output stays bounded: past a fixed count, print grouped counts with one example per group
  and a `do:` that reruns just that group. JSON output stays complete; only text output cuts.
- Point new prose at the config field that caused the violation, the same way an existing rule's
  `because` reason does, so an agent can find the one line to change.

Preserve the same contract when you add a verb:

- Support both a text and a `--json` mode, with the same field names and order the existing verbs
  use for the same concept (`do`, `error`, a per-item `path`).
- A config or missing-file failure throws so `main` in `src/cli.ts` catches it and prints
  `{ "error": "<message>", "do": "<command>" }` (or the text equivalent) - do not print a partial
  result and a stack trace instead.
- Add the verb to `AGENTS.md`'s Commands section and to the CLI usage line in `src/cli.ts`.
- Add example-based tests for exact text and JSON output, and Hegel property tests for any round
  trip, invariant, or ordering rule the verb introduces.

## Triage a bug report

Ask for the project's `archstrict.config.ts`, the `archstrict check --json` output, and the
project's `archstrict.todo.json` if one exists. The config shows which module, tag, and edge rules
apply; the JSON output shows every violation with its rule id and evidence; the todo file shows
which of those are already frozen debt rather than new failures.

Reproduce the report by running `archstrict check` against a copy of the project, or against a
minimal fixture that keeps the same module and edge shape. Compare the text and `--json` output
against what the report describes. Add the fixture as a test case when it contains no sensitive
paths or names, then add an example test for the exact output and a property test for the broken
invariant, when one exists.
