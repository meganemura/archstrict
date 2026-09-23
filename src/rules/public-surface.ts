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
import { toProjectRelativePosix, type Edge, type Module, type ModuleGraph } from "../module-graph.js";

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
};

const BECAUSE = "a module's public surface is its only public surface; everything else is private";

// A friend exception (ArchUnit's term): the target file is public to
// exactly the importers `from` matches, private to everyone else - unlike
// `surface`, which is public to every importer equally. Checked only once
// a bypass candidate is already known (surface itself didn't match), the
// same order rule 1's own violation-vs-suppression logic already follows.
function isExemptedByFriend(edge: Edge, targetModule: Module, rootDir: string): boolean {
  const targetRel = toProjectRelativePosix(edge.resolvedFile, rootDir);
  const fromRel = toProjectRelativePosix(edge.fromFile, rootDir);
  return targetModule.friends.some(
    (friend) => compileGlob(friend.fileGlob).test(targetRel) && compileGlob(friend.from).test(fromRel),
  );
}

export function checkPublicSurfaceBypass(graph: ModuleGraph): Violation[] {
  const violations: Violation[] = [];
  for (const edge of graph.crossModuleEdges) {
    const targetModule = graph.modules.get(edge.toModule!);
    if (targetModule === undefined) continue; // resolved outside any module; not this rule's concern
    if (targetModule.surfaceFiles.includes(edge.resolvedFile)) continue; // reached the public surface itself
    if (isExemptedByFriend(edge, targetModule, graph.rootDir)) continue;

    violations.push(violationFor(edge, targetModule.name, targetModule.surfaceFiles, targetModule.surfaceName));
  }
  return violations;
}

function violationFor(
  edge: Edge,
  targetModuleName: string,
  surfaceFiles: readonly string[],
  surface: string | readonly string[],
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
  const doText =
    surfaceFiles.length === 0
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
  };
}
