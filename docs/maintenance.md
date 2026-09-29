# Maintenance

## Checks

Run the main checks before a release or after a code change:

```sh
npm run build
npm run typecheck
npm test
```

Run the dogfood scenario and the oracle comparisons separately:

```sh
npm run dogfood:nukadoko
node scripts/run-prisma-oracle.mjs <path-to-a-real-prisma/prisma-clone>
node scripts/run-vscode-oracle.mjs <path-to-a-real-microsoft/vscode-clone>
```

`dogfood:nukadoko` runs the built CLI's full init/check/todo/edit/check round trip against a real,
unrelated published `src/` copied into a disposable scratch directory. The two oracle scripts
re-run the Prisma and VS Code boundary-config comparisons through the real, built CLI against a
scratch copy of a local clone, converting each project's own real config with the existing
`scripts/convert-*` converters. Neither writes into the clone itself. See
[AGENTS.md](../AGENTS.md)'s Commands section for what each requires (a local clone, `pnpm install`
for the Prisma one) and what each prints.

After `npm run build`, `node dist/cli.js check` analyzes this repository's own `src/` with the root
`archstrict.config.ts`. A clean run exits 0. `node dist/cli.js todo` creates `archstrict.todo.json`
on the first run and only prunes it afterward. Modules named in that config's `strict` list cannot
take on frozen debt. The skill under `skills/archstrict/` is what the package ships; it is not a
second copy of this config.

`npm run ci:ts7-probe` measures which of the operations rule 6 needs work on whatever typescript 7
happens to be installed. It never fails; an unsupported operation is the measurement, not an error.
archstrict itself always analyzes with its own pinned `typescript` dependency, independent of this
probe.

## Dependencies and Node.js

Do not add a dependency without the owner's approval. Pin every dependency to an exact version.
Wait at least seven days after a version is released before adding it, and check that no newer
security release replaces it. Prefer language-official packages, then vendor packages, and avoid
single-maintainer packages.

archstrict analyzes with `typescript` pinned at `6.0.3`. CI (`.github/workflows/ci.yml`) runs the
main job on Node.js 22 and separately probes typescript 7 (`ci:ts7-probe`) without changing the
pinned dependency. The publish workflow (`.github/workflows/publish.yml`) requires Node.js 24.10
and npm 11.5.1 or newer before it runs `npm publish`. `package.json` currently declares no
`engines` field; adding one, and which Node.js versions it should name, is the owner's call.

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
