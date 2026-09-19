import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkEmptyRuleSet } from "../src/rules/empty-rule.js";
import type { Config } from "../src/config.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/uncovered"); // a, b, c

describe("checkEmptyRuleSet", () => {
  test("a kind naming a nonexistent module is a violation", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, modulesGlob: "src/*" });
    const config: Config = {
      configPath: "<test>",
      modules: "src/*",
      kinds: { ghost: "src/nonexistent", real: "src/a" },
      because: "test config",
    };

    const violations = checkEmptyRuleSet(graph, config);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("empty-rule-set");
    expect(violations[0]!.evidence).toContain("ghost");
  });

  test("the catch-all always matches when at least one module exists", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, modulesGlob: "src/*" });
    const config: Config = {
      configPath: "<test>",
      modules: "src/*",
      kinds: { flat: "src/*" },
      because: "test config",
    };

    expect(checkEmptyRuleSet(graph, config)).toHaveLength(0);
  });

  test("a layers entry naming a kind that doesn't exist is a violation", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, modulesGlob: "src/*" });
    const config: Config = {
      configPath: "<test>",
      modules: "src/*",
      kinds: { flat: "src/*" },
      layers: ["flat", "ghost-layer"],
      because: "test config",
    };

    const violations = checkEmptyRuleSet(graph, config);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.evidence).toContain("ghost-layer");
  });

  test("an invalid kind pattern shape throws, same as rule 3", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, modulesGlob: "src/*" });
    const config: Config = {
      configPath: "<test>",
      modules: "src/*",
      kinds: { nested: "src/a/*" },
      because: "test config",
    };

    expect(() => checkEmptyRuleSet(graph, config)).toThrow(/not a shape v0 supports/);
  });

  test("no modules at all is a violation, not silence", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-empty-rule-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true }); // src/ exists, but has no module directories
      writeFileSync(join(root, "tsconfig.json"), "{}");
      const graph = buildModuleGraph({ projectRoot: root, modulesGlob: "src/*" });
      const config: Config = {
        configPath: "<test>",
        modules: "src/*",
        kinds: { flat: "src/*" },
        because: "test config",
      };

      const violations = checkEmptyRuleSet(graph, config);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.evidence).toContain("no modules under");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an invalid kind pattern shape throws even with no modules at all", () => {
    // The bug review caught: validating shapes only while looping over
    // graph.modules meant an empty graph skipped validation entirely,
    // since the loop that would have found the invalid shape never ran.
    const root = mkdtempSync(join(tmpdir(), "archstrict-empty-rule-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "tsconfig.json"), "{}");
      const graph = buildModuleGraph({ projectRoot: root, modulesGlob: "src/*" });
      const config: Config = {
        configPath: "<test>",
        modules: "src/*",
        kinds: { nested: "src/a/*" },
        because: "test config",
      };

      expect(() => checkEmptyRuleSet(graph, config)).toThrow(/not a shape v0 supports/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
