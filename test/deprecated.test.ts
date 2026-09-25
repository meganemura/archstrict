import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkDeprecatedEdges } from "../src/rules/deprecated.js";
import { checkEmptyRuleSet } from "../src/rules/empty-rule.js";
import type { Config } from "../src/config.js";

// c -> a has 2 edges (widget via public.ts, secret via internal.ts);
// c -> b has 1 edge (gadget).
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/public-surface");
const declaredModules = ["a", "b", "c"].map((name) => ({ name, glob: `src/${name}/**` }));

function baseConfig(deprecated: Config["deprecated"]): Config {
  return { configPath: "<test>", deprecated, because: "test config" };
}

describe("checkDeprecatedEdges", () => {
  test("an exact count match is neither a violation nor a suggestion", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules });
    const config = baseConfig([{ from: "c", to: "a", count: 2, because: "migrating off a" }]);

    const { violations, suggestions } = checkDeprecatedEdges(graph, config);
    expect(violations).toHaveLength(0);
    expect(suggestions).toHaveLength(0);
  });

  test("an increased count is a violation", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules });
    const config = baseConfig([{ from: "c", to: "a", count: 1, because: "migrating off a" }]);

    const { violations, suggestions } = checkDeprecatedEdges(graph, config);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("deprecated-edge-increased");
    expect(violations[0]!.because).toBe("migrating off a");
    expect(suggestions).toHaveLength(0);
  });

  test("a decreased but nonzero count is a suggestion, not a violation", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules });
    const config = baseConfig([{ from: "c", to: "a", count: 5, because: "migrating off a" }]);

    const { violations, suggestions } = checkDeprecatedEdges(graph, config);
    expect(violations).toHaveLength(0);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.rule).toBe("deprecated-edge-decreased");
    expect(suggestions[0]!.do).toContain("update count to 2");
  });

  test("a count fallen to zero is reported by rule 4, not rule 5", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules });
    const config = baseConfig([{ from: "a", to: "b", count: 3, because: "no real edge a -> b exists" }]);

    const { violations, suggestions } = checkDeprecatedEdges(graph, config);
    expect(violations).toHaveLength(0);
    expect(suggestions).toHaveLength(0);

    const emptyRuleViolations = checkEmptyRuleSet(graph, config);
    expect(emptyRuleViolations.some((v) => v.evidence.includes("a -> b"))).toBe(true);
  });

  test("a deprecated entry naming a nonexistent module is a config error", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules });
    const config = baseConfig([{ from: "c", to: "ghost", count: 1, because: "test" }]);

    expect(() => checkDeprecatedEdges(graph, config)).toThrow(/does not exist/);
  });

  test("rule 4 and rule 5 agree: a nonexistent module throws from both, not one reporting it as a stale edge", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules });
    const config = baseConfig([{ from: "ghost", to: "a", count: 1, because: "test" }]);

    expect(() => checkDeprecatedEdges(graph, config)).toThrow(/does not exist/);
    expect(() => checkEmptyRuleSet(graph, config)).toThrow(/does not exist/);
  });
});
