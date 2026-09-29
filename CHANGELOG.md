# Changelog

The format follows Keep a Changelog, and the versions follow SemVer. Before 1.0, a minor version
may change commands, flags, config, or output shape. The version entry will describe each change.

## Unreleased

### Changed

- Every verb that walks the project (`init`, `check`, `todo`, `simulate`, `hotspots`, `recommend`)
  now skips gitignored paths. archstrict reads the root and nested `.gitignore` files, the ones
  above the project root, and the repository's `info/exclude` with git's own pattern rules, and
  never runs git. A local scratch directory such as `tmp/` no longer floods `check` with
  `uncovered-module` violations. A gitignored file stays resolvable as an import target. A config
  that already declares a module inside a gitignored directory keeps analyzing that module; remove
  the declaration to drop it.

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
