// Responsibility: the `todo` verb (packwerk's shape). Freezes known
// violations into one project-root archstrict.todo.json, grouped by module
// name. First run adds every current freezable violation; every later run
// only prunes entries whose identity no longer matches a current violation
// — todo never adds again after the first run, so "run todo" cannot be
// used to accept a new violation quietly.
// Boundary: freeze/prune policy only. The on-disk shape and
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
import { loadConfig, runRules, type AnyViolation } from "./check.js";
import { dominantBypassModule, dominantBypassSentence } from "./map-shape.js";

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
//
// The message names the first few project-relative paths, then a count of
// the rest. A count alone does not say which file, so the reader has to
// run another command before it can act. `archstrict check --rule
// uncovered-module` already prints the paste-ready entry for every file,
// so the message stops at three paths and points `do` at that command.
const UNCOVERED_PATHS_SHOWN = 3;

function uncoveredPathList(paths: readonly string[]): string {
  const shown = paths.slice(0, UNCOVERED_PATHS_SHOWN).join(", ");
  const rest = paths.length - UNCOVERED_PATHS_SHOWN;
  return rest > 0 ? `${shown} (and ${rest} more)` : shown;
}

function refuseIfUncovered(violations: AnyViolation[], relativePath: ModuleGraph["relativePath"]): void {
  const uncovered = violations.filter((v) => v.rule === "uncovered-module");
  if (uncovered.length === 0) return;
  const noun = uncovered.length === 1 ? "file matches" : "files match";
  // Code-unit order, the same reason checkUncoveredModules sorts: a
  // locale-aware compare can order the same two paths differently on
  // different machines.
  const paths = uncovered.map((v) => relativePath(v.path)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  throw new ReportError(
    `todo's first run refuses: ${uncovered.length} ${noun} no declared module: ${uncoveredPathList(paths)}`,
    "archstrict check --rule uncovered-module",
  );
}

function freezeOrPrune(
  graph: ModuleGraph,
  config: Config,
  violations: AnyViolation[],
): TodoResult {
  // Stryker disable next-line ArrayDeclaration: An injected name does not define a module policy.
  const strict = new Set(config.strict ?? []);
  // Stryker disable next-line MethodExpression: The module-name filter also excludes nonfreezable violations.
  const freezable = violations.filter(isFreezable);

  // rootDir is realpath'd (module-graph.ts's own prepareGraph does this so
  // every relative-path computation agrees with the paths TypeScript itself
  // resolved to).
  const rootDir = graph.rootDir;
  const parsed = readTodoFile(rootDir);
  // "First run" is the file's own absence. A later run only prunes.
  const firstRun = parsed === undefined;

  if (firstRun) refuseIfUncovered(violations, graph.relativePath);

  const currentByModule = new Map<string, TodoEntry[]>();
  if (parsed !== undefined) {
    for (const [name, entries] of parsed.modules) currentByModule.set(name, entries);
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
      // Prune: keep an existing entry exactly when some current violation
      // still names it (todo-store.ts's own findMatchingEntry, indexed once
      // per module rather than rescanned per violation - see buildTodoIndex's
      // own comment). A strict module's entries prune the same as any other
      // module's. Strict blocks this verb from adding, not from shrinking. It never
      // hides an existing entry from check, though: check reports any
      // entry in a strict module's todo as its own violation
      // (clean-module-has-todo), so an entry that survives pruning here
      // still fails check until it's fixed.
      //
      // Every surviving entry is rewritten from the live violation that
      // matched it (todo-store.ts's own buildTodoEntry), not kept
      // byte-for-byte. An entry stored with an absolute path, or frozen
      // under an older fingerprint formula, is rewritten into today's
      // shape the first time it still matches. One entry's own object
      // identity in `current` (not its content, which duplicate rows can
      // share) decides which live violation refreshes it, so a genuine
      // duplicate stored row - runRules can report the same edge twice -
      // collapses to the one `buildTodoIndex`'s own map can still
      // reference, instead of being rewritten twice over.
      const index = buildTodoIndex(current);
      const matchedViolationByEntry = new Map<TodoEntry, AnyViolation & { todoModule: string }>();
      for (const v of currentViolations) {
        const entry = findMatchingEntry(index, v, graph.relativePath);
        // Stryker disable next-line LogicalOperator: Either matching violation can represent the same accepted entry.
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
  const config = await loadConfig(configPath, undefined, "archstrict check", "archstrict todo");
  // See check.ts's own comment: declaredModules is the only source of
  // scope now.
  const graph = buildModuleGraphForRules({
    projectRoot,
    declaredModules: config.declaredModules!,
    exclude: config.exclude,
    surface: config.surface,
  });
  const result = runRules(graph, config);
  return freezeOrPrune(graph, config, result.violations);
}
