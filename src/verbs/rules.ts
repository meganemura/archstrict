// Responsibility: describe a current or proposed path using the project's config.
// Boundary: reuses graph membership and violation constructors; does not project edge constraints.
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { classifyFile, compileGlob } from "../classify.js";
import { buildModuleGraph, DEFAULT_SURFACE, moduleForDeclaredFile, surfaceGlobsFor, toProjectRelativePosix } from "../module-graph.js";
import { checkMustBeEmpty, type Violation as MustBeEmptyViolation } from "../rules/must-be-empty.js";
import { uncoveredViolationFor, type Violation as UncoveredViolation } from "../rules/uncovered.js";
import { loadConfig } from "./check.js";

export type RulesResult = {
  path: string;
  exists: boolean;
  excluded: boolean;
  module: string | undefined;
  tags: string[];
  isSurfaceFile: boolean;
  importableFrom: { module: string; surfaceFiles: string[] }[];
  friendAccess: { module: string; file: string; from: string; because: string }[];
  mustBeEmptyViolation: MustBeEmptyViolation | undefined;
  uncoveredViolation: UncoveredViolation | undefined;
};

// The graph uses real paths. Resolve existing ancestors so new paths also
// agree with it through directory symlinks, including macOS temporary roots.
function canonicalPath(path: string): string {
  const missing: string[] = [];
  let ancestor = path;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    missing.unshift(relative(parent, ancestor));
    ancestor = parent;
  }
  return join(realpathSync(ancestor), ...missing);
}

export async function rules(projectRoot: string, path: string): Promise<RulesResult> {
  const root = realpathSync(projectRoot);
  const resolvedPath = canonicalPath(resolve(path));
  const rel = toProjectRelativePosix(resolvedPath, root);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error(`rules ${path}: path is outside project root '${root}'`);
  }
  const config = await loadConfig(resolve(root, "archstrict.config.ts"));
  const graph = buildModuleGraph({ projectRoot: root, declaredModules: config.declaredModules, exclude: config.exclude });
  const exists = existsSync(resolvedPath);
  const excluded = (config.exclude ?? []).some((glob) => compileGlob(glob).test(rel));
  let module: string | undefined;
  let isSurfaceFile = false;
  if (exists) {
    const owner = [...graph.modules.values()].find((m) => m.files.includes(resolvedPath));
    module = owner?.name;
    isSurfaceFile = owner?.surfaceFiles.includes(resolvedPath) ?? false;
  } else {
    module = moduleForDeclaredFile(resolvedPath, root, config.declaredModules ?? []);
    const declaration = config.declaredModules?.find((dm) => dm.name === module);
    if (declaration !== undefined) {
      isSurfaceFile = surfaceGlobsFor(declaration, root, config.surface ?? DEFAULT_SURFACE)
        .some((glob) => compileGlob(glob).test(rel));
    }
  }
  const modules = [...graph.modules.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    path: resolvedPath,
    exists,
    excluded,
    module,
    tags: [...classifyFile(rel, config)].sort(),
    isSurfaceFile,
    importableFrom: modules.filter((m) => m.name !== module && m.surfaceFiles.length > 0)
      .map((m) => ({ module: m.name, surfaceFiles: m.surfaceFiles })),
    friendAccess: modules.flatMap((m) => m.friends
      .filter((friend) => compileGlob(friend.from).test(rel))
      .map((friend) => ({ module: m.name, file: friend.fileGlob, from: friend.from, because: friend.because }))),
    mustBeEmptyViolation: excluded ? undefined : checkMustBeEmpty([rel], config)[0],
    uncoveredViolation: !excluded && (exists ? graph.outsideFiles.includes(resolvedPath) : module === undefined)
      ? uncoveredViolationFor(resolvedPath, graph.rootDir) : undefined,
  };
}

export function formatRulesText(result: RulesResult): string {
  const lines: string[] = [];
  if (result.excluded) lines.push("excluded - out of scope, none of the following apply");
  lines.push(
    `path: ${result.path}`,
    `exists: ${result.exists}`,
    `excluded: ${result.excluded ? "yes" : "no"}`,
    `module: ${result.module ?? "(none)"}`,
    `tags: ${result.tags.length > 0 ? result.tags.join(", ") : "(none)"}`,
    `surface file: ${result.isSurfaceFile ? "yes" : "no"}`,
    `must-be-empty: ${result.excluded ? "out of scope" : result.mustBeEmptyViolation ? "violation" : "ok"}`,
  );
  for (const violation of [result.mustBeEmptyViolation, result.uncoveredViolation]) {
    if (violation === undefined) continue;
    lines.push(`[${violation.rule}] ${violation.path}:${violation.line}:${violation.column}`,
      `  evidence: ${violation.evidence}`, `  because: ${violation.because}`, `  next: ${violation.next}`);
  }
  lines.push(`importable from:${result.importableFrom.length === 0 ? " (none)" : ""}`);
  for (const entry of result.importableFrom) {
    for (const file of entry.surfaceFiles) lines.push(`  ${entry.module} -> ${file}`);
  }
  lines.push(`friend access:${result.friendAccess.length === 0 ? " (none)" : ""}`);
  for (const entry of result.friendAccess) {
    lines.push(`  ${entry.module} -> ${entry.file}`, `    from: ${entry.from}`, `    because: ${entry.because}`);
  }
  return lines.join("\n") + "\n";
}
