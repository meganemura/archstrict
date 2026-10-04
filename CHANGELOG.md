# Changelog

The format follows Keep a Changelog, and the versions follow SemVer. Before 1.0, a minor version
may change commands, flags, config, or output shape. The version entry will describe each change.

## Unreleased

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
