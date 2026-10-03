import { describe, expect, test, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkPublicSurfaceBypass } from "../src/rules/public-surface.js";
import * as projectPath from "../src/project-path.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/public-surface");
const declaredModules = ["a", "b", "c"].map((name) => ({ name, glob: `src/${name}/**` }));

describe("checkPublicSurfaceBypass", () => {
  test("walk paths with Windows separators share the compiler's surface identity", () => {
    const normalize = projectPath.toTypeScriptPath;
    // Separator injection preserves real host I/O while reproducing Windows
    // file-list identities at the graph's input boundary.
    const conversion = vi.spyOn(projectPath, "toTypeScriptPath")
      .mockImplementation(path => normalize(path, "\\"));
    try {
      const graph = buildModuleGraph({
        projectRoot: FIXTURE, declaredModules, surface: "public.ts",
        fileListOverride: files => files.map(file => file.replace(/\//g, "\\")),
        resolvableFileListOverride: files => files.map(file => file.replace(/\//g, "\\")),
      });
      expect(graph.unresolvedSpecifierCount).toBe(0);
      expect(graph.crossModuleEdges).toHaveLength(3);
      const publicEdge = graph.crossModuleEdges.find(edge => edge.specifier === "../a/public.ts")!;
      expect(graph.modules.get("a")!.surfaceFiles).toContain(publicEdge.resolvedFile);
      expect(checkPublicSurfaceBypass(graph)).toHaveLength(2);
    } finally {
      conversion.mockRestore();
    }
  });

  test("flags a bypass of a's public.ts, and every import into b (no public.ts)", () => {
    // This fixture's own surface convention is "public.ts", not the
    // tool's default ("index.ts") - the surface file name is configurable
    // (a project names its own), and this test exercises the rule itself,
    // not that default.
    const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules, surface: "public.ts" });

    // Sanity: module resolution actually worked (a nodenext moduleResolution
    // change that broke .ts-extension resolution would otherwise show up as
    // "0 edges, 0 violations, green" instead of a loud failure.
    expect(graph.unresolvedSpecifierCount).toBe(0);
    expect(graph.crossModuleEdges.length).toBe(3); // widget, secret, gadget

    const violations = checkPublicSurfaceBypass(graph);
    expect(violations).toHaveLength(2);

    const bySpecifier = new Map(violations.map((v) => [v.evidence, v]));
    const secretViolation = [...bySpecifier.values()].find((v) =>
      v.evidence.includes("'../a/internal.ts'"),
    );
    expect(secretViolation).toBeDefined();
    expect(secretViolation?.todoModule).toBe("a");
    expect(secretViolation?.do).toContain("a/public.ts");

    const gadgetViolation = [...bySpecifier.values()].find((v) =>
      v.evidence.includes("'../b/module.ts'"),
    );
    expect(gadgetViolation).toBeDefined();
    expect(gadgetViolation?.todoModule).toBe("b");
    expect(gadgetViolation?.do).toContain("add a public.ts");

    // The import that reaches a's public.ts itself is not a violation.
    expect(
      violations.some((v) => v.evidence.includes("'../a/public.ts'")),
    ).toBe(false);
  });

  test("a module with none of several surface files present asks for one of them, naming each", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules, surface: ["public.ts", "entry.ts"] });
    expect(graph.unresolvedSpecifierCount).toBe(0);
    expect(graph.modules.get("b")?.surfaceFiles).toEqual([]);

    const gadgetViolation = checkPublicSurfaceBypass(graph).find((v) =>
      v.evidence.includes("'../b/module.ts'"),
    );
    expect(gadgetViolation?.do).toBe("add one of public.ts, entry.ts to b/ naming what it exports");
  });

  test("a file-rooted module whose surface file exists sends the importer to that file", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-file-module-bypass-"));
    try {
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "esnext", module: "nodenext", moduleResolution: "nodenext", jsx: "preserve", strict: true, skipLibCheck: true, noEmit: true },
      }));
      mkdirSync(join(root, "src/app"), { recursive: true });
      writeFileSync(join(root, "src/foo.ts"), "export const pub = 1;\n");
      writeFileSync(join(root, "src/foo.tsx"), "export const extra = 2;\n");
      writeFileSync(join(root, "src/app/main.ts"), 'import { extra } from "../foo.tsx";\nexport const y = extra;\n');
      const graph = buildModuleGraph({
        projectRoot: root,
        declaredModules: [
          { name: "foo", glob: "src/foo.ts*", surface: "foo.ts" },
          { name: "app", glob: "src/app/**" },
        ],
      });
      expect(graph.unresolvedSpecifierCount).toBe(0);
      const foo = graph.modules.get("foo")!;
      expect(foo.rootIsFile).toBe(true);
      expect(foo.surfaceFiles.map((f) => graph.relativePath(f))).toEqual(["src/foo.ts"]);

      const violations = checkPublicSurfaceBypass(graph);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.evidence).toContain("'../foo.tsx'");
      expect(violations[0]?.do).toContain("import from src/foo.ts");
      expect(violations[0]?.do).not.toContain("set surface");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("modules missing entirely from the graph are counted, not silently absent", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules });
    expect(graph.outsideFiles).toEqual([]);
    expect(graph.unsupportedSyntaxCount).toBe(0);
    expect([...graph.modules.keys()].sort()).toEqual(["a", "b", "c"]);
  });

  // `import("./x").Y` in type position reaches past a module's surface the
  // same as any other import - a project could otherwise read internal
  // types through it while every value import stays clean.
  test("an import(...) type reaching past a surface is reported; one reaching the surface itself is not", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-import-type-bypass-"));
    try {
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "esnext", module: "nodenext", moduleResolution: "nodenext", strict: true, skipLibCheck: true, noEmit: true },
      }));
      mkdirSync(join(root, "src/a"), { recursive: true });
      mkdirSync(join(root, "src/b"), { recursive: true });
      writeFileSync(join(root, "src/a/index.ts"), "export type Public = { value: number };\n");
      writeFileSync(join(root, "src/a/internal.ts"), "export type Secret = { value: number };\n");
      writeFileSync(join(root, "src/b/bypass.ts"), 'export type Leaked = import("../a/internal.ts").Secret;\n');
      writeFileSync(join(root, "src/b/clean.ts"), 'export type Ok = import("../a/index.ts").Public;\n');
      const graph = buildModuleGraph({
        projectRoot: root,
        declaredModules: [{ name: "a", glob: "src/a/**" }, { name: "b", glob: "src/b/**" }],
      });
      expect(graph.unresolvedSpecifierCount).toBe(0);

      const violations = checkPublicSurfaceBypass(graph);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.evidence).toContain("'../a/internal.ts'");
      expect(violations[0]?.path.endsWith("bypass.ts")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
