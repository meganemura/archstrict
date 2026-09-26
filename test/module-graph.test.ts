import { describe, expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildModuleGraph, prepareGraph, walkFileImports, type DeclaredModule } from "../src/module-graph.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/package-resolution");
const declaredModules = [{ name: "consumer", glob: "src/consumer/**" }];

describe("buildModuleGraph (package-specifier resolution)", () => {
  test("a bare package specifier resolves through the workspace's own package.json exports, not left unresolved", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules });

    expect(graph.unresolvedSpecifierCount).toBe(0);

    const edge = graph.edges.find((e) => e.specifier === "@internal/a");
    expect(edge).toBeDefined();
    expect(edge!.fromModule).toBe("consumer");
    expect(edge!.toModule).toBeUndefined(); // resolves outside src/* entirely
    expect(edge!.externalPackage).toBe("@internal/a");
    expect(edge!.resolvedFile.endsWith("node_modules/@internal/a/src/index.ts")).toBe(true);
  });

  test("a node builtin (\"node:fs\") is synthesized as its own external edge, not left unresolved", () => {
    // ts.resolveModuleName never returns a real resolvedModule for a
    // builtin - even with `types: ["node"]` set, @types/node's ambient
    // `declare module "node:fs"` is resolved by the checker's own
    // ambient-module lookup, a different mechanism entirely (measured
    // directly). Treating that as "unresolved" would flag nearly every
    // real project's own node:fs/node:path imports as unanalyzable.
    const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules });

    expect(graph.unresolvedSpecifierCount).toBe(0);

    const edge = graph.edges.find((e) => e.specifier === "node:fs");
    expect(edge).toBeDefined();
    expect(edge!.toModule).toBeUndefined();
    expect(edge!.externalPackage).toBe("fs");
  });
});

// A minimal reference walk kept in this file only (not exported from
// src/): parses through a real ts.Program's own getSourceFiles(), a
// second, independent path to the same per-file imports buildPreparedGraph
// walks without one. walkFileImports and ts.resolveModuleName are the same
// real code the production build uses; only the source of the parsed
// SourceFile differs (Program-owned vs. this file's own per-file parse).
// Equal output on many small, generated projects is the equivalence
// module-graph.ts's own header claims.
const IMPORT_KINDS = ["value", "type", "export", "dynamic", "builtin", "missing", "require"] as const;

function renderImport(kind: typeof IMPORT_KINDS[number], target: number): string {
  switch (kind) {
    case "value": return `import { v as v${target} } from "./f${target}.js"; void v${target};`;
    case "type": return `import type { T } from "./f${target}.js";`;
    case "export": return `export { v as e${target} } from "./f${target}.js";`;
    case "dynamic": return `void import("./f${target}.js");`;
    case "builtin": return 'import "node:fs";';
    case "missing": return 'import "missing-package-does-not-exist";';
    case "require": return `require("./f${target}.js");`;
  }
}

type ReferenceEdge = {
  fromFile: string; specifier: string; isTypeOnly: boolean; isDynamic: boolean; resolvedFile: string;
  line: number; column: number;
};

// No ts.ModuleResolutionCache passed to ts.resolveModuleName below,
// deliberately: this reference walk exercises each file's own nearest
// tsconfig (compilerOptionsForFile) with no cache in front of it, so a
// resolution difference between two different per-file option sets
// cannot be masked by a cache keyed on the wrong options.
function referenceWalk(root: string, declaredModules: readonly DeclaredModule[]) {
  const prepared = prepareGraph({ projectRoot: root, declaredModules });
  const program = ts.createProgram({ rootNames: prepared.rootNames, options: prepared.compilerOptions });
  const host = ts.createCompilerHost(prepared.compilerOptions);
  const rootNameSet = new Set(prepared.rootNames);
  const edges: ReferenceEdge[] = [];
  const unresolvedSpecifiers: string[] = [];
  let unsupportedSyntaxCount = 0;
  for (const sf of program.getSourceFiles()) {
    if (!rootNameSet.has(sf.fileName)) continue;
    const walked = walkFileImports(sf);
    unsupportedSyntaxCount += walked.unsupportedSyntaxCount;
    for (const imp of walked.imports) {
      const common = { fromFile: relative(root, sf.fileName), specifier: imp.specifier, isTypeOnly: imp.isTypeOnly, isDynamic: imp.isDynamic,
        line: imp.fromPosition.line, column: imp.fromPosition.column };
      if (imp.specifier === "node:fs") {
        edges.push({ ...common, resolvedFile: "node:fs" });
        continue;
      }
      const resolved = ts.resolveModuleName(imp.specifier, sf.fileName, prepared.compilerOptionsForFile(sf.fileName), host);
      const resolvedFile = resolved.resolvedModule?.resolvedFileName;
      if (resolvedFile === undefined) { unresolvedSpecifiers.push(imp.specifier); continue; }
      edges.push({ ...common, resolvedFile: relative(root, resolvedFile) });
    }
  }
  return { edges, unresolvedSpecifiers, unsupportedSyntaxCount };
}

test("edges from the Program-free build equal a Program-based reference walk over generated small projects", () => {
  // Small trees, few cases: this is a real-compiler, real-filesystem
  // property test (like test/init.property.test.ts's own P8), not a pure
  // in-memory one - bounded the same way, to stay well under this test's
  // own timeout on a loaded machine.
  hegel.test((tc) => {
    const root = mkdtempSync(join(tmpdir(), "edge-equivalence-"));
    try {
      mkdirSync(join(root, "src/m/nested"), { recursive: true });
      // jsx: preserve, so the .tsx file below parses as real JSX syntax
      // (scriptKindForFile picks TSX from its extension on both the
      // production build and this reference walk) without needing any
      // JSX namespace types - nothing here runs type checking, only
      // parsing and specifier resolution.
      writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"noLib":true,"types":[],"module":"nodenext","jsx":"preserve"}}');
      writeFileSync(join(root, "package.json"), '{"type":"module"}');
      // A nested tsconfig whose own `paths` differs from the root's (which
      // has none) - src/m/nested/g.ts only resolves its "@nested/*" import
      // if compilerOptionsForFile picks THIS tsconfig for that file, not
      // the root one, on both the production build and this reference walk.
      writeFileSync(join(root, "src/m/nested/tsconfig.json"),
        '{"compilerOptions":{"noLib":true,"types":[],"module":"nodenext","baseUrl":".","paths":{"@nested/*":["../*"]}}}');
      const fileCount = tc.draw(gen.integers({ minValue: 2, maxValue: 4 }));
      for (let i = 0; i < fileCount; i++) {
        const statementCount = tc.draw(gen.integers({ minValue: 0, maxValue: 3 }));
        const lines: string[] = [];
        for (let s = 0; s < statementCount; s++) {
          const kind = tc.draw(gen.sampledFrom(IMPORT_KINDS));
          const target = tc.draw(gen.integers({ minValue: 0, maxValue: fileCount - 1 }));
          lines.push(renderImport(kind, target));
        }
        lines.push("export const v = 1;");
        writeFileSync(join(root, "src/m", `f${i}.ts`), lines.join("\n") + "\n");
      }
      writeFileSync(join(root, "src/m/nested/g.ts"), 'import { v as gv } from "@nested/f0.js";\nexport const w = gv;\n');
      writeFileSync(join(root, "src/m/comp.tsx"),
        'import { v as cv } from "./f0.js";\nexport const Comp = () => <div>{cv}</div>;\n');
      writeFileSync(join(root, "src/m/util.mts"), 'import { v as uv } from "./f0.js";\nexport const w = uv;\n');
      const declaredModules: DeclaredModule[] = [{ name: "m", glob: "src/m/**" }];
      const graph = buildModuleGraph({ projectRoot: root, declaredModules });
      const reference = referenceWalk(root, declaredModules);

      const sortEdges = <T extends { fromFile: string; specifier: string }>(edges: readonly T[]) =>
        [...edges].sort((a, b) => `${a.fromFile}\n${a.specifier}`.localeCompare(`${b.fromFile}\n${b.specifier}`));
      expect(sortEdges(graph.edges.map((e) => ({
        fromFile: relative(root, e.fromFile), specifier: e.specifier, isTypeOnly: e.isTypeOnly, isDynamic: e.isDynamic,
        resolvedFile: e.resolvedFile.startsWith("node:") ? e.resolvedFile : relative(root, e.resolvedFile),
        line: e.fromPosition.line, column: e.fromPosition.column,
      })))).toEqual(sortEdges(reference.edges));
      expect([...graph.unresolvedSpecifiers].sort()).toEqual([...reference.unresolvedSpecifiers].sort());
      expect(graph.unsupportedSyntaxCount).toBe(reference.unsupportedSyntaxCount);
      // The fixed files above are real, non-generated cases the assertions
      // above already cover - checked by name too, so a future change that
      // silently dropped one of them (rather than merely resolving it
      // differently on both sides) would still fail here.
      expect(graph.edges.some((e) => e.fromFile.endsWith("nested/g.ts") && e.specifier === "@nested/f0.js")).toBe(true);
      expect(graph.edges.some((e) => e.fromFile.endsWith("comp.tsx"))).toBe(true);
      expect(graph.edges.some((e) => e.fromFile.endsWith("util.mts"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, { testCases: 15 });
}, 20_000);
