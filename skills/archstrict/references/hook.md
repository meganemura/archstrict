# The PostToolUse hook

This plugin's `PostToolUse` hook (`.agents/hooks/post-tool-use.mjs`) runs after every Edit/Write/MultiEdit. Claude invokes it as `${CLAUDE_PLUGIN_ROOT}/hooks/post-tool-use.mjs`; repo-root `hooks/` is a symlink to `.agents/hooks`. On a TypeScript source file (`.ts`, `.tsx`, `.mts`, `.cts`), it shells out to **the edited project's own** `node_modules/.bin/archstrict check <file> --json` - never this repository's own build - and returns any violation into the agent's own context via `hookSpecificOutput.additionalContext`, the same moment a human editor's red squiggly would appear.

## Why it might say nothing

Every one of these is silent by design, not a failure:

- The edited file isn't `.ts`, or the tool wasn't an Edit/Write/MultiEdit.
- The project has no `node_modules/.bin/archstrict` at all - most edits happen in files or projects that never adopted this tool. `archstrict init` does not produce this file (it only writes `archstrict.config.ts`/`archstrict.types.ts`); see the [README](../../../README.md#install) for how to actually install the package into that project.
- `check <file>` found no violation in the edited file. Analysis still covers the whole project (resolving an edge needs every file), but the report is scoped to the one file that changed.

## The `todo` field is scoped too

`check <file>`'s own `todo` count (JSON) or `todo:` line (text) counts only the frozen violations reported at that one file - not every frozen violation in the project. A frozen violation elsewhere is real, and a plain `check` (no file argument) still counts it; this run just never evaluated it, the same way its own `typeLeaks: null` reports "not evaluated" rather than a project-wide fact whenever rule 6 is skipped.

## Why it might report "check did not run"

When `archstrict check --json` reports `{ "error": "...", "do": "..." }` instead of a real result, or exits with no output at all - `check` exiting 1 with violations present is expected, normal output, read as data, not this case. A config error (`archstrict.config.ts` missing a required field, a `schemaVersion` other than `1`, a `deprecated` entry naming a module that doesn't exist, `check <file>` naming a file that doesn't exist) reports this way; the message names which one, and `do` names the command to run. The hook includes that `do` line in the context it returns.

`archstrict init` itself, not the hook, reports its own errors when a project has no analyzed TypeScript source file to declare at all (`init` writes neither file and exits 1), or its own directory argument names something init won't open (a glob character, a nested path, a hidden name, `node_modules`, `dist`, or an explicit directory that doesn't exist or holds no TypeScript source) - each names what's wrong and the one command to run next.

## Path resolution

The hook uses the hook payload's own `cwd` (the session's project directory), joined with `node_modules/.bin/archstrict` - matching how npm itself installs a package's binary. It does not search `PATH`, a global install, or a parent directory's `node_modules`.
