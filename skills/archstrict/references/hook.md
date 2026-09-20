# The PostToolUse hook

This plugin's `PostToolUse` hook (`hooks/post-tool-use.mjs`) runs after every Edit/Write/MultiEdit. On a `.ts` file, it shells out to **the edited project's own** `node_modules/.bin/archstrict check <file> --json` - never this repository's own build - and returns any violation into the agent's own context via `hookSpecificOutput.additionalContext`, the same moment a human editor's red squiggly would appear.

## Why it might say nothing

Every one of these is silent by design, not a failure:

- The edited file isn't `.ts`, or the tool wasn't an Edit/Write/MultiEdit.
- The project has no `node_modules/.bin/archstrict` at all - most edits happen in files or projects that never adopted this tool. `archstrict init` does not produce this file (it only writes `archstrict.config.ts`/`archstrict.generated.ts`); see the [README](../../../README.md#install) for how to actually install the package into that project.
- `check <file>` found no violation in the edited file. Analysis still covers the whole project (resolving an edge needs every file), but the report is scoped to the one file that changed.

## Why it might report "check did not run"

When `archstrict check --json` reports `{ "error": "..." }` instead of a real result, or exits with no output at all - `check` exiting 1 with violations present is expected, normal output, read as data, not this case. A config error (`archstrict.config.ts` missing a required field, a `deprecated` entry naming a module that doesn't exist, the modules glob's root directory not existing yet during `init`, `check <file>` naming a file that doesn't exist) reports this way; the message names which one. If the message is `init` itself complaining the modules glob's root doesn't exist, `init` cannot fix that on its own: create that directory first (with at least one real `.ts` file in it), or re-run `init` with a `modulesGlob` argument naming a directory that already exists.

## Path resolution

The hook uses the hook payload's own `cwd` (the session's project directory), joined with `node_modules/.bin/archstrict` - matching how npm itself installs a package's binary. It does not search `PATH`, a global install, or a parent directory's `node_modules`.
