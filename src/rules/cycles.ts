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
//
// Decision: a cycle's do: leads with the minority direction of its most
// lopsided module pair. A survey of two-module value cycles across real
// codebases found the
// smaller side had only 1-3 edges in about 63% of pairs (one editor<->
// platform pair was 951 edges one way, 1 the other) - the minority
// direction is usually the accident, and the majority direction the
// intended one, so naming the minority side's own few imports first
// points at the likely, cheap fix instead of an arbitrary edge on the
// shortest simple cycle. "Lopsided" is deliberately absolute-and-relative
// together (minority <= 3 AND majority >= 3x minority): a relative
// threshold alone would call 40-vs-15 lopsided, which is not a few
// imports to delete; an absolute threshold alone would call 3-vs-4
// lopsided, which is not dominated by either side. This only changes
// do: text - evidence (and so the fingerprint, which excludes path for
// this rule already) is untouched, and when no pair in the component is
// lopsided, today's do: is unchanged.
import type { Config } from "../config.ts";
import type { Edge, ModuleGraph } from "../module-graph.ts";
import { toProjectRelativePosix } from "../module-graph.js";

export type Violation = {
  rule: "cycle";
  path: string;
  line: number;
  column: number;
  evidence: string;
  because: string;
  do: string;
  todoModule: string;
};

// A declared ignoredCycles entry naming a pair that isn't actually part of
// any real cycle anymore - config drift, not a real finding, same shape
// (and same reasoning) as rule 3's own stale-todo: an unmatched exception
// hides nothing real, so it must be visible, not silently tolerated.
export type StaleExceptionViolation = {
  rule: "stale-cycle-exception";
  path: string;
  line: number;
  column: number;
  evidence: string;
  because: string;
  do: string;
};

const BECAUSE = "modules that import each other cannot be reasoned about, tested, or replaced independently";
const STALE_BECAUSE = "an ignoredCycles entry naming no real cycle hides nothing - it is dead configuration, not a decision anyone can still judge";

// A pair is lopsided when its minority direction is small in absolute
// terms (survey: 1-3 edges covers ~63% of real minority sides) AND
// dominated in relative terms (majority at least 3x minority) - see the
// header comment above for why both conditions are required together.
const MINORITY_MAX_EDGES = 3;
const MAJORITY_MIN_RATIO = 3;
// Real, project-relative file edges named in a lopsided pair's do: are
// capped at 5, so a pathological future change to the threshold above
// can't grow this list without bound. In practice the cap never binds
// today: the minority side has at most MINORITY_MAX_EDGES edges, deduped
// by (fromFile, resolvedFile) pair, so the displayed list is never
// longer than 3.
const MINORITY_FILE_EDGES_SHOWN = 5;

type ModuleEdge = { to: string; edge: Edge };

// All real value edges (not type-only, already excludes same-module
// edges via crossModuleEdges), grouped by ordered (from, to) module
// pair - undeduped, unlike buildAdjacency's adjacency list, because a
// lopsided-pair judgment needs the true edge count, not one
// representative edge.
function valueEdgesByOrderedPair(graph: ModuleGraph): Map<string, Edge[]> {
  const map = new Map<string, Edge[]>();
  for (const edge of graph.crossModuleEdges) {
    if (edge.isTypeOnly) continue;
    const key = `${edge.fromModule}->${edge.toModule}`;
    const list = map.get(key) ?? [];
    list.push(edge);
    map.set(key, list);
  }
  return map;
}

type LopsidedPair = {
  minorityFrom: string;
  minorityTo: string;
  minorityEdges: Edge[];
  majorityCount: number;
};

// The most lopsided pair among a component's members that has edges in
// both directions, or undefined when none qualifies. Iterates pairs in
// sorted module-name order and only replaces the running best on a
// strictly higher ratio, so a tie keeps the alphabetically first pair -
// a stable, deterministic tie-break, so re-running `check` always names
// the same pair for the same graph. Ratios are compared by cross
// multiplication, not floats, since edge counts are always small
// integers and this must stay exact.
function findMostLopsidedPair(component: string[], edgesByPair: Map<string, Edge[]>): LopsidedPair | undefined {
  const sorted = [...component].sort();
  let best: LopsidedPair | undefined;
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      const aToB = edgesByPair.get(`${a}->${b}`) ?? [];
      const bToA = edgesByPair.get(`${b}->${a}`) ?? [];
      if (aToB.length === 0 || bToA.length === 0) continue; // not a pair with edges in both directions

      const [minorityFrom, minorityTo, minorityEdges, majorityCount] =
        aToB.length <= bToA.length ? [a, b, aToB, bToA.length] as const : [b, a, bToA, aToB.length] as const;
      const minorityCount = minorityEdges.length;
      if (minorityCount > MINORITY_MAX_EDGES) continue;
      if (majorityCount < minorityCount * MAJORITY_MIN_RATIO) continue;

      if (best === undefined || majorityCount * best.minorityEdges.length > best.majorityCount * minorityCount) {
        best = { minorityFrom, minorityTo, minorityEdges, majorityCount };
      }
    }
  }
  return best;
}

function lopsidedDo(pair: LopsidedPair, rootDir: string): string {
  const fileEdges = [...new Set(
    pair.minorityEdges.map((e) => `${toProjectRelativePosix(e.fromFile, rootDir)} -> ${toProjectRelativePosix(e.resolvedFile, rootDir)}`),
  )].sort().slice(0, MINORITY_FILE_EDGES_SHOWN).join(", ");
  return `remove the ${pair.minorityEdges.length} import(s) from ${pair.minorityFrom} to ${pair.minorityTo} (${pair.minorityTo} imports ${pair.minorityFrom} ${pair.majorityCount} times, so ${pair.minorityFrom} -> ${pair.minorityTo} is likely the unintended direction): ${fileEdges}`;
}

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

export function checkCycles(
  graph: ModuleGraph,
  config?: Pick<Config, "ignoredCycles" | "configPath">,
): Violation[] {
  const adjacency = buildAdjacency(graph);
  const nodes = [...graph.modules.keys()];
  const components = stronglyConnectedComponents(nodes, adjacency).filter((c) => c.length > 1);
  const ignoredCycles = config?.ignoredCycles ?? [];
  const valueEdgesByPair = valueEdgesByOrderedPair(graph);

  const violations: Violation[] = [];
  for (const component of components) {
    const memberSet = new Set(component);
    // A pair named in either order is ignored the moment both its modules
    // are in the same component - the whole component, not just that one
    // edge, since a cycle spanning more than two modules is one finding
    // either way (this rule reports one violation per component already).
    const ignored = ignoredCycles.some(([a, b]) => memberSet.has(a) && memberSet.has(b));
    if (ignored) continue;

    const sorted = [...component].sort();
    const anchor = sorted[0]!;
    const { modules, edges } = shortestCycleFrom(anchor, new Set(component), adjacency);
    const firstEdge = edges[0]!;
    const fileChain = edges
      .map((e) => `${toProjectRelativePosix(e.fromFile, graph.rootDir)} -> ${toProjectRelativePosix(e.resolvedFile, graph.rootDir)}`)
      .join(", ");
    const breakCycleDo = `break the cycle at ${toProjectRelativePosix(firstEdge.fromFile, graph.rootDir)} -> ${toProjectRelativePosix(firstEdge.resolvedFile, graph.rootDir)} (module ${modules[0]} -> ${modules[1]}), or merge the modules involved - real import chain: ${fileChain}`;

    // A lopsided pair's minority edges are the likely accident and the
    // cheap fix, so they lead the do:; the general break-the-cycle advice
    // stays as the fallback for when that guess is wrong.
    const lopsided = findMostLopsidedPair(component, valueEdgesByPair);
    const doText = lopsided === undefined
      ? breakCycleDo
      : `${lopsidedDo(lopsided, graph.rootDir)}; alternatively, ${breakCycleDo}`;

    violations.push({
      rule: "cycle",
      path: firstEdge.fromFile,
      line: firstEdge.fromPosition.line,
      column: firstEdge.fromPosition.column,
      evidence: modules.join(" -> "),
      because: BECAUSE,
      do: doText,
      todoModule: anchor,
    });
  }
  return violations;
}

// A declared pair not found together in any real strongly connected
// component at all (ignored or not) is stale - checked against every
// component, not just the ignored ones, since a pair that never cycled in
// the first place is just as stale as one that used to but no longer does.
export function checkStaleCycleExceptions(
  graph: ModuleGraph,
  config: Pick<Config, "ignoredCycles" | "configPath">,
): StaleExceptionViolation[] {
  const adjacency = buildAdjacency(graph);
  const nodes = [...graph.modules.keys()];
  const components = stronglyConnectedComponents(nodes, adjacency).filter((c) => c.length > 1);
  const componentSets = components.map((c) => new Set(c));

  const violations: StaleExceptionViolation[] = [];
  for (const [a, b] of config.ignoredCycles ?? []) {
    const stillCycles = componentSets.some((members) => members.has(a) && members.has(b));
    if (stillCycles) continue;

    violations.push({
      rule: "stale-cycle-exception",
      path: config.configPath,
      line: 1,
      column: 1,
      evidence: `ignoredCycles entry ['${a}', '${b}'] names no real cycle`,
      because: STALE_BECAUSE,
      do: `remove ['${a}', '${b}'] from ignoredCycles in archstrict.config.ts`,
    });
  }
  return violations;
}
