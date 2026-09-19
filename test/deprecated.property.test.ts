// Property: for a real edge count between two modules, a declared count
// above it is a violation, below it (and nonzero) is a suggestion, equal is
// neither — checked against the actual count buildModuleGraph reports, not
// against checkDeprecatedEdges re-deriving its own answer.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkDeprecatedEdges } from "../src/rules/deprecated.js";
import type { Config } from "../src/config.js";

// c -> a has 2 edges; c -> b has 1 edge (test/deprecated.test.ts's own
// header has the detail).
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/public-surface");

const declaredCount = gs.integers({ minValue: 0, maxValue: 6 });

describe("checkDeprecatedEdges (property)", () => {
  test("classification (violation / suggestion / neither) matches the real count exactly", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, modulesGlob: "src/*" });
    const actual = graph.crossModuleEdges.filter(
      (e) => e.fromModule === "c" && e.toModule === "a",
    ).length;
    assert.equal(actual, 2); // pins the fixture's own shape; a change there should fail loudly here

    hegel.test((tc) => {
      const count = tc.draw(declaredCount);
      const config: Config = {
        configPath: "<test>",
        modules: "src/*",
        kinds: { flat: "src/*" },
        deprecated: [{ from: "c", to: "a", count, because: "property test" }],
        because: "test config",
      };

      const { violations, suggestions } = checkDeprecatedEdges(graph, config);

      if (actual > count) {
        assert.equal(violations.length, 1);
        assert.equal(suggestions.length, 0);
      } else if (actual > 0 && actual < count) {
        assert.equal(violations.length, 0);
        assert.equal(suggestions.length, 1);
      } else {
        // actual === count, or actual === 0 (rule 4's case, not rule 5's)
        assert.equal(violations.length, 0);
        assert.equal(suggestions.length, 0);
      }
    });
  });
});
