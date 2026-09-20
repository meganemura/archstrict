// A real, second public-surface convention (found in the config-authoring
// experiment: a webpack-built package publishing `"types": "./types.d.ts"`
// with no index.ts at all) - a hand-authored .d.ts is otherwise excluded
// from analysis entirely (most .d.ts files are either a third-party
// ambient declaration or a generated twin of a real .ts file, neither one
// "module content"), so a declaredModules entry whose own `surface` glob
// explicitly names one is the sole, narrow exception.
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkPublicSurfaceBypass } from "../src/rules/public-surface.js";

describe(".d.ts as a module's public surface", () => {
  test("a declaredModules surface naming a .d.ts file is recognized, and a real import through it resolves", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-dts-surface-"));
    try {
      mkdirSync(join(root, "packages", "webish"), { recursive: true });
      mkdirSync(join(root, "packages", "consumer"), { recursive: true });
      writeFileSync(join(root, "packages", "webish", "internal.ts"), "export type Widget = { name: string };\n");
      // A hand-authored .d.ts naming what the package's own built dist/
      // exposes - the real npm convention this ticket found ("types":
      // "./types.d.ts"), reproduced without a build step since a `.js`
      // specifier resolves to a sibling `.d.ts` under node/nodenext
      // resolution the same way it would resolve to real compiled output.
      writeFileSync(join(root, "packages", "webish", "types.d.ts"), 'export type { Widget } from "./internal.js";\n');
      writeFileSync(
        join(root, "packages", "consumer", "module.ts"),
        'import type { Widget } from "../webish/types.js";\nexport function use(w: Widget): string { return w.name; }\n',
      );
      writeFileSync(
        join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { target: "esnext", module: "nodenext", moduleResolution: "nodenext", strict: true, skipLibCheck: true, noEmit: true },
        }),
      );

      const graph = buildModuleGraph({
        projectRoot: root,
        declaredModules: [
          { name: "webish", glob: "packages/webish/**", surface: "types.d.ts" },
          { name: "consumer", glob: "packages/consumer/**", surface: "index.ts" },
        ],
      });

      const webish = graph.modules.get("webish")!;
      expect(webish.surfaceFiles).toHaveLength(1);
      expect(webish.surfaceFiles[0]!.endsWith("types.d.ts")).toBe(true);

      // The edge through the .d.ts surface resolves and is a clean pass -
      // reaching the surface itself is never a bypass.
      const edge = graph.edges.find((e) => e.specifier === "../webish/types.js");
      expect(edge).toBeDefined();
      expect(edge!.toModule).toBe("webish");
      expect(checkPublicSurfaceBypass(graph)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a real edge that reaches PAST the .d.ts surface, into internal.ts directly, is still a public-surface-bypass", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-dts-surface-"));
    try {
      mkdirSync(join(root, "packages", "webish"), { recursive: true });
      mkdirSync(join(root, "packages", "consumer"), { recursive: true });
      writeFileSync(join(root, "packages", "webish", "internal.ts"), "export type Widget = { name: string };\n");
      writeFileSync(join(root, "packages", "webish", "types.d.ts"), 'export type { Widget } from "./internal.js";\n');
      writeFileSync(
        join(root, "packages", "consumer", "module.ts"),
        // Bypasses types.d.ts entirely, reaching internal.ts directly.
        'import type { Widget } from "../webish/internal.js";\nexport function use(w: Widget): string { return w.name; }\n',
      );
      writeFileSync(
        join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { target: "esnext", module: "nodenext", moduleResolution: "nodenext", strict: true, skipLibCheck: true, noEmit: true },
        }),
      );

      const graph = buildModuleGraph({
        projectRoot: root,
        declaredModules: [
          { name: "webish", glob: "packages/webish/**", surface: "types.d.ts" },
          { name: "consumer", glob: "packages/consumer/**", surface: "index.ts" },
        ],
      });

      const violations = checkPublicSurfaceBypass(graph);
      expect(violations).toHaveLength(1);
      // Names the module's own real surface (types.d.ts), not the
      // project's global default - a module whose surface overrides the
      // default must get an accurate next: too, not one telling the
      // reader to use a file ("index.ts") this module doesn't even have.
      expect(violations[0]!.evidence).toContain("other than its types.d.ts");
      expect(violations[0]!.next).toContain("webish/types.d.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a .d.ts not named by any declaredModules surface stays excluded, same as before", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-dts-surface-"));
    try {
      mkdirSync(join(root, "packages", "app"), { recursive: true });
      writeFileSync(join(root, "packages", "app", "index.ts"), "export const app = 1;\n");
      writeFileSync(join(root, "packages", "app", "global.d.ts"), "declare const __VERSION__: string;\n");
      writeFileSync(
        join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { target: "esnext", module: "nodenext", moduleResolution: "nodenext", strict: true, skipLibCheck: true, noEmit: true },
        }),
      );

      const graph = buildModuleGraph({
        projectRoot: root,
        declaredModules: [{ name: "app", glob: "packages/app/**", surface: "index.ts" }],
      });

      const app = graph.modules.get("app")!;
      expect(app.files.some((f) => f.endsWith("global.d.ts"))).toBe(false);
      expect(graph.outsideFiles.some((f) => f.endsWith("global.d.ts"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
