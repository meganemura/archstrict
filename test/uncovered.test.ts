import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkUncoveredModules } from "../src/rules/uncovered.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/uncovered");

describe("checkUncoveredModules", () => {
  test("flags a real file matching no declared module, leaves declared modules' own files alone", () => {
    const graph = buildModuleGraph({
      projectRoot: FIXTURE,
      declaredModules: [
        { name: "a", glob: "src/a/**", surface: "index.ts" },
        { name: "b", glob: "src/b/**", surface: "index.ts" },
        // "c" is deliberately not declared.
      ],
    });

    const violations = checkUncoveredModules(graph);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("uncovered-module");
    expect(violations[0]!.path.endsWith("src/c/module.ts")).toBe(true);
    expect(violations[0]!.evidence).toContain("matches no declared module");
    // `do` embeds a value meant to be pasted directly into a
    // declaredModules entry's own glob, which is always project-relative
    // (config.md) - unlike `path` above, which stays absolute.
    expect(violations[0]!.do).toContain("'src/c/module.ts'");
    expect(violations[0]!.do).not.toContain(FIXTURE);
  });

  test("declaring every real directory leaves nothing uncovered", () => {
    const graph = buildModuleGraph({
      projectRoot: FIXTURE,
      declaredModules: [
        { name: "a", glob: "src/a/**", surface: "index.ts" },
        { name: "b", glob: "src/b/**", surface: "index.ts" },
        { name: "c", glob: "src/c/**", surface: "index.ts" },
      ],
    });

    expect(checkUncoveredModules(graph)).toHaveLength(0);
  });

  test("v0-style discovery (no declaredModules) has no outsideFiles for a well-formed fixture, so nothing to flag", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, modulesGlob: "src/*" });
    expect(graph.outsideFiles).toHaveLength(0);
    expect(checkUncoveredModules(graph)).toHaveLength(0);
  });
});
