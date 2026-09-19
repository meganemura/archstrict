// Property: detecting the public-surface bypass matches import resolution
// itself. For any generated module graph, a cross-module edge is a
// violation exactly when it does not resolve to its target module's
// public.ts (including when the target has no public.ts at all) — never
// more, never fewer.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkPublicSurfaceBypass } from "../src/rules/public-surface.js";

const MODULE_NAMES = ["m1", "m2", "m3", "m4"] as const;

type EdgeSpec = { from: string; to: string; hitsPublicTs: boolean };

const moduleFlags = gs.arrays(gs.booleans(), { minSize: 4, maxSize: 4 });

const edgeSpec = gs.record({
  from: gs.sampledFrom([...MODULE_NAMES]),
  to: gs.sampledFrom([...MODULE_NAMES]),
  hitsPublicTs: gs.booleans(),
});
const edgeSpecs = gs.arrays(edgeSpec, { minSize: 0, maxSize: 8 });

function writeProject(root: string, hasPublicTs: boolean[], edges: EdgeSpec[]): void {
  for (const [i, name] of MODULE_NAMES.entries()) {
    const dir = join(root, "src", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "module.ts"), `export const value_${name} = 1;\n`);
    writeFileSync(join(dir, "internal.ts"), `export const secret_${name} = 1;\n`);
    if (hasPublicTs[i]) {
      writeFileSync(join(dir, "public.ts"), `export { value_${name} } from "./module.ts";\n`);
    }
  }

  // One importer file per module, holding every edge that starts there —
  // several imports in one file, keyed by target and by which file inside
  // the target they reach.
  const byImporter = new Map<string, EdgeSpec[]>();
  for (const edge of edges) {
    if (edge.from === edge.to) continue; // not a cross-module edge; not this property's concern
    const list = byImporter.get(edge.from) ?? [];
    list.push(edge);
    byImporter.set(edge.from, list);
  }

  for (const [from, list] of byImporter) {
    const lines = list.map((edge, i) => {
      const targetIndex = MODULE_NAMES.indexOf(edge.to as (typeof MODULE_NAMES)[number]);
      // Drawing hitsPublicTs=true means nothing when the target has no
      // public.ts to hit at all — there is no such file to import from.
      // Measured: without this normalization, that combination writes an
      // import to a file that does not exist, an unresolved specifier
      // rather than the internal-file edge the property means to test.
      const hitsPublicTs = edge.hitsPublicTs && hasPublicTs[targetIndex];
      const targetFile = hitsPublicTs ? "public" : "internal";
      return `import { ${targetFile === "public" ? `value_${edge.to}` : `secret_${edge.to}`} as x${i} } from "../${edge.to}/${targetFile}.ts";\n`;
    });
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

describe("checkPublicSurfaceBypass (property)", () => {
  // Each iteration writes real files and creates a real ts.Program, roughly
  // 150-200ms per case measured here — slower than the pure-function
  // properties this repository will mostly write, so both hegel's own case
  // count and vitest's test timeout are set explicitly rather than left at
  // defaults sized for cheap properties.
  test(
    "a violation occurs exactly when a cross-module edge misses the target's public.ts",
    () => {
      hegel.test(
        (tc) => {
          const hasPublicTs = tc.draw(moduleFlags);
          const edges = tc.draw(edgeSpecs).filter((e) => e.from !== e.to);

          const root = mkdtempSync(join(tmpdir(), "archstrict-public-surface-"));
          try {
            writeProject(root, hasPublicTs, edges);
            const graph = buildModuleGraph({ projectRoot: root, modulesGlob: "src/*" });
            assert.equal(graph.unresolvedSpecifierCount, 0);

            const violations = checkPublicSurfaceBypass(graph);

            const expectedViolatingEdges = edges.filter((edge) => {
              const targetHasPublicTs =
                hasPublicTs[MODULE_NAMES.indexOf(edge.to as (typeof MODULE_NAMES)[number])];
              return !targetHasPublicTs || !edge.hitsPublicTs;
            });

            assert.equal(violations.length, expectedViolatingEdges.length);
            // Not just the count: which edges. A rule that flagged the
            // wrong edges in the right number would still pass a bare
            // length check, so compare the multiset of (importer module,
            // exposed module) pairs each side actually names.
            const sortPairs = (pairs: string[]) => [...pairs].sort();
            const expectedPairs = sortPairs(
              expectedViolatingEdges.map((e) => `${e.from}->${e.to}`),
            );
            const actualPairs = sortPairs(
              violations.map((v) => `${basename(dirname(v.path))}->${v.todoModule}`),
            );
            assert.deepEqual(actualPairs, expectedPairs);

            assert.ok(violations.every((v) => v.rule === "public-surface-bypass"));
            assert.ok(violations.every((v) => v.because.length > 0));
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
