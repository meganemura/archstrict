# The PostToolUse hook

This plugin's `PostToolUse` hook (`hooks/post-tool-use.mjs`) runs after every Edit/Write/MultiEdit. On a `.ts` file, it shells out to **the edited project's own** `node_modules/.bin/archstrict check <file> --json` - never this repository's own build - and returns any violation into the agent's own context via `hookSpecificOutput.additionalContext`, the same moment a human editor's red squiggly would appear.

## Why it might say nothing

Every one of these is silent by design, not a failure:

- The edited file isn't `.ts`, or the tool wasn't an Edit/Write/MultiEdit.
- The project has no `node_modules/.bin/archstrict` at all - most edits happen in files or projects that never adopted this tool. Run `archstrict init` in that project first if you want the hook active there.
- `check <file>` found no violation in the edited file. Analysis still covers the whole project (resolving an edge needs every file), but the report is scoped to the one file that changed.

## Why it might report "check did not run"

When `archstrict check` exits without writing any JSON at all - `check` exiting 1 with violations present is expected, normal output, read as data, not this case. A config error writes no JSON before throwing: `archstrict.config.ts` missing a required field, an unsupported `kinds` pattern shape, or the modules glob's root directory not existing yet (run `archstrict init` first).

## Path resolution

The hook uses the hook payload's own `cwd` (the session's project directory), joined with `node_modules/.bin/archstrict` - matching how npm itself installs a package's binary. It does not search `PATH`, a global install, or a parent directory's `node_modules`.
