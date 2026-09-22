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
            const graph = buildModuleGraph({ projectRoot: root, modulesGlob: "src/*" });
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
              const filePairs = path.slice(0, -1).map((from, i) => `${from}/importer.ts -> ${path[i + 1]}/module.ts`);
              assert.equal(v.next, `break the cycle at ${filePairs[0]} (module ${path[0]} -> ${path[1]}), or merge the modules involved - real import chain: ${filePairs.join(", ")}`);
              const component = components.find((c) => c.includes(v.todoModule));
              assert.ok(component !== undefined);
              assert.equal(v.todoModule, [...component!].sort()[0]);
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
