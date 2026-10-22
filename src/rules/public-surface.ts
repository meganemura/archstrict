// Responsibility: rule 1, the public-surface bypass. A module is private by
// default, the same posture Bazel's build visibility takes: an import from
// outside a module that reaches a file other than that module's configured
// public surface is a violation, and a module with no surface file present
// is entirely private, so every external import into it violates.
// This counts a type-only (`import type`) edge the same as a value edge:
// reaching an internal file for its types alone still reaches past the
// public surface (module-graph.ts's own header has the contrasting
// decision for cycles).
// Boundary: pure predicate over a ModuleGraph's cross-module edges. No I/O,
// no output formatting (that is the `check` verb's job), no todo handling
// (that is `todo`'s job).
import { compileGlob } from "../classify.js";
import { type Edge, type Module, type ModuleGraph } from "../module-graph.js";
import type { ProjectRelativePath } from "../project-path.js";

export type Violation = {
  rule: "public-surface-bypass";
  // The IMPORTING file, not the module whose internals were reached — the
  // todo this violation freezes into lives in the imported (exposed)
  // module, per the spec, but the fingerprint's own `path` is this file: a
  // rename of the importer changes the fingerprint (correct — a rename is
  // a change), while a rename of the target module's internal file does
  // not (also correct — the violation is about the edge, not the target's
  // internal layout).
  path: string;
  line: number;
  column: number;
  // The import specifier text, plus the module the import actually
  // resolved into — enough for the fingerprint's `evidence` input and for
  // a human or an agent to see what was reached without re-resolving it.
  evidence: string;
  because: string;
  do: string;
  // Where a todo for this violation is filed: the exposed module, not the
  // importer.
  todoModule: string;
  // The debt's own identity, apart from evidence's own explanatory prose:
  // the literal import specifier text, and the real file it resolved to.
  // Both are edge-intrinsic - neither depends on whether THIS bypass's own
  // target module (targetModuleName below) gains or loses a surface,
  // unlike evidence's own sentence, which names that module's surface
  // state directly and so reads differently the moment it changes, even
  // though the edge itself never moved. todo-store.ts's own fingerprintOf
  // reads these two fields instead of evidence for this rule, so a frozen
  // bypass survives its own target module gaining a surface step by step
  // (declaring one surface entry, then another, while the rest of that
  // module's real bypasses stay frozen throughout).
  specifier: string;
  target: string;
};

const BECAUSE = "a module's public surface is its only public surface; everything else is private";

// A friend exception (ArchUnit's term): the target file is public to
// exactly the importers `from` matches, private to everyone else - unlike
// `surface`, which is public to every importer equally. Checked only once
// a bypass candidate is already known (surface itself didn't match), the
// same order rule 1's own violation-vs-suppression logic already follows.
function isExemptedByFriend(edge: Edge, targetModule: Module, relativePath: ProjectRelativePath): boolean {
  const targetRel = relativePath(edge.resolvedFile);
  const fromRel = relativePath(edge.fromFile);
  return targetModule.friends.some(
    (friend) => compileGlob(friend.fileGlob).test(targetRel) && compileGlob(friend.from).test(fromRel),
  );
}

// Every violation this rule returns is reported at `edge.fromFile` (the
// importing file) - never at the target module's own directory or any
// other file. `focus`, when given, is check()'s own realpath'd target for
// a `check <file>` run: filtering `graph.crossModuleEdges` down to the
// ones whose `fromFile` is that exact file, before this rule ever builds a
// Violation object (evidence/do strings, both built by concatenation, are
// this rule's own real cost on a large project), gives back exactly the
// set `filterToFile` would keep from the unscoped result - the same
// (edge -> violation) mapping runs either way, only over fewer edges.
// `edge.fromFile` is compared directly, not through `resolve()`: every
// file in `graph.crossModuleEdges` is already an absolute, real path (the
// module graph builds it that way), the same invariant `filterToFile`
// itself already trusts before comparing a violation's own `path`.
export function checkPublicSurfaceBypass(graph: ModuleGraph, focus?: string): Violation[] {
  const violations: Violation[] = [];
  const edges = focus === undefined ? graph.crossModuleEdges : graph.crossModuleEdges.filter((e) => e.fromFile === focus);
  for (const edge of edges) {
    const targetModule = graph.modules.get(edge.toModule!);
    if (targetModule === undefined) continue; // resolved outside any module; not this rule's concern
    if (targetModule.surfaceFiles.includes(edge.resolvedFile)) continue; // reached the public surface itself
    if (isExemptedByFriend(edge, targetModule, graph.relativePath)) continue;

    violations.push(violationFor(edge, targetModule, graph.relativePath));
  }
  // `graph.crossModuleEdges` follows the edge build's own walk order
  // (rootNames order - a directory scan, not a promise about reading
  // order across files), not a promise about output order - sorted here
  // so this rule's own output stays stable regardless of it, by the same
  // (path, line, column) a reader would scan a file top to bottom.
  // Code-unit order (`<`/`>`), not localeCompare: a locale-aware compare
  // can order the same two paths differently on different machines.
  return violations.sort((a, b) =>
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line || a.column - b.column);
}

function violationFor(edge: Edge, targetModule: Module, relativePath: ProjectRelativePath): Violation {
  const surfaceList = Array.isArray(targetModule.surfaceName)
    ? [...targetModule.surfaceName]
    : [targetModule.surfaceName];
  // Singular reads exactly as before (existing messages, unchanged);
  // plural names every configured entry point instead of picking one
  // arbitrarily. Evidence still names the configuration. The do below
  // names files, because a configured name is not a path that exists.
  const surfaceDisplay = surfaceList.join(", ");

  const evidence =
    targetModule.surfaceFiles.length === 0
      ? `'${edge.specifier}' resolved to module '${targetModule.name}', which has no ${surfaceDisplay}`
      : `'${edge.specifier}' resolved to a file inside module '${targetModule.name}' other than its ${surfaceDisplay}`;

  return {
    rule: "public-surface-bypass",
    path: edge.fromFile,
    line: edge.fromPosition.line,
    column: edge.fromPosition.column,
    evidence,
    because: BECAUSE,
    do: remediation(edge, targetModule, surfaceList, relativePath),
    todoModule: targetModule.name,
    specifier: edge.specifier,
    target: edge.resolvedFile,
  };
}

// The do names files, so following one of its instructions removes this
// violation. A configured name that is not on disk is not an import
// target. When a surface file is present, retargeting the import and
// exporting the symbol are both required, so they are one instruction.
// When none is present, adding a surface file without retargeting the
// import leaves the same edge in place, so that pair is one instruction.
// Setting surface to the file the import already reaches is the other
// instruction, and either one is enough. A file module has no directory
// to add index.ts into, so that case still points at the file the glob
// already names.
function remediation(
  edge: Edge,
  targetModule: Module,
  surfaceList: readonly string[],
  relativePath: ProjectRelativePath,
): string {
  const targetRel = relativePath(edge.resolvedFile);
  if (targetModule.surfaceFiles.length > 0) {
    const present = targetModule.surfaceFiles.map((file) => relativePath(file)).join(", ");
    return `import from ${present} instead of ${targetRel}, adding the export there first if it is missing`;
  }
  if (targetModule.rootIsFile) {
    return `set surface on '${targetModule.name}' to match ${relativePath(targetModule.dir)}, or stop importing it; this module is that file, not a directory`;
  }
  const moduleDir = relativePath(targetModule.dir);
  const importedName = moduleRelative(moduleDir, targetRel);
  // The default surface name is a fallback here, not a file the package
  // publishes. Offer index.ts only when adding it would make the exports
  // map resolve and every analyzed file already sits in the module
  // directory. A file under src/ means ./dist/index.js did not guess the
  // real source, so a new root barrel would be a second entry point.
  if (targetModule.exportsUnresolved === true) {
    const lead = `package.json exports for '${targetModule.name}' did not resolve to a source file.`;
    const setSurface = `set surface: ${JSON.stringify(importedName)} on '${targetModule.name}' in archstrict.config.ts, or stop importing ${targetRel}`;
    if (targetModule.exportsBarrel === "index.ts" && filesSitInModuleDirectory(targetModule, relativePath)) {
      const addedPath = moduleDir === "" ? "index.ts" : `${moduleDir}/index.ts`;
      return `${lead} Add ${addedPath} that re-exports what other modules use and import it instead of ${targetRel}, or ${setSurface}`;
    }
    return `${lead} Set surface: ${JSON.stringify(importedName)} on '${targetModule.name}' in archstrict.config.ts, or stop importing ${targetRel}`;
  }
  const addedName = surfaceFileToAdd(surfaceList);
  const addedPath = moduleDir === "" ? addedName : `${moduleDir}/${addedName}`;
  return `add ${addedPath} that re-exports what other modules use and import it instead of ${targetRel}, or set surface: ${JSON.stringify(importedName)} on '${targetModule.name}' in archstrict.config.ts`;
}

// index.ts is the file the default surface already names, so the common
// case tells the reader to add that file. A module that configured a
// different surface file is told to add that file: adding index.ts would
// not make the retargeted import legal.
function filesSitInModuleDirectory(module: Module, relativePath: ProjectRelativePath): boolean {
  if (module.files.length === 0) return false;
  const dir = relativePath(module.dir);
  const prefix = dir === "" ? "" : `${dir}/`;
  return module.files.every((file) => {
    const rel = relativePath(file);
    const rest = prefix === "" ? rel : rel.startsWith(prefix) ? rel.slice(prefix.length) : rel;
    return !rest.includes("/");
  });
}

function surfaceFileToAdd(surfaceList: readonly string[]): string {
  if (surfaceList.includes("index.ts")) return "index.ts";
  const plain = surfaceList.find((name) => !/[*?{}[\]]/.test(name));
  return plain ?? "index.ts";
}

function moduleRelative(moduleDir: string, targetRel: string): string {
  if (moduleDir === "") return targetRel;
  const prefix = `${moduleDir}/`;
  return targetRel.startsWith(prefix) ? targetRel.slice(prefix.length) : targetRel;
}
