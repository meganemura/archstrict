import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { check } from "../src/verbs/check.js";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkTypeLeaks } from "../src/rules/type-leak.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/type-leak");

describe("checkTypeLeaks", () => {
  test("every detection path (structural, through a re-export, through a type argument, inferred-return, generic-parameter, through an optional array) finds the same never-exported internal type, and they collapse into one violation naming every referencing export - not a re-exported type, an annotated plain return, or an anonymous literal", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, modulesGlob: "src/*", surface: "public.ts" });
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
    const graph = buildModuleGraph({ projectRoot: FIXTURE, modulesGlob: "src/*", surface: "nonexistent.ts" });
    expect(checkTypeLeaks(graph)).toHaveLength(0);
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
    expect(violations).toHaveLength(1);
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
    expect(leak.next).toBe(`export 'Hidden' by name from ${leak.path} (it's declared in ${internalFile}), change the referencing exports to not expose it, or add ${internalFile} to this module's own surface`);
  }));
