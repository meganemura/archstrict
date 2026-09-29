// Responsibility: the `todo` verb (packwerk's shape). Freezes known
// violations into one project-root archstrict.todo.json, grouped by module
// name. First run adds every current freezable violation; every later run
// only prunes entries whose identity no longer matches a current violation
// — todo never adds again after the first run, so "run todo" cannot be
// used to accept a new violation quietly. Also folds in the old per-module
// layout the first time it finds one (todo-migration.ts), so a project
// that adopted archstrict before this file existed keeps its frozen debt.
// Boundary: freeze/prune/migrate policy only. The on-disk shape and
// fingerprint identity live in todo-store.ts, shared with check.ts, so
// both agree on the same identity for the same violation without
// depending on each other.
import { join } from "node:path";
import { buildModuleGraphForRules, type ModuleGraph } from "../module-graph.js";
import type { Config } from "../config.js";
import { ReportError } from "../report-error.js";
import {
  buildTodoEntry,
  buildTodoIndex,
  findMatchingEntry,
  readTodoFile,
  writeTodoFile,
  type TodoEntry,
} from "../todo-store.js";
import { deleteLegacyTodoFiles, readLegacyTodoState } from "../todo-migration.js";
import { loadConfig, runRules, type AnyViolation } from "./check.js";
import { dominantBypassModule, dominantBypassSentence } from "../map-shape.js";

// Only a violation with its own todoModule can be frozen: rule 1 (public-
// surface bypass), rule 2 (cycles), rule 6 (type-leak), and rule 7 (the
// constraint engine: tag-boundary/tag-order/point-rule) are per-edge or
// per-relationship findings that accumulate as real, gradually-shrinkable
// debt - a team may want to accept a known architectural violation while
// blocking new growth, the same precedent rule 1 already set. Rules 3
// and 4 are config-vs-graph consistency checks (the config itself doesn't
// match reality) - freezing those would hide a broken config rather than
// track debt. Rule 5 already has its own freeze mechanism (the declared
// count); it needs no todo entry.
type Freezable = AnyViolation & { todoModule: string };

function isFreezable(v: AnyViolation): v is Freezable {
  return "todoModule" in v;
}

export type TodoResult = {
  firstRun: boolean;
  added: number;
  pruned: number;
  // Set when the violations being frozen (or already frozen) are mostly
  // surface bypasses of one module that also holds most of the files.
  // Absent otherwise, so a small project's JSON stays the three counts.
  notes?: string[];
};

// An uncovered-module violation has no todoModule (module-graph.ts's
// outsideFiles matches no declared module at all, so there is no module
// name to freeze it under - see isFreezable's own comment) - it can never
// be frozen, first run or later. If the first run happens while one
// exists, it freezes every OTHER current violation and writes the file,
// after which "never add again" permanently forecloses freezing it once
// it's later declared: check would stay at exit 1 forever (measured on
// two real repository shapes: 12 and 52 such violations). Refusing the
// first run outright - no file written at all - keeps the freeze
// available until every file is actually covered. A later (prune-only)
// run is unaffected: pruning only ever shrinks, so an uncovered file
// already past the first run does not block it.
function refuseIfUncovered(violations: AnyViolation[]): void {
  const uncovered = violations.filter((v) => v.rule === "uncovered-module");
  if (uncovered.length === 0) return;
  const noun = uncovered.length === 1 ? "file matches" : "files match";
  throw new ReportError(
    `todo's first run refuses: ${uncovered.length} ${noun} no declared module`,
    "add each to declaredModules or exclude in archstrict.config.ts, then run archstrict todo",
  );
}

export function freezeOrPrune(
  projectRoot: string,
  graph: ModuleGraph,
  config: Config,
  violations: AnyViolation[],
): TodoResult {
  const strict = new Set(config.strict ?? []);
  const freezable = violations.filter(isFreezable);

  // graph.rootDir, not the raw projectRoot parameter: rootDir is
  // realpath'd (module-graph.ts's own prepareGraph does this so every
  // relative-path computation agrees with the paths TypeScript itself
  // resolved to), while projectRoot may not be (e.g. macOS's own
  // /tmp -> /private/tmp). Reading and normalizing an absolute stored path
  // against the wrong base would silently fail to relativize it back to
  // what a live violation's own (realpath'd) path relativizes to,
  // un-matching an otherwise-identical entry - the same reasoning
  // check.ts's own applyTodo already applies.
  const rootDir = graph.rootDir;
  const moduleDirs = new Map<string, string>([...graph.modules].map(([name, m]) => [name, m.dir]));
  const parsed = readTodoFile(rootDir);
  // Only consulted when the new file itself is absent - a project already
  // migrated (the new file exists) never re-reads the old layout, even if
  // a stray legacy file somehow still sits on disk.
  const legacy = parsed === undefined ? readLegacyTodoState(rootDir, moduleDirs) : undefined;
  // "First run" is now the new file's own absence, AND no sign the old
  // layout ever ran either - a project moving from the old layout to this
  // one is a migration (folding in whatever the old layout had already
  // frozen), not a fresh first run that would freeze today's live
  // violations instead of what was actually already accepted as debt.
  const firstRun = parsed === undefined && !(legacy?.present ?? false);

  if (firstRun) refuseIfUncovered(violations);

  const currentByModule = new Map<string, TodoEntry[]>();
  if (parsed !== undefined) {
    for (const [name, entries] of parsed.modules) currentByModule.set(name, entries);
  } else if (legacy !== undefined) {
    for (const [name, entries] of legacy.entriesByModule) currentByModule.set(name, entries);
  }

  let added = 0;
  let pruned = 0;
  const nextByModule = new Map<string, TodoEntry[]>();

  for (const name of graph.modules.keys()) {
    const current = currentByModule.get(name) ?? [];
    const currentViolations = freezable.filter((v) => v.todoModule === name);

    if (firstRun) {
      // A strict module never gains an entry, not even on the first run:
      // its violations simply stay reported by check, uncovered by any
      // todo. Every other module's current violations all freeze at once.
      const toFreeze = strict.has(name) ? [] : currentViolations;
      const entries = toFreeze.map((v) => buildTodoEntry(v, graph.relativePath));
      if (entries.length > 0) {
        nextByModule.set(name, entries);
        added += entries.length;
      }
    } else {
      // Prune (and, on a migration run, fold in): keep an existing entry
      // exactly when some current violation still names it (todo-store.ts's
      // own findMatchingEntry, indexed once per module rather than
      // rescanned per violation - see buildTodoIndex's own comment). A
      // strict module's entries prune the same as any other module's -
      // strict blocks this verb from adding, not from shrinking. It never
      // hides an existing entry from check, though: check reports any
      // entry in a strict module's todo as its own violation
      // (clean-module-has-todo), so an entry that survives pruning here
      // still fails check until it's fixed.
      //
      // Every surviving entry is rewritten from the live violation that
      // matched it (todo-store.ts's own buildTodoEntry), not kept
      // byte-for-byte - self-healing for every rule (a legacy entry
      // migrated with an absolute path, or one frozen under an older
      // fingerprint formula, is rewritten into today's shape the first
      // time it's pruned again). One entry's own object identity in
      // `current` (not its content, which duplicate rows can share)
      // decides which live violation refreshes it, so a genuine duplicate
      // stored row - runRules can report the same edge twice - collapses
      // to the one `buildTodoIndex`'s own map can still reference, instead
      // of being rewritten twice over.
      const index = buildTodoIndex(current);
      const matchedViolationByEntry = new Map<TodoEntry, AnyViolation & { todoModule: string }>();
      for (const v of currentViolations) {
        const entry = findMatchingEntry(index, v, graph.relativePath);
        if (entry !== undefined && !matchedViolationByEntry.has(entry)) matchedViolationByEntry.set(entry, v);
      }
      const kept = current
        .filter((e) => matchedViolationByEntry.has(e))
        .map((e) => buildTodoEntry(matchedViolationByEntry.get(e)!, graph.relativePath));
      pruned += current.length - kept.length;
      if (kept.length > 0) nextByModule.set(name, kept);
    }
  }

  // An entry under a module name today's graph no longer declares (the
  // module was renamed or removed since it was frozen) matches no current
  // violation by construction - nothing this run's rules produced even
  // claims that module name - so it can only ever be pruned, never kept or
  // re-added.
  for (const [name, entries] of currentByModule) {
    if (graph.modules.has(name)) continue;
    pruned += entries.length;
  }

  // Written unconditionally, even with an empty module map, so the file's
  // own existence keeps meaning "todo has run" - see todo-store.ts's own
  // writeTodoFile comment.
  writeTodoFile(rootDir, nextByModule);
  if (legacy !== undefined) deleteLegacyTodoFiles(legacy.filesToDelete);

  const bypassesByModule = new Map<string, number>();
  for (const violation of violations) {
    if (violation.rule !== "public-surface-bypass" || !("todoModule" in violation)) continue;
    bypassesByModule.set(violation.todoModule, (bypassesByModule.get(violation.todoModule) ?? 0) + 1);
  }
  const dominant = dominantBypassModule(
    [...graph.modules.values()].map((module) => ({ name: module.name, files: module.files.length })),
    bypassesByModule,
  );
  if (dominant === undefined) return { firstRun, added, pruned };
  return {
    firstRun,
    added,
    pruned,
    notes: [
      `${dominantBypassSentence(dominant)}. Freezing them records one bucket. Split '${dominant.name}' into directories that change together before treating this freeze as done.`,
    ],
  };
}

export async function todo(projectRoot: string): Promise<TodoResult> {
  const configPath = join(projectRoot, "archstrict.config.ts");
  const config = await loadConfig(configPath);
  // See check.ts's own comment: declaredModules is the only source of
  // scope now.
  const graph = buildModuleGraphForRules({
    projectRoot,
    declaredModules: config.declaredModules!,
    exclude: config.exclude,
    surface: config.surface,
  });
  const result = runRules(graph, config);
  return freezeOrPrune(projectRoot, graph, config, result.violations);
}
