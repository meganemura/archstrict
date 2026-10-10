# The PreToolUse and PostToolUse hooks

This plugin ships two hooks around every Edit/Write/MultiEdit: `PreToolUse` (`.agents/hooks/pre-tool-use.mjs`) previews a proposed edit, and `PostToolUse` (`.agents/hooks/post-tool-use.mjs`) runs right after the write. Claude invokes them as `${CLAUDE_PLUGIN_ROOT}/hooks/pre-tool-use.mjs` and `${CLAUDE_PLUGIN_ROOT}/hooks/post-tool-use.mjs`; repo-root `hooks/` is a symlink to `.agents/hooks`. Both shell out to **the edited project's own** `node_modules/.bin/archstrict` - never this repository's own build.

## PreToolUse: a preview next to the tool result

On a TypeScript source file (`.ts`, `.tsx`, `.mts`, `.cts`) edited with Edit, Write, or MultiEdit, the hook builds the file text the tool call would produce, without writing it to disk:

- Write uses `tool_input.content` directly.
- Edit reads the file's current text and applies `old_string` -> `new_string`, honoring `replace_all`.
- MultiEdit applies each edit in `tool_input.edits` in order, on top of the file's current text.

It then runs `archstrict simulate --json` from the directory that holds the nearest `archstrict.config.ts`, starting at the edited file's own directory and walking up, with that one change on stdin, under a time budget (10 s by default; set `ARCHSTRICT_PRETOOLUSE_TIMEOUT_MS` to change it, in milliseconds). When the change adds a violation, the default hook returns `hookEventName` and the added violations as `hookSpecificOutput.additionalContext`. It does not set `permissionDecision`. The agent reads that preview next to the tool result. The text prints the rule, `path:line:col`, evidence, `because:`, the violation's `config:` pointer line, and `do:`. It shows at most five violations and a count of the rest. A resolved violation, if any, is mentioned in one summary line.

Set `ARCHSTRICT_PRETOOLUSE=deny` to deny the tool call before the write, with the same text as `permissionDecisionReason`. The default leaves the normal permission prompt in place. An agent mid-refactor may write an intermediate state on purpose, and a hard deny would block that.

`permissionDecision` `"ask"`, with the preview as `permissionDecisionReason`, is not implemented.

### Why it might say nothing

Every one of these is silent by design, not a failure:

- The edited file isn't `.ts`, `.tsx`, `.mts`, or `.cts`, or the tool wasn't an Edit/Write/MultiEdit.
- An `old_string` in the Edit or MultiEdit call isn't found in the file's current text - the tool call itself will report that failure, so the hook doesn't guess at it.
- The walk from the edited file finds no `archstrict.config.ts`.
- The directory that holds that config has no `node_modules/.bin/archstrict`.
- `simulate --json` times out, crashes, prints output that is not JSON, or reports a config or input error (`{ "error": "...", "do": "..." }`). Unlike the PostToolUse hook, a broken project config stays silent here rather than being reported, because this hook runs before every edit. Reporting it would interrupt every tool call instead of just the one edit that caused it.
- The change adds no violation, even when it resolves one.

### Double reporting

When the PreToolUse hook reports a violation for a file, the PostToolUse hook for that same edit may still report it once the write actually happens. The two hooks don't share state and don't suppress each other: an agent may see the same violation twice for one edit, once as a preview and once as confirmation that the write landed as previewed.

## PostToolUse: confirmation after the write

On a TypeScript source file (`.ts`, `.tsx`, `.mts`, `.cts`), this hook shells out to `archstrict check <file> --json` in the directory that holds the nearest `archstrict.config.ts`, starting at the edited file's own directory and walking up, and returns any violation into the agent's own context via `hookSpecificOutput.additionalContext`, the same moment a human editor's red squiggly would appear. Each violation is the rule, `path:line:col`, evidence, `because:`, and `do:`. The hook prints every violation in the file.

### Why it might say nothing

Every one of these is silent by design, not a failure:

- The edited file isn't `.ts`, `.tsx`, `.mts`, or `.cts`, or the tool wasn't an Edit/Write/MultiEdit.
- The walk from the edited file finds no `archstrict.config.ts`. The hook does not run a binary that happens to sit in `cwd`, and it does not print an `archstrict init` hint. `archstrict init` writes the config. It does not install the package. See the [README](https://github.com/meganemura/archstrict#install) for how to install the package into that project.
- The directory that holds that config has no `node_modules/.bin/archstrict`. Most edits happen in files or projects that never adopted this tool.
- `check --json` prints output that is not JSON.
- `check <file>` found no violation in the edited file. Analysis still covers the whole project (resolving an edge needs every file), but the report is scoped to the one file that changed. An excluded file, a file outside the project, or a file that is not analyzed (a `.d.ts` that is not a surface) still returns that empty list with exit code 0. The text `note:` is not part of the JSON.

For a module surface, `check <file>` builds rule 6 from that surface's type closure, and `typeLeaks` counts only leaks reported at that file.

### The `todo` field is scoped too

`check <file>`'s own `todo` count (JSON) or `todo:` line (text) counts only the frozen violations reported at that one file - not every frozen violation in the project. A frozen violation elsewhere is real, and a plain `check` (no file argument) still counts it; this run just never evaluated it, the same way its own `typeLeaks: null` reports "not evaluated" rather than a project-wide fact whenever rule 6 is skipped.

### Why it might report "check did not run"

This report happens only after the walk has found an `archstrict.config.ts` and run that project's binary. A missing config file is silent, listed above. When `archstrict check --json` reports `{ "error": "...", "do": "..." }` instead of a real result, or exits with no output at all, the hook reports it. `check` exiting 1 with violations present is expected, normal output, read as data, not this case. A config error (`archstrict.config.ts` missing a required field, a `schemaVersion` other than `1`, a `deprecated` entry naming a module that doesn't exist, `check <file>` naming a file that doesn't exist) reports this way; the message names which one, and `do` names the command to run. The hook includes that `do` line in the context it returns.

`archstrict init` itself, not the hook, reports its own errors when a project has no analyzed TypeScript source file to declare at all (`init` writes neither file and exits 1), or its own directory argument names something init won't open (a glob character, a nested path, a hidden name, `node_modules`, `dist`, or an explicit directory that doesn't exist or holds no TypeScript source) - each names what's wrong and the one command to run next.

## Path resolution

Both hooks walk up from the edited file's directory to the nearest directory that holds `archstrict.config.ts`. They run that directory's `node_modules/.bin/archstrict`, with that directory as the working directory. `check` and `simulate` read the config from the working directory, so the working directory is the directory that holds the config.

The hook payload's `cwd` is not that directory. `cwd` follows `cd`. `CLAUDE_PROJECT_DIR` stays at the main checkout when the edited file is in a git worktree. A nested package with its own `archstrict.config.ts` is checked with that package's config and binary.

When the walk finds no `archstrict.config.ts`, or that directory has no `node_modules/.bin/archstrict`, the hook prints `{}`. Neither hook searches `PATH` or a global install. The binary is the one beside the config, not a binary in the hook `cwd` and not a binary in a parent of that config.
