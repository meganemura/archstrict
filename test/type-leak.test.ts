import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkTypeLeaks } from "../src/rules/type-leak.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/type-leak");

describe("checkTypeLeaks", () => {
  test("flags a structural leak, a structural leak reached through a re-export, a structural leak reached through a type argument, an inferred-return leak, and a generic-parameter leak; not a re-exported type, an annotated plain return, or an anonymous literal", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, modulesGlob: "src/*", surface: "public.ts" });
    expect(graph.unresolvedSpecifierCount).toBe(0);

    const violations = checkTypeLeaks(graph);
    expect(violations).toHaveLength(6);

    const byExported = new Map(violations.map((v) => [v.evidence, v]));
    const structural = [...byExported.values()].find((v) => v.evidence.startsWith("'WrapsInternal'"));
    expect(structural).toBeDefined();
    expect(structural?.evidence).toContain("'SecretInternal'");
    expect(structural?.todoModule).toBe("m");

    // Leaky itself is re-exported by name (a consumer has a name for
    // Leaky), but its own property still reaches SecretInternal, which
    // nothing exports by name - Leaky's declaration is an ExportSpecifier
    // in public.ts, not a local TypeAliasDeclaration, so this is the case
    // that needs alias resolution to reach at all.
    const throughReExport = [...byExported.values()].find((v) => v.evidence.startsWith("'Leaky'"));
    expect(throughReExport).toBeDefined();
    expect(throughReExport?.evidence).toContain("'SecretInternal'");

    const inferredReturn = [...byExported.values()].find((v) => v.evidence.startsWith("'returnsInternalInferred'"));
    expect(inferredReturn).toBeDefined();
    expect(inferredReturn?.evidence).toContain("inferred-return");
    expect(inferredReturn?.evidence).toContain("'SecretInternal'");

    const genericParameter = [...byExported.values()].find((v) => v.evidence.startsWith("'Holder'"));
    expect(genericParameter).toBeDefined();
    expect(genericParameter?.evidence).toContain("generic-parameter");

    // WrapsViaTypeArgument has no property whose own type IS
    // SecretInternal - it only shows up in Promise<SecretInternal>'s own
    // type argument, not in any property's direct type.
    const throughTypeArgument = [...byExported.values()].find((v) => v.evidence.startsWith("'WrapsViaTypeArgument'"));
    expect(throughTypeArgument).toBeDefined();
    expect(throughTypeArgument?.evidence).toContain("'SecretInternal'");

    // An optional array property's own type argument and its index
    // signature's value type both name SecretInternal - exactly one
    // violation, not two, even though the walk reaches the declaration
    // two structural ways.
    const throughOptionalArray = violations.filter((v) => v.evidence.startsWith("'WrapsViaOptionalArray'"));
    expect(throughOptionalArray).toHaveLength(1);
    expect(throughOptionalArray[0]?.evidence).toContain("'SecretInternal'");

    // AlsoFine re-exports InternalRecord by name right in public.ts, so a
    // consumer has a name for it, and returnsPlain's annotated return type
    // is self-contained - neither is a leak.
    expect([...byExported.values()].some((v) => v.evidence.startsWith("'AlsoFine'"))).toBe(false);
    expect([...byExported.values()].some((v) => v.evidence.startsWith("'returnsPlain'"))).toBe(false);

    expect(violations.every((v) => v.rule === "type-leak")).toBe(true);
    expect(violations.every((v) => v.because.length > 0)).toBe(true);
  });

  test("a module with no surface has nothing to check - no entry point to walk", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, modulesGlob: "src/*", surface: "nonexistent.ts" });
    expect(checkTypeLeaks(graph)).toHaveLength(0);
  });
});
