import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkUncoveredModules } from "../src/rules/uncovered.js";
import type { Config } from "../src/config.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/uncovered");

describe("checkUncoveredModules", () => {
  test("flags a module with no matching kind, leaves covered ones alone", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, modulesGlob: "src/*" });
    const config: Config = {
      modules: "src/*",
      kinds: { covered: "src/a", also: "src/b" }, // c is not named anywhere
      because: "test config",
    };

    const violations = checkUncoveredModules(graph, config);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("uncovered-module");
    expect(violations[0]!.evidence).toContain("'c'");
  });

  test("the flat preset's catch-all pattern covers every module", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, modulesGlob: "src/*" });
    const config: Config = {
      modules: "src/*",
      kinds: { flat: "src/*" },
      because: "test config",
    };

    expect(checkUncoveredModules(graph, config)).toHaveLength(0);
  });

  test("an overlapping kind assignment is a config error, not a violation", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, modulesGlob: "src/*" });
    const config: Config = {
      modules: "src/*",
      kinds: { flat: "src/*", also: "src/a" }, // a matches both
      because: "test config",
    };

    expect(() => checkUncoveredModules(graph, config)).toThrow(/more than one kind/);
  });

  test("a nested wildcard pattern is a config error, not silent non-coverage", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, modulesGlob: "src/*" });
    const config: Config = {
      modules: "src/*",
      kinds: { nested: "src/a/*" }, // out of scope for v0's single-level modules
      because: "test config",
    };

    expect(() => checkUncoveredModules(graph, config)).toThrow(/not a shape v0 supports/);
  });
});
