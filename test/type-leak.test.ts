import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { check } from "../src/verbs/check.js";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkTypeLeaks } from "../src/rules/type-leak.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/type-leak");
const VALUES_AND_BASES_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/type-leak-values-and-bases",
);
const declaredModules = [{ name: "m", glob: "src/m/**" }];

describe("checkTypeLeaks", () => {
  test("every detection path (structural, through a re-export, through a type argument, inferred-return, generic-parameter, through an optional array) finds the same never-exported internal type, and they collapse into one violation naming every referencing export - not a re-exported type, an annotated plain return, or an anonymous literal", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules, surface: "public.ts" });
    expect(graph.unresolvedSpecifierCount).toBe(0);

    const violations = checkTypeLeaks(graph);
    // Every one of the six detection paths in this fixture leaks the
    // SAME internal type (SecretInternal) - the whole point of the
    // (module, internal type) grouping is that this reads as one real
    // fact about module 'm', not six.
    expect(violations).toHaveLength(1);

    const leak = violations[0]!;
    expect(leak.evidence.startsWith("'SecretInternal'")).toBe(true);
    expect(leak.evidence).toContain("never exported by name from module 'm'");
    expect(leak.todoModule).toBe("m");
    expect(leak.rule).toBe("type-leak");
    expect(leak.because.length).toBeGreaterThan(0);

    // Every one of the six real referencing exports is named - none
    // silently dropped by the aggregation.
    for (const name of [
      "WrapsInternal", // structural
      "Leaky", // structural, reached through a re-export
      "returnsInternalInferred", // inferred-return
      "Holder", // generic-parameter
      "WrapsViaTypeArgument", // structural, reached through a type argument
      "WrapsViaOptionalArray", // structural, reached two structural ways - named once, not twice
    ]) {
      expect(leak.evidence, `expected '${name}' to be named in the aggregated evidence`).toContain(`'${name}'`);
    }
    // Not double-counted even though the walk reaches WrapsViaOptionalArray's
    // own declaration two structural ways (its type argument and its index
    // signature's value type both name SecretInternal).
    expect(leak.evidence.match(/'WrapsViaOptionalArray'/g)).toHaveLength(1);

    // AlsoFine re-exports InternalRecord by name right in public.ts, so a
    // consumer has a name for it, and returnsPlain's annotated return type
    // is self-contained - neither is a leak, and neither type name (which
    // never appears in the fixture's own internal type) shows up here.
    expect(leak.evidence).not.toContain("InternalRecord");
  });

  test("a module with no surface has nothing to check - no entry point to walk", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules, surface: "nonexistent.ts" });
    expect(checkTypeLeaks(graph)).toHaveLength(0);
    expect(graph.typeLeaksForFocus("all")).toHaveLength(0);
  });
});

describe("checkTypeLeaks (exported values and base types)", () => {
  test("reports inferred value types and unnamed interface and class bases", () => {
    const graph = buildModuleGraph({
      projectRoot: VALUES_AND_BASES_FIXTURE,
      declaredModules,
      surface: "index.ts",
    });
    const violations = checkTypeLeaks(graph);

    expect(violations).toHaveLength(2);
    const byType = new Map(violations.map((violation) => [violation.leak?.internalType, violation]));
    expect(byType.get("Secret")?.leak?.exportedAs).toEqual([
      "Wrapper",
      "config",
      "default",
      "factory",
      "legacyConfig",
      "mutableConfig",
    ]);
    expect(byType.get("SecretBase")?.leak?.exportedAs).toEqual(["Derived"]);
  });

  test("ignores primitive inferred values and base types exported by name", () => {
    const graph = buildModuleGraph({
      projectRoot: VALUES_AND_BASES_FIXTURE,
      declaredModules,
      surface: "index.ts",
    });
    const evidence = checkTypeLeaks(graph).map((violation) => violation.evidence).join("\n");

    expect(evidence).not.toContain("primitive");
    expect(evidence).not.toContain("publicConfig");
    expect(evidence).not.toContain("PublicWrapper");
    expect(evidence).not.toContain("PublicDerived");
  });

  test("a scoped surface check equals the full check", async () => {
    const full = await check(VALUES_AND_BASES_FIXTURE);
    const scoped = await check(
      VALUES_AND_BASES_FIXTURE,
      join(VALUES_AND_BASES_FIXTURE, "src/m/index.ts"),
    );

    expect(scoped.violations.filter((violation) => violation.rule === "type-leak"))
      .toEqual(full.violations.filter((violation) => violation.rule === "type-leak"));
  });
});

describe("checkTypeLeaks (declared-module boundary)", () => {
  const ROOT_BOUNDARY_FIXTURE = join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures/type-leak-root-boundary",
  );

  test("a type declared outside every declared module (a project-root-level file) is not flagged as an internal leak", () => {
    // Found by direct measurement: under declared modules, rootDir is the
    // whole project root, so a root-level file's own type declarations
    // (archstrict.config.ts, a test helper, ...) would incorrectly count
    // as "this project's own checked source" for every module's surface.
    const graph = buildModuleGraph({
      projectRoot: ROOT_BOUNDARY_FIXTURE,
      declaredModules: [{ name: "m", glob: "src/m/**", surface: "public.ts" }],
    });
    expect(graph.unresolvedSpecifierCount).toBe(0);
    expect(checkTypeLeaks(graph)).toHaveLength(0);
    expect(graph.typeLeaksForFocus("all")).toHaveLength(0);
  });

  test("a type declared inside a DIFFERENT declared module still counts - a cross-module leak is still real", () => {
    const graph = buildModuleGraph({
      projectRoot: ROOT_BOUNDARY_FIXTURE,
      declaredModules: [
        { name: "m", glob: "src/m/**", surface: "public.ts" },
        // Declaring root-type.ts's own directory as a second module (its
        // own boundary) proves the fix is "any declared module", not "no
        // module ever counts as internal to another".
        { name: "root", glob: "*.ts", surface: "public.ts" },
      ],
    });
    const violations = checkTypeLeaks(graph);
    const focused = graph.typeLeaksForFocus("m");
    expect(violations).toHaveLength(1);
    expect(focused).toEqual(violations);
    expect(violations[0]!.evidence).toContain("RootType");
  });
});


async function withSiblingSurfaces(surface: string | string[], internal: boolean, run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "archstrict-sibling-surface-"));
  try {
    mkdirSync(join(root, "src/m"), { recursive: true });
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { noLib: true, types: [] } }));
    writeFileSync(join(root, "archstrict.config.ts"), `export default ${JSON.stringify({
      declaredModules: [{ name: "m", glob: "src/m/**", surface }], exclude: ["*.ts"], because: "Expose the named public files.",
    })};`);
    writeFileSync(join(root, "src/m/a.ts"), "export interface PublicType { value: string }");
    writeFileSync(join(root, "src/m/b.ts"),
      'import type { PublicType } from "./a.js"; export interface Wrapper { item: PublicType }' +
      (internal ? '\nimport type { Hidden } from "./internal.js"; export interface Leaky { item: Hidden }' : ""));
    if (internal) writeFileSync(join(root, "src/m/internal.ts"), "export interface Hidden { secret: string }");
    await run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test.each([{ surface: "*.ts" }, { surface: ["a.ts", "b.ts"] }])("a named type on a sibling surface is public with surface $surface", ({ surface }) =>
  withSiblingSurfaces(surface, false, async root => {
    const result = await check(root);
    expect(result.violations.filter(violation => violation.rule === "type-leak")).toEqual([]);
    expect(result.typeLeaks).toBe(0);
  }));

test("a non-surface declaration still leaks beside a public sibling type", () =>
  withSiblingSurfaces(["a.ts", "b.ts"], true, async root => {
    const result = await check(root);
    const leaks = result.violations.filter(violation => violation.rule === "type-leak");
    expect(leaks).toHaveLength(1);
    const leak = leaks[0]!;
    expect(leak.leak?.internalType).toBe("Hidden");
    const internalFile = join("src", "m", "internal.ts");
    expect(leak.do).toBe(`'Hidden' belongs to module 'm': export 'Hidden' by name from ${leak.path} (it's declared in ${internalFile})`);
  }));

describe("checkTypeLeaks (a consumer already has a name from another declared module's surface)", () => {
  const CROSS_MODULE_FIXTURE = join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures/type-leak-cross-module",
  );

  test("a type declared in ANOTHER module's own surface file is not a leak, but a type in that module's internal file (never re-exported) still is", () => {
    const crossModuleDeclaredModules = ["a", "b", "c"].map((name) => ({ name, glob: `src/${name}/**` }));
    const graph = buildModuleGraph({ projectRoot: CROSS_MODULE_FIXTURE, declaredModules: crossModuleDeclaredModules, surface: "index.ts" });
    expect(graph.unresolvedSpecifierCount).toBe(0);

    const violations = checkTypeLeaks(graph);
    const focused = graph.typeLeaksForFocus("a");
    expect(violations).toHaveLength(1);
    expect(focused).toEqual(violations);
    const leak = violations[0]!;
    expect(leak.evidence.startsWith("'Hidden'")).toBe(true);
    expect(leak.todoModule).toBe("a");
    expect(leak.evidence).not.toContain("'B'");
  });
});

describe("checkTypeLeaks (an aliased re-export names an internal type)", () => {
  async function withAliasedReExport(alias: boolean, run: (root: string) => Promise<void>) {
    const root = mkdtempSync(join(tmpdir(), "archstrict-alias-reexport-"));
    try {
      mkdirSync(join(root, "src/m"), { recursive: true });
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { noLib: true, types: [] } }));
      writeFileSync(join(root, "archstrict.config.ts"), `export default ${JSON.stringify({
        declaredModules: [{ name: "m", glob: "src/m/**", surface: "index.ts" }], exclude: ["*.ts"], because: "Expose the named public files.",
      })};`);
      writeFileSync(
        join(root, "src/m/internal.ts"),
        "export interface Violation { rule: string }\nexport function makeViolation(): Violation { return { rule: \"x\" }; }",
      );
      writeFileSync(
        join(root, "src/m/index.ts"),
        alias
          ? 'export { type Violation as AViolation, makeViolation } from "./internal.js";'
          : 'export { makeViolation } from "./internal.js";',
      );
      await run(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  test("re-exporting under an alias gives the consumer a name - no leak", () =>
    withAliasedReExport(true, async root => {
      const result = await check(root);
      expect(result.violations.filter(v => v.rule === "type-leak")).toEqual([]);
      expect(result.typeLeaks).toBe(0);
    }));

  test("re-exporting only the function, not the type, under any name - still a leak (unchanged)", () =>
    withAliasedReExport(false, async root => {
      const result = await check(root);
      const leaks = result.violations.filter(v => v.rule === "type-leak");
      expect(leaks).toHaveLength(1);
      expect(leaks[0]!.leak?.internalType).toBe("Violation");
    }));
});

describe("checkTypeLeaks (a dependency's own type, real node_modules on disk)", () => {
  const NODE_MODULES_FIXTURE = join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures/type-leak-node-modules",
  );

  test("a declared module whose glob is rooted at the project root does not treat node_modules as its own internal boundary", () => {
    const graph = buildModuleGraph({
      projectRoot: NODE_MODULES_FIXTURE,
      declaredModules: [{ name: "all", glob: "**", surface: "src/index.ts" }],
    });
    expect(checkTypeLeaks(graph)).toHaveLength(0);
  });

  test("control: a module glob scoped under src/ never reached node_modules in the first place", () => {
    const graph = buildModuleGraph({
      projectRoot: NODE_MODULES_FIXTURE,
      declaredModules: [{ name: "all", glob: "src/**", surface: "index.ts" }],
    });
    expect(checkTypeLeaks(graph)).toHaveLength(0);
  });
});

// The do: line tells apart a leak this module can fix by naming the type
// from one it cannot: a type owned by another module with no surface.
test("a type owned by a module with no surface names that module and the two fixes, in exact text", async () => {
  const root = mkdtempSync(join(tmpdir(), "archstrict-leak-owner-"));
  try {
    mkdirSync(join(root, "src/m"), { recursive: true });
    mkdirSync(join(root, "src/z"), { recursive: true });
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { noLib: true, types: [] } }));
    writeFileSync(join(root, "src/z/model.ts"), "export interface Hidden { secret: string }");
    writeFileSync(join(root, "src/m/index.ts"),
      'import type { Hidden } from "../z/model.js"; export interface Leaky { item: Hidden }');
    const graph = buildModuleGraph({ projectRoot: root, declaredModules: [
      { name: "m", glob: "src/m/**" },
      { name: "z", glob: "src/z/**" },
    ] });
    const leaks = checkTypeLeaks(graph);
    expect(leaks).toHaveLength(1);
    expect(leaks[0]!.do).toBe(
      "'Leaky' reaches 'Hidden', owned by module 'z', which has no surface: give 'z' a surface that exports 'Hidden', or drop 'Leaky' from this surface",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});
