// Responsibility: .tsx, .mts, and .cts are analyzed exactly like .ts
// (module membership, edges, every rule), and the default public surface
// accepts one file per analyzed source extension.
// Boundary: exercises module-graph.ts's own widened eligibility and
// default-surface logic plus init's real walk and check's real graph
// build, through disposable temp projects - no fixture in test/fixtures/
// (every project here is small enough to build inline, and none is shared
// with another test file).
import { describe, expect, test } from "vitest";
import ts from "typescript";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/verbs/init.js";
import { check, loadConfig } from "../src/verbs/check.js";
import { buildModuleGraph, isEligibleSourceFile } from "../src/module-graph.js";
import { checkTypeLeaks } from "../src/rules/type-leak.js";

function scratchProject(prefix: string): { root: string; put: (relPath: string, contents: string) => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return {
    root,
    put(relPath: string, contents: string) {
      const full = join(root, relPath);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, contents);
    },
  };
}

describe("React-shaped project (.tsx)", () => {
  // Deliberately omits `jsx` from tsconfig.json: parsing a .tsx file's own
  // JSX syntax does not need it (the parser keys off the file extension,
  // not this compiler option), only type-checking does - the acceptance
  // criterion this test measures directly (edges still resolve), rather
  // than assuming it from the TypeScript docs alone.
  test("init declares ui and app, a loose main.tsx becomes its own module, and check reports exactly the ui bypass", async () => {
    const { root, put } = scratchProject("archstrict-tsx-");
    try {
      put(
        "tsconfig.json",
        JSON.stringify({ compilerOptions: { target: "esnext", module: "nodenext", moduleResolution: "nodenext" } }),
      );
      put("src/ui/Button.tsx", "export function Button() {\n  return <button>Click</button>;\n}\n");
      put("src/ui/index.tsx", "export function Widget() {\n  return <div>Widget</div>;\n}\n");
      put(
        "src/app/App.tsx",
        'import { Button } from "../ui/Button";\n' + // bypass: reaches ui's internal Button.tsx directly
          'import { Widget } from "../ui";\n' + // fine: reaches ui's own surface
          "export function App() {\n  return <div><Button /><Widget /></div>;\n}\n",
      );
      put("src/main.tsx", "export function main() {\n  return null;\n}\n");

      const result = await init(root);
      expect(result.moduleNames).toEqual(["app", "main.tsx", "ui"]);

      const report = await check(root);
      expect(report.violations).toHaveLength(1);
      const violation = report.violations[0]!;
      expect(violation.rule).toBe("public-surface-bypass");
      expect(violation.evidence).toContain("'../ui/Button'");
      expect(violation.evidence).not.toContain("'../ui'\n");

      // The single-file module's own surface names itself, the same rule a
      // loose .ts file already gets.
      const config = await loadConfig(join(root, "archstrict.config.ts"));
      const mainModule = config.declaredModules!.find((m) => m.name === "main.tsx")!;
      expect(mainModule.surface).toBe("main.tsx");

      // JSX parsed without a `jsx` compiler option: the edge from App.tsx
      // into ui resolved either way (both the bypass and the fine import
      // are real edges below, not unresolved specifiers). The omitted
      // `jsx` option does surface as its own semantic diagnostic ("Cannot
      // use JSX unless the '--jsx' flag is provided") - a real, measured
      // fact, but one that never changes which edges the program resolved.
      const graph = buildModuleGraph({ projectRoot: root, declaredModules: config.declaredModules! });
      expect(graph.unresolvedSpecifierCount).toBe(0);
      const diagnostics = graph.program.getSemanticDiagnostics().map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      expect(diagnostics.some((m) => m.includes("--jsx"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe(".mts and .cts are analyzed", () => {
  test("a .mts/.cts pair inside one module contributes files and a real edge, and a hand-authored .d.mts stays excluded by default", () => {
    const { root, put } = scratchProject("archstrict-mts-cts-");
    try {
      put(
        "tsconfig.json",
        JSON.stringify({ compilerOptions: { target: "esnext", module: "nodenext", moduleResolution: "nodenext" } }),
      );
      // An .mts file is always ESM under nodenext regardless of
      // package.json - its own relative import needs the real emitted
      // extension (.mjs), the same convention a real Node ESM project uses.
      put("src/pkg/value.mts", "export const value = 1;\n");
      put("src/pkg/user.mts", 'import { value } from "./value.mjs";\nexport const used = value + 1;\n');
      // A .cts file is always CJS under nodenext - its own relative
      // import needs .cjs.
      put("src/pkg/legacy.cts", "export const legacy = 1;\n");
      put("src/pkg/consumer.cts", 'import { legacy } from "./legacy.cjs";\nexport const consumed = legacy + 1;\n');
      // Never analyzed unless a declaredModules entry's own `surface`
      // explicitly names it (module-graph.ts's own .d.ts exception, now
      // widened to cover every analyzed source extension's own
      // declaration-file twin).
      put("src/pkg/ambient.d.mts", "export declare const ambient: number;\n");
      put("src/pkg/index.ts", "export * from \"./user.mjs\";\nexport * from \"./consumer.cjs\";\n");

      const declaredModules = [{ name: "pkg", glob: "src/pkg/**" }];
      const graph = buildModuleGraph({ projectRoot: root, declaredModules });
      expect(graph.unresolvedSpecifierCount).toBe(0);

      const files = graph.modules.get("pkg")!.files;
      expect(files.some((f) => f.endsWith("value.mts"))).toBe(true);
      expect(files.some((f) => f.endsWith("user.mts"))).toBe(true);
      expect(files.some((f) => f.endsWith("legacy.cts"))).toBe(true);
      expect(files.some((f) => f.endsWith("consumer.cts"))).toBe(true);
      // The hand-authored .d.mts is not named by any surface glob here, so
      // it never entered the graph at all - not as this module's file, and
      // not as an outside file either (isEligibleSourceFile excluded it
      // before the program was even built).
      expect(files.some((f) => f.endsWith("ambient.d.mts"))).toBe(false);
      expect(graph.outsideFiles.some((f) => f.endsWith("ambient.d.mts"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Unit-level, no compiler program: the exact predicate listAnalyzedFiles
  // itself filters through, isolated from a real ts.Program's own cost.
  test("isEligibleSourceFile: .mts/.cts are eligible, .d.mts/.d.cts are not unless a surface glob names them", () => {
    const { root, put } = scratchProject("archstrict-eligible-");
    try {
      put("src/pkg/a.mts", "export const a = 1;\n");
      put("src/pkg/b.cts", "export const b = 1;\n");
      put("src/pkg/a.d.mts", "export declare const a: number;\n");
      put("src/pkg/b.d.cts", "export declare const b: number;\n");
      const declaredModules = [{ name: "pkg", glob: "src/pkg/**" }];

      expect(isEligibleSourceFile(join(root, "src/pkg/a.mts"), root, [], declaredModules, "index.ts")).toBe(true);
      expect(isEligibleSourceFile(join(root, "src/pkg/b.cts"), root, [], declaredModules, "index.ts")).toBe(true);
      expect(isEligibleSourceFile(join(root, "src/pkg/a.d.mts"), root, [], declaredModules, "index.ts")).toBe(false);
      expect(isEligibleSourceFile(join(root, "src/pkg/b.d.cts"), root, [], declaredModules, "index.ts")).toBe(false);

      const namedAsSurface = [{ name: "pkg", glob: "src/pkg/**", surface: "a.d.mts" }];
      expect(isEligibleSourceFile(join(root, "src/pkg/a.d.mts"), root, [], namedAsSurface, "index.ts")).toBe(true);
      // b.d.cts still isn't named by any surface glob in this config, so it
      // stays excluded even though a.d.mts, right beside it, now isn't.
      expect(isEligibleSourceFile(join(root, "src/pkg/b.d.cts"), root, [], namedAsSurface, "index.ts")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("type-leak through a .tsx surface", () => {
  test("an internal type structurally reachable through a .tsx surface's own export is flagged, the same as through a .ts one", () => {
    const { root, put } = scratchProject("archstrict-tsx-leak-");
    try {
      put(
        "tsconfig.json",
        JSON.stringify({ compilerOptions: { target: "esnext", module: "nodenext", moduleResolution: "nodenext" } }),
      );
      put(
        "src/m/internal.ts",
        'export interface Hidden { value: string }\nexport function make(): Hidden { return { value: "ok" }; }\n',
      );
      put("src/m/index.tsx", 'export { make } from "./internal";\n');
      const declaredModules = [{ name: "m", glob: "src/m/**" }];
      const graph = buildModuleGraph({ projectRoot: root, declaredModules });
      expect(graph.unresolvedSpecifierCount).toBe(0);
      expect(graph.modules.get("m")!.surfaceFiles.some((f) => f.endsWith("index.tsx"))).toBe(true);

      const violations = checkTypeLeaks(graph);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.evidence).toContain("'Hidden'");
      expect(violations[0]!.path.endsWith("index.tsx")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("nonTsSourceFileCount", () => {
  test("a .tsx file is not counted as a non-TS source file", () => {
    const { root, put } = scratchProject("archstrict-nontssrc-");
    try {
      put("src/app/index.tsx", "export const App = 1;\n");
      // A real non-TS source file, the fact this count exists to surface.
      put("src/app/legacy.js", "module.exports = 1;\n");
      const declaredModules = [{ name: "app", glob: "src/app/**" }];
      const graph = buildModuleGraph({ projectRoot: root, declaredModules });
      expect(graph.nonTsSourceFileCount).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
