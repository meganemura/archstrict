// Responsibility: compare proposed source and config changes with the current project through the full rule pipeline.
// Boundary: all changes stay in memory; the baseline and archstrict.todo.json remain inputs from disk.
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import ts from "typescript";
import { buildModuleGraphForRules, DEFAULT_SURFACE, isEligibleSourceFile, isResolvableFile, prepareGraph, type ModuleGraph } from "../module-graph.js";
import { fingerprintOf, relativizeForTodo } from "../todo-store.js";
import { applyTodo, formatText, loadConfig, runRules, type AnyViolation, type CheckResult } from "./check.js";
import { createConfigLocator } from "../config-pointer.js";

export type Change = { path: string; content: string | null };
export type SimulateMode = "scoped" | "whole-project";
export type SimulateResult = { mode: SimulateMode; added: AnyViolation[]; resolved: AnyViolation[]; unchangedCount: number };
export type SimulateOptions = { wholeProject?: boolean };

// A proposed file can belong to a directory that does not exist yet.
// realpathSync would throw for that file or directory. Resolve only the
// nearest existing ancestor, then append the missing segments to preserve
// canonical paths through existing symlinks.
function canonicalChangePath(projectRoot: string, path: string): string {
  const absolute = resolve(projectRoot, path);
  const missing = [basename(absolute)];
  let ancestor = dirname(absolute);
  while (!existsSync(ancestor)) {
    missing.unshift(basename(ancestor));
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`cannot resolve change path: ${path}`);
    ancestor = parent;
  }
  return join(realpathSync(ancestor), ...missing);
}

function overlayHost(options: ts.CompilerOptions, changes: ReadonlyMap<string, string | null>): ts.CompilerHost {
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const directoryExists = host.directoryExists!.bind(host);
  const getDirectories = host.getDirectories!.bind(host);
  // Module resolution can probe directoryExists and getDirectories before
  // it reads a file. File overrides alone cannot resolve an import into a
  // new directory. Include the parents of each added or modified file so
  // the compiler can reach files that exist only in the overlay.
  const directories = new Map<string, Set<string>>();
  for (const [file, content] of changes) {
    if (content === null) continue;
    let directory = dirname(file);
    if (!directories.has(directory)) directories.set(directory, new Set());
    while (dirname(directory) !== directory) {
      const parent = dirname(directory);
      if (!directories.has(parent)) directories.set(parent, new Set());
      directories.get(parent)!.add(basename(directory));
      directory = parent;
    }
  }
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => {
    const content = changes.get(resolve(file));
    if (content === null) return undefined;
    if (content !== undefined) return ts.createSourceFile(file, content, languageVersion);
    return getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.readFile = file => {
    const content = changes.get(resolve(file));
    return content === null ? undefined : content ?? readFile(file);
  };
  host.fileExists = file => {
    const content = changes.get(resolve(file));
    return content === undefined ? fileExists(file) : content !== null;
  };
  host.directoryExists = directory => directories.has(resolve(directory)) || directoryExists(directory);
  host.getDirectories = directory => [...new Set([
    ...(directoryExists(directory) ? getDirectories(directory) : []),
    ...(directories.get(resolve(directory)) ?? []),
  ])];
  return host;
}

function surfaceModuleForPath(graph: ModuleGraph, path: string): string | undefined {
  for (const module of graph.modules.values()) {
    if (module.surfaceFiles.includes(path)) return module.name;
  }
  return undefined;
}

function evaluate(
  graph: ModuleGraph,
  config: Awaited<ReturnType<typeof loadConfig>>,
  locator: ReturnType<typeof createConfigLocator>,
  focusPaths: readonly string[] | undefined,
): AnyViolation[] {
  if (focusPaths === undefined) {
    const result = applyTodo(graph, config, runRules(graph, config, { configLocator: locator }), { configLocator: locator });
    graph.releaseProgram();
    return result.violations;
  }

  const violations = new Map<string, AnyViolation>();
  for (const focus of focusPaths) {
    const focusedTypeLeakModule = surfaceModuleForPath(graph, focus);
    const skipTypeLeak = focusedTypeLeakModule === undefined;
    const result = applyTodo(
      graph,
      config,
      runRules(graph, config, { configLocator: locator, focus, focusedTypeLeakModule, skipTypeLeak }),
      { configLocator: locator, focus, skipStaleCheckForRules: skipTypeLeak ? ["type-leak"] : [] },
    );
    graph.releaseProgram();
    // fingerprintOf needs a project-relative path (see todo-store.ts's own
    // relativizeForTodo) - a live violation's own `path`/`target` is
    // always absolute, so every key computed from one must relativize
    // first, the same as todo.ts's freeze/prune and check.ts's own
    // matching already do.
    for (const violation of result.violations) {
      violations.set(fingerprintOf(relativizeForTodo(violation, graph.relativePath)), violation);
    }
  }
  return [...violations.values()];
}

export async function simulate(
  projectRoot: string,
  changes: readonly Change[],
  simulateOptions: SimulateOptions = {},
): Promise<SimulateResult> {
  projectRoot = realpathSync(projectRoot);
  const configPath = canonicalChangePath(projectRoot, "archstrict.config.ts");
  const beforeConfig = await loadConfig(configPath);
  let proposedSource: string | undefined;
  const contents = new Map<string, string | null>();
  for (const change of changes) {
    if (typeof change?.path !== "string" || change.path.length === 0 ||
        (change.content !== null && typeof change.content !== "string")) {
      throw new Error("each change must have a nonempty path and string or null content");
    }
    const path = canonicalChangePath(projectRoot, change.path);
    if (contents.has(path)) throw new Error(`duplicate change path: ${change.path}`);
    if (path === configPath) {
      if (change.content === null) throw new Error("cannot delete archstrict.config.ts");
      proposedSource = change.content;
    }
    contents.set(path, change.content);
  }
  // The baseline must reflect disk, while every after-side rule uses the proposed config.
  const afterConfig = proposedSource === undefined ? beforeConfig : await loadConfig(configPath, proposedSource);
  // loadConfig already guarantees declaredModules is a well-shaped array
  // (assertDeclaredModulesShapeValid) - see check.ts's own comment.
  const options = { projectRoot, declaredModules: beforeConfig.declaredModules!, exclude: beforeConfig.exclude, surface: beforeConfig.surface };
  const prepared = prepareGraph(options);
  const baseline = buildModuleGraphForRules(options);
  const beforeLocator = createConfigLocator(beforeConfig);
  const mode: SimulateMode = simulateOptions.wholeProject ? "whole-project" : "scoped";
  const focusPaths = simulateOptions.wholeProject ? undefined : [...contents.keys()];
  const before = evaluate(baseline, beforeConfig, beforeLocator, focusPaths);
  const added = new Set<string>();
  const deleted = new Set<string>();
  for (const [file, content] of contents) {
    if (content === null) deleted.add(file);
    else if (!existsSync(file)) added.add(file);
  }
  const host = overlayHost(prepared.compilerOptions, contents);
  // A second preparation keeps rootNames, modules, surfaceFiles, and
  // resolvers consistent through the same computations as a real build.
  // Manual reconstruction missed new surface files and admitted excluded
  // files as roots. Adjust the input list and let preparation derive the
  // metadata again, without changes to the baseline's module objects.
  const listOverride = (realFiles: string[]) => [...new Set([
    ...realFiles.filter(file => !deleted.has(file)),
    ...[...added].filter(isResolvableFile),
  ])];
  const graphOptions = {
    projectRoot, declaredModules: afterConfig.declaredModules!, exclude: afterConfig.exclude,
    surface: afterConfig.surface,
    fileListOverride: (realFiles: string[]) => [...new Set([
      ...realFiles.filter(file => !deleted.has(file)),
      ...[...added].filter(file => isEligibleSourceFile(file, projectRoot, afterConfig.exclude ?? [],
        afterConfig.declaredModules!, afterConfig.surface ?? DEFAULT_SURFACE)),
    ])],
    resolvableFileListOverride: listOverride,
  };
  const simulatedPrepared = prepareGraph(graphOptions);
  const graph = buildModuleGraphForRules(graphOptions, { host, dirtyFiles: new Set(contents.keys()), persistCache: false });
  // graph.edges above already came from this same `host` (buildPreparedGraph's
  // own per-file walk reads through it, then drops each SourceFile once
  // walked - it never keeps one around to inspect). This does not force
  // `graph.program`: rule 6's own Program holds only the type-reachable
  // closure from every module's surface (type-closure.ts), a smaller file
  // list than the simulation's own, so an ordinary change outside that
  // closure would misread here as a host bug that never happened.
  // Instead this calls `host.getSourceFile` directly - the same function
  // a real `ts.createProgram` call uses to load a file's text - for
  // every change, and compares its own text with the change's own
  // content: a deleted file must read back as absent there, and every
  // other change's real SourceFile text must equal what this call asked
  // to write.
  const languageVersion = simulatedPrepared.compilerOptions.target ?? ts.ScriptTarget.ESNext;
  for (const [file, content] of contents) {
    const source = host.getSourceFile(file, languageVersion);
    if (content === null ? source !== undefined : (source === undefined || source.text !== content)) {
      throw new Error(`internal simulation error: overlay mismatch for ${file}`);
    }
  }
  const afterLocator = createConfigLocator(afterConfig, proposedSource);
  const after = evaluate(graph, afterConfig, afterLocator, focusPaths);
  // Both graphs share the same (realpath'd) projectRoot, so `baseline`'s
  // and `graph`'s own relativePath agree on every real file either could
  // name - either one relativizes either side's violations correctly.
  // fingerprintOf itself needs a project-relative path (see
  // todo-store.ts's own relativizeForTodo); a live violation's own
  // `path`/`target` is always absolute.
  const keyOf = (v: AnyViolation) => fingerprintOf(relativizeForTodo(v, baseline.relativePath));
  const beforeFingerprints = new Set(before.map(keyOf));
  const afterFingerprints = new Set(after.map(keyOf));
  return {
    mode,
    added: after.filter(violation => !beforeFingerprints.has(keyOf(violation))),
    resolved: before.filter(violation => !afterFingerprints.has(keyOf(violation))),
    unchangedCount: before.filter(violation => afterFingerprints.has(keyOf(violation))).length,
  };
}

export function formatSimulateText(result: SimulateResult): string {
  const render = (violations: AnyViolation[]) => {
    const report: CheckResult = {
      violations, suggestions: [], modules: 0, modulesWithoutSurface: 0, modulesWithoutSurfaceNames: [], edges: 0, outsideFiles: 0,
      nonTsSourceFiles: 0,
      unresolvedSpecifiers: 0, unresolvedSpecifierBreakdown: [], unsupportedSyntax: 0, typeLeaks: 0,
      todo: 0, edgeRuleCoverage: [],
    };
    const text = formatText(report);
    // Keep the shared violation rendering, but omit counts that describe a full check rather than a change set.
    return text.slice(0, text.lastIndexOf("\nmodules:") + 1);
  };
  return `mode: ${result.mode}\nadded: ${result.added.length}; resolved: ${result.resolved.length}; unchanged: ${result.unchangedCount}\n` +
    (result.added.length ? `added violations:\n${render(result.added)}` : "") +
    (result.resolved.length ? `resolved violations:\n${render(result.resolved)}` : "");
}
