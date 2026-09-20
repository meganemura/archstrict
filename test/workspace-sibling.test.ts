// A real npm/yarn/pnpm workspace symlinks a sibling package into
// node_modules - TS resolves that exactly like a real external dependency
// (isExternalLibraryImport), but the real, symlink-followed target is this
// project's own code, not truly external. Built as a real filesystem
// symlink at test time (not committed - a checked-in symlink is a surprise
// on Windows, and every other fixture in this project commits a real file
// tree instead), so this exercises the exact resolution TypeScript itself
// performs, not a simulation of it.
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkAllowDeny, checkEdgesCoverage } from "../src/rules/constraints.js";
import type { Config } from "../src/config.js";

function writeWorkspaceFixture(root: string): void {
  mkdirSync(join(root, "packages", "a"), { recursive: true });
  mkdirSync(join(root, "packages", "b"), { recursive: true });
  writeFileSync(join(root, "packages", "a", "package.json"), JSON.stringify({ name: "@probe/a", main: "./index.ts" }));
  writeFileSync(join(root, "packages", "b", "package.json"), JSON.stringify({ name: "@probe/b", main: "./index.ts" }));
  writeFileSync(
    join(root, "packages", "a", "index.ts"),
    'import { b } from "@probe/b";\nimport { z } from "real-dep";\nexport const a = b + (z as number);\n',
  );
  writeFileSync(join(root, "packages", "b", "index.ts"), "export const b = 1;\n");
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "esnext", module: "nodenext", moduleResolution: "nodenext", strict: true, skipLibCheck: true, noEmit: true },
    }),
  );

  mkdirSync(join(root, "node_modules", "@probe"), { recursive: true });
  symlinkSync(join(root, "packages", "a"), join(root, "node_modules", "@probe", "a"));
  symlinkSync(join(root, "packages", "b"), join(root, "node_modules", "@probe", "b"));

  // A real external dependency, symlinked from OUTSIDE this project's own
  // root entirely (a pnpm-style store, or simply a directory elsewhere on
  // disk) - proves the discriminator is real containment, not "any
  // symlink": this one is a symlink too, but must still classify as
  // external, not a sibling.
  const externalStore = mkdtempSync(join(tmpdir(), "archstrict-external-dep-"));
  writeFileSync(join(externalStore, "package.json"), JSON.stringify({ name: "real-dep", main: "./index.ts" }));
  writeFileSync(join(externalStore, "index.ts"), "export const z = 1;\n");
  symlinkSync(externalStore, join(root, "node_modules", "real-dep"));
}

describe("workspace-sibling resolution (module-graph.ts + constraints.ts)", () => {
  test("a workspace sibling symlinked into node_modules gets this project's own classify tags, not a pkg: one", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-workspace-"));
    try {
      writeWorkspaceFixture(root);
      const graph = buildModuleGraph({
        projectRoot: root,
        declaredModules: [
          { name: "a", glob: "packages/a/**", surface: "index.ts" },
          { name: "b", glob: "packages/b/**", surface: "index.ts" },
        ],
      });

      const siblingEdge = graph.edges.find((e) => e.specifier === "@probe/b");
      expect(siblingEdge).toBeDefined();
      expect(siblingEdge!.externalPackage).toBeUndefined();
      expect(siblingEdge!.toModule).toBe("b");

      // The real external dependency, reached through a symlink too, must
      // still classify as external - a symlink alone doesn't make
      // something a sibling; only landing back inside this project does.
      const externalEdge = graph.edges.find((e) => e.specifier === "real-dep");
      expect(externalEdge).toBeDefined();
      expect(externalEdge!.externalPackage).toBe("real-dep");
      expect(externalEdge!.toModule).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a project's own classify tags now constrain a real workspace-sibling edge, and edgeRuleCoverage proves it was genuinely evaluated", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-workspace-"));
    try {
      writeWorkspaceFixture(root);
      const graph = buildModuleGraph({
        projectRoot: root,
        declaredModules: [
          { name: "a", glob: "packages/a/**", surface: "index.ts" },
          { name: "b", glob: "packages/b/**", surface: "index.ts" },
        ],
      });
      const config: Config = {
        configPath: "<test>",
        because: "test config",
        classify: [
          { glob: "packages/a/**", tags: ["kind:a"] },
          { glob: "packages/b/**", tags: ["kind:b"] },
        ],
        edges: { allowDeny: [{ source: "kind:a", targetNamespace: "kind", allow: [], because: "test" }] },
      };

      const violations = checkAllowDeny(graph, config);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.evidence).toContain("'@probe/b' (from 'kind:a') reaches 'kind:b'");

      const coverage = checkEdgesCoverage(graph, config);
      expect(coverage).toEqual([{ kind: "allowDeny", identifier: "kind:a -> kind", evaluated: 1 }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
