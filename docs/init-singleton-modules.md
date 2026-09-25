# init declares one module per directory or loose file

`archstrict init [dir]` walks the project with check's own file-eligibility
rule and declares one module per top-level directory that holds an
analyzed `.ts` file, and one single-file module per loose top-level `.ts`
file - both inside the opened container (`src/` by default) and at the
project root. Every file the first `check` analyzes then belongs to
exactly one declared module, by construction. The first check therefore
reports 0 `uncovered-module` and 0 `empty-rule-set` violations, on any
project shape.

## The problem this replaces

Before this change, `init` declared a module for each directory under a
fixed glob (`src/*`) and excluded every loose top-level `.ts` file with a
literal `exclude: ["*.ts"]`. Two real shapes broke that:

- A directory with no `src/` at all, or a `src/` holding no directories
  (only loose files) - `init` had nothing to declare, or refused.
- A directory alongside `src/` at the project root, or a loose file
  directly inside `src/` itself - each showed up as its own
  `uncovered-module` violation on the very first `check`, which `todo`
  can never freeze away (an `uncovered-module` violation has no module
  directory to freeze it into). A project in this shape stayed at exit 1
  permanently unless a person hand-wrote an `exclude` entry for those
  files before running `todo` for the first time.

## The decision

Each analyzed file becomes its own module (a directory module for a
directory's files, a single-file module - `surface` naming the file
itself - for a loose file), never a shared catch-all covering every loose
file at once. Two ideas were rejected:

- **Printing an inventory of directories, with loose files left
  uncovered.** This reproduces the exact trap above: the first check
  still reports `uncovered-module`, and it still can't be frozen.
- **One catch-all module for every loose file at once
  (`{ name: "loose", glob: "src/*.ts" }`).** Its own public surface is
  every one of those files' own exports at once - a degenerate shape with
  no real public/private distinction inside it. `init` also never writes
  a glob whose base is the project root (`**`, `*.ts`): such a module's
  directory is the whole project.

A directory module carries no per-entry `surface` of its own - the
project's own top-level default applies, or a real `package.json`
`exports` map at that directory's own root, when it has one. Setting a
per-entry `surface` would turn that derivation off for every directory
`init` ever declares.

## Naming

A group's name is its on-disk name (the directory's name, or the file's
name including its extension) - one directory cannot hold a file and
another directory of the same name, so this alone never collides at the
same level. A group below the project root whose on-disk name is already
taken (by a top-level entry of the same name) instead takes its own
project-relative path as its name: a root `cli.ts` and a container's own
`cli.ts` become `"cli.ts"` and, say, `"src/cli.ts"`.

## Everything the walk excludes

`init` writes an `exclude` covering: its own two files
(`archstrict.config.ts`, `archstrict.types.ts`); every hidden directory,
at any depth (`.git`, a tool's own state directory) - the same thing
`tsc`'s own default `include` already skips; and a fixed list of common
non-source directory names (`test`, `tests`, `example`, `examples`,
`spike`, `build`, `coverage`, `fixtures`, `e2e`, `tmp`), each added only when a
real directory of that name exists on disk. A container named on the
command line is never treated as noise, even when its own name is on that
list. The two hidden-directory patterns are the same on every machine (a
committed config never names a directory that exists on only one
machine); a directory a project decided is real source keeps its exclude
entry removed by hand.

## Zero-directory and zero-candidate cases

A container holding only loose files (no directories at all) still
declares one module per file; `init` prints one extra line, naming the
alternative (checking the whole container as one module instead) without
writing it - that shape stays a hand-edit, since a `do:` line names one
action, not a menu.

A project with no analyzed `.ts` file anywhere - under the seeded
exclude - has nothing for `init` to declare. It writes neither file and
exits 1, naming what's missing.

## Re-run

`init` never touches an existing `archstrict.config.ts`. A re-run only
re-reads it and rewrites `archstrict.types.ts` (the `ModuleName` union)
from its own `declaredModules` names - never from a fresh walk. A
directory argument on a re-run is still validated (the same syntax rules
apply), then ignored: it only ever chose a container for a config `init`
is about to write.

## What stays out of this change

A re-run does not yet print the paste-ready `declare:`/`exclude:` lines
for a file that has since fallen outside every declared module (only the
`ModuleName` regeneration lands here); rule 3's own suggested fix text and
`check`'s own footer are unchanged for the same reason. `init --json`, and
retiring the old single-level `modulesGlob` discovery path entirely
(`recommend` still takes one), are both separate, later work.

Rule 6 (type-leak) can still report a finding for a singleton file whose
own export structurally exposes another module's own internal
declaration - this is this project's own currently-implemented reading of
that rule, unrelated to this change and unaffected by it: declaring more,
smaller modules only means more module boundaries between files for that
existing rule to evaluate, not a new rule or a new finding class.
