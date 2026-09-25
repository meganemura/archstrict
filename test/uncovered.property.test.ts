// Property: a violation occurs for exactly the real files matching no
// declared module - checked against an independent computation of which
// files fall outside the drawn declaredModules subset, not against
// checkUncoveredModules re-deriving its own answer via graph.outsideFiles.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkUncoveredModules } from "../src/rules/uncovered.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/uncovered");
const MODULE_NAMES = ["a", "b", "c"] as const;

const declaredFlags = gs.arrays(gs.booleans(), { minSize: 3, maxSize: 3 });

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
});
