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

    violations.push(
      violationFor(
        edge,
        targetModule.name,
        targetModule.surfaceFiles,
        targetModule.surfaceName,
        // A file module has nowhere to "add a index.ts". The relative path
        // is the file the glob already names, so the fix can point at it.
        targetModule.rootIsFile ? graph.relativePath(targetModule.dir) : undefined,
      ),
    );
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

function violationFor(
  edge: Edge,
  targetModuleName: string,
  surfaceFiles: readonly string[],
  surface: string | readonly string[],
  // Set when the module root is a file. Undefined for a directory module,
  // whose remediation still names `<module>/<surface>`.
  fileModuleRel: string | undefined,
): Violation {
  const surfaceList = Array.isArray(surface) ? surface : [surface as string];
  // Singular reads exactly as before (existing messages, unchanged);
  // plural names every real, configured entry point instead of picking
  // one arbitrarily.
  const surfaceDisplay = surfaceList.join(", ");
  const addArticle = surfaceList.length === 1 ? "a" : "one of";
  const importTargets = surfaceList.map((s) => `${targetModuleName}/${s}`).join(", ");

  const evidence =
    surfaceFiles.length === 0
      ? `'${edge.specifier}' resolved to module '${targetModuleName}', which has no ${surfaceDisplay}`
      : `'${edge.specifier}' resolved to a file inside module '${targetModuleName}' other than its ${surfaceDisplay}`;
  // `<module>/` is a directory. A glob that names one file has no such
  // directory, so the fix names that file instead of telling the reader
  // to add a surface file inside the module name.
  const doText =
    fileModuleRel !== undefined
      ? surfaceFiles.length === 0
        ? `set surface on '${targetModuleName}' to match ${fileModuleRel}, or stop importing it; this module is that file, not a directory`
        : `import from ${fileModuleRel} instead, or add the needed export there`
      : surfaceFiles.length === 0
        ? `add ${addArticle} ${surfaceDisplay} to ${targetModuleName}/ naming what it exports`
        : `import from ${importTargets} instead, or add the needed export there`;

  return {
    rule: "public-surface-bypass",
    path: edge.fromFile,
    line: edge.fromPosition.line,
    column: edge.fromPosition.column,
    evidence,
    because: BECAUSE,
    do: doText,
    todoModule: targetModuleName,
    specifier: edge.specifier,
    target: edge.resolvedFile,
  };
}
