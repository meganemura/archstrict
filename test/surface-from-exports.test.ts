// declaredModules[].surface is optional - when a declaredModules entry
// omits it and a real package.json sits at that module's own root,
// buildDeclaredModules derives surface from the package's own real
// exports map (every entry confidently resolved back to a real, existing
// source file), never a partial or guessed-wrong array.
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";

function withTempProject(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "archstrict-surface-exports-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("declaredModules[].surface derived from a real package.json exports map", () => {
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
});
