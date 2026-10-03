// Properties of rule 3 (uncovered-module):
// - a violation occurs for exactly the real files matching no declared
//   module - checked against an independent computation of which files
//   fall outside the drawn declaredModules subset, not against
//   checkUncoveredModules re-deriving its own answer via graph.outsideFiles;
// - the report does not depend on the order the project walk listed the
//   uncovered files in, and comes back in code-unit path order;
// - a focus file only narrows the report to that file's own violation, and
//   never changes the suggestion that file gets in the unscoped report.
// Boundary: generated order and focus cases reuse a complete real graph.
// The declaration property also checks real file-to-module membership.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildModuleGraph, type ModuleGraph } from "../src/module-graph.js";
import { makeProjectRelativePosix } from "../src/project-path.js";
import { checkUncoveredModules } from "../src/rules/uncovered.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/uncovered");
const MODULE_NAMES = ["a", "b", "c"] as const;

const declaredFlags = gs.arrays(gs.booleans(), { minSize: 3, maxSize: 3 });

const FAKE_ROOT = "/project";
const UNCOVERED_POOL = [
  "z.ts", "A.ts", "a.ts", "lib/q.tsx", "src/a-b.ts", "src/a/x.ts", "src/a/y/z.ts", "src/B/index.ts", "src/b.mts",
] as const;
const uncoveredFiles = gs.arrays(gs.sampledFrom(UNCOVERED_POOL), { unique: true, maxSize: UNCOVERED_POOL.length })
  .map((rels) => rels.map((rel) => `${FAKE_ROOT}/${rel}`));

const uncoveredTemplate = buildModuleGraph({ projectRoot: FIXTURE, declaredModules: [] });

function uncoveredGraph(outsideFiles: string[]): ModuleGraph {
  return { ...uncoveredTemplate, rootDir: FAKE_ROOT, outsideFiles, relativePath: makeProjectRelativePosix(FAKE_ROOT) };
}

describe("checkUncoveredModules (property)", () => {
  test("an uncovered violation occurs exactly for real files whose directory isn't declared", () => {
    hegel.test((tc) => {
      const declared = tc.draw(declaredFlags);
      const declaredModules = MODULE_NAMES.filter((_, i) => declared[i]).map((name) => ({
        name,
        glob: `src/${name}/**`,
        surface: "index.ts",
      }));

      const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules });
      const violations = checkUncoveredModules(graph, { declaredModules });

      const expectedUndeclared = MODULE_NAMES.filter((_, i) => !declared[i]);
      assert.equal(violations.length, expectedUndeclared.length);
      for (const name of expectedUndeclared) {
        assert.ok(violations.some((v) => v.path.endsWith(`src/${name}/module.ts`)));
      }
      assert.ok(violations.every((v) => v.rule === "uncovered-module"));
    });
  });

  test("the report is one violation per uncovered file in code-unit path order, whatever order the walk listed them in", () => {
    hegel.test((tc) => {
      const outsideFiles = tc.draw(uncoveredFiles);

      const violations = checkUncoveredModules(uncoveredGraph(outsideFiles), {});

      assert.deepEqual(violations.map((v) => v.path), [...outsideFiles].sort());
      assert.deepEqual(checkUncoveredModules(uncoveredGraph([...outsideFiles].reverse()), {}), violations);
    });
  });

  test("a focus file narrows the report to that file's own unscoped violation", () => {
    hegel.test((tc) => {
      const outsideFiles = tc.draw(uncoveredFiles);

      const focus = `${FAKE_ROOT}/${tc.draw(gs.sampledFrom([...UNCOVERED_POOL, "src/covered.ts"]))}`;

      const unscoped = checkUncoveredModules(uncoveredGraph(outsideFiles), {});
      const focused = checkUncoveredModules(uncoveredGraph(outsideFiles), {}, focus);

      const expectedPaths = outsideFiles.includes(focus) ? [focus] : [];
      assert.deepEqual(focused.map(v => v.path), expectedPaths);
      assert.equal(focused.length, expectedPaths.length);
      assert.deepEqual(focused, unscoped.filter((v) => v.path === focus));
    });
  });
});
