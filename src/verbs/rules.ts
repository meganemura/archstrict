// Responsibility: describe a current or proposed path using the project's config.
// Boundary: projects source-side constraints; actual target evaluation remains with check.
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { classifyFile, compileGlob } from "../classify.js";
import { buildModuleGraph, DEFAULT_SURFACE, moduleForDeclaredFile, surfaceGlobsFor, toProjectRelativePosix } from "../module-graph.js";
import { checkMustBeEmpty, type Violation as MustBeEmptyViolation } from "../rules/must-be-empty.js";
import { uncoveredViolationFor, type Violation as UncoveredViolation } from "../rules/uncovered.js";
import { assertSequenceListsValue, formatPredicate, matchesPredicate, sequenceFor } from "../rules/constraints.js";
import { loadConfig } from "./check.js";

export type AllowDenyProjection = {
  source: string;
  targetNamespace: string;
  allow: string[] | undefined;
  deny: string[] | undefined;
  sameGroupExempt: true;
  exceptionsFromP: { to: string; because: string }[];
  edgeType: "value" | "type" | "both";
  importForm: "static" | "dynamic" | "both";
  because: string;
};

export type OrderProjection = {
  tagNamespace: string;
  within: string | undefined;
  ownLayer: string;
  sequence: string[];
  mayDependOn: string[];
  edgeType: "value" | "type" | "both";
  importForm: "static" | "dynamic" | "both";
  because: string;
};

export type PointProjection = {
  identifier: string;
  forbiddenTo: string;
  edgeType: "value" | "type" | "both";
  importForm: "static" | "dynamic" | "both";
  because: string;
};

export type RulesResult = {
  allowDenyConstraints: AllowDenyProjection[];
  orderConstraints: OrderProjection[];
  pointConstraints: PointProjection[];
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
  const tags = [...classifyFile(rel, config)].sort();
  const allowDenyConstraints: AllowDenyProjection[] = (config.edges?.allowDeny ?? [])
    .filter((rule) => tags.includes(rule.source))
    .map((rule) => ({
      source: rule.source,
      targetNamespace: rule.targetNamespace,
      allow: rule.allow ? [...rule.allow] : undefined,
      deny: rule.deny ? [...rule.deny] : undefined,
      sameGroupExempt: true,
      exceptionsFromP: (rule.exceptions ?? []).filter((ex) => compileGlob(ex.from).test(rel))
        .map((ex) => ({ to: ex.to, because: ex.because })),
      edgeType: rule.edgeType ?? "both",
      importForm: rule.importForm ?? "both",
      because: rule.because,
    }));
  const orderConstraints: OrderProjection[] = [];
  for (const rule of config.edges?.order ?? []) {
    const ownLayerTag = tags.find((tag) => tag.startsWith(`${rule.tagNamespace}:`));
    if (ownLayerTag === undefined) continue;
    let withinValue: string | undefined;
    if (rule.within !== undefined) {
      const withinTag = tags.find((tag) => tag.startsWith(`${rule.within}:`));
      if (withinTag === undefined) continue;
      withinValue = withinTag.slice(rule.within.length + 1);
    }
    const sequence = sequenceFor(rule, withinValue);
    if (sequence === undefined) continue;
    // Detect the same configuration error as check before an edge exists:
    // the queried path's own layer must already be placed in its sequence.
    assertSequenceListsValue(rule, withinValue, sequence, ownLayerTag);
    const ownLayer = ownLayerTag.slice(rule.tagNamespace.length + 1);
    const idx = sequence.indexOf(ownLayer);
    orderConstraints.push({
      tagNamespace: rule.tagNamespace,
      within: rule.within,
      ownLayer,
      sequence: [...sequence],
      // computeOrder permits targetIndex <= sourceIndex (downward-only),
      // so this prefix includes the queried path's own layer.
      mayDependOn: sequence.slice(0, idx + 1),
      edgeType: rule.edgeType ?? "both",
      importForm: rule.importForm ?? "both",
      because: rule.because,
    });
  }
  const pointConstraints: PointProjection[] = (config.edges?.point ?? [])
    .filter((rule) => matchesPredicate(rule.from, rel, new Set(tags)))
    .map((rule) => ({
      identifier: `${formatPredicate(rule.from)} -> ${formatPredicate(rule.to)}`,
      forbiddenTo: formatPredicate(rule.to),
      edgeType: rule.edgeType ?? "both",
      importForm: rule.importForm ?? "both",
      because: rule.because,
    }));
  return {
    allowDenyConstraints,
    orderConstraints,
    pointConstraints,
    path: resolvedPath,
    exists,
    excluded,
    module,
    tags,
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
  lines.push(`allowDeny constraints:${result.allowDenyConstraints.length === 0 ? " (none)" : ""}`);
  for (const entry of result.allowDenyConstraints) {
    lines.push(`  source: ${entry.source}`, `  target namespace: ${entry.targetNamespace}`,
      `  allow: ${entry.allow === undefined ? "(unset)" : JSON.stringify(entry.allow)}`,
      `  deny: ${entry.deny === undefined ? "(unset)" : JSON.stringify(entry.deny)}`,
      `  same group exempt: ${entry.sameGroupExempt}`,
      `  exceptions from path: ${entry.exceptionsFromP.length === 0 ? "(none)" : JSON.stringify(entry.exceptionsFromP)}`,
      `  edge type: ${entry.edgeType}`, `  import form: ${entry.importForm}`, `  because: ${entry.because}`);
  }
  lines.push(`order constraints:${result.orderConstraints.length === 0 ? " (none)" : ""}`);
  for (const entry of result.orderConstraints) {
    lines.push(`  tag namespace: ${entry.tagNamespace}`, `  within: ${entry.within ?? "(unscoped)"}`,
      `  own layer: ${entry.ownLayer}`, `  sequence: ${JSON.stringify(entry.sequence)}`,
      `  may depend on: ${JSON.stringify(entry.mayDependOn)}`,
      `  edge type: ${entry.edgeType}`, `  import form: ${entry.importForm}`, `  because: ${entry.because}`);
  }
  lines.push(`point constraints:${result.pointConstraints.length === 0 ? " (none)" : ""}`);
  for (const entry of result.pointConstraints) {
    lines.push(`  identifier: ${entry.identifier}`, `  forbidden to: ${entry.forbiddenTo}`,
      `  edge type: ${entry.edgeType}`, `  import form: ${entry.importForm}`, `  because: ${entry.because}`);
  }
  return lines.join("\n") + "\n";
}
