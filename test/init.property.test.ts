// Properties over a randomly-shaped project tree - src/ present or absent,
// nested directories, loose top-level files, a hidden directory at a random
// depth, and a noise directory - checked against the real graph a fresh
// `archstrict init` writes and check's own code path builds from it, not
// against a second, hand-rolled computation of the same answer.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/verbs/init.js";
import { loadConfig } from "../src/verbs/check.js";
import { listAnalyzedFiles, moduleForDeclaredFile, moduleGlobBaseDir, toProjectRelativePosix } from "../src/module-graph.js";
import { compileGlob } from "../src/classify.js";

const SRC_DIR_NAMES = ["alpha", "beta", "gamma"] as const;
const SRC_FILE_NAMES = ["one.ts", "two.ts"] as const;
const TOP_DIR_NAMES = ["widgets", "gizmos"] as const;
const TOP_FILE_NAMES = ["cli.ts", "tool.config.ts"] as const;

type Tree = {
  srcDirFlags: boolean[];
  srcFileFlags: boolean[];
  topDirFlags: boolean[];
  topFileFlags: boolean[];
  hiddenAtRoot: boolean;
  hiddenNested: boolean;
  includeNoise: boolean;
  includeMd: boolean;
};

const treeGenerator = gs.record({
  srcDirFlags: gs.arrays(gs.booleans(), { minSize: SRC_DIR_NAMES.length, maxSize: SRC_DIR_NAMES.length }),
  srcFileFlags: gs.arrays(gs.booleans(), { minSize: SRC_FILE_NAMES.length, maxSize: SRC_FILE_NAMES.length }),
  topDirFlags: gs.arrays(gs.booleans(), { minSize: TOP_DIR_NAMES.length, maxSize: TOP_DIR_NAMES.length }),
  topFileFlags: gs.arrays(gs.booleans(), { minSize: TOP_FILE_NAMES.length, maxSize: TOP_FILE_NAMES.length }),
  hiddenAtRoot: gs.booleans(),
  hiddenNested: gs.booleans(),
  includeNoise: gs.booleans(),
  includeMd: gs.booleans(),
});

// Writes the random tree to disk under `root`. Always writes src/alpha/ so
// the container is never empty (the zero-candidates case is its own
// example test, not this property) - every other src/ entry is optional.
function writeTree(root: string, tree: Tree): void {
  mkdirSync(join(root, "src", "alpha"), { recursive: true });
  writeFileSync(join(root, "src", "alpha", "index.ts"), "export const alpha = 1;\n");
  for (const [i, name] of SRC_DIR_NAMES.entries()) {
    if (i === 0 || !tree.srcDirFlags[i]) continue; // alpha (i===0) is the guaranteed one above
    mkdirSync(join(root, "src", name), { recursive: true });
    writeFileSync(join(root, "src", name, "index.ts"), `export const ${name} = 1;\n`);
  }
  for (const [i, name] of SRC_FILE_NAMES.entries()) {
    if (!tree.srcFileFlags[i]) continue;
    writeFileSync(join(root, "src", name), `export const ${name.replace(".ts", "")} = 1;\n`);
  }
  for (const [i, name] of TOP_DIR_NAMES.entries()) {
    if (!tree.topDirFlags[i]) continue;
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "index.ts"), `export const ${name} = 1;\n`);
  }
  for (const [i, name] of TOP_FILE_NAMES.entries()) {
    if (!tree.topFileFlags[i]) continue;
    writeFileSync(join(root, name), `export const x = 1;\n`);
  }
  if (tree.hiddenAtRoot) {
    mkdirSync(join(root, ".hidden-root"), { recursive: true });
    writeFileSync(join(root, ".hidden-root", "x.ts"), "export const x = 1;\n");
  }
  if (tree.hiddenNested) {
    mkdirSync(join(root, "src", "alpha", ".hidden-nested"), { recursive: true });
    writeFileSync(join(root, "src", "alpha", ".hidden-nested", "y.ts"), "export const y = 1;\n");
  }
  if (tree.includeNoise) {
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(join(root, "test", "some.test.ts"), "export const t = 1;\n");
  }
  if (tree.includeMd) {
    writeFileSync(join(root, "src", "notes.md"), "# not source\n");
  }
}

async function withTree(tree: Tree, fn: (root: string) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-init-property-")));
  try {
    writeTree(root, tree);
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("init (property)", () => {
  // Deliberately avoids buildModuleGraph (which compiles a real ts.Program):
  // coverage is a pure fact about the analyzed file list and the
  // declaredModules globs, and module-graph.ts's own listAnalyzedFiles and
  // moduleForDeclaredFile are the exact functions check's own graph build
  // uses to answer it, without the added cost of a real program per draw.
  test("P1 coverage: every analyzed file matches exactly one declaredModules glob, and none is outside every module", async () => {
    await hegel.testAsync(async (tc) => {
      const tree = tc.draw(treeGenerator);
      await withTree(tree, async (root) => {
        await init(root);
        const config = await loadConfig(join(root, "archstrict.config.ts"));
        const declaredModules = config.declaredModules!;
        const files = listAnalyzedFiles(root, config.exclude ?? [], declaredModules, config.surface ?? "index.ts");
        assert.ok(files.length > 0);
        for (const file of files) {
          const rel = toProjectRelativePosix(file, root);
          const matches = declaredModules.filter((dm) => compileGlob(dm.glob).test(rel));
          assert.equal(matches.length, 1, `expected exactly one glob match for ${rel}, got ${matches.length}`);
          assert.notEqual(moduleForDeclaredFile(file, root, declaredModules), undefined);
        }
      });
    });
  });

  test("P2 names: every declaredModules name is unique, and ModuleName equals the sorted unique config names", async () => {
    await hegel.testAsync(async (tc) => {
      const tree = tc.draw(treeGenerator);
      await withTree(tree, async (root) => {
        const result = await init(root);
        const names = result.moduleNames;
        assert.equal(new Set(names).size, names.length);
        const config = await loadConfig(join(root, "archstrict.config.ts"));
        const sortedUnique = [...new Set(config.declaredModules!.map((dm) => dm.name))].sort();
        assert.deepEqual(names, sortedUnique);
      });
    });
  });

  test("P3 no root base: no declaredModules entry's own glob base is the project root", async () => {
    await hegel.testAsync(async (tc) => {
      const tree = tc.draw(treeGenerator);
      await withTree(tree, async (root) => {
        const config = await init(root).then(() => loadConfig(join(root, "archstrict.config.ts")));
        for (const dm of config.declaredModules!) {
          assert.notEqual(moduleGlobBaseDir(dm.glob), "");
        }
      });
    });
  });

  test("P4 hidden: no file under a hidden directory, at any depth, is analyzed at all", async () => {
    await hegel.testAsync(async (tc) => {
      const tree = tc.draw(treeGenerator);
      await withTree(tree, async (root) => {
        await init(root);
        const config = await loadConfig(join(root, "archstrict.config.ts"));
        const files = listAnalyzedFiles(root, config.exclude ?? [], config.declaredModules, config.surface ?? "index.ts");
        for (const file of files) {
          const rel = toProjectRelativePosix(file, root);
          assert.ok(!rel.split("/").some((segment) => segment.startsWith(".")), `${rel} is under a hidden directory`);
        }
      });
    });
  });

  test("P5 argument normalization: init(d), init(d + \"/\"), and init(d + \"/*\") write byte-identical configs", async () => {
    await hegel.testAsync(async (tc) => {
      const tree = tc.draw(treeGenerator);
      const configs: string[] = [];
      for (const arg of ["src", "src/", "src/*"]) {
        await withTree(tree, async (root) => {
          await init(root, arg);
          configs.push(readFileSync(join(root, "archstrict.config.ts"), "utf8"));
        });
      }
      assert.equal(configs[1], configs[0]);
      assert.equal(configs[2], configs[0]);
    });
  });

  test("P6 idempotence: a second init leaves the config byte-identical", async () => {
    await hegel.testAsync(async (tc) => {
      const tree = tc.draw(treeGenerator);
      await withTree(tree, async (root) => {
        await init(root);
        const before = readFileSync(join(root, "archstrict.config.ts"), "utf8");
        await init(root);
        assert.equal(readFileSync(join(root, "archstrict.config.ts"), "utf8"), before);
      });
    });
  });
});
