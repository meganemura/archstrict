# AGENTS.md

Context for agents that work in this repository.

## What this is

archstrict checks TypeScript module boundaries.
It is not tsc, not ESLint, and not a type checker; it is architecture linting, in the sense of ArchUnit (Java) and archspec (Ruby).
It is designed for a reader that starts from an empty context: a coding agent first, a human second.

The shape, in one paragraph.
A module is one directory under a configured glob (for example `src/*`).
A module shows the rest of the codebase one file, named by the config's own `surface` field (default `index.ts`); anything a module does not export from that file is private, and an import that reaches past it into the module's internals is a violation.
A module with no public-surface file present is entirely private: every external import into it is a violation.
Shape (kinds, layers, direction, the surface file name) lives in one root file, `archstrict.config.ts`, written as a plain TypeScript value; it is never scattered per module.
Known violations freeze into a per-module todo file that can only shrink; a module marked `strict` in config can never accumulate a todo entry, existing or new — any entry there is itself a violation.
A violation report always carries a rule id, `path:line:col`, the evidence, the `because` reason, and a `next:` command — enough for an agent to fix its own mistake without asking.

## Layout

- `src/` is the library and CLI.
- `.claude-team/` holds the task spec, the report, and their working artifacts. It is gitignored; do not reference it from committed content.

## Visibility

This repository is intended for public release.
Write all committed text in English: code, comments, docs, commit messages.
Do not reference private tools, private repositories, or internal working documents (including `.claude-team/`) in committed content.
If you want to cite an internal document, write its substance in place instead.

## Rules

- Do not add dependencies without the owner's approval. Pin exact versions, at least 7 days past release. Prefer language-official packages, then vendor packages, and avoid single-maintainer packages.
- Write tests with Hegel (`@hegeldev/hegel`, property-based) wherever a property exists: round trips, invariants, monotonicity. Example-based tests cover exact CLI output and JSON shape.
- Comments say why: the constraint, or the alternative that was refused. Each module starts with its responsibility and its boundary.
- Violation text never uses the words "strict" or "typed"; a name must not mislead about what fixes a violation.
- A release, a `npm publish`, or a change of the repository's visibility is the owner's to run.

## Commands

For working on archstrict itself:

- `npm run build` — compile `src/` to `dist/`. The CLI's own tests spawn the built `dist/cli.js`, so run this before `npm test` if `dist/` is missing or stale.
- `npm run typecheck` — `tsc --noEmit` over the whole project.
- `npm test` — the Vitest suite.

The CLI itself:

- `archstrict init [modulesGlob]` — write `archstrict.generated.ts` (the module-name union type) and, if absent, `archstrict.config.ts` with a default flat preset. Re-run any time modules are added or removed; it regenerates the first file and leaves a hand-edited config alone.
- `archstrict check [file] [--json]` — analyze the whole project and report violations. With a file argument, analysis still covers the whole project (resolving an edge needs it), but the report is scoped to that file's own violations.
- `archstrict todo` — on a project's first run, freeze every current freezable violation into its owning module's todo file; on every later run, only prune entries that no longer match a current violation. Never adds after the first run.
