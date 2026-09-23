// declaredModules[].surface can be a single glob or several - a real
// package can publish more than one real, differently-shaped public entry
// point at once (a package.json exports map naming several real paths,
// not just its default "main"). Measured directly, authoring a config
// against a real monorepo: a package with 14 real entry points forced an
// author into misusing `friends` (a narrower, per-consumer mechanism) for
// every extra one, each with `from` matching everyone - not a friend
// exception at all, just an unconditionally-public entry point.
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkPublicSurfaceBypass } from "../src/rules/public-surface.js";

describe("declaredModules[].surface as an array of globs", () => {
  test("surfaceFiles is the union of every glob's own matches, and each is a real, unconditional public entry point", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-multi-surface-"));
    try {
      mkdirSync(join(root, "src", "server"), { recursive: true });
      mkdirSync(join(root, "src", "consumer"), { recursive: true });

      writeFileSync(join(root, "src", "server", "index.ts"), "export const main = 1;\n");
      writeFileSync(join(root, "src", "server", "http.ts"), "export const http = 1;\n");
      writeFileSync(join(root, "src", "server", "internal.ts"), "export const internal = 1;\n");
      writeFileSync(
        join(root, "src", "consumer", "module.ts"),
        [
          `import { main } from "../server/index.js";`,
          `import { http } from "../server/http.js";`,
          `import { internal } from "../server/internal.js";`,
          `export const x = [main, http, internal];`,
        ].join("\n"),
      );

      const graph = buildModuleGraph({
        projectRoot: root,
        declaredModules: [
          { name: "server", glob: "src/server/**", surface: ["index.ts", "http.ts"] },
          { name: "consumer", glob: "src/consumer/**", surface: "index.ts" },
        ],
      });
      expect(graph.unresolvedSpecifierCount).toBe(0);

      const server = graph.modules.get("server")!;
      expect(server.surfaceFiles).toHaveLength(2);
      expect(server.surfaceFiles.some((f) => f.endsWith("src/server/index.ts"))).toBe(true);
      expect(server.surfaceFiles.some((f) => f.endsWith("src/server/http.ts"))).toBe(true);

      const violations = checkPublicSurfaceBypass(graph);
      // Both index.ts and http.ts are reached - neither violates, since
      // both are configured surface entries; only internal.ts does.
      expect(violations).toHaveLength(1);
      expect(violations[0]!.evidence).toContain("'../server/internal.js'");
      // Plural display names both real entry points, not one arbitrarily.
      expect(violations[0]!.evidence).toContain("index.ts, http.ts");
      expect(violations[0]!.do).toContain("server/index.ts, server/http.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a single-string surface still reads exactly as before (no plural wording)", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-multi-surface-single-"));
    try {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      mkdirSync(join(root, "src", "consumer"), { recursive: true });
      writeFileSync(join(root, "src", "app", "internal.ts"), "export const x = 1;\n");
      writeFileSync(
        join(root, "src", "consumer", "module.ts"),
        'import { x } from "../app/internal.js";\nexport const y = x;\n',
      );

      const graph = buildModuleGraph({
        projectRoot: root,
        declaredModules: [
          { name: "app", glob: "src/app/**", surface: "index.ts" },
          { name: "consumer", glob: "src/consumer/**", surface: "index.ts" },
        ],
      });

      const violations = checkPublicSurfaceBypass(graph);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.do).toBe("add a index.ts to app/ naming what it exports");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
