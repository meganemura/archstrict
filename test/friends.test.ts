// Rule 1's own "friend" exception (declaredModules[].friends): a specific
// internal file is public to exactly the importers a `from` glob matches,
// private to everyone else - unlike `surface`, which is public to every
// importer equally. Design recorded in rules.md's rule 1 section; this is
// its real implementation test.
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkPublicSurfaceBypass } from "../src/rules/public-surface.js";

describe("declaredModules[].friends (rule 1's friend exception)", () => {
  test("a friend importer is exempt, a non-friend importer still violates, and the module's own file is never affected", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-friends-"));
    try {
      mkdirSync(join(root, "src", "core"), { recursive: true });
      mkdirSync(join(root, "src", "friend"), { recursive: true });
      mkdirSync(join(root, "src", "stranger"), { recursive: true });

      writeFileSync(join(root, "src", "core", "index.ts"), "export const publicThing = 1;\n");
      writeFileSync(join(root, "src", "core", "internal.ts"), "export const internalThing = 1;\n");
      // core's own internal file importing itself: never a violation
      // regardless of friends, the same as any other intra-module edge.
      writeFileSync(
        join(root, "src", "core", "reexport.ts"),
        'export { internalThing } from "./internal.js";\n',
      );
      writeFileSync(
        join(root, "src", "friend", "module.ts"),
        'import { internalThing } from "../core/internal.js";\nexport const x = internalThing;\n',
      );
      writeFileSync(
        join(root, "src", "stranger", "module.ts"),
        'import { internalThing } from "../core/internal.js";\nexport const y = internalThing;\n',
      );

      const graph = buildModuleGraph({
        projectRoot: root,
        declaredModules: [
          {
            name: "core",
            glob: "src/core/**",
            surface: "index.ts",
            friends: [{ file: "internal.ts", from: "src/friend/**", because: "test" }],
          },
          { name: "friend", glob: "src/friend/**", surface: "index.ts" },
          { name: "stranger", glob: "src/stranger/**", surface: "index.ts" },
        ],
      });
      expect(graph.unresolvedSpecifierCount).toBe(0);

      const violations = checkPublicSurfaceBypass(graph);
      const paths = violations.map((v) => v.path);

      expect(paths.some((p) => p.endsWith("src/friend/module.ts"))).toBe(false);
      expect(paths.some((p) => p.endsWith("src/stranger/module.ts"))).toBe(true);
      expect(paths.some((p) => p.endsWith("src/core/reexport.ts"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
