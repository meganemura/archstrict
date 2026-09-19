// Responsibility: rule 2, module-level cycles. Two or more modules that
// import each other, directly or transitively, form a cycle.
// Boundary: pure predicate over a ModuleGraph's cross-module edges, at
// module granularity (a file-level cycle inside one module is not this
// rule's concern). No I/O, no output formatting.
//
// Decision: a type-only (`import type`) edge does NOT count toward a
// cycle. A type-only cycle has no runtime consequence — TypeScript itself
// allows it — and counting it would produce violations nobody can act on.
// This is the opposite of rule 1 (public-surface.ts), which counts a
// type-only edge the same as a value edge; module-graph.ts's own header
// has both decisions side by side.
//
// Decision: one violation per cycle (per strongly connected component,
// really — a component may hold more than one simple cycle, and this
// reports the component once, with its shortest simple cycle as
// evidence), not one per edge in it. Placement (spec, undecided by the
// task spec, left to this implementation): the todo for a cycle goes on
// the name-first module among the ones in it — an arbitrary but stable
// and deterministic choice, so re-running `check` always picks the same
// module for the same cycle.
import type { Edge, ModuleGraph } from "../module-graph.ts";

export type Violation = {
  rule: "cycle";
  path: string;
  line: number;
  column: number;
  evidence: string;
  because: string;
  next: string;
  todoModule: string;
};

const BECAUSE = "modules that import each other cannot be reasoned about, tested, or replaced independently";

type ModuleEdge = { to: string; edge: Edge };

function buildAdjacency(graph: ModuleGraph): Map<string, ModuleEdge[]> {
  const adjacency = new Map<string, ModuleEdge[]>();
  const seenPairs = new Set<string>();
  for (const edge of graph.crossModuleEdges) {
    if (edge.isTypeOnly) continue; // decision above: type-only edges don't count for cycles
    const to = edge.toModule!;
    const pairKey = `${edge.fromModule}->${to}`;
    if (seenPairs.has(pairKey)) continue; // one representative edge per (from, to) pair is enough
    seenPairs.add(pairKey);
    const list = adjacency.get(edge.fromModule) ?? [];
    list.push({ to, edge });
    adjacency.set(edge.fromModule, list);
  }
  return adjacency;
}

// Tarjan's algorithm: strongly connected components of size > 1 are cycles
// (a module-level self-loop cannot occur here — crossModuleEdges already
// excludes same-module edges).
function stronglyConnectedComponents(
  nodes: string[],
  adjacency: Map<string, ModuleEdge[]>,
): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  function strongconnect(v: string): void {
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const { to: w } of adjacency.get(v) ?? []) {
      if (!indices.has(w)) {
        strongconnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      components.push(component);
    }
  }

  for (const node of nodes) {
    if (!indices.has(node)) strongconnect(node);
  }
  return components;
}

// Shortest simple cycle that visits `start`, using only edges within
// `component` (BFS over paths, since module graphs are small — v0 does not
// need this to scale past a few dozen modules).
function shortestCycleFrom(
  start: string,
  component: Set<string>,
  adjacency: Map<string, ModuleEdge[]>,
): { modules: string[]; edges: Edge[] } {
  type QueueItem = { node: string; path: string[]; edges: Edge[] };
  const queue: QueueItem[] = [{ node: start, path: [start], edges: [] }];
  while (queue.length > 0) {
    const { node, path, edges } = queue.shift()!;
    for (const { to, edge } of adjacency.get(node) ?? []) {
      if (!component.has(to)) continue;
      if (to === start) return { modules: [...path, start], edges: [...edges, edge] };
      if (path.includes(to)) continue; // simple cycle only; don't revisit a node
      queue.push({ node: to, path: [...path, to], edges: [...edges, edge] });
    }
  }
  // Invariant, not error handling: every node in a strongly connected
  // component of size > 1 lies on some cycle within it, so this branch is
  // unreachable for a genuine SCC. It only fires if `component` was built
  // wrong (e.g. from a stale or mismatched adjacency).
  throw new Error(`no cycle found from ${start} within its own strongly connected component`);
}

export function checkCycles(graph: ModuleGraph): Violation[] {
  const adjacency = buildAdjacency(graph);
  const nodes = [...graph.modules.keys()];
  const components = stronglyConnectedComponents(nodes, adjacency).filter((c) => c.length > 1);

  const violations: Violation[] = [];
  for (const component of components) {
    const sorted = [...component].sort();
    const anchor = sorted[0]!;
    const { modules, edges } = shortestCycleFrom(anchor, new Set(component), adjacency);
    const firstEdge = edges[0]!;

    violations.push({
      rule: "cycle",
      path: firstEdge.fromFile,
      line: firstEdge.fromPosition.line,
      column: firstEdge.fromPosition.column,
      evidence: modules.join(" -> "),
      because: BECAUSE,
      next: `break the cycle at ${modules[0]} -> ${modules[1]}, or merge the modules involved`,
      todoModule: anchor,
    });
  }
  return violations;
}
