// Module resolution used to use only the project-root tsconfig.json's own
// compilerOptions for every file, so a leaf package's own path alias (a
// completely ordinary per-package convention, mirroring a webpack alias
// of the same name) was invisible - inflating unresolvedSpecifierCount
// for every aliased import in that package. Real, measured against
// allure-framework/allure3's web-* packages during the config-authoring
// experiment.
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";

const BASE_TSCONFIG = {
  compilerOptions: {
    target: "esnext",
    module: "nodenext",
    moduleResolution: "nodenext",
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  },
};

function writeFixture(root: string): void {
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify(BASE_TSCONFIG));

  // has-own-config: its own tsconfig.json extends the root, adding a
  // paths alias real leaf configs in a monorepo typically add on top of
  // shared base options, not in place of them.
  mkdirSync(join(root, "packages", "has-own-config", "src"), { recursive: true });
  writeFileSync(
    join(root, "packages", "has-own-config", "tsconfig.json"),
    JSON.stringify({ extends: "../../tsconfig.json", compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
  );
  writeFileSync(join(root, "packages", "has-own-config", "src", "util.ts"), "export const util = 1;\n");
  writeFileSync(
    join(root, "packages", "has-own-config", "index.ts"),
    'import { util } from "@/util";\nexport const value = util;\n',
  );

  // no-own-config: the identical alias, but no leaf tsconfig of its own -
  // the negative control. If this ALSO resolved, the fix would be
  // reading the alias too broadly (inheriting it project-wide) rather
  // than from the nearest config to each file.
  mkdirSync(join(root, "packages", "no-own-config", "src"), { recursive: true });
  writeFileSync(join(root, "packages", "no-own-config", "src", "util.ts"), "export const util = 2;\n");
  writeFileSync(
    join(root, "packages", "no-own-config", "index.ts"),
    'import { util } from "@/util";\nexport const value = util;\n',
  );
}

describe("per-file tsconfig.json resolution", () => {
  test("a leaf package's own tsconfig.json path alias resolves, reusing the real TypeScript paths/baseUrl convention", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-per-package-tsconfig-"));
    try {
      writeFixture(root);
      const graph = buildModuleGraph({
        projectRoot: root,
        declaredModules: [
          { name: "has-own-config", glob: "packages/has-own-config/**", surface: "index.ts" },
          { name: "no-own-config", glob: "packages/no-own-config/**", surface: "index.ts" },
        ],
      });

      const resolvedEdge = graph.edges.find(
        (e) => e.specifier === "@/util" && e.fromFile.includes("has-own-config"),
      );
      expect(resolvedEdge).toBeDefined();
      expect(resolvedEdge!.resolvedFile.endsWith("packages/has-own-config/src/util.ts")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the SAME alias in a package with no tsconfig.json of its own stays unresolved - the fix reads the nearest config, not the whole project's", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-per-package-tsconfig-"));
    try {
      writeFixture(root);
      const graph = buildModuleGraph({
        projectRoot: root,
        declaredModules: [
          { name: "has-own-config", glob: "packages/has-own-config/**", surface: "index.ts" },
          { name: "no-own-config", glob: "packages/no-own-config/**", surface: "index.ts" },
        ],
      });

      const unresolvedEdge = graph.edges.find(
        (e) => e.specifier === "@/util" && e.fromFile.includes("no-own-config"),
      );
      expect(unresolvedEdge).toBeUndefined();
      expect(graph.unresolvedSpecifierCount).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
