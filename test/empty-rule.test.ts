import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildModuleGraph } from "../src/graph/module-graph.js";
import { checkEmptyRuleSet } from "../src/rules/empty-rule.js";
import { createConfigLocator, locateViolations } from "../src/config/config-pointer.js";
import type { Config } from "../src/config/config.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/uncovered"); // a, b, c
// c imports from both a (its surface, and a bypass into a/internal.ts) and
// b - real, resolvable cross-module edges to evaluate an edges rule
// against, unlike fixtures/uncovered's own three isolated modules.
const EDGES_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/public-surface");

const CYCLES_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/cycles");

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

  test("a classify glob that matches files but loses every one of them to a more specific glob is a violation", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-classify-shadow-"));
    try {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "payment.ts"), "export const price = 1;\n");
      writeFileSync(join(root, "src", "app", "payment.test.ts"), "export const testPrice = 1;\n");
      writeFileSync(join(root, "tsconfig.json"), "{}");
      const declaredModules = [{ name: "app", glob: "src/app/**", surface: "payment.ts" }];
      const graph = buildModuleGraph({ projectRoot: root, declaredModules });
      const losing: Config = {
        configPath: join(root, "archstrict.config.ts"),
        because: "test config",
        declaredModules,
        classify: [
          { glob: "src/app/**", tags: ["kind:prod"] },
          { glob: "**/*.test.ts", tags: ["kind:test"] },
        ],
      };

      const violations = checkEmptyRuleSet(graph, losing);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        rule: "empty-rule-set",
        evidence: "classify glob '**/*.test.ts' matches 1 file but a more specific glob supplies their tags",
      });
      expect(violations[0]!.do).toContain("literal prefix");
      expect(violations[0]!.because).toMatch(/\S/);
      const [located] = locateViolations(violations, losing, createConfigLocator(losing));
      expect(located!.config).toMatchObject({ pointer: "classify[1]", role: "fired" });

      const winning: Config = {
        ...losing,
        classify: [
          { glob: "src/app/**", tags: ["kind:prod"] },
          { glob: "src/app/*.test.ts", tags: ["kind:test"] },
        ],
      };
      expect(checkEmptyRuleSet(graph, winning)).toHaveLength(0);

      const sameTags: Config = {
        ...losing,
        classify: [
          { glob: "src/app/**", tags: ["kind:prod"] },
          { glob: "**/*.test.ts", tags: ["kind:prod"] },
        ],
      };
      expect(checkEmptyRuleSet(graph, sameTags)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a friends entry that matches no file is a violation, and one that matches both sides is not", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-friends-empty-"));
    try {
      mkdirSync(join(root, "src", "core"), { recursive: true });
      mkdirSync(join(root, "src", "friend"), { recursive: true });
      writeFileSync(join(root, "src", "core", "index.ts"), "export const publicThing = 1;\n");
      writeFileSync(join(root, "src", "core", "internal.ts"), "export const internalThing = 1;\n");
      writeFileSync(join(root, "src", "friend", "module.ts"), "export const allowed = 1;\n");
      writeFileSync(join(root, "tsconfig.json"), "{}");
      const declaredModules = [
        {
          name: "core",
          glob: "src/core/**",
          surface: "index.ts",
          friends: [
            { file: "internal.ts", from: "src/friend/**", because: "allowed" },
            { file: "missing.ts", from: "src/friend/**", because: "no such file" },
            { file: "internal.ts", from: "src/ghost/**", because: "no such importer" },
          ],
        },
        { name: "friend", glob: "src/friend/**", surface: "index.ts" },
      ];
      const graph = buildModuleGraph({ projectRoot: root, declaredModules });
      const config: Config = {
        configPath: join(root, "archstrict.config.ts"),
        because: "test config",
        declaredModules,
      };

      const violations = checkEmptyRuleSet(graph, config);
      expect(violations.map((v) => v.evidence)).toEqual([
        "friends file 'missing.ts' on module 'core' matches no file in that module",
        "friends from 'src/ghost/**' on module 'core' matches no file in scope",
      ]);
      const located = locateViolations(violations, config, createConfigLocator(config));
      expect(located.map((v) => v.config)).toMatchObject([
        { pointer: "declaredModules[0].friends[1]", role: "fired" },
        { pointer: "declaredModules[0].friends[2]", role: "fired" },
      ]);
      const fromEvidence = locateViolations(violations.map((v) => ({ ...v })), config, createConfigLocator(config));
      expect(fromEvidence.map((v) => (v.config as { pointer: string }).pointer)).toEqual([
        "declaredModules[0].friends[1]",
        "declaredModules[0].friends[2]",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  test("no modules at all is a violation that points at declaredModules, not silence", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-empty-rule-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true }); // src/ exists, but no declaredModules cover it
      writeFileSync(join(root, "tsconfig.json"), "{}");
      const graph = buildModuleGraph({ projectRoot: root, declaredModules: [] });
      const config: Config = { configPath: "<test>", because: "test config" };

      const violations = checkEmptyRuleSet(graph, config);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.evidence).toContain("no modules declared in declaredModules");

      const [located] = locateViolations(violations, config, createConfigLocator(config));
      expect(located!.config).toMatchObject({ pointer: "declaredModules", role: "fired" });
      expect(located!.do).toContain("declaredModules");
      expect(located!.because).toMatch(/\S/);
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
    expect(findings[0]!.do).toContain("kind:c -> kind");
    expect(findings[0]!.do).toContain("narrow the allow list");
    expect(findings[0]!.do).toContain("remove the rule");

    const [located] = locateViolations(findings, config, createConfigLocator(config));
    expect(located!.config).toMatchObject({ pointer: "edges.allowDeny[0].allow", role: "fired" });
  });
});

describe("checkEmptyRuleSet config pointers", () => {

  test("each empty entry points at its own index, as the value that fired, with fix text naming it", () => {
    const graph = buildModuleGraph({
      projectRoot: CYCLES_FIXTURE,
      declaredModules: ["a", "b", "c", "d"].map((name) => ({ name, glob: `src/${name}/**` })),
    });
    const unmatchedDeny = { source: "role:absent", targetNamespace: "role", deny: ["x"], because: "test" };
    const config: Config = {
      configPath: "<test>",
      because: "test config",
      classify: [{ glob: "src/ghost/**", tags: ["role:ghost"] }],

      deprecated: [
        { from: "a", to: "b", count: 1, because: "test" },
        { from: "a", to: "c", count: 1, because: "test" },
      ],
      edges: { allowDeny: [unmatchedDeny, { ...unmatchedDeny }] },
    };

    const violations = checkEmptyRuleSet(graph, config);
    const located = locateViolations(violations, config, createConfigLocator(config));
    expect(located.map((v) => v.config)).toMatchObject([
      { pointer: "classify[0]", role: "fired" },
      { pointer: "deprecated[1]", role: "fired" },
      { pointer: "edges.allowDeny[0]", role: "fired" },
      { pointer: "edges.allowDeny[1]", role: "fired" },
    ]);
    expect(located[0]!.do).toContain("classify");
    expect(located[1]!.do).toContain("'a -> c'");
    expect(located[2]!.do).toContain("allowDeny");
    expect(located[3]!.do).toContain("allowDeny");
    for (const v of located) {
      expect(v.rule).toBe("empty-rule-set");
      expect(v.because).toMatch(/\S/);
    }
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
  const graph = buildModuleGraph({ projectRoot: root, declaredModules: config.declaredModules! });
  expect(graph.edges.some(edge => edge.fromFile.endsWith("/other/index.ts") && edge.resolvedFile.endsWith("/db/index.ts"))).toBe(true);
  expect(graph.edges.some(edge => edge.fromFile.endsWith("/app/index.ts") && edge.resolvedFile.endsWith("/db/index.ts"))).toBe(false);
  expect(checkEmptyRuleSet(graph, config)).toEqual([]);
}));

test("the source value does not prevent an exhaustive finding", () => roleProject((root, config) => {
  writeFileSync(join(root, "src/other/index.ts"), 'import "../app/index.js";');
  const graph = buildModuleGraph({ projectRoot: root, declaredModules: config.declaredModules! });
  expect(checkEmptyRuleSet(graph, config).map(v => v.rule)).toEqual(["exhaustive-allow-list"]);
}));

test("deny-only forward guards do not produce exhaustive findings", () => roleProject((root, config) => {
  config.edges = { allowDeny: [{ source: "role:app", targetNamespace: "role", deny: ["future"], because: "Prevent future access." }] };
  const graph = buildModuleGraph({ projectRoot: root, declaredModules: config.declaredModules! });
  expect(checkEmptyRuleSet(graph, config)).toEqual([]);
}));

test("zero evaluated edges produce only the existing coverage finding", () => roleProject((root, config) => {
  config.edges = { allowDeny: [{ source: "role:absent", targetNamespace: "role", allow: ["app", "infra", "shared", "db"], because: "test" }] };
  const graph = buildModuleGraph({ projectRoot: root, declaredModules: config.declaredModules! });
  expect(checkEmptyRuleSet(graph, config).map(v => v.rule)).toEqual(["empty-rule-set"]);
}));

test.each(["type", "dynamic", "exception"] as const)("whole-graph values survive %s edge filters", mode => roleProject((root, config) => {
  writeFileSync(join(root, "src/other/index.ts"), mode === "type" ? 'import type { value } from "../db/index.js";' :
    mode === "dynamic" ? 'void import("../db/index.js");' : 'import "../db/index.js";');
  const rule = config.edges!.allowDeny![0]!;
  config.edges = { allowDeny: [{ ...rule, edgeType: "value", importForm: "static",
    exceptions: [{ from: "src/other/**", to: "src/db/**", because: "Other access is exempt." }] }] };
  const graph = buildModuleGraph({ projectRoot: root, declaredModules: config.declaredModules! });
  expect(checkEmptyRuleSet(graph, config)).toEqual([]);
}));

describe("a guard rule, which bans an import no file has yet", () => {
  const graphOf = (root: string, config: Config) => buildModuleGraph({ projectRoot: root, declaredModules: config.declaredModules! });

  test("evaluating zero edges is clean when its source tags a real file and its target namespace is one a file can carry", () => roleProject((root, config) => {
    config.edges = {
      allowDeny: [
        { source: "role:db", targetNamespace: "pkg", deny: ["some-sql-lib"], guard: true, because: "The database layer stays free of a SQL client." },
        { source: "role:db", targetNamespace: "role", allow: ["shared"], guard: true, because: "The database layer reaches only shared code." },
      ],
      point: [{ from: { tags: ["role:db"] }, to: { tags: ["role:app"] }, guard: true, because: "The database layer never reaches the app." }],
    };
    expect(checkEmptyRuleSet(graphOf(root, config), config)).toEqual([]);
  }));

  test("without guard, the same zero is an empty-rule-set finding whose do names guard", () => roleProject((root, config) => {
    config.edges = { allowDeny: [{ source: "role:db", targetNamespace: "pkg", deny: ["some-sql-lib"], because: "The database layer stays free of a SQL client." }] };
    const violations = checkEmptyRuleSet(graphOf(root, config), config);
    expect(violations.map(v => [v.rule, v.evidence])).toEqual([["empty-rule-set", "allowDeny rule 'role:db -> pkg' matches no real edge in scope"]]);
    expect(violations[0]!.do).toBe("remove or correct this allowDeny entry in archstrict.config.ts's edges - its own source/target never applies to any real edge this project has (a workspace-sibling import may resolve as an external package rather than a project tag; see rules.md). If it bans an import no file has yet, set guard: true on it and prove it fires with archstrict simulate (see prove-rules.md)");
  }));

  test("a guard whose source tags no file, or whose target namespace no file can carry, is still an empty-rule-set finding", () => roleProject((root, config) => {
    config.edges = {
      allowDeny: [
        { source: "role:absent", targetNamespace: "pkg", deny: ["some-sql-lib"], guard: true, because: "test" },
        { source: "role:db", targetNamespace: "pkgs", deny: ["some-sql-lib"], guard: true, because: "test" },
      ],
      point: [
        { from: "src/nowhere/**", to: { tags: ["role:app"] }, guard: true, because: "test" },
        { from: "src/db/**", to: "src/nowhere/**", guard: true, because: "test" },
        { from: "src/db/**", to: { tags: ["rol:app"] }, guard: true, because: "test" },
      ],
    };
    expect(checkEmptyRuleSet(graphOf(root, config), config).map(v => v.evidence)).toEqual([
      "guard allowDeny rule 'role:absent -> pkg' matches no real edge in scope, and its source 'role:absent' tags no file in scope",
      "guard allowDeny rule 'role:db -> pkgs' matches no real edge in scope, and its targetNamespace 'pkgs' is neither pkg nor a namespace classify assigns",
      "guard point rule 'src/nowhere/** -> {\"tags\":[\"role:app\"]}' matches no real edge in scope, and its from 'src/nowhere/**' matches no file in scope",
      "guard point rule 'src/db/** -> src/nowhere/**' matches no real edge in scope, and its to 'src/nowhere/**' matches no file in scope",
      "guard point rule 'src/db/** -> {\"tags\":[\"rol:app\"]}' matches no real edge in scope, and its to tag 'rol:app' is neither a pkg tag nor a tag classify assigns",
    ]);
  }));

  test("a guard whose deny value or to tag is a typo of a value classify assigns is still an empty-rule-set finding", () => roleProject((root, config) => {
    config.edges = {
      allowDeny: [
        { source: "role:db", targetNamespace: "role", deny: ["app", "ap"], guard: true, because: "test" },
        { source: "role:db", targetNamespace: "role", allow: ["nothing-real"], guard: true, because: "allow values are not checked" },
      ],
      point: [
        { from: { tags: ["role:db"] }, to: { tags: ["role:ap"] }, guard: true, because: "test" },
        { from: { tags: ["role:db"] }, to: { tags: ["pkg:not-installed"] }, guard: true, because: "pkg names are not checked" },
      ],
    };
    expect(checkEmptyRuleSet(graphOf(root, config), config).map(v => v.evidence)).toEqual([
      "guard allowDeny rule 'role:db -> role' matches no real edge in scope, and its deny value 'ap' is not a 'role:' value classify assigns",
      "guard point rule '{\"tags\":[\"role:db\"]} -> {\"tags\":[\"role:ap\"]}' matches no real edge in scope, and its to tag 'role:ap' is neither a pkg tag nor a tag classify assigns",
    ]);
  }));
});
