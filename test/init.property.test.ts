// Properties over a randomly-shaped project tree - one of three top-level
// shapes (no src/ at all, a flat src/ holding only files, or a src/ holding
// directories), nested directories, loose top-level files, overlapping
// on-disk names (forcing the naming-collision path), a hidden directory at
// a random depth, and a noise directory - checked against the real graph a
// fresh `archstrict init` writes and check's own code path builds from it,
// not against a second, hand-rolled computation of the same answer.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/verbs/init.js";
import { loadConfig } from "../src/verbs/check.js";
import {
  listAnalyzedFiles,
  moduleForDeclaredFile,
  moduleGlobBaseDir,
  toProjectRelativePosix,
  type ModuleGraph,
} from "../src/module-graph.js";
import { compileGlob } from "../src/classify.js";
import { checkUncoveredModules } from "../src/rules/uncovered.js";

// "widgets" is deliberately in both SRC_DIR_NAMES and TOP_DIR_NAMES, and
// "cli.ts" / "context.ts" are deliberately in both the src and top file
// pools - two groups that land at different anchors (src/widgets and
// widgets/, or src/cli.ts and cli.ts) but share an on-disk name, forcing
// the same collision path a real project hits (a root file and a same-name
// src/ file, or a same-name directory at two levels) rather than never
// drawing one at all.
const SRC_DIR_NAMES = ["alpha", "beta", "gamma", "widgets"] as const;
const SRC_FILE_NAMES = ["one.ts", "two.ts", "cli.ts"] as const;
const TOP_DIR_NAMES = ["widgets", "gizmos", "context"] as const;
const TOP_FILE_NAMES = ["cli.ts", "tool.config.ts", "context.ts"] as const;

type Shape = "none" | "flat" | "dirs";

type Tree = {
  shape: Shape;
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
  shape: gs.sampledFrom(["none", "flat", "dirs"] as const),
  srcDirFlags: gs.arrays(gs.booleans(), { minSize: SRC_DIR_NAMES.length, maxSize: SRC_DIR_NAMES.length }),
  srcFileFlags: gs.arrays(gs.booleans(), { minSize: SRC_FILE_NAMES.length, maxSize: SRC_FILE_NAMES.length }),
  topDirFlags: gs.arrays(gs.booleans(), { minSize: TOP_DIR_NAMES.length, maxSize: TOP_DIR_NAMES.length }),
  topFileFlags: gs.arrays(gs.booleans(), { minSize: TOP_FILE_NAMES.length, maxSize: TOP_FILE_NAMES.length }),
  hiddenAtRoot: gs.booleans(),
  hiddenNested: gs.booleans(),
  includeNoise: gs.booleans(),
  includeMd: gs.booleans(),
});

// Writes the random tree to disk under `root`. Each shape guarantees at
// least one real candidate on its own (a directory holding a hidden-nested
// test needs a real parent too) so init never sees zero analyzed files
// regardless of which optional flags below land false - the zero-candidate
// case is its own example test, not this property.
function writeTree(root: string, tree: Tree): void {
  // The directory every optional entry below nests under when it needs a
  // real parent directory to nest inside (hiddenNested) - the shape's own
  // guaranteed directory, so it exists under every shape.
  let nestParent: string;

  if (tree.shape === "dirs") {
    mkdirSync(join(root, "src", "alpha"), { recursive: true });
    writeFileSync(join(root, "src", "alpha", "index.ts"), "export const alpha = 1;\n");
    for (const [i, name] of SRC_DIR_NAMES.entries()) {
      if (i === 0 || !tree.srcDirFlags[i]) continue; // alpha (i===0) is the guaranteed one above
      mkdirSync(join(root, "src", name), { recursive: true });
      writeFileSync(join(root, "src", name, "index.ts"), `export const ${name} = 1;\n`);
    }
    nestParent = join(root, "src", "alpha");
  } else if (tree.shape === "flat") {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", SRC_FILE_NAMES[0]), "export const one = 1;\n");
    for (const [i, name] of SRC_FILE_NAMES.entries()) {
      if (i === 0 || !tree.srcFileFlags[i]) continue;
      writeFileSync(join(root, "src", name), `export const ${name.replace(".ts", "")} = 1;\n`);
    }
    nestParent = join(root, "src");
  } else {
    mkdirSync(join(root, "core"), { recursive: true });
    writeFileSync(join(root, "core", "index.ts"), "export const core = 1;\n");
    nestParent = join(root, "core");
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
    mkdirSync(join(nestParent, ".hidden-nested"), { recursive: true });
    writeFileSync(join(nestParent, ".hidden-nested", "y.ts"), "export const y = 1;\n");
  }
  if (tree.includeNoise) {
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(join(root, "test", "some.test.ts"), "export const t = 1;\n");
  }
  if (tree.includeMd) {
    writeFileSync(join(nestParent, "notes.md"), "# not source\n");
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

  // The generator's own on-disk name pools overlap on purpose (see their
  // own comment above), so a config nameCandidates fails to disambiguate
  // would show up here as a real duplicate - checked against the raw
  // config array, not result.moduleNames, which init already runs through
  // a Set and so can never itself contain a duplicate to find.
  test("P2 names: every declaredModules name is unique, and ModuleName equals the sorted unique config names", async () => {
    await hegel.testAsync(async (tc) => {
      const tree = tc.draw(treeGenerator);
      await withTree(tree, async (root) => {
        const result = await init(root);
        const config = await loadConfig(join(root, "archstrict.config.ts"));
        const rawNames = config.declaredModules!.map((dm) => dm.name);
        assert.equal(new Set(rawNames).size, rawNames.length, "declaredModules has a duplicate name");
        const sortedUnique = [...new Set(rawNames)].sort();
        assert.deepEqual(result.moduleNames, sortedUnique);
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

  // Argument normalization only has a real "src" directory to name under
  // the two src/ shapes - under "none" there is no src/ at all, so the
  // three arguments that must normalize to the same thing are instead the
  // three spellings of "no container" (".", "./", "*").
  test("P5 argument normalization: three spellings of the same argument write byte-identical configs", async () => {
    await hegel.testAsync(async (tc) => {
      const tree = tc.draw(treeGenerator);
      const args = tree.shape === "none" ? [".", "./", "*"] : ["src", "src/", "src/*"];
      const configs: string[] = [];
      for (const arg of args) {
        await withTree(tree, async (root) => {
          await init(root, arg);
          configs.push(readFileSync(join(root, "archstrict.config.ts"), "utf8"));
        });
      }
      assert.equal(configs[1], configs[0]);
      assert.equal(configs[2], configs[0]);
    });
  });

  // The byte-identical half (a second init never rewrites the config at
  // all) holds trivially by construction; the property worth checking is
  // that the module-name union a re-run reports agrees with the union the
  // fresh run just wrote, not merely that no bytes moved.
  test("P6 idempotence: a second init's module-name union equals the fresh run's own union", async () => {
    await hegel.testAsync(async (tc) => {
      const tree = tc.draw(treeGenerator);
      await withTree(tree, async (root) => {
        const first = await init(root);
        const before = readFileSync(join(root, "archstrict.config.ts"), "utf8");
        const second = await init(root);
        assert.equal(readFileSync(join(root, "archstrict.config.ts"), "utf8"), before);
        assert.deepEqual(second.moduleNames, first.moduleNames);
      });
    });
  });

  // Round-trips a fresh config through a random removal (simulating a
  // hand-edit that drops some entries) plus a few new, real files no
  // surviving entry could ever match - then checks the re-run's own
  // suggestion against an independent computation of the same answer
  // (checkUncoveredModules, rule 3's own rule), not init re-deriving
  // itself. avoids buildModuleGraph (a real ts.Program) the same way P1
  // does - listAnalyzedFiles + moduleForDeclaredFile is the exact
  // predicate pair a real graph build uses to decide `outsideFiles`.
  test("P7 suggestion round trip: a re-run's declare lines equal rule 3's own suggestion for the same files, and pasting all of them leaves 0 uncovered with unique names", async () => {
    await hegel.testAsync(async (tc) => {
      const tree = tc.draw(treeGenerator);
      await withTree(tree, async (root) => {
        await init(root);
        const configPath = join(root, "archstrict.config.ts");
        const config = await loadConfig(configPath);
        const declaredModules = config.declaredModules!;
        const keepFlags = tc.draw(
          gs.arrays(gs.booleans(), { minSize: declaredModules.length, maxSize: declaredModules.length }),
        );
        const kept = declaredModules.filter((_, i) => keepFlags[i]);
        writeFileSync(configPath, `export default ${JSON.stringify({ ...config, declaredModules: kept })};`);

        // New, real files no surviving entry could ever match - guaranteed
        // uncovered regardless of which entries the random removal above
        // kept, and covering both group shapes (a root file, a root
        // directory).
        writeFileSync(join(root, "___zz_loose.ts"), "export const zz = 1;\n");
        mkdirSync(join(root, "___zz_dir"), { recursive: true });
        writeFileSync(join(root, "___zz_dir", "leaf.ts"), "export const zz2 = 1;\n");
        if (tree.shape !== "none") {
          writeFileSync(join(root, "src", "___zz_src_loose.ts"), "export const zz3 = 1;\n");
        }

        const rerun = await init(root);
        const declareLines = rerun.messageLines
          .filter((l) => l.trim().startsWith("declare: "))
          .map((l) => l.trim().slice("declare: ".length).replace(/,$/, ""))
          .sort();

        const rerunConfig = await loadConfig(configPath);
        const files = listAnalyzedFiles(root, rerunConfig.exclude ?? [], rerunConfig.declaredModules, rerunConfig.surface ?? "index.ts");
        const outsideFiles = files.filter((f) => moduleForDeclaredFile(f, root, rerunConfig.declaredModules ?? []) === undefined);
        assert.ok(outsideFiles.length > 0);
        const fakeGraph = { rootDir: root, outsideFiles } as ModuleGraph;
        const rule3Texts = [
          ...new Set(checkUncoveredModules(fakeGraph, rerunConfig).map((v) => v.do.match(/^add (.+) to declaredModules/)![1])),
        ].sort();
        assert.deepEqual(declareLines, rule3Texts);

        // Pasting every suggested entry, together with what survived the
        // random removal, leaves 0 uncovered-module and every name unique.
        const pasted = [...kept, ...declareLines.map((text) => (0, eval)(`(${text})`))];
        assert.equal(new Set(pasted.map((e) => e.name)).size, pasted.length, "pasted entries have a duplicate name");
        const pastedFiles = listAnalyzedFiles(root, rerunConfig.exclude ?? [], pasted, rerunConfig.surface ?? "index.ts");
        assert.equal(pastedFiles.filter((f) => moduleForDeclaredFile(f, root, pasted) === undefined).length, 0);
      });
    });
  });
});
