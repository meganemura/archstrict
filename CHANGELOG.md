# Changelog

The format follows Keep a Changelog, and the versions follow SemVer. Before 1.0, a minor version
may change commands, flags, config, or output shape. The version entry will describe each change.

## Unreleased

### Added

- `archstrict diagram` draws `archstrict.config.ts` as a Mermaid flowchart on stdout. The first unscoped `order` rule becomes the layout: one box per layer, highest first, holding the modules whose files all carry that tag. A tag, glob, or tag predicate that a rule names becomes a dashed pill that lists the modules holding a matching file, with `(n/m files)` when only part of a module matches. `pkg:` targets become red hexagons. `deny` and `point` draw red dashed arrows, `allow` draws green ones, and `exceptions`, `ignoredCycles`, `deprecated`, and `mustBeEmpty` each have their own look. A rule's `edgeType` or `importForm` other than `both` always shows on its label. `--format markdown` adds a heading, a legend table, and the facts the arrows cannot carry. `--detail names|rules|reasons`, `--direction TB|BT|LR|RL`, and `--focus <module>` change what is drawn, and `--json` prints the document with its nodes and links. The verb reads file names, builds no import graph, and writes nothing. See `skills/archstrict/references/diagram.md`.
- `archstrict --help`, `-h`, and `help` print one usage table and exit 0 without running a verb. `archstrict <verb> --help` prints that verb's line. `init`, `todo`, `fix`, and `agents` are marked `[writes files]`. An unknown verb prints the table and exits 1. A failure without its own `do` uses `archstrict <verb> --help`.

### Changed

- The CLI imports a verb only when that verb runs. `--help`, an unknown verb, and a usage error no longer load the TypeScript compiler or the MCP SDK, so `archstrict --help` takes about 40 ms instead of about 0.5 s.
- The MCP `check` tool accepts optional `rule` and `module` arguments and filters with the same rule and module check as `archstrict check`. Past 20 violations it returns each shown group's count, one example, and the `do:` that reruns that group. Groups the text report cuts stay as counts, with the `do:` for the largest remaining group.
- The package-files test runs `npm pack --dry-run --ignore-scripts` once per file. `prepare` is `npm run build`, and that flag keeps the pack from rebuilding `dist/`. CI no longer runs `npm run build` after `npm ci`. The Windows job's `node dist/cli.js check` depends on `prepare` having run under `npm ci`. The packed list must not contain a path under `.agents/skills/`.
- `npm run typecheck` includes `src`, `test`, `scripts`, `features`, and root `*.ts`. It checks TypeScript files in those paths. `scripts` holds `.mjs` files only, which `tsc` skips. `test/fixtures` is excluded, except a fixture a test imports.
- The CI test job runs `npm run dogfood:nukadoko` after `npm test`.
- CI pins `actions/checkout` at v7.0.1 and `actions/setup-node` at v7.0.0, the same commits as the publish workflow. Each `setup-node` step sets `package-manager-cache: false`, so the job does not write an npm cache.
- A version bump in `package.json` that lands on `main` now starts the publish workflow. The workflow publishes to npm after the `publish` environment approves the run, then creates the `v*` tag and the GitHub release. Nobody pushes a release tag by hand.
- The TypeScript 7 probe job sets `continue-on-error: true`. A failed install or a version guard in that job stays visible on the job, and the workflow run stays successful.
- Run `archstrict init` again after upgrading archstrict. `archstrict.types.ts` says to do that after an upgrade, and after adding, removing, or renaming a `declaredModules` entry.
- `Config.scope` stays on the type and is reserved. Nothing reads it. Set `exclude` to leave files out of analysis. `archstrict init` writes that sentence on the generated type, and the Prisma and VS Code converters no longer emit `scope`.
- `archstrict check <file>` and `archstrict simulate` print one `note:` line when that file is excluded, outside the project, or not analyzed. `--json` and the exit code stay the same, so the PostToolUse hook stays silent. `archstrict fix` on a missing file exits 1 and reports `no such file`, the same failure `archstrict check` reports for a missing file.
- The section `archstrict agents` writes says to run `npx archstrict rules <path>` and `npx archstrict check`. The skill says the CLI runs as `npx archstrict <verb>` and that a `do:` line leaves out the `npx` prefix.
- `archstrict check` prints each footer `do:` once, with the next action first. The `archstrict todo` line says that the first run freezes once. `--json` `nextSteps` lists those same lines.
- An unknown `--rule` or `--module` value sets `do:` to the same `archstrict check` command without that filter. With no git history, `archstrict hotspots` points `do:` at the module with the most active violations, or says to run inside a git repository. `archstrict init --json` says to add each declare line to `declaredModules`.

### Removed

- `archstrict check` and `archstrict todo` no longer match a `public-surface-bypass` entry that omits `specifier` and `target`. Every published version writes both. An entry without them is stale and does not suppress the violation.
- `archstrict check` and `archstrict todo` no longer read the pre-release per-module todo files or the `.archstrict-todo-initialized` marker. Frozen debt lives only in the project-root `archstrict.todo.json`. No published version wrote that layout.

### Fixed

- `archstrict recommend` adds its proposed `classify` entries to the config's own instead of listing them beside it. Before, a proposed entry with the same glob as an existing one, such as an exact entry for a single-file module, made recommend fail with an equally-specific classify error that `check` never reports, and a broader existing entry took the proposed tag away from the files it covers. The fragment now shows each changed or new entry with the config's tags and the proposed tag together, and `addedViolations` is measured on that combined `classify`.
- `archstrict recommend` leaves a module with no edge to another module out of the `layered-order` proposal and names it on a `left out` evidence line. Before, the topological sort placed such a module in the order by name, so the proposal read as if real edges put it there. A module whose only edges are a balanced pair stays in the order.
- `archstrict recommend` counts the edges of a balanced pair, two modules with the same edge count each way, in the `layered-order` support, and names the pair on its own evidence line. Before, support left those edges out and could read 100% beside added violations, because whichever way the order places the pair, one direction's edges break it.
- `node:sqlite`, `node:test`, `node:sea`, and `node:test/reporters` are builtin edges. `check` counted them as unresolved specifiers, because Node lists these scheme-only builtins only with the `node:` prefix. A bare `sqlite` still resolves as a package.
- `archstrict todo` accepted any argument and ran its first-run freeze for `todo --dry-run`, writing `archstrict.todo.json`. An argument other than `--json` is now an error (`unknown option`), and nothing is written.

## 0.3.0 (2026-10-10)

### Changed

- `archstrict todo`'s first run names the uncovered files when it refuses. The message lists the first three project-relative paths, then a count of the rest. Its `do:` is `archstrict check --rule uncovered-module`.
- A missing `archstrict.config.ts` names the nearest ancestor directory that has one, and its `do:` is `cd <that directory> && archstrict <verb>`. A directory with no config in any ancestor still says `do: archstrict init`.
- A `cycle` violation's `config` pointer names the declared module that governs the cycle. It no longer points at `ignoredCycles`. That field is a suppression, and the cycle `do:` does not edit it.
- A `type-leak` `do:` ends with `or run archstrict fix` when the leaked type is already exported from the file that declares it. That is the leak `archstrict fix` re-exports in one step. A declaration that file does not export keeps the earlier text.
- `archstrict recommend` prints each pattern proposal's config fragment in text output, under that proposal's evidence. The `do:` line says to paste the fragment into `archstrict.config.ts` before `archstrict simulate`.
- The MCP check tool appends a ReportError `do:` line to the tool error.
- Each MCP input property has one sentence. Simulate content is the full file text, or null to delete the file. Check and rules paths are project-relative, and rules accepts a path that does not exist yet.
- When archstrict is not installed, the plugin MCP stub says so in its initialize instructions and names `npm install -D archstrict`. The README states that case.
- A `public-surface-bypass` `do:` is built from paths that exist. When a surface file is present, it names that file and the imported file, and says to add the export there first if it is missing. When none is present, it names the surface file to add (`index.ts` when that name is configured) and the imported file, and offers `surface: "<file>"` on that module as the other fix. A single-file module with no surface file still says to set `surface` to that file.

### Fixed

- Both edit hooks find the project by walking up from the edited file to the nearest `archstrict.config.ts`, and run that directory's `node_modules/.bin/archstrict` from that directory. A hook `cwd` inside the project, including after `cd` and inside a git worktree, still reports the edited file. A nested package is checked with its own config. No config, or a missing binary beside that config, prints `{}`. PostToolUse also prints `{}` and exits 0 when the binary's output is not JSON.
- A change set that contains `archstrict.config.ts` previews in whole-project mode without `--whole-project`. A source-only change stays scoped. The MCP simulate tool uses the same choice. `archstrict.config.ts` matches the PreToolUse hook's extension filter, so that preview runs inside the hook's existing time budget.
- The Prisma and VS Code config converters now start when an absolute path reaches them through a symlink. `fileURLToPath(import.meta.url)` names the real file, and `process.argv[1]` can keep the symlink path. The check still accepts an argv string that already equals that file, and it also accepts `realpath` of argv.
- `archstrict check <dir>` reports a type leak at a surface file inside that directory, and exits 1 when that leak blocks. `archstrict check <file>` still reports a type leak only when that file is a module surface.
- `archstrict check <dir>` reports each violation whose path is that directory or a file inside it, and exits 1 when any of them block. `archstrict check <file>` still reports only that file.
- `archstrict simulate` no longer writes `node_modules/.cache/archstrict` when it builds the baseline graph. A preview stays off disk. The files it used to create are `edges.json`, `augmentations.json`, and the edge shards.
- The default PreToolUse hook no longer returns `permissionDecision` `"allow"` when an edit would add a violation. It still returns `hookEventName` and `additionalContext`, so the preview sits next to the tool result and the edit keeps the normal permission prompt. `ARCHSTRICT_PRETOOLUSE=deny` still denies the tool call before the write.
- The Prisma and VS Code config converters now start when their own path contains a space. The run-as-main check compared a URL pathname with `process.argv[1]`. A pathname percent-encodes a space, and on Windows it starts with `/C:/`. The check uses `fileURLToPath`.

## 0.2.1 (2026-10-04)

### Fixed

- On Windows, `archstrict check` reported every import into a module as `public-surface-bypass`. This included imports of the module's own surface file. Walk paths used backslashes. TypeScript's resolved paths use forward slashes. Every path in the graph now uses the TypeScript spelling. CI runs the check on Windows.

## 0.2.0 (2026-10-01)

### Added

- This repository includes `.claude-plugin/marketplace.json`. Claude Code users can install the plugin with `/plugin marketplace add meganemura/archstrict` and `/plugin install archstrict@archstrict`.
- `declaredModules[].glob` accepts an array of paths that share one directory, so a flat directory can name a multi-file seam without a directory move. Surface and friends resolve against that directory. The type-leak boundary is each listed file. Paths in two directories, and an empty array, are config errors.
- `archstrict init` prints that the generated map is an inventory. A container of only files is told to group seams with a glob array. A directory that holds at least four fifths of the files (and at least eight) is named so it can be split before `archstrict todo`.
- `archstrict recommend` adds `mapNotes` (`mega-module`, `file-per-module`). A surface proposal for the mega-module says to split it before freezing its bypasses.
- `archstrict check` and `archstrict todo` name the case where one module holds most analyzed files and most public-surface bypasses, including bypasses a todo file already suppresses. The next command is to split that module before freezing more. `check <file>` leaves the note out.
- While the config has no `edges` rule, a whole-project `check` prints one `summary:` line: the
  config so far freezes today's import graph, not a target architecture. Its `do:` lines name
  `archstrict recommend`, `archstrict hotspots`, and the rearchitect reference. `--json` carries
  the same text as `nextSteps`. `check <file>` leaves it out.
- A cycle between two modules now names the imports on each side and two moves in its `do:`:
  extract the shared part into a leaf module both import, or pass the dependency in from the side
  that owns it, and run `archstrict simulate` on the planned change first. A lopsided pair still
  names its minority imports first. A cycle of three or more modules keeps the earlier text.
- A `type-leak` `do:` now tells two cases apart. A type this module owns needs only a name on this
  surface. A type owned by another module with no surface needs a surface on that module, or the
  exposing export must leave this surface.

### Changed

- Every verb that walks the project (`init`, `check`, `todo`, `simulate`, `hotspots`, `recommend`)
  now skips gitignored paths. archstrict reads the root and nested `.gitignore` files, the ones
  above the project root, and the repository's `info/exclude` with git's own pattern rules, and
  never runs git. A local scratch directory such as `tmp/` no longer floods `check` with
  `uncovered-module` violations. A gitignored file stays resolvable as an import target. A config
  that already declares a module inside a gitignored directory keeps analyzing that module; remove
  the declaration to drop it.

### Documentation

- The skill, recommend reference, and re-architecture notes tell an adopter to treat `init` as an inventory, to split a mega-module before freezing it, to group a flat directory with a `glob` array, to install the skill once per user, and where a CLI and a graph helper sit.
- The README (and its Japanese twin) has one Install section per host. Claude Code users add the
  repository marketplace, then install `archstrict@archstrict` for the skill, edit hooks, and MCP
  server. Other agents install the skill with `gh skill install`, add the `AGENTS.md` section with
  `archstrict agents`, and run `archstrict check` in CI, since the edit hooks are Claude Code only.

## 0.1.0 (2026-09-29)

### Added

- `archstrict init [dir] [--json]` declares one module per top-level directory holding TypeScript
  source and one per loose top-level source file, so the first `check` covers every analyzed file
  by construction, and writes `archstrict.types.ts`.
- `archstrict check [file] [--json] [--rule <id>] [--module <name>] [--frozen]` reports module
  boundary violations: a public-surface bypass, an import cycle, an uncovered module, an empty rule
  set, a deprecated module edge whose count grew, a type leaked out of a surface, and a tag-boundary,
  tag-order, or point-rule violation from the constraint engine. `--rule` and `--module` filter both
  the text and JSON output; `--frozen` also reports todo-matched violations without affecting the
  exit code.
- `archstrict todo [--json]` freezes current violations into one project-root
  `archstrict.todo.json`, grouped by module name, on the first run, then only prunes stale entries
  afterward. A module marked `strict` in config can never accumulate a todo entry.
- `archstrict rules <path> [--json]`, `archstrict search <query> [--json]`,
  `archstrict recommend [dir] [--json]`, `archstrict fix [file] [--dry-run] [--json]`, and
  `archstrict hotspots [--since <ref>] [--json]` describe a path's constraints, search declared
  public surfaces, propose a boundary config from real edges, fix a surface bypass by adding a
  re-export, and rank modules by Git change frequency, co-change, fan-in, fan-out, and frozen debt.
- `archstrict simulate [--json] [--whole-project]` previews proposed source or config changes
  against the full rule pipeline without writing to disk, reading the change set from stdin.
- `archstrict.config.ts` declares a project's modules, their public-surface file name, tags
  (`classify`/`classifyByDirectoryName`), edges between tags (`allowDeny`, `order`, `point`), known
  cycle exceptions (`ignoredCycles`), and directories that must hold no code (`mustBeEmpty`).
- A violation always carries a rule id, `path:line:col`, the evidence, a `because` reason, and a
  `do:` command, in both text and JSON output.
- A Claude Code plugin (`.agents/`): a `PreToolUse` hook previews an Edit, Write, or MultiEdit
  through `simulate` before the write lands, a `PostToolUse` hook confirms the result through
  `check` right after, and an MCP server exposes the same verbs as tools.
- An agent skill (`skills/archstrict/SKILL.md` and its references) and `llms.txt` give a coding
  agent the workflow and the rule reference without reading the source.
