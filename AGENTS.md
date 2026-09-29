# AGENTS.md

Context for agents that work in this repository.

## What this is

archstrict checks TypeScript module boundaries.
It is not tsc, not ESLint, and not a type checker; it is architecture linting, in the sense of ArchUnit (Java) and archspec (Ruby).
It is designed for a reader that starts from an empty context: a coding agent first, a human second.

The shape, in one paragraph.
A module is one directory, declared explicitly in config (`declaredModules`) rather than discovered by convention - a barrel `index.ts` is not evidence of an enforced boundary. A glob that names a single file is a module too: `surface` resolves against that file's parent.
A module shows the rest of the codebase one file, named by the config's own `surface` field (default one entry per analyzed source extension: `index.ts`, `index.tsx`, `index.mts`, `index.cts`); anything a module does not export from that file is private, and an import that reaches past it into the module's internals is a violation.
A module with no public-surface file present is entirely private: every external import into it is a violation.
A module's surface file can also leak an internal type it never exported by name - a property, a return type, or a generic constraint that structurally reaches past the surface - which is its own violation, distinct from an import bypassing the surface from outside.
A file can also carry tags (`classify`/`classifyByDirectoryName`, glob or ambient directory-name -> tag) independent of module membership, and a constraint engine (`edges`: `allowDeny`, `order`, `point`) checks edges between tags - the same domain/layer/plane shapes tools like dependency-cruiser and Nx's `depConstraints` express, generalized over tags instead of a fixed vocabulary.
Shape (scope, exclude, classify, declaredModules, edges, the surface file name) lives in one root file, `archstrict.config.ts`, written as a plain TypeScript value; it is never scattered per module.
A known cycle can be named as an exception (`ignoredCycles`), and a directory a project decided must hold no code at all can be declared with `mustBeEmpty` - see [skills/archstrict/references/rules.md](skills/archstrict/references/rules.md) for both.
Known violations freeze into one project-root todo file, `archstrict.todo.json`, grouped by module name, that can only shrink; a module marked `strict` in config can never accumulate a todo entry, existing or new — any entry there is itself a violation.
A violation report always carries a rule id, `path:line:col`, the evidence, the `because` reason, and a `do:` command — enough for an agent to fix its own mistake without asking.

## Layout

- `src/` is the library and CLI. The root `archstrict.config.ts` checks that tree: `core` is the analysis engine, `rules` and `verbs` are where a new rule or verb lands, and `cli`, `mcp`, and `check-options` sit above them. `archstrict.todo.json` is the ratchet. `skills/archstrict/` is the product skill shipped to consumers, not a second config.
- `test/` is the Vitest suite; `features/` is the nukadoko (Gherkin) dogfood scenario.
- `.agents/` is the canonical Claude Code plugin: the manifest, the PreToolUse and PostToolUse hooks, and the MCP server. `.claude-plugin/plugin.json` symlinks to `.agents/plugin.json`, and repo-root `hooks/` and `mcp/` symlink to `.agents/hooks` and `.agents/mcp`. `${CLAUDE_PLUGIN_ROOT}` is the directory that contains `.claude-plugin/`, so those plugin-root paths still resolve. `.claude-plugin/` stays a real directory holding only the manifest symlink: Claude loads `hooks/` from the plugin root, and a directory symlink onto `.agents/` would place `hooks/` and `mcp/` inside `.claude-plugin/`.
- `skills/archstrict/` (and root `llms.txt`) is the agent-facing skill (`SKILL.md` plus `references/`).
- `scripts/` holds standalone scripts (not part of the shipped library): the typescript 7 probe, two narrow config converters (Prisma's architecture.config.json, VS Code's code-layering table) to archstrict.config.ts's own shape, and the two runners that re-run the Prisma/VS Code oracle comparisons through the real CLI against a real clone (see Commands below). `.github/workflows/` is CI.
- `.claude-team/` holds the task spec, the report, and their working artifacts. It is gitignored; do not reference it from committed content.

## Visibility

This repository is intended for public release.
Write all committed text in English: code, comments, docs, commit messages.
Do not reference private tools, private repositories, or internal working documents (including `.claude-team/`) in committed content.
If you want to cite an internal document, write its substance in place instead.

## Rules

- Do not add dependencies without the owner's approval. Pin exact versions, at least 7 days past release. Prefer language-official packages, then vendor packages, and avoid single-maintainer packages.
- Write tests with Hegel (`@hegeldev/hegel`, property-based) wherever a property exists: round trips, invariants, monotonicity. Example-based tests cover exact CLI output and JSON shape.
- Comments say why: the constraint, or the alternative that was refused. Each module starts with its responsibility and its boundary.
- Violation text never uses the words "strict" or "typed"; a name must not mislead about what fixes a violation.
- A release, a `npm publish`, or a change of the repository's visibility is the owner's to run.

## Commands

For working on archstrict itself:

- `npm run build` — compile `src/` to `dist/`. The CLI's own tests spawn the built `dist/cli.js`, so run this before `npm test` if `dist/` is missing or stale.
- `node dist/cli.js check` — checks this repository against the root `archstrict.config.ts`. `node dist/cli.js todo` prunes `archstrict.todo.json` after the first run and does not add debt again.
- `npm run typecheck` — `tsc --noEmit` over the whole project.
- `npm test` — the Vitest suite.
- `npm run dogfood:nukadoko` — a nukadoko (Gherkin) scenario that runs the built CLI's full init/check/todo/edit/check round trip against nukadoko's own published `src/` (a real, unrelated codebase with no public-surface convention), copied into a disposable scratch directory. Never modifies the real nukadoko package or a checkout of it.
- `npm run ci:ts7-probe` — measures, against whatever typescript 7 happens to be installed, which of the operations rule 6 needs actually work on typescript 7's `./unstable/*` surface. Never fails: an unsupported operation is the measurement, not an error. archstrict itself always analyzes with its own pinned `typescript` dependency (6.0.3), independent of this. CI (`.github/workflows/ci.yml`) installs `typescript@7.0.2` (`--no-save`, never touching `package.json`) just for this job.
- `node scripts/run-prisma-oracle.mjs <path-to-a-real-prisma/prisma-clone>` / `node scripts/run-vscode-oracle.mjs <path-to-a-real-microsoft/vscode-clone>` — re-run the Prisma/VS Code oracle comparisons through the real, built CLI (`dist/cli.js check --json`) against a scratch copy of the clone, converting its own real config (`architecture.config.json` / the `code-layering` ESLint rule's table) with the existing `scripts/convert-*` converters. Requires a local clone (`ghq get --shallow` or equivalent); the Prisma one also needs `pnpm install` run in it once, for its own real `node_modules`. Neither ever writes into the clone itself. Each prints a positive-control run (a rule deliberately forbidding something real and common) alongside the baseline, so a `0` in the baseline reads as a genuine pass, not the constraint engine silently seeing no edges at all.

The CLI itself:

- `archstrict init [dir] [--json]` — on a fresh project, declare one module per top-level directory holding TypeScript source (`.ts`, `.tsx`, `.mts`, `.cts`; default container `src/`, or the project root when it's absent or holds none) and one single-file module per loose top-level source file, so the first `check` covers every analyzed file by construction. That map is an inventory: group files that change together (`glob` may be an array of paths in one directory), split a directory that holds almost every file, then add `edges`. `archstrict recommend` names a mega-module and a file-per-module inventory in `mapNotes`. Write `archstrict.types.ts` (the module-name union type). Re-run any time; it never touches an existing `archstrict.config.ts`, only regenerates `archstrict.types.ts` from its own `declaredModules` names. `--json` prints one object (`configPath`, `typesPath`, `configWritten`, `opened`, `moduleNames`, `hiddenDirs`, `noiseDirs`, `testFileExcludes`, `uncovered`, `notes`, `do`), or `{ "error": "<message>", "do": "<command>" }` on failure, the same convention `check` and `todo` follow.
- `archstrict check [file] [--json] [--rule <id>] [--module <name>] [--frozen]` — analyze the whole project and report violations. With a file argument, analysis still covers the whole project (resolving an edge needs it), but the report is scoped to that file's own violations. Text output prints every violation up to 20; past that it prints grouped counts (by rule, then by the module owning the todo) with one full example per group and a `do:` that reruns just that group, cut at a line-count cap with a count of the groups left out. `--rule`/`--module` are repeatable and filter both the text and `--json` output after analysis; the exit code reflects the filtered set once either is given. An unknown rule id or module name is an error listing the valid ones. `--frozen` includes todo-matched violations too, each marked `frozen: true` and still combinable with `--rule`/`--module`; the exit code ignores a frozen violation, so a project already covered by `archstrict todo` still exits 0. When most public-surface-bypass violations target modules with no surface file at all, the summary says so and offers freezing, naming a surface, or adding surface files as next steps.
- `archstrict todo [--json]` — on a project's first run, freeze every current freezable violation into one project-root `archstrict.todo.json`, grouped by module name; on every later run, only prune entries that no longer match a current violation. Never adds after the first run. That file's own existence is the "first run happened" signal, replacing an earlier marker file; a project with no debt after its first run still gets the file, with an empty module map, so the ratchet stays visible. The first run refuses instead (exit 1, no file written) while any `uncovered-module` violation exists, since such a file can never be frozen and a later declared-and-covered version of it would then find freezing already closed forever; a later, prune-only run is unaffected. `--json` prints `{ firstRun, added, pruned }`, or `{ "error": "<message>" }` on a config error, the same convention `check` follows.

- `archstrict hotspots [--since <git ref or date>] [--json]` — report commits, changed lines, fan-in, fan-out, frozen debt, active violations, and a commits-times-fan-in score per module. It also reports co-change counts and both directional shares for module pairs. Text output is limited to ten modules and ten pairs; JSON contains all results.

- `archstrict simulate [--json] [--whole-project]` — preview proposed source or config changes without writing to disk. The default report is scoped to changed files; `--whole-project` reports the complete project delta. Read the JSON change set from stdin; see [simulation](skills/archstrict/references/simulate.md).

## Claude Code plugin

This repository is itself a Claude Code plugin (`.claude-plugin/plugin.json`, a symlink to `.agents/plugin.json`). It ships two hooks around every Edit/Write/MultiEdit, both shelling out to the edited project's own `node_modules/.bin/archstrict`, never to this repository's own build. Its `PreToolUse` hook (`.agents/hooks/pre-tool-use.mjs`, reached as `hooks/pre-tool-use.mjs`) runs before the write happens: it builds the file text the tool call would produce and previews it through that project's `archstrict simulate --json`, returning any added violation into the agent's own context so it can change course before the write lands, or denying the tool call outright when `ARCHSTRICT_PRETOOLUSE=deny` is set. Its `PostToolUse` hook (`.agents/hooks/post-tool-use.mjs`, reached as `hooks/post-tool-use.mjs`) runs the edited project's own installed `archstrict check <file>` right after the write and returns any violation into the agent's own context - the same moment a human editor's red squiggly would appear. Both say nothing when the edited project has no `archstrict` installed at all or the edited file has no violation; see [the hook reference](skills/archstrict/references/hook.md) for the full set of silent cases. The MCP server is `.agents/mcp/server.mjs`, reached as `${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs`. `npm pack` ships `.agents/` and drops the symlinks, so an installed package's hooks are `node_modules/archstrict/.agents/hooks/pre-tool-use.mjs` and `post-tool-use.mjs`.


<!-- ARCHSTRICT_START -->
## archstrict

In projects with an `archstrict.config.ts` (module-boundary/architecture linting), run `archstrict rules <path>` BEFORE creating a file or adding an import - it reports the module, tags, and constraints that would govern that path, even before it exists. Run `archstrict check` after editing to confirm.

The full rule reference (every rule's evidence/because/do shape, the config schema, the pre-edit query) is at `node_modules/archstrict/skills/archstrict/SKILL.md` when installed via npm - read it before configuring `archstrict.config.ts`, or when a violation's `do:` text alone isn't enough.

If there is no `archstrict.config.ts`, skip archstrict entirely - it may not be installed here.
<!-- ARCHSTRICT_END -->
