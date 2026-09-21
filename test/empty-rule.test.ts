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

  test("an allowDeny rule covering every real target value is exhaustive", () => {
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
      // Both real target values are allowed, so every evaluated edge must pass.
      edges: { allowDeny: [{ source: "kind:c", targetNamespace: "kind", allow: ["a", "b"], because: "test" }] },
    };

    const findings = checkEmptyRuleSet(graph, config);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: "exhaustive-allow-list", path: config.configPath,
      line: 1, column: 1, because: "test" });
    expect(findings[0]).not.toHaveProperty("todoModule");
    expect(findings[0]!.evidence).toContain("kind:c -> kind");
    expect(findings[0]!.evidence).toContain('["a","b"]');
    expect(findings[0]!.next).toContain("kind:c -> kind");
    expect(findings[0]!.next).toContain("narrow the allow list");
    expect(findings[0]!.next).toContain("remove the rule");
  });
});

function roleProject(run: (root: string, config: Config) => void) {
  const root = mkdtempSync(join(tmpdir(), "archstrict-allow-universe-"));
  try {
    for (const name of ["app", "infra", "shared", "db", "other"]) {
      mkdirSync(join(root, "src", name), { recursive: true });
      writeFileSync(join(root, "src", name, "index.ts"), "export const value = 1;");
    }
    writeFileSync(join(root, "src/app/index.ts"), 'import "../infra/index.js"; import "../shared/index.js";');
    writeFileSync(join(root, "src/other/index.ts"), 'import "../app/index.js"; import "../db/index.js";');
    writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"noLib":true,"types":[]}}');
    const config: Config = { configPath: join(root, "archstrict.config.ts"), because: "test",
      declaredModules: [{ name: "all", glob: "src/**" }],
      classify: ["app", "infra", "shared", "db"].map(name => ({ glob: `src/${name}/**`, tags: [`role:${name}`] })),
      edges: { allowDeny: [{ source: "role:app", targetNamespace: "role", allow: ["infra", "shared"], because: "Keep database access outside app." }] },
    };
    run(root, config);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("a healthy allow list stays valid when another source reaches the forbidden database value", () => roleProject((root, config) => {
  const graph = buildModuleGraph({ projectRoot: root, declaredModules: config.declaredModules });
  expect(graph.edges.some(edge => edge.fromFile.endsWith("/other/index.ts") && edge.resolvedFile.endsWith("/db/index.ts"))).toBe(true);
  expect(graph.edges.some(edge => edge.fromFile.endsWith("/app/index.ts") && edge.resolvedFile.endsWith("/db/index.ts"))).toBe(false);
  expect(checkEmptyRuleSet(graph, config)).toEqual([]);
}));

test("the source value does not prevent an exhaustive finding", () => roleProject((root, config) => {
  writeFileSync(join(root, "src/other/index.ts"), 'import "../app/index.js";');
  const graph = buildModuleGraph({ projectRoot: root, declaredModules: config.declaredModules });
  expect(checkEmptyRuleSet(graph, config).map(v => v.rule)).toEqual(["exhaustive-allow-list"]);
}));

test("deny-only forward guards do not produce exhaustive findings", () => roleProject((root, config) => {
  config.edges = { allowDeny: [{ source: "role:app", targetNamespace: "role", deny: ["future"], because: "Prevent future access." }] };
  const graph = buildModuleGraph({ projectRoot: root, declaredModules: config.declaredModules });
  expect(checkEmptyRuleSet(graph, config)).toEqual([]);
}));

test("zero evaluated edges produce only the existing coverage finding", () => roleProject((root, config) => {
  config.edges = { allowDeny: [{ source: "role:absent", targetNamespace: "role", allow: ["app", "infra", "shared", "db"], because: "test" }] };
  const graph = buildModuleGraph({ projectRoot: root, declaredModules: config.declaredModules });
  expect(checkEmptyRuleSet(graph, config).map(v => v.rule)).toEqual(["empty-rule-set"]);
}));

test.each(["type", "dynamic", "exception"] as const)("whole-graph values survive %s edge filters", mode => roleProject((root, config) => {
  writeFileSync(join(root, "src/other/index.ts"), mode === "type" ? 'import type { value } from "../db/index.js";' :
    mode === "dynamic" ? 'void import("../db/index.js");' : 'import "../db/index.js";');
  const rule = config.edges!.allowDeny![0]!;
  config.edges = { allowDeny: [{ ...rule, edgeType: "value", importForm: "static",
    exceptions: [{ from: "src/other/**", to: "src/db/**", because: "Other access is exempt." }] }] };
  const graph = buildModuleGraph({ projectRoot: root, declaredModules: config.declaredModules });
  expect(checkEmptyRuleSet(graph, config)).toEqual([]);
}));
