// Responsibility: plan type re-exports and keep each surface edit only after real rule verification.
// Boundary: fixes surface files only; preserves frozen violations and leaves internal declarations unchanged.
import ts from "typescript";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { prepareGraph, type ModuleGraph } from "../module-graph.js";
import { createWarmGraph } from "../warm-graph.js";
import { fingerprintOf, relativizeForTodo, type ViolationForTodo } from "../todo-store.js";
import type { Violation } from "../rules/type-leak.js";
import { loadConfig, runRules, applyTodo, filterToFile } from "./check.js";
import { resolveWriteTarget, writeTarget } from "./agents.js";
import { createConfigLocator } from "../config-pointer.js";

export type FixResult = {
  fixed: { path: string; lines: string[] }[];
  planned: { path: string; lines: string[] }[];
  unfixable: { path: string; type: string; reason: string }[];
  reverted: { path: string; reason: string }[];
  // Set only when rule 6's own closure Program (type-closure.ts) had to
  // fall back to the whole-project Program on any refresh this call
  // made - the same shape and the same convention `check`'s own `notes`
  // follows (undefined, never an empty array, on every ordinary run).
  notes?: string[];
};

// A bare interface or type can leak through an inferred return type without its declaring file ever exporting it.
// Re-exporting that declaration produces TS2459, but the surface's new export name can make the type-leak rule report success.
// Verification runs architecture rules, not a full semantic-diagnostics pass, so this guard must reject the declaration before any write.
function exportedFromInternal(graph: ModuleGraph, leak: NonNullable<Violation["leak"]>): boolean {
  const source = graph.program.getSourceFile(leak.internalFile);
  const symbol = source === undefined ? undefined : graph.checker.getSymbolAtLocation(source);
  return symbol !== undefined && graph.checker.getExportsOfModule(symbol).some(entry => entry.name === leak.internalType);
}

export async function fix(projectRoot: string, file?: string, dryRun = false): Promise<FixResult> {
  const result: FixResult = { fixed: [], planned: [], unfixable: [], reverted: [] };
  const focus = file === undefined ? undefined : resolve(projectRoot, file);
  if (focus !== undefined && !existsSync(focus)) return result;
  const config = await loadConfig(resolve(projectRoot, "archstrict.config.ts"));
  const configLocator = createConfigLocator(config);
  // loadConfig already guarantees declaredModules is a well-shaped array
  // (assertDeclaredModulesShapeValid) - see check.ts's own comment.
  const options = { projectRoot, declaredModules: config.declaredModules!, exclude: config.exclude, surface: config.surface };
  const warm = createWarmGraph();
  let graph = warm.refresh(options);
  // fingerprintOf needs a project-relative path (see todo-store.ts's own
  // relativizeForTodo) - a live violation's own `path`/`target` is always
  // absolute. Reads `graph` fresh on every call (not captured once): the
  // graph is reassigned after each write below, but `options.projectRoot`
  // never changes, so relativePath's own output stays consistent across
  // the reassignment.
  const keyOf = (v: ViolationForTodo) => fingerprintOf(relativizeForTodo(v, graph.relativePath));
  const notesSeen = new Set<string>();
  const evaluate = () => {
    const evaluated = applyTodo(
      graph,
      config,
      runRules(graph, config, { configLocator }),
      { configLocator },
    );
    for (const note of graph.programNotes) notesSeen.add(note);
    return evaluated;
  };
  const baseline = evaluate();
  const baselineKeys = new Set(baseline.violations.map(keyOf));
  const scoped = focus === undefined ? baseline : filterToFile(baseline, focus);
  const files = new Map<string, Violation[]>();
  for (const violation of scoped.violations) {
    if (violation.rule !== "type-leak") continue;
    const group = files.get(violation.path) ?? [];
    group.push(violation);
    files.set(violation.path, group);
  }
  const prepared = prepareGraph(options);
  const host = ts.createCompilerHost(prepared.compilerOptions);
  for (const [path, leaks] of files) {
    const declarations = new Map<string, Set<string>>();
    for (const { leak } of leaks) {
      if (leak === undefined) continue;
      const sources = declarations.get(leak.internalType) ?? new Set<string>();
      sources.add(leak.internalFile);
      declarations.set(leak.internalType, sources);
    }
    // Rule 6 checks exported names, so one re-export can make two distinct declarations with the same name appear fixed.
    // Consumers of the other declaration would receive the wrong type. A partial fix cannot resolve which declaration should own the name.
    // Leave the whole file unchanged until a human resolves the collision, including the otherwise fixable leaks.
    const collisions = [...declarations].filter(([, sources]) => sources.size > 1);
    if (collisions.length > 0) {
      const reason = collisions.map(([name, sources]) => `name collision for '${name}' in ${[...sources].sort().join(", ")}; rename by hand`).join("; ");
      for (const violation of leaks) result.unfixable.push({ path, type: violation.leak?.internalType ?? "unknown", reason });
      continue;
    }
    const groups = new Map<string, Set<string>>();
    const targeted = new Set<string>();
    for (const violation of leaks) {
      const leak = violation.leak;
      if (leak === undefined) {
        result.unfixable.push({ path, type: "unknown", reason: "structured leak information is unavailable" });
        continue;
      }
      if (!exportedFromInternal(graph, leak)) {
        result.unfixable.push({ path, type: leak.internalType,
          reason: `the internal declaration itself is not exported from its own file '${leak.internalFile}' - add export to its declaration first, or fix by hand` });
        continue;
      }
      const rel = relative(dirname(path), leak.internalFile).split(sep).join("/").replace(/(?:\.d)?\.[cm]?tsx?$/, "");
      const base = rel.startsWith("../") ? rel : `./${rel}`;
      // A formatted relative path can still fail under the compiler's extension and module resolution rules.
      // Require the real resolver to confirm the exact internal file before emitting a specifier that only appears correct.
      const specifier = [`${base}.js`, base, `${base}.ts`].find(candidate =>
        ts.resolveModuleName(candidate, path, prepared.compilerOptionsForFile(path), host).resolvedModule?.resolvedFileName === leak.internalFile);
      if (specifier === undefined) {
        result.unfixable.push({ path, type: leak.internalType, reason: `no candidate specifier resolves to '${leak.internalFile}'` });
        continue;
      }
      const names = groups.get(specifier) ?? new Set<string>();
      names.add(leak.internalType);
      groups.set(specifier, names);
      targeted.add(keyOf(violation));
    }
    const lines = [...groups.keys()].sort().map(specifier =>
      `export type { ${[...groups.get(specifier)!].sort().join(", ")} } from ${JSON.stringify(specifier)};`);
    if (lines.length === 0) continue;
    if (dryRun) {
      result.planned.push({ path, lines });
      continue;
    }
    // A re-export can remove a type leak while crossing a module boundary that the project's tag rules forbid.
    // Compare the full violation set with baselineKeys: the regression can appear elsewhere, even when every targeted leak disappears.
    // Restore the original bytes on failure so a locally successful type fix cannot leave a new architecture violation behind.
    const target = resolveWriteTarget(path);
    const original = readFileSync(target);
    const firstNewline = original.indexOf(10);
    const newline = firstNewline > 0 && original[firstNewline - 1] === 13 ? "\r\n" : "\n";
    const separator = original.length > 0 && original[original.length - 1] !== 10 ? newline : "";
    const updated = Buffer.concat([original, Buffer.from(separator + lines.join(newline) + newline)]);
    let failure: string | undefined;
    try {
      writeTarget(target, updated);
      graph = warm.refresh(options);
      const after = evaluate();
      if (after.violations.some(v => v.rule === "type-leak" && v.path === path && targeted.has(keyOf(v)))) {
        failure = "verification still reports a targeted type leak";
      } else if (after.violations.some(v => !baselineKeys.has(keyOf(v)))) {
        failure = "verification reports a new violation";
      }
    } catch (error) {
      failure = `verification or write failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (failure !== undefined) {
      // A failure that blocks the first write can also block the revert at the same path.
      // Preserve both failures so the report does not imply that restoration succeeded.
      try {
        writeTarget(target, original);
      } catch (error) {
        failure += `; revert failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      graph = warm.refresh(options);
      result.reverted.push({ path, reason: failure });
    } else {
      result.fixed.push({ path, lines });
    }
  }
  if (notesSeen.size > 0) result.notes = [...notesSeen];
  return result;
}

export function formatFixText(result: FixResult): string {
  const lines: string[] = [];
  for (const category of ["fixed", "planned"] as const) {
    for (const entry of result[category]) lines.push(`${category}: ${entry.path}`, ...entry.lines);
  }
  for (const entry of result.unfixable) lines.push(`unfixable: ${entry.path} (${entry.type}): ${entry.reason}`);
  for (const entry of result.reverted) lines.push(`reverted: ${entry.path}: ${entry.reason}`);
  lines.push(`fixed: ${result.fixed.length}; planned: ${result.planned.length}; unfixable: ${result.unfixable.length}; reverted: ${result.reverted.length}`);
  for (const note of result.notes ?? []) lines.push(`note: ${note}`);
  return lines.join("\n") + "\n";
}
