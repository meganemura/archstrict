import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkUncoveredModules } from "../src/rules/uncovered.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/uncovered");

describe("checkUncoveredModules", () => {
  test("flags a real file matching no declared module, leaves declared modules' own files alone", () => {
    const declaredModules = [
      { name: "a", glob: "src/a/**", surface: "index.ts" },
      { name: "b", glob: "src/b/**", surface: "index.ts" },
      // "c" is deliberately not declared.
    ];
    const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules });
    const violations = checkUncoveredModules(graph, { declaredModules });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("uncovered-module");
    expect(violations[0]!.path.endsWith("src/c/module.ts")).toBe(true);
    expect(violations[0]!.evidence).toContain("matches no declared module");
    // `do` embeds a value meant to be pasted directly into a
    // declaredModules entry's own glob, which is always project-relative
    // (config.md) - unlike `path` above, which stays absolute. "c" is a
    // directory group here (the fixture's src/c holds one file), so the
    // pasted entry names the directory, not the single file inside it.
    expect(violations[0]!.do).toContain('{ name: "c", glob: "src/c/**" }');
    expect(violations[0]!.do).not.toContain(FIXTURE);
  });

  test("declaring every real directory leaves nothing uncovered", () => {
    const declaredModules = [
      { name: "a", glob: "src/a/**", surface: "index.ts" },
      { name: "b", glob: "src/b/**", surface: "index.ts" },
      { name: "c", glob: "src/c/**", surface: "index.ts" },
    ];
    const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules });

    expect(checkUncoveredModules(graph, { declaredModules })).toHaveLength(0);
  });
});
