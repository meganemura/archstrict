// Responsibility: the `todo` verb (packwerk's shape). Freezes known
// violations per module into archstrict.todo.json, inside the module's own
// directory (so a module's owner sees only their own todo, not a
// project-wide file). First run adds every current freezable violation;
// every later run only prunes entries whose fingerprint no longer matches
// a current violation — todo never adds again after the first run, so
// "run todo" cannot be used to accept a new violation quietly.
// Boundary: freeze/prune policy only. The on-disk shape and fingerprint
// identity live in todo-store.ts, shared with check.ts, so both agree on
// the same identity for the same violation without depending on each other.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildModuleGraph, type ModuleGraph } from "../module-graph.js";
import type { Config } from "../config.js";
import { fingerprintOf, readTodo, writeTodo } from "../todo-store.js";
import { loadConfig, runRules, type AnyViolation } from "./check.js";

// Only a violation with its own todoModule can be frozen: rule 1 (public-
// surface bypass) and rule 2 (cycles) are per-edge/per-relationship
// findings that accumulate as real, gradually-shrinkable debt. Rules 3
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
};

// Whether any module HAS a todo file is not a reliable first-run signal: a
// project with zero freezable violations writes no file at all on its
// first run (writeTodo only creates a file when there is something to
// freeze), so a later run would wrongly read as "first" again and add
// whatever showed up since — exactly what "never add after the first run"
// exists to prevent. Measured directly: a clean project, then a run after
// a violation appeared, both read as firstRun without this marker. A
// project-root marker file records that todo has run at all, independent
// of whether anything was frozen that time.
function markerPath(projectRoot: string): string {
  return join(projectRoot, ".archstrict-todo-initialized");
}

export function freezeOrPrune(
  projectRoot: string,
  graph: ModuleGraph,
  config: Config,
  violations: AnyViolation[],
): TodoResult {
  const strict = new Set(config.strict ?? []);
  const freezable = violations.filter(isFreezable);
  const firstRun = !existsSync(markerPath(projectRoot));

  let added = 0;
  let pruned = 0;

  for (const [name, module] of graph.modules) {
    const current = readTodo(module.dir);
    const currentViolations = freezable.filter((v) => v.todoModule === name);
    const currentFingerprints = new Set(currentViolations.map(fingerprintOf));

    if (firstRun) {
      // A strict module never gains an entry, not even on the first run:
      // its violations simply stay reported by check, uncovered by any
      // todo. Every other module's current violations all freeze at once.
      const toFreeze = strict.has(name) ? [] : currentViolations;
      const entries = toFreeze.map((v) => ({
        fingerprint: fingerprintOf(v),
        rule: v.rule,
        path: v.path,
        evidence: v.evidence,
      }));
      if (entries.length > 0) {
        writeTodo(module.dir, entries);
        added += entries.length;
      }
    } else {
      // Prune only: keep an existing entry exactly when its fingerprint
      // still matches a current violation. A strict module's entries
      // prune the same as any other module's - strict blocks this verb
      // from adding, not from shrinking. It never hides an existing entry
      // from check, though: check reports any entry in a strict module's
      // todo as its own violation (clean-module-has-todo), so an entry
      // that survives pruning here still fails check until it's fixed.
      const kept = current.filter((e) => currentFingerprints.has(e.fingerprint));
      pruned += current.length - kept.length;
      writeTodo(module.dir, kept);
    }
  }

  if (firstRun) writeFileSync(markerPath(projectRoot), "");

  return { firstRun, added, pruned };
}

export async function todo(projectRoot: string): Promise<TodoResult> {
  const configPath = join(projectRoot, "archstrict.config.ts");
  const config = await loadConfig(configPath);
  // See check.ts's own comment: declaredModules is not wired into the live
  // CLI path yet - deliberately deferred to the ticket that also migrates
  // rules 3/4/5.
  const graph = buildModuleGraph({ projectRoot, modulesGlob: config.modules, surface: config.surface });
  const result = runRules(graph, config);
  return freezeOrPrune(projectRoot, graph, config, result.violations);
}
