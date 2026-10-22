// declaredModules[].surface is optional - when a declaredModules entry
// omits it and a real package.json sits at that module's own root,
// buildDeclaredModules derives surface from the package's own real
// exports map (every entry confidently resolved back to a real, existing
// source file), never a partial or guessed-wrong array.
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkPublicSurfaceBypass } from "../src/rules/public-surface.js";
import { check, formatText } from "../src/verbs/check.js";

function withTempProject(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "archstrict-surface-exports-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("declaredModules[].surface derived from a real package.json exports map", () => {
  test("an existing declaration output permits the default condition to resolve source", () => {
    withTempProject((root) => {
      const dir = join(root, "packages", "lib");
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "dist"), { recursive: true });
      writeFileSync(join(dir, "src", "index.ts"), "export const main = 1;\n");
      writeFileSync(join(dir, "dist", "index.d.ts"), "export declare const main: number;\n");
      writeFileSync(join(dir, "package.json"), JSON.stringify({
        name: "lib",
        // The resolver removes dist/ but does not insert src/ into a path.
        exports: { ".": { types: "./dist/index.d.ts", default: "./src/index.js" } },
      }));

      const graph = buildModuleGraph({
        projectRoot: root,
        declaredModules: [{ name: "lib", glob: "packages/lib/**" }],
      });
      expect(graph.modules.get("lib")!.surfaceFiles).toEqual([realpathSync(join(dir, "src", "index.ts"))]);
    });
  });

  test("an existing declaration output resolves through the built-to-source conversion", () => {
    withTempProject((root) => {
      const dir = join(root, "packages", "lib");
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "dist", "src"), { recursive: true });
      writeFileSync(join(dir, "src", "index.ts"), "export const main = 1;\n");
      writeFileSync(join(dir, "dist", "src", "index.d.ts"), "export declare const main: number;\n");
      writeFileSync(join(dir, "package.json"), JSON.stringify({
        name: "lib",
        exports: { ".": { types: "./dist/src/index.d.ts" } },
      }));

      const graph = buildModuleGraph({
        projectRoot: root,
        declaredModules: [{ name: "lib", glob: "packages/lib/**" }],
      });
      expect(graph.modules.get("lib")!.surfaceFiles).toEqual([realpathSync(join(dir, "src", "index.ts"))]);
    });
  });

  test("a multi-entry exports map with a source-pointing condition derives the full array", () => {
    withTempProject((root) => {
      const dir = join(root, "packages", "lib");
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "index.ts"), "export const main = 1;\n");
      writeFileSync(join(dir, "src", "http.ts"), "export const http = 1;\n");
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "lib",
          exports: {
            ".": { "@lib/lib-source": "./src/index.ts", types: "./dist/index.d.ts", default: "./dist/index.js" },
            "./http": { "@lib/lib-source": "./src/http.ts", types: "./dist/http.d.ts", default: "./dist/http.js" },
          },
        }),
      );

      const graph = buildModuleGraph({
        projectRoot: root,
        declaredModules: [{ name: "lib", glob: "packages/lib/**" }],
      });
      expect(graph.unresolvedSpecifierCount).toBe(0);

      const module = graph.modules.get("lib")!;
      expect(module.surfaceFiles).toHaveLength(2);
      expect(module.surfaceFiles.some((f) => f.endsWith("src/index.ts"))).toBe(true);
      expect(module.surfaceFiles.some((f) => f.endsWith("src/http.ts"))).toBe(true);
    });
  });

  test("an exports map pointing only at nonexistent built dist/ paths falls back to the plain default, not a guessed-wrong path", () => {
    withTempProject((root) => {
      const dir = join(root, "packages", "lib");
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "index.ts"), "export const main = 1;\n");
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "lib",
          // No source condition, and the built dist/ files don't exist on
          // disk in this fixture (never actually built) - nothing here
          // confidently resolves to a real source file.
          exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
        }),
      );

      const graph = buildModuleGraph({
        projectRoot: root,
        declaredModules: [{ name: "lib", glob: "packages/lib/**" }],
        surface: "index.ts",
      });

      const module = graph.modules.get("lib")!;
      // Falls back to the project's own global default (index.ts) at the
      // module's own root - src/index.ts is NOT the default surface path
      // here (the default is relative to the module's own directory,
      // "packages/lib/index.ts", which doesn't exist), so surfaceFiles is
      // empty - a real, honest "no surface present" rather than a wrong
      // guess. Rule 1 reports every external import into it, same as
      // any module whose real surface just doesn't exist yet.
      expect(module.surfaceFiles).toHaveLength(0);
      expect(module.surfaceName).toBe("index.ts");
    });
  });

  test("an explicit surface on the entry is completely unaffected by any exports map present", () => {
    withTempProject((root) => {
      const dir = join(root, "packages", "lib");
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "index.ts"), "export const main = 1;\n");
      writeFileSync(join(dir, "index.ts"), "export const other = 1;\n");
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "lib",
          exports: { ".": { "@lib/lib-source": "./src/index.ts", default: "./dist/index.js" } },
        }),
      );

      const graph = buildModuleGraph({
        projectRoot: root,
        declaredModules: [{ name: "lib", glob: "packages/lib/**", surface: "index.ts" }],
      });

      const module = graph.modules.get("lib")!;
      expect(module.surfaceName).toBe("index.ts");
      expect(module.surfaceFiles).toHaveLength(1);
      expect(module.surfaceFiles[0]!.endsWith("packages/lib/index.ts")).toBe(true);
      expect(module.surfaceFiles.some((f) => f.endsWith("src/index.ts"))).toBe(false);
    });
  });

  test("an unresolved exports map does not tell the reader to add the missing default surface file", () => {
    withTempProject((root) => {
      writeLib(root, {
        exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
      });
      writeApp(root, "../lib/src/index.ts");

      const graph = buildModuleGraph({
        projectRoot: root,
        declaredModules: [
          { name: "lib", glob: "packages/lib/**" },
          { name: "app", glob: "packages/app/**" },
        ],
        surface: "index.ts",
      });
      const violations = checkPublicSurfaceBypass(graph);
      expect(violations).toHaveLength(1);
      const command = violations[0]!.do;
      expect(command).toContain("package.json exports for 'lib' did not resolve to a source file");
      expect(command).toContain('Set surface: "src/index.ts" on \'lib\' in archstrict.config.ts');
      expect(command).not.toContain("add ");
      expect(command).not.toContain("packages/lib/index.ts");
    });
  });

  test("a module with no package.json still says to add the missing default surface file", () => {
    withTempProject((root) => {
      const dir = join(root, "packages", "lib");
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "index.ts"), "export const main = 1;\n");
      writeApp(root, "../lib/src/index.ts");

      const graph = buildModuleGraph({
        projectRoot: root,
        declaredModules: [
          { name: "lib", glob: "packages/lib/**" },
          { name: "app", glob: "packages/app/**" },
        ],
        surface: "index.ts",
      });
      const violations = checkPublicSurfaceBypass(graph);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.do).toBe(
        'add packages/lib/index.ts that re-exports what other modules use and import it instead of packages/lib/src/index.ts, or set surface: "src/index.ts" on \'lib\' in archstrict.config.ts',
      );
    });
  });

  test("a hand-set surface still names that file when exports would not resolve", () => {
    withTempProject((root) => {
      writeLib(root, {
        exports: { ".": { default: "./dist/index.js" } },
      });
      writeApp(root, "../lib/src/index.ts");

      const graph = buildModuleGraph({
        projectRoot: root,
        declaredModules: [
          { name: "lib", glob: "packages/lib/**", surface: "index.ts" },
          { name: "app", glob: "packages/app/**" },
        ],
      });
      expect(checkPublicSurfaceBypass(graph)[0]!.do).toContain("add packages/lib/index.ts");
    });
  });
});

describe("check notes an unresolved exports map", () => {
  test("the text names the module and the do does not add index.ts", async () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-surface-exports-"));
    try {
      writeLib(root, {
        exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
      });
      writeApp(root, "../lib/src/index.ts");
      writeFileSync(
        join(root, "archstrict.config.ts"),
        `export default ${JSON.stringify({
          declaredModules: [
            { name: "lib", glob: "packages/lib/**" },
            { name: "app", glob: "packages/app/**" },
          ],
          because: "test",
        })};\n`,
      );

      const result = await check(root);
      const text = formatText(result);
      expect(text).toContain(
        "note: package.json exports for 'lib' did not resolve to a source file, so check kept the default surface name",
      );
      expect(text).not.toContain("add packages/lib/index.ts");
      expect(JSON.stringify(result)).toContain("did not resolve to a source file");
      expect(JSON.stringify(result)).not.toContain("add packages/lib/index.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function writeLib(root: string, pkg: { exports: unknown }): void {
  const dir = join(root, "packages", "lib");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), "export const main = 1;\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "lib", ...pkg }));
}

function writeApp(root: string, specifier: string): void {
  const dir = join(root, "packages", "app");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "main.ts"), `import { main } from ${JSON.stringify(specifier)};\nexport const x = main;\n`);
}
