# The PreToolUse and PostToolUse hooks

This plugin ships two hooks around every Edit/Write/MultiEdit: `PreToolUse` (`.agents/hooks/pre-tool-use.mjs`) runs before the write happens, and `PostToolUse` (`.agents/hooks/post-tool-use.mjs`) runs right after. Claude invokes them as `${CLAUDE_PLUGIN_ROOT}/hooks/pre-tool-use.mjs` and `${CLAUDE_PLUGIN_ROOT}/hooks/post-tool-use.mjs`; repo-root `hooks/` is a symlink to `.agents/hooks`. Both shell out to **the edited project's own** `node_modules/.bin/archstrict` - never this repository's own build.

## PreToolUse: a preview before the write

On a TypeScript source file (`.ts`, `.tsx`, `.mts`, `.cts`) edited with Edit, Write, or MultiEdit, the hook builds the file text the tool call would produce, without writing it to disk:

- Write uses `tool_input.content` directly.
- Edit reads the file's current text and applies `old_string` -> `new_string`, honoring `replace_all`.
- MultiEdit applies each edit in `tool_input.edits` in order, on top of the file's current text.

It then runs `node_modules/.bin/archstrict simulate --json` with that one change on stdin, under a time budget (10 s by default; set `ARCHSTRICT_PRETOOLUSE_TIMEOUT_MS` to change it, in milliseconds). When the change adds a violation, the hook allows the edit and returns the added violations as `hookSpecificOutput.additionalContext` - the same compact form the PostToolUse hook prints (rule, `path:line:col`, evidence, `because:`, the violation's `config:` pointer line, and `do:`), bounded to a few violations with a count of the rest. A resolved violation, if any, is mentioned in one summary line.

Set `ARCHSTRICT_PRETOOLUSE=deny` to make the hook deny the tool call instead, with the same text as `permissionDecisionReason`. The default is allow-with-context: an agent mid-refactor may write an intermediate state on purpose, and a hard deny would block that.

### Why it might say nothing

Every one of these is silent by design, not a failure:

- The edited file isn't `.ts`, or the tool wasn't an Edit/Write/MultiEdit.
- An `old_string` in the Edit or MultiEdit call isn't found in the file's current text - the tool call itself will report that failure, so the hook doesn't guess at it.
- The project has no `node_modules/.bin/archstrict` at all.
- `simulate --json` times out, crashes, or reports a config or input error (`{ "error": "..." }`) - unlike the PostToolUse hook, a broken project config stays silent here rather than being reported, because this hook runs before every edit; reporting it would interrupt every tool call instead of just the one edit that caused it.
- The change adds no violation, even when it resolves one.

### Double reporting

When the PreToolUse hook reports a violation for a file, the PostToolUse hook for that same edit may still report it once the write actually happens. The two hooks don't share state and don't suppress each other: an agent may see the same violation twice for one edit, once as a preview and once as confirmation that the write landed as previewed.

## PostToolUse: confirmation after the write

On a TypeScript source file, this hook shells out to `node_modules/.bin/archstrict check <file> --json` and returns any violation into the agent's own context via `hookSpecificOutput.additionalContext`, the same moment a human editor's red squiggly would appear.

### Why it might say nothing

Every one of these is silent by design, not a failure:

- The edited file isn't `.ts`, or the tool wasn't an Edit/Write/MultiEdit.
- The project has no `node_modules/.bin/archstrict` at all - most edits happen in files or projects that never adopted this tool. `archstrict init` does not produce this file (it only writes `archstrict.config.ts`/`archstrict.types.ts`); see the [README](../../../README.md#install) for how to actually install the package into that project.
- `check <file>` found no violation in the edited file. Analysis still covers the whole project (resolving an edge needs every file), but the report is scoped to the one file that changed.

For a module surface, `check <file>` builds rule 6 from that surface's type closure, and `typeLeaks` counts only leaks reported at that file.

### The `todo` field is scoped too

`check <file>`'s own `todo` count (JSON) or `todo:` line (text) counts only the frozen violations reported at that one file - not every frozen violation in the project. A frozen violation elsewhere is real, and a plain `check` (no file argument) still counts it; this run just never evaluated it, the same way its own `typeLeaks: null` reports "not evaluated" rather than a project-wide fact whenever rule 6 is skipped.

### Why it might report "check did not run"

When `archstrict check --json` reports `{ "error": "...", "do": "..." }` instead of a real result, or exits with no output at all - `check` exiting 1 with violations present is expected, normal output, read as data, not this case. A config error (`archstrict.config.ts` missing a required field, a `schemaVersion` other than `1`, a `deprecated` entry naming a module that doesn't exist, `check <file>` naming a file that doesn't exist) reports this way; the message names which one, and `do` names the command to run. The hook includes that `do` line in the context it returns.

`archstrict init` itself, not the hook, reports its own errors when a project has no analyzed TypeScript source file to declare at all (`init` writes neither file and exits 1), or its own directory argument names something init won't open (a glob character, a nested path, a hidden name, `node_modules`, `dist`, or an explicit directory that doesn't exist or holds no TypeScript source) - each names what's wrong and the one command to run next.

## Path resolution

Both hooks use the hook payload's own `cwd` (the session's project directory), joined with `node_modules/.bin/archstrict` - matching how npm itself installs a package's binary. Neither searches `PATH`, a global install, or a parent directory's `node_modules`.
