// Responsibility: under module/moduleResolution node16/nodenext, a specifier's
// own resolution mode (import vs require) decides which of a dual package's
// own export conditions applies. Exercises the two real shapes a fixed,
// mode-blind resolver gets wrong: a package with only an "import" condition
// (unresolved under a mode that reads as "require"), and a dual package
// whose "import" and "require" conditions point at different real files.
// Boundary: real node_modules fixtures under a scratch mkdtemp, never
// committed (a fixture with its own node_modules would need one real
// install per clone, or a hand-rolled fake that drifts from a real one).
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { buildModuleGraph, prepareGraph, type DeclaredModule } from "../src/module-graph.js";
import { checkTypeLeaks } from "../src/rules/type-leak.js";

const NODE16_TSCONFIG = JSON.stringify({
  compilerOptions: { target: "esnext", module: "nodenext", moduleResolution: "nodenext", strict: true, skipLibCheck: true, noEmit: true },
});

function withScratchProject(prefix: string, populate: (root: string) => void, run: (root: string) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  try {
    populate(root);
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("resolution mode: import vs require export conditions", () => {
  test("a package with only an \"import\" condition resolves for an ESM project, and rule 6 finds the leak it structurally carries", () => {
    withScratchProject("archstrict-mode-esm-only-", (root) => {
      writeFileSync(join(root, "tsconfig.json"), NODE16_TSCONFIG);
      writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
      const pkg = join(root, "node_modules/esm-only-pkg");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, "package.json"), JSON.stringify({
        name: "esm-only-pkg", version: "1.0.0", exports: { ".": { import: { types: "./index.d.mts" } } },
      }));
      writeFileSync(join(pkg, "index.d.mts"), "export interface Observable<T> { get(): T }\n");
      mkdirSync(join(root, "src/m"), { recursive: true });
      writeFileSync(join(root, "src/m/internal.ts"), "export interface Internal { value: number }\n");
      writeFileSync(join(root, "src/m/index.ts"),
        'import type { Observable } from "esm-only-pkg";\n' +
        'import type { Internal } from "./internal.js";\n' +
        "export type Result = Observable<Internal>;\n");
    }, (root) => {
      const declaredModules: DeclaredModule[] = [{ name: "m", glob: "src/m/**" }];
      const graph = buildModuleGraph({ projectRoot: root, declaredModules });

      // Without a mode, an ESM file's own bare specifier into a package
      // whose exports map has no "require" condition resolves nothing at
      // all under nodenext - the edge, not merely rule 6, is what a
      // mode-blind resolver gets wrong here.
      expect(graph.unresolvedSpecifierCount).toBe(0);
      const edge = graph.edges.find((e) => e.specifier === "esm-only-pkg");
      expect(edge).toBeDefined();
      expect(edge!.toModule).toBeUndefined();
      expect(edge!.externalPackage).toBe("esm-only-pkg");
      expect(edge!.resolvedFile.endsWith("esm-only-pkg/index.d.mts")).toBe(true);

      const violations = checkTypeLeaks(graph);
      expect(violations.length).toBeGreaterThan(0);
      expect(graph.programNotes).toEqual([]); // the closure settled on round 0 - no whole-project fallback needed

      // Oracle: a default ts.createProgram, no host override at all -
      // TypeScript's own Program computes impliedNodeFormat and mode by
      // itself for every file, exactly the behavior this fix's own
      // resolver and closureHost now match.
      const prepared = prepareGraph({ projectRoot: root, declaredModules });
      const oracleProgram = ts.createProgram({ rootNames: prepared.rootNames, options: prepared.compilerOptions });
      const oracle = checkTypeLeaks({ modules: graph.modules, program: oracleProgram, checker: oracleProgram.getTypeChecker(), rootDir: graph.rootDir });
      expect(violations.map((v) => v.evidence)).toEqual(oracle.map((v) => v.evidence));
    });
  });

  test("a dual package's own .mts and .cts importers each resolve through their own condition", () => {
    withScratchProject("archstrict-mode-dual-", (root) => {
      writeFileSync(join(root, "tsconfig.json"), NODE16_TSCONFIG);
      writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
      const pkg = join(root, "node_modules/dual-pkg");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, "package.json"), JSON.stringify({
        name: "dual-pkg", version: "1.0.0",
        exports: { ".": { import: { types: "./import.d.mts" }, require: { types: "./require.d.cts" } } },
      }));
      writeFileSync(join(pkg, "import.d.mts"), "export interface Shape { esm: true }\n");
      writeFileSync(join(pkg, "require.d.cts"), "export interface Shape { esm: false }\n");
      mkdirSync(join(root, "src/m"), { recursive: true });
      writeFileSync(join(root, "src/m/a.mts"), 'import type { Shape } from "dual-pkg";\nexport type X = Shape;\n');
      writeFileSync(join(root, "src/m/b.cts"), 'import type { Shape } from "dual-pkg";\nexport type Y = Shape;\n');
    }, (root) => {
      const declaredModules: DeclaredModule[] = [{ name: "m", glob: "src/m/**" }];
      const graph = buildModuleGraph({ projectRoot: root, declaredModules });

      expect(graph.unresolvedSpecifierCount).toBe(0);
      const fromMts = graph.edges.find((e) => e.fromFile.endsWith("a.mts"));
      const fromCts = graph.edges.find((e) => e.fromFile.endsWith("b.cts"));
      expect(fromMts).toBeDefined();
      expect(fromCts).toBeDefined();
      expect(fromMts!.resolvedFile.endsWith("dual-pkg/import.d.mts")).toBe(true);
      expect(fromCts!.resolvedFile.endsWith("dual-pkg/require.d.cts")).toBe(true);
    });
  });
});
