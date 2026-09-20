---
name: archstrict
description: Use when a project has an archstrict.config.ts, or when the user names archstrict, a module's public surface, a module boundary, `archstrict check`, `archstrict init`, `archstrict todo`, a todo freeze, a strict module, a type leak, a deprecated edge, or the archstrict PostToolUse hook. Covers writing or changing a module's public-surface file, reading a violation report (rule id, path:line:col, evidence, because, next), freezing known violations into a module's todo file, and troubleshooting a violation the hook or `check` reported.
---

# archstrict

TypeScript module boundary checking: architecture linting, in the sense of ArchUnit (Java) and archspec (Ruby). Not tsc, not ESLint, not a type checker.

A module is one directory under a configured glob (for example `src/*`). A module shows the rest of the codebase one file, named by the root config's own `surface` field (default `index.ts`); anything a module does not export from that file is private, and an import that reaches past it into the module's internals is a violation. A module with no public-surface file present is entirely private. Shape (kinds, layers, direction, the surface file name) lives in one root file, `archstrict.config.ts`, written as a plain TypeScript value satisfying the generated `Config` type - never scattered per module.

Every violation carries a rule id, `path:line:col`, the `evidence` (what was found), the `because` reason, and a `next:` command - enough to fix the mistake without asking. Every rule, in full: [references/rules.md](references/rules.md).

## Workflow

1. **Start a project**: `archstrict init [modulesGlob]` (default `src/*`). Writes `archstrict.generated.ts` (the module-name union type, regenerated every run) and, if absent, `archstrict.config.ts` with a default flat preset - it never overwrites a hand-edited config. Re-run any time a module directory is added or removed.
2. **Give each module its own surface file** (`index.ts` by default, or whatever `surface` names) that re-exports what other modules may use. An import from outside the module that reaches any other file is `public-surface-bypass` ([references/rules.md](references/rules.md#1-public-surface-bypass)); a surface file that re-exports a type whose own shape reaches an internal declaration nothing exports by name is `type-leak` ([references/rules.md](references/rules.md#6-type-leak)).
3. **Check**: `archstrict check [file] [--json]`. With no file, analyzes the whole project. With a file, analysis still covers the whole project (resolving an edge needs every file), but the report is scoped to that file's own violations - what the PostToolUse hook uses after an edit. Exit code 1 means at least one violation. `--json` prints a `CheckResult` on success, or `{ "error": "<message>" }` with exit 1 instead when the config itself is broken (a required field absent, an unsupported `kinds` pattern shape, a named file that doesn't exist) - two shapes, not one; check for `error` before reading `violations`. Full config schema: [references/config.md](references/config.md).
4. **Freeze known violations**: `archstrict todo [--json]`. On a project's first run, freezes every current freezable violation (rule 1, rule 2, and rule 6 - the three whose violation names the module it belongs to) into that module's own `archstrict.todo.json`. Every later run only prunes: an entry whose fingerprint no longer matches a current violation is dropped, and nothing is ever added again, even when a new violation appears. `--json` prints `{ firstRun, added, pruned }` (or `{ "error": "<message>" }` on a config error, the same two-shape convention `check --json` uses). `check` then suppresses a violation whose fingerprint is already frozen (counted in the `todo` field, not the exit code), unless the module is `strict` (step 5 below) - a strict module's own violations are never suppressed, frozen or not. `check` also flags a todo entry that matches nothing as its own violation (`stale-todo`).
5. **`strict` a module** (in `archstrict.config.ts`'s `strict: string[]`) once its own todo file is empty, to keep it that way: a strict module's todo file can never gain a new entry, and any existing entry there is itself a violation (`clean-module-has-todo`) - staying clean means no debt, not debt frozen at whatever existed when the module was marked.
6. **The PostToolUse hook** runs automatically after an Edit/Write/MultiEdit on a `.ts` file, if this project has archstrict installed (`node_modules/.bin/archstrict`) - no separate step. It says nothing when the edited file has no violation or archstrict isn't installed here at all. Troubleshooting: [references/hook.md](references/hook.md).

## Reading a violation

`path` is always an absolute path (`/path/to/project/src/app/importer.ts` here, abbreviated below):

```
[public-surface-bypass] .../src/app/importer.ts:1:24
  '../shared/module.ts' resolved to module 'shared', which has no index.ts
  because: a module's public surface is its only public surface; everything else is private
  next: add a index.ts to shared/ naming what it exports
```

`evidence` says what was found; `next` says the one thing to do about it. Do the thing `next` says, not a broader refactor - a rule flags exactly the edge, property, or entry it names, nothing implied beyond it.
