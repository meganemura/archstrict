# Migrating from the per-module todo layout

**Remove all of the following after the first release** - the migration
only matters for a project that adopted archstrict before the single-file
`archstrict.todo.json` existed:

- this file
- `src/todo-migration.ts` and `test/todo-migration.test.ts`, whole
- in `src/verbs/check.ts`: `readCurrentTodo`'s own `legacy`/`migrationNote`
  branches (fold `readCurrentTodo` back down to reading only
  `readTodoFile`), and the `migrationNote` plumbing into `result.notes`
- in `src/verbs/todo.ts`: `freezeOrPrune`'s own `legacy` branch and its
  call to `deleteLegacyTodoFiles`
- in `src/todo-store.ts`'s `readTodoFile`: the `{ entries: [...] }`,
  no-`schemaVersion` fallback that returns `undefined` instead of throwing
  `malformed` - once nothing on the old layout exists to collide with the
  new file's own path, an object without `schemaVersion` is just malformed

## The old layout

Before this change, frozen debt lived in one file per module:
`archstrict.todo.json` inside a directory module's own directory, or
`<file>.archstrict.todo.json` beside a single-file module (there is no
directory to hold a sibling file). A project-root marker file,
`.archstrict-todo-initialized`, recorded that `archstrict todo` had run at
all, since a project with zero freezable violations wrote no per-module
file on its first run and file-existence alone couldn't tell "first run,
genuinely clean" apart from "a later run."

On a 31-module project, that put 24 todo files scattered among the source
files, and a re-architecture created and removed a todo file with every
module it added or split.

## The new layout

One file at the project root, `archstrict.todo.json`, with a schema
version and entries grouped by module name. Its own existence now means
"the first run happened" - a project with no debt after its first run
still gets the file, with an empty module map, so the ratchet's own state
stays visible on disk. `.archstrict-todo-initialized` no longer exists.

## What migrates, and when

`archstrict todo` folds the old layout in automatically, the first time it
runs after this change ships: it reads every legacy per-module file and
the marker (if any), treats the result as a normal prune pass (never a
fresh first run, since the debt was already frozen under the old layout),
writes the new single file, then deletes every old file it read. A module
whose own glob covers the project root itself (`"**"`) has its legacy
per-module path collide with the new file's own path; that file is read,
then overwritten in place with the new, schema-versioned shape - never
queued for deletion, which would otherwise erase the migration in the same
run that produced it.

`archstrict check` reads the old layout too, until someone actually runs
`archstrict todo` - so an adopted project already covered by the old
layout keeps passing `check` across the upgrade, with a note in the report
pointing at `archstrict todo` to migrate.
