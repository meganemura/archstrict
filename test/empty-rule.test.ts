import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkEmptyRuleSet } from "../src/rules/empty-rule.js";
import type { Config } from "../src/config.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/uncovered"); // a, b, c
// c imports from both a (its surface, and a bypass into a/internal.ts) and
// b - real, resolvable cross-module edges to evaluate an edges rule
// against, unlike fixtures/uncovered's own three isolated modules.
const EDGES_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/public-surface");

describe("checkEmptyRuleSet", () => {
  test("a classify glob matching no real file is a violation", () => {
    const graph = buildModuleGraph({
      projectRoot: FIXTURE,
      declaredModules: [
        { name: "a", glob: "src/a/**", surface: "index.ts" },
        { name: "b", glob: "src/b/**", surface: "index.ts" },
        { name: "c", glob: "src/c/**", surface: "index.ts" },
      ],
    });
    const config: Config = {
      configPath: "<test>",
      because: "test config",
      classify: [
        { glob: "src/nonexistent/**", tags: ["kind:ghost"] },
        { glob: "src/a/**", tags: ["kind:real"] },
      ],
    };

    const violations = checkEmptyRuleSet(graph, config);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("empty-rule-set");
    expect(violations[0]!.evidence).toContain("src/nonexistent/**");
  });

  test("a classify glob matching a real file is a clean pass", () => {
    const graph = buildModuleGraph({
      projectRoot: FIXTURE,
      declaredModules: [
        { name: "a", glob: "src/a/**", surface: "index.ts" },
        { name: "b", glob: "src/b/**", surface: "index.ts" },
        { name: "c", glob: "src/c/**", surface: "index.ts" },
      ],
    });
    const config: Config = {
      configPath: "<test>",
      because: "test config",
      classify: [{ glob: "src/**", tags: ["kind:flat"] }],
    };

    expect(checkEmptyRuleSet(graph, config)).toHaveLength(0);
  });

  test("a deprecated edge whose actual count has fallen to zero is a violation", () => {
    const graph = buildModuleGraph({
      projectRoot: FIXTURE,
      declaredModules: [
        { name: "a", glob: "src/a/**", surface: "index.ts" },
        { name: "b", glob: "src/b/**", surface: "index.ts" },
        { name: "c", glob: "src/c/**", surface: "index.ts" },
      ],
    });
    const config: Config = {
      configPath: "<test>",
      because: "test config",
      deprecated: [{ from: "a", to: "b", count: 3, because: "test" }],
    };

    const violations = checkEmptyRuleSet(graph, config);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.evidence).toContain("a -> b");
  });

  test("no classify or deprecated entries at all is a clean pass", () => {
    const graph = buildModuleGraph({
      projectRoot: FIXTURE,
      declaredModules: [{ name: "a", glob: "src/a/**", surface: "index.ts" }],
    });
    const config: Config = { configPath: "<test>", because: "test config" };

    expect(checkEmptyRuleSet(graph, config)).toHaveLength(0);
  });

  test("no modules at all is a violation, not silence", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-empty-rule-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true }); // src/ exists, but no declaredModules cover it
      writeFileSync(join(root, "tsconfig.json"), "{}");
      const graph = buildModuleGraph({ projectRoot: root, declaredModules: [] });
      const config: Config = { configPath: "<test>", because: "test config" };

      const violations = checkEmptyRuleSet(graph, config);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.evidence).toContain("no modules declared in declaredModules");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an allowDeny rule whose targetNamespace never applies to any real edge is a violation", () => {
    const graph = buildModuleGraph({
      projectRoot: EDGES_FIXTURE,
      declaredModules: [
        { name: "a", glob: "src/a/**", surface: "public.ts" },
        { name: "b", glob: "src/b/**", surface: "module.ts" },
        { name: "c", glob: "src/c/**", surface: "module.ts" },
      ],
    });
    const config: Config = {
      configPath: "<test>",
      because: "test config",
      classify: [
        { glob: "src/a/**", tags: ["kind:a"] },
        { glob: "src/b/**", tags: ["kind:b"] },
        { glob: "src/c/**", tags: ["kind:c"] },
      ],
      // "pkg" never applies here - every real edge in this fixture reaches
      // another project file, never an external package, so this rule's
      // own targetNamespace can never match anything.
      edges: { allowDeny: [{ source: "kind:c", targetNamespace: "pkg", allow: [], because: "test" }] },
    };

    const violations = checkEmptyRuleSet(graph, config);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.evidence).toContain("allowDeny rule 'kind:c -> pkg'");
    expect(violations[0]!.evidence).toContain("matches no real edge in scope");
  });

  test("an allowDeny rule that genuinely evaluates real edges and finds nothing forbidden is NOT flagged", () => {
    const graph = buildModuleGraph({
      projectRoot: EDGES_FIXTURE,
      declaredModules: [
        { name: "a", glob: "src/a/**", surface: "public.ts" },
        { name: "b", glob: "src/b/**", surface: "module.ts" },
        { name: "c", glob: "src/c/**", surface: "module.ts" },
      ],
    });
    const config: Config = {
      configPath: "<test>",
      because: "test config",
      classify: [
        { glob: "src/a/**", tags: ["kind:a"] },
        { glob: "src/b/**", tags: ["kind:b"] },
        { glob: "src/c/**", tags: ["kind:c"] },
      ],
      // c really does import from both a and b - a genuinely evaluated,
      // genuinely clean rule, not a rule that checks nothing.
      edges: { allowDeny: [{ source: "kind:c", targetNamespace: "kind", allow: ["a", "b"], because: "test" }] },
    };

    expect(checkEmptyRuleSet(graph, config)).toHaveLength(0);
  });
});
