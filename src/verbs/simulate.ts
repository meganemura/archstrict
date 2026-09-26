// Responsibility: compare proposed source and config changes with the current project through the full rule pipeline.
// Boundary: all changes stay in memory; the baseline and todo files remain inputs from disk.
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import ts from "typescript";
import { buildPreparedGraph, DEFAULT_SURFACE, isEligibleSourceFile, prepareGraph } from "../module-graph.js";
import { fingerprintOf } from "../todo-store.js";
import { applyTodo, formatText, loadConfig, runRules, type AnyViolation, type CheckResult } from "./check.js";

export type Change = { path: string; content: string | null };
export type SimulateResult = { added: AnyViolation[]; resolved: AnyViolation[]; unchangedCount: number };

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

export async function simulate(projectRoot: string, changes: readonly Change[]): Promise<SimulateResult> {
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
  const baseline = buildPreparedGraph(prepared);
  const before = applyTodo(baseline, beforeConfig, runRules(baseline, beforeConfig));
  const roots = new Set(prepared.rootNames);
  const added = new Set<string>();
  const deleted = new Set<string>();
  for (const [file, content] of contents) {
    if (content === null) deleted.add(file);
    else if (!roots.has(file)) added.add(file);
  }
  const host = overlayHost(prepared.compilerOptions, contents);
  // A second preparation keeps rootNames, modules, surfaceFiles, and
  // resolvers consistent through the same computations as a real build.
  // Manual reconstruction missed new surface files and admitted excluded
  // files as roots. Adjust the input list and let preparation derive the
  // metadata again, without changes to the baseline's module objects.
  const simulatedPrepared = prepareGraph({
    projectRoot, declaredModules: afterConfig.declaredModules!, exclude: afterConfig.exclude,
    surface: afterConfig.surface,
    fileListOverride: realFiles => [...new Set([
      ...realFiles.filter(file => !deleted.has(file)),
      ...[...added].filter(file => isEligibleSourceFile(file, projectRoot, afterConfig.exclude ?? [],
        afterConfig.declaredModules!, afterConfig.surface ?? DEFAULT_SURFACE)),
    ])],
  });
  // `baseline.program` is a lazy getter, but `before` above already forces
  // it: runRules always evaluates rule 6 (type-leak) here, with no file
  // scope to skip it by (unlike check.ts's own `check <file>`). Passing it
  // as oldProgram costs nothing extra beyond that - it accelerates this
  // second Program build by reusing the baseline's own unaffected
  // SourceFiles.
  //
  // No `resolutionCache` override here, deliberately: buildPreparedGraph's
  // own per-options caching already gives each file's own nearest tsconfig
  // (compilerOptionsForFile) its own cache. One shared cache across every
  // file, keyed by the root options alone, could return a resolution
  // cached under one tsconfig's `paths`/`baseUrl` for a specifier text
  // that means something different under another file's own tsconfig.
  const graph = buildPreparedGraph(simulatedPrepared, { host, oldProgram: baseline.program });
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
  const after = applyTodo(graph, afterConfig, runRules(graph, afterConfig));
  const beforeFingerprints = new Set(before.violations.map(fingerprintOf));
  const afterFingerprints = new Set(after.violations.map(fingerprintOf));
  return {
    added: after.violations.filter(violation => !beforeFingerprints.has(fingerprintOf(violation))),
    resolved: before.violations.filter(violation => !afterFingerprints.has(fingerprintOf(violation))),
    unchangedCount: before.violations.filter(violation => afterFingerprints.has(fingerprintOf(violation))).length,
  };
}

export function formatSimulateText(result: SimulateResult): string {
  const render = (violations: AnyViolation[]) => {
    const report: CheckResult = {
      violations, suggestions: [], modules: 0, modulesWithoutSurface: 0, edges: 0, outsideFiles: 0,
      nonTsSourceFiles: 0,
      unresolvedSpecifiers: 0, unresolvedSpecifierBreakdown: [], unsupportedSyntax: 0, typeLeaks: 0,
      todo: 0, edgeRuleCoverage: [],
    };
    const text = formatText(report);
    // Keep the shared violation rendering, but omit counts that describe a full check rather than a change set.
    return text.slice(0, text.lastIndexOf("\nmodules:") + 1);
  };
  return `added: ${result.added.length}; resolved: ${result.resolved.length}; unchanged: ${result.unchangedCount}\n` +
    (result.added.length ? `added violations:\n${render(result.added)}` : "") +
    (result.resolved.length ? `resolved violations:\n${render(result.resolved)}` : "");
}
