---
name: archstrict
description: Use when a project has an archstrict.config.ts, or when the user names archstrict, a module's public surface, a module boundary, `archstrict check`, `archstrict init`, `archstrict todo`, a todo freeze, a strict module, a type leak, a deprecated edge, or the archstrict PostToolUse hook. Covers writing or changing a module's public-surface file, reading a violation report (rule id, path:line:col, evidence, because, do), freezing known violations into the project's todo file, and troubleshooting a violation the hook or `check` reported.
---

# archstrict

TypeScript module boundary checking: architecture linting. It does not check types or code style.

A module is one directory, or one file when its glob names that file, declared explicitly in `declaredModules` (never discovered from directory structure at runtime). A module shows the rest of the codebase one file, named by the root config's own `surface` field (default one entry per analyzed source extension: `index.ts`, `index.tsx`, `index.mts`, `index.cts`); anything a module does not export from that file is private, and an import that reaches past it into the module's internals is a violation. A module with no public-surface file present is entirely private. A file can also carry tags (`classify`/`classifyByDirectoryName`) independent of module membership, and a constraint engine (`edges`) checks edges between tags - domain/layer/plane boundaries generalized over tags instead of module names. Shape (exclude, classify, declaredModules, edges, the surface file name) lives in one root file, `archstrict.config.ts`, written as a plain TypeScript value satisfying the generated `Config` type - never scattered per module.

Every violation carries a rule id, `path:line:col`, the `evidence` (what was found), the `because` reason, a structured `config` pointer, and a `do:` command - enough to fix the mistake without asking. Read `config.pointer` to find the config value without parsing `evidence` or `do`. A violation that needs two config locations uses a `config` array, with the entry that fired first. Every rule, in full: [references/rules.md](references/rules.md).

## Workflow

The CLI runs as `npx archstrict <verb>`, and a `do:` line leaves out the `npx` prefix. `archstrict --help`, `-h`, or `help` prints usage and runs no verb.

Run `archstrict agents` to add the fixed pre-edit guidance to `AGENTS.md`; use `--remove` to remove it. That section is a few lines of project instructions, separate from this skill. See [agent instructions](references/agents-verb.md). The edit hooks run only in Claude Code; on any other host, `archstrict check` in CI is what catches a violation after an edit. The [README's Install section](https://github.com/meganemura/archstrict#install) says how each host gets the skill, the hooks, and the MCP server. `archstrict mcp` starts the stdio MCP server for this project. Its tools are `check`, `rules`, `search`, and `simulate`.

Before creating a file, run `archstrict rules <path> [--json]` to inspect its module, tags, public surfaces, friend access, and placement violations; see [path rules](references/path-rules.md). `archstrict search <query> [--json]` ranks names exported from public surfaces by token overlap with the query.

1. **Start a project**: `archstrict init [dir] [--json]` (default container `src/`) writes `archstrict.types.ts` and, only when it is absent, `archstrict.config.ts`, and it never overwrites a hand-edited config. If there's no `archstrict` command available in this project yet, see the [README's Install section](https://github.com/meganemura/archstrict#install) first. Read [init](references/config.md#init) for the walk, the JSON fields, and `recommend`, and read [The first map is an inventory](#the-first-map-is-an-inventory) before treating that map as finished.
2. **Give each module its own surface file** (`index.ts`/`index.tsx`/`index.mts`/`index.cts` by default, or whatever `surface` names) that re-exports what other modules may use. An import from outside the module that reaches any other file is `public-surface-bypass` ([references/rules.md](references/rules.md#1-public-surface-bypass)), and a surface file that re-exports or otherwise exposes a type whose own shape reaches an internal declaration nothing exports by name is `type-leak` ([references/rules.md](references/rules.md#6-type-leak)). `archstrict fix [file] [--dry-run]` appends `export type` re-exports for a type leak whose declaring file already exports that name, and `--dry-run` prints the planned lines and writes nothing.
3. **Check**: `archstrict check [file] [--json]` analyzes the whole project and, with a file, reports only that file's violations. Exit code 1 means at least one violation, and [check](references/rules.md#check) holds the report, the filters, and the footer. Before making a source or config change, preview it with `archstrict simulate` ([references/simulate.md](references/simulate.md)), and after adding or changing a config rule, prove that it can report the intended violation with the positive-control procedure in [references/prove-rules.md](references/prove-rules.md).
4. **Freeze known violations**: `archstrict todo [--json]` freezes freezable violations into one project-root `archstrict.todo.json` on the first run and only prunes after that. The first run writes no file while any `uncovered-module` violation exists. Sorting, the JSON shape, suppression, and what deleting the file does are in [todo](references/rules.md#todo).
5. **`strict` a module** (in `archstrict.config.ts`'s `strict: string[]`) once it has no todo entries of its own, to keep it that way: a strict module can never gain a new entry, and any existing one is itself a violation (`clean-module-has-todo`) - staying clean means no debt, not debt frozen at whatever existed when the module was marked.
6. **The PostToolUse hook** runs automatically after an Edit/Write/MultiEdit on a TypeScript source file (`.ts`, `.tsx`, `.mts`, `.cts`), if this project has archstrict installed (`node_modules/.bin/archstrict`) - no separate step. It says nothing when the edited file has no violation or archstrict isn't installed here at all. Troubleshooting: [references/hook.md](references/hook.md).

After adoption is clean, use `archstrict hotspots [--since <git ref or date>] [--json]` to find high-change modules and boundary pairs that change together. Follow the [re-architecture workflow](references/rearchitect.md) to name a move, simulate it, and verify its numeric effect.

## The first map is an inventory

`archstrict init` covers every analyzed file, one module per directory and one per loose file. That is coverage. A file-per-module map makes every file public as itself, so imports between files are checked, and it still names no growth seam. One module over `src/**` (or one directory that holds almost every file) makes `archstrict hotspots` report a single score, and freezing its public-surface bypasses records that one bucket. `init` prints both shapes when it sees them. `archstrict recommend` repeats them as `mapNotes` (`mega-module`, `file-per-module`). `check` and `todo` add a note when most public-surface bypasses target that one large module, and the next command is to split it before freezing more.

Name seams that change together, then add an `edges` rule so import direction is checked. `archstrict hotspots`, once the project has history, shows which modules and pairs move together. `archstrict recommend` proposes `edges` from the real graph (`patternProposals`) and a surface per surface-less module (`surfaceProposals`). Prove a new rule can fire before trusting a clean check: [references/prove-rules.md](references/prove-rules.md).

A flat directory can name a seam without a directory move. `glob` accepts an array of paths that share one directory: `{ name: "plan", glob: ["src/build/plan.ts", "src/build/graph.ts"], surface: "plan.ts" }`. `plan.ts` is public; `graph.ts` stays private except to a `friends` entry. Paths in two directories are a config error; use one entry per directory. Brace syntax (`{a,b}`) is rejected. See [references/config.md](references/config.md) and [references/patterns.md](references/patterns.md#flat-directory-seam).

Two cuts that kept a real graph readable: the CLI and the MCP server sit above the verbs they call, because a verb that imports the CLI cycles. A helper that the module graph calls (a type-leak walk, a shared report type) sits with the graph, because putting it in the rules package makes the graph import the rules. A pair that keeps changing together after that cut can be the graph's own API. See [references/rearchitect.md](references/rearchitect.md#cuts-that-kept-the-signal).

Install the skill once for the user (`gh skill install meganemura/archstrict archstrict --agent cursor --scope user`). Copying `skills/archstrict` into every repository duplicates it. `archstrict agents` is the separate, per-project `AGENTS.md` section; it is a few lines of commands, and it is not a second copy of this skill.

## Reading a violation

`path` is always an absolute path (`/path/to/project/src/app/importer.ts` here, abbreviated below):

```
[public-surface-bypass] .../src/app/importer.ts:1:24
  '../shared/module.ts' resolved to module 'shared', which has no index.ts, index.tsx, index.mts, index.cts
  because: a module's public surface is its only public surface; everything else is private
  config: .../archstrict.config.ts:8:3 declaredModules[1] (governs)
  do: add one of index.ts, index.tsx, index.mts, index.cts to shared/ naming what it exports
```

`evidence` says what was found; `do` says the one thing to do about it. Do the thing `do` says, not a broader refactor - a rule flags exactly the edge, property, or entry it names, nothing implied beyond it.
