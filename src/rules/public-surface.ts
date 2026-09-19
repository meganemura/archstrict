// Responsibility: rule 1, the public-surface bypass. A module is private by
// default (Q28): an import from outside a module that reaches a file other
// than that module's public.ts is a violation, and a module with no
// public.ts is entirely private, so every external import into it violates.
// Boundary: pure predicate over a ModuleGraph's cross-module edges. No I/O,
// no output formatting (that is the `check` verb's job), no todo handling
// (that is `todo`'s job).
import type { Edge, ModuleGraph } from "../module-graph.ts";

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
  next: string;
  // Where a todo for this violation is filed: the exposed module, not the
  // importer.
  todoModule: string;
};

const BECAUSE =
  "a module's public.ts is its only public surface; everything else is private (Q28)";

export function checkPublicSurfaceBypass(graph: ModuleGraph): Violation[] {
  const violations: Violation[] = [];
  for (const edge of graph.crossModuleEdges) {
    const targetModule = graph.modules.get(edge.toModule!);
    if (targetModule === undefined) continue; // resolved outside any module; not this rule's concern
    if (edge.resolvedFile === targetModule.publicTsPath) continue; // reached the public surface itself

    violations.push(violationFor(edge, targetModule.name, targetModule.publicTsPath));
  }
  return violations;
}

function violationFor(
  edge: Edge,
  targetModuleName: string,
  publicTsPath: string | undefined,
): Violation {
  const evidence =
    publicTsPath === undefined
      ? `'${edge.specifier}' resolved to module '${targetModuleName}', which has no public.ts`
      : `'${edge.specifier}' resolved to a file inside module '${targetModuleName}' other than its public.ts`;
  const next =
    publicTsPath === undefined
      ? `add a public.ts to ${targetModuleName}/ naming what it exports`
      : `import from ${targetModuleName}/public.ts instead, or add the needed export there`;

  return {
    rule: "public-surface-bypass",
    path: edge.fromFile,
    line: edge.fromPosition.line,
    column: edge.fromPosition.column,
    evidence,
    because: BECAUSE,
    next,
    todoModule: targetModuleName,
  };
}
