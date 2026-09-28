// Responsibility: reads the per-module todo layout archstrict wrote before
// the single-file archstrict.todo.json existed - one archstrict.todo.json
// inside each directory module, one <file>.archstrict.todo.json beside each
// single-file module, and a root .archstrict-todo-initialized marker - so
// todo.ts can fold it into the new file once, and check.ts can still pass
// on a project that adopted archstrict under the old layout and hasn't run
// `archstrict todo` since.
// Boundary: reading and detecting the OLD layout only. The new layout
// lives in todo-store.ts, which this module depends on but never the
// reverse. Slated for removal once the old layout is old enough that no
// adopted project could still be on it - the first release after this one.
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { toProjectRelativePosix } from "./module-graph.js";
import { todoFilePath, type TodoEntry } from "./todo-store.js";

export const LEGACY_MARKER_NAME = ".archstrict-todo-initialized";

function legacyMarkerPath(projectRoot: string): string {
  return join(projectRoot, LEGACY_MARKER_NAME);
}

function pathIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// Mirrors the pre-migration `todoPath`: a directory module keeps its todo
// inside itself; a single-file module (the glob names one file, with no
// directory of its own to hold a sibling archstrict.todo.json) keeps it
// beside the file, named from the file's own basename.
function legacyModuleTodoPath(moduleDir: string): string {
  if (pathIsFile(moduleDir)) return join(dirname(moduleDir), `${basename(moduleDir)}.archstrict.todo.json`);
  return join(moduleDir, "archstrict.todo.json");
}

// A legacy entry's own stored `path` (and, for public-surface-bypass,
// `target`) is project-relative UNLESS it was frozen by an archstrict old
// enough to have stored the raw absolute form - normalized here the same
// way the pre-migration readTodo already did, so a file this old still
// matches today's algorithm without a dedicated migration step of its own.
function normalizeLegacyEntry(entry: TodoEntry, projectRoot: string): TodoEntry {
  const path = isAbsolute(entry.path) ? toProjectRelativePosix(entry.path, projectRoot) : entry.path;
  const target = entry.target !== undefined && isAbsolute(entry.target)
    ? toProjectRelativePosix(entry.target, projectRoot)
    : entry.target;
  return target === undefined ? { ...entry, path } : { ...entry, path, target };
}

function readLegacyModuleTodo(moduleDir: string, projectRoot: string): TodoEntry[] {
  const p = legacyModuleTodoPath(moduleDir);
  if (!existsSync(p)) return [];
  const entries = (JSON.parse(readFileSync(p, "utf8")) as { entries: (TodoEntry & { fingerprint?: string })[] }).entries;
  // Old entries carried a `fingerprint` field that today's shape drops
  // (todo-store.ts's own comment on why it's no longer stored) - stripped
  // here rather than carried forward into the new file.
  return entries.map((e) => {
    const { fingerprint: _fingerprint, ...rest } = e;
    return normalizeLegacyEntry(rest, projectRoot);
  });
}

export type LegacyTodoState = {
  // Every module directory that had its own legacy todo file, keyed by
  // module name (as declared today - a renamed module's OLD entries are
  // unreadable by name alone, the same limitation the old layout itself
  // had: it read by directory, and a renamed module points its declared
  // glob at the same directory it always did, so this still finds them).
  entriesByModule: ReadonlyMap<string, TodoEntry[]>;
  // Every file this migration will delete once the new file is written -
  // every legacy per-module file found to exist, plus the marker if
  // present.
  filesToDelete: readonly string[];
  // Whether ANY sign of the old layout was found at all (a legacy file, or
  // the marker with none) - this, not entriesByModule's own size, is
  // "was this project on the old layout", since a clean legacy project has
  // zero legacy files but still has the marker.
  present: boolean;
};

// `moduleDirs` - a Map<name, dir> - comes from the live module graph (the
// caller already built one for `check`/`todo`'s own run), not from
// re-declaring modules here: a module renamed or removed since the old
// layout was written is exactly the case this function cannot help with
// (see entriesByModule's own comment), and the caller decides what happens
// to entries under a name this run no longer declares.
export function readLegacyTodoState(projectRoot: string, moduleDirs: ReadonlyMap<string, string>): LegacyTodoState {
  // A module whose own glob covers the project root itself (e.g. "**")
  // has its legacy per-module path (join(dir, "archstrict.todo.json"))
  // equal to the new single file's own path - todo-store.ts's own
  // readTodoFile already treats a file at this path with no schemaVersion
  // as "the new shape isn't present" and returns undefined so this
  // function runs at all. That file must never be queued for deletion:
  // freezeOrPrune writes the migrated, schema-versioned content to this
  // SAME path before deleteLegacyTodoFiles ever runs, and deleting it
  // afterward would erase the migration this run just did, not an old
  // file left behind by it.
  const newFilePath = todoFilePath(projectRoot);
  const entriesByModule = new Map<string, TodoEntry[]>();
  const filesToDelete: string[] = [];
  // Counts every legacy file FOUND, even the one colliding path excluded
  // from filesToDelete above - `present` must stay true for that case too
  // (the project genuinely was on the old layout), not fall back to only
  // filesToDelete's own length, which the collision deliberately excludes.
  let legacyFilesFound = 0;
  for (const [name, dir] of moduleDirs) {
    const p = legacyModuleTodoPath(dir);
    if (!existsSync(p)) continue;
    legacyFilesFound++;
    if (p !== newFilePath) filesToDelete.push(p);
    const entries = readLegacyModuleTodo(dir, projectRoot);
    if (entries.length > 0) entriesByModule.set(name, entries);
  }
  const marker = legacyMarkerPath(projectRoot);
  const markerPresent = existsSync(marker);
  if (markerPresent) filesToDelete.push(marker);
  return { entriesByModule, filesToDelete, present: markerPresent || legacyFilesFound > 0 };
}

// Deletes every legacy file this run found, once the new single file has
// already been written - never before, so a crash between the two leaves
// the old layout still fully readable rather than silently dropping debt.
export function deleteLegacyTodoFiles(files: readonly string[]): void {
  for (const f of files) {
    if (existsSync(f)) unlinkSync(f);
  }
}
