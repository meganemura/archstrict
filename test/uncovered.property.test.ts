// Property: a module is reported as uncovered exactly when no kind pattern
// names it — checked against an independent computation of "which modules
// the drawn kinds subset actually names," not against checkUncoveredModules
// re-deriving its own answer.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkUncoveredModules } from "../src/rules/uncovered.js";
import type { Config } from "../src/config.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/uncovered");
const MODULE_NAMES = ["a", "b", "c"] as const;

// Every module either has its own exact-pattern kind, or is left out
// entirely — the two valid v0 pattern shapes this rule supports (config.ts's
// header), so this generator never draws the "invalid shape" or "overlap"
// cases the example tests already cover directly.
const coverageFlags = gs.arrays(gs.booleans(), { minSize: 3, maxSize: 3 });

describe("checkUncoveredModules (property)", () => {
  test("an uncovered violation occurs exactly for modules no kind names", () => {
    hegel.test((tc) => {
      const covered = tc.draw(coverageFlags);
      const kinds: Record<string, string> = {};
      MODULE_NAMES.forEach((name, i) => {
        if (covered[i]) kinds[`kind_${name}`] = `src/${name}`;
      });

      const graph = buildModuleGraph({ projectRoot: FIXTURE, modulesGlob: "src/*" });
      const config: Config = { modules: "src/*", kinds, because: "property test" };
      const violations = checkUncoveredModules(graph, config);

      const expectedUncovered = MODULE_NAMES.filter((_, i) => !covered[i]);
      assert.equal(violations.length, expectedUncovered.length);
      for (const name of expectedUncovered) {
        assert.ok(violations.some((v) => v.evidence.includes(`'${name}'`)));
      }
      assert.ok(violations.every((v) => v.rule === "uncovered-module"));
    });
  });
});
