// Property: a module-level cycle is reported exactly when one exists among
// the non-type-only edges — checked against an independent reference cycle
// check (plain DFS), not against the rule's own Tarjan implementation, so a
// shared bug in both wouldn't hide behind agreement.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkCycles } from "../src/rules/cycles.js";

const MODULE_NAMES = ["m1", "m2", "m3", "m4"] as const;
const declaredModules = MODULE_NAMES.map((name) => ({ name, glob: `src/${name}/**` }));

const edgeSpec = gs.record({
  from: gs.sampledFrom([...MODULE_NAMES]),
  to: gs.sampledFrom([...MODULE_NAMES]),
  isTypeOnly: gs.booleans(),
});
const edgeSpecs = gs.arrays(edgeSpec, { minSize: 0, maxSize: 10 });

type EdgeSpec = { from: string; to: string; isTypeOnly: boolean };

function writeProject(root: string, edges: EdgeSpec[]): void {
  for (const name of MODULE_NAMES) {
    const dir = join(root, "src", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "module.ts"),
      `export interface Shape_${name} { tag: "${name}" }\nexport const value_${name} = 1;\n`,
    );
  }

  const byImporter = new Map<string, EdgeSpec[]>();
  for (const edge of edges) {
    if (edge.from === edge.to) continue; // not a cross-module edge
    const list = byImporter.get(edge.from) ?? [];
    list.push(edge);
    byImporter.set(edge.from, list);
  }

  for (const [from, list] of byImporter) {
    const lines = list.map((edge, i) =>
      edge.isTypeOnly
        ? `import type { Shape_${edge.to} as t${i} } from "../${edge.to}/module.ts";\n`
        : `import { value_${edge.to} as v${i} } from "../${edge.to}/module.ts";\n`,
    );
    writeFileSync(join(root, "src", from, "importer.ts"), lines.join(""));
  }

  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "esnext",
          module: "nodenext",
          moduleResolution: "nodenext",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
      },
      null,
      2,
    ),
  );
}

// Independent reference: how many strongly connected components of size > 1
// exist among the non-type-only edges? Reachability-based (for each pair,
// is each reachable from the other), deliberately not Tarjan's algorithm —
// a bug shared between this and the rule's own implementation would
// otherwise pass unnoticed. Module graphs are small in v0 (a handful of
// modules), so quadratic reachability is fine for a test.
function reachableFrom(start: string, adjacency: Map<string, string[]>): Set<string> {
  const visited = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    for (const next of adjacency.get(node) ?? []) stack.push(next);
  }
  return visited;
}

// Independent oracle for the lopsided-pair rule in src/rules/cycles.ts,
// computed straight from the generator's own `edges` (never from the
// parsed graph) - same independence the reachability-based SCC check
// above relies on. Mirrors the implementation's threshold and tie-break
// exactly (both are part of what this test checks). It expects exactly
// one file-edge in a lopsided do:, never a comma-joined list, because
// writeProject puts every edge from one module into a single
// `importer.ts` - so 2 or 3 edges between the same two modules dedupe
// down to that one (fromFile, resolvedFile) pair here, exercising the
// dedup itself. A list of more than one distinct file pair needs more
// than one file per module, which only cycles.test.ts's own dedicated
// multi-file fixture writes.
const MINORITY_MAX_EDGES = 3;
const MAJORITY_MIN_RATIO = 3;

function mostLopsidedPair(
  component: string[],
  valueEdges: EdgeSpec[],
): { minorityFrom: string; minorityTo: string; minorityCount: number; majorityCount: number } | undefined {
  const countOf = (from: string, to: string) => valueEdges.filter((e) => e.from === from && e.to === to).length;
  const sorted = [...component].sort();
  let best: { minorityFrom: string; minorityTo: string; minorityCount: number; majorityCount: number } | undefined;
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      const aToB = countOf(a, b);
      const bToA = countOf(b, a);
      if (aToB === 0 || bToA === 0) continue;

      const [minorityFrom, minorityTo, minorityCount, majorityCount] =
        aToB <= bToA ? [a, b, aToB, bToA] as const : [b, a, bToA, aToB] as const;
      if (minorityCount > MINORITY_MAX_EDGES) continue;
      if (majorityCount < minorityCount * MAJORITY_MIN_RATIO) continue;

      if (best === undefined || majorityCount * best.minorityCount > best.majorityCount * minorityCount) {
        best = { minorityFrom, minorityTo, minorityCount, majorityCount };
      }
    }
  }
  return best;
}

function stronglyConnectedComponentsOfSizeAbove1(edges: EdgeSpec[]): string[][] {
  const valueEdges = edges.filter((e) => !e.isTypeOnly && e.from !== e.to);
  const adjacency = new Map<string, string[]>();
  for (const e of valueEdges) {
    const list = adjacency.get(e.from) ?? [];
    list.push(e.to);
    adjacency.set(e.from, list);
  }

  const seen = new Set<string>();
  const components: string[][] = [];
  for (const m of MODULE_NAMES) {
    if (seen.has(m)) continue;
    const forward = reachableFrom(m, adjacency);
    const component = [...forward].filter((other) => reachableFrom(other, adjacency).has(m));
    for (const member of component) seen.add(member);
    if (component.length > 1) components.push(component.sort());
  }
  return components;
}

describe("checkCycles (property)", () => {
  test(
    "a cycle is reported exactly when one exists among non-type-only edges",
    () => {
      hegel.test(
        (tc) => {
          const edges = tc.draw(edgeSpecs).filter((e) => e.from !== e.to);

          const root = mkdtempSync(join(tmpdir(), "archstrict-cycles-"));
          try {
            writeProject(root, edges);
            const graph = buildModuleGraph({ projectRoot: root, declaredModules });
            assert.equal(graph.unresolvedSpecifierCount, 0);

            const violations = checkCycles(graph);
            const components = stronglyConnectedComponentsOfSizeAbove1(edges);
            // Count, not just existence: two disjoint cycles must produce
            // two violations, not one — a bare "some cycle exists" check
            // cannot tell the two apart.
            assert.equal(violations.length, components.length);

            // Every reported cycle's evidence is a real closed walk over
            // the actual (non-type-only) edges written to disk, and its
            // todoModule is that walk's own first node (name-first among
            // the component's members, by construction).
            const valuePairs = new Set(
              edges.filter((e) => !e.isTypeOnly).map((e) => `${e.from}->${e.to}`),
            );
            for (const v of violations) {
              const path = v.evidence.split(" -> ");
              assert.ok(path.length >= 3); // at least a 2-module cycle plus the repeated start
              assert.equal(path[0], path.at(-1));
              assert.equal(v.todoModule, path[0]);
              const filePairs = path.slice(0, -1).map((from, i) => `src/${from}/importer.ts -> src/${path[i + 1]}/module.ts`);
              const breakCycleDo = `break the cycle at ${filePairs[0]} (module ${path[0]} -> ${path[1]}), or merge the modules involved - real import chain: ${filePairs.join(", ")}`;
              const component = components.find((c) => c.includes(v.todoModule));
              assert.ok(component !== undefined);
              assert.equal(v.todoModule, [...component!].sort()[0]);

              const valueEdges = edges.filter((e) => !e.isTypeOnly);
              // A two-module cycle names both sides and the two moves; a longer one
              // keeps the general break-the-cycle advice.
              const [first, second] = [...component!].sort();
              const side = (from: string, to: string) =>
                `${from} imports ${to} ${valueEdges.filter((e) => e.from === from && e.to === to).length} time(s): src/${from}/importer.ts -> src/${to}/module.ts`;
              const generalDo = component!.length === 2
                ? `${side(first!, second!)}; ${side(second!, first!)}; either extract the part both sides use into a leaf module that ${first} and ${second} both import, or pass the dependency in from the side that owns it, so the other side stops importing it; run archstrict simulate on the planned change first`
                : breakCycleDo;
              const lopsided = mostLopsidedPair(component!, valueEdges);
              if (lopsided === undefined) {
                assert.equal(v.do, generalDo);
              } else {
                const fileEdge = `src/${lopsided.minorityFrom}/importer.ts -> src/${lopsided.minorityTo}/module.ts`;
                const lopsidedDo = `remove the ${lopsided.minorityCount} import(s) from ${lopsided.minorityFrom} to ${lopsided.minorityTo} (${lopsided.minorityTo} imports ${lopsided.minorityFrom} ${lopsided.majorityCount} times, so ${lopsided.minorityFrom} -> ${lopsided.minorityTo} is likely the unintended direction): ${fileEdge}`;
                assert.equal(v.do, `${lopsidedDo}; alternatively, ${generalDo}`);
              }
              for (let i = 0; i < path.length - 1; i++) {
                assert.ok(valuePairs.has(`${path[i]}->${path[i + 1]}`));
              }
            }
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        },
        { testCases: 25 },
      );
    },
    20_000,
  );
});
