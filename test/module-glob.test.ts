// A flat directory can name a seam as an array of file paths. Membership,
// surface, friends, and the type-leak boundary stay on those files. A
// list that spans two directories is a config error.
import { describe, expect, test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mostSpecificMatch } from "../src/classify.js";
import {
  buildModuleGraph,
  declaredModuleMembership,
  globResolutionDir,
  moduleForDeclaredFile,
  sharedGlobResolutionDir,
} from "../src/module-graph.js";
import { check, formatText, loadConfig } from "../src/verbs/check.js";
import { init } from "../src/verbs/init.js";
import { recommend } from "../src/verbs/recommend.js";
import { todo } from "../src/verbs/todo.js";
import { ReportError } from "../src/report-error.js";

const segment = gen.fromRegex("[a-z][a-z0-9]{2,6}");

function withTempProject(fn: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "archstrict-glob-"));
  return Promise.resolve().then(() => fn(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

function write(root: string, rel: string, text: string): void {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

describe("glob array membership (property)", () => {
  test("a file list matches exactly the listed files, and an exact path beats a directory glob", () => {
    hegel.test((tc) => {
      const dir = tc.draw(segment);
      const stems = [...new Set(Array.from({ length: 4 }, () => tc.draw(segment)))];
      if (stems.length < 2) return;
      const listed = stems.slice(0, stems.length - 1);
      const outsider = stems[stems.length - 1]!;
      const globs = listed.map((name) => `${dir}/${name}.ts`);
      const membership = declaredModuleMembership([{ name: "seam", glob: globs }]);
      const same = (left: string, right: string) => left === right;
      for (const name of listed) {
        assert.equal(mostSpecificMatch(`${dir}/${name}.ts`, membership, same), "seam");
      }
      assert.equal(mostSpecificMatch(`${dir}/${outsider}.ts`, membership, same), undefined);
      const exact = `${dir}/${listed[0]}.ts`;
      const both = [
        { glob: `${dir}/**`, value: "wide" },
        { glob: exact, value: "seam" },
      ];
      assert.equal(mostSpecificMatch(exact, both, same), "seam");
      assert.equal(mostSpecificMatch(exact, [...both].reverse(), same), "seam");
      assert.equal(sharedGlobResolutionDir(globs), dir);
      assert.equal(globResolutionDir(`${dir}/**`), dir);
      assert.equal(sharedGlobResolutionDir([globs[0]!, `other/${outsider}.ts`]), undefined);
    });
  });
});

describe("flat-directory file list", () => {
  test("two files are one module, the sibling stays out, and the surface is the named file", async () => {
    await withTempProject(async (root) => {
      write(root, "src/build/plan.ts", "export const plan = 1;\n");
      write(root, "src/build/graph.ts", "export const graph = 1;\n");
      write(root, "src/build/other.ts", "export const other = 1;\n");
      write(root, "src/app/main.ts", "import { plan } from \"../build/plan.ts\";\nimport { graph } from \"../build/graph.ts\";\nexport const main = plan + graph;\n");
      write(root, "src/app/side.ts", "import { graph } from \"../build/graph.ts\";\nexport const side = graph;\n");
      write(root, "archstrict.config.ts", `export default {
        declaredModules: [
          { name: "plan", glob: ["src/build/plan.ts", "src/build/graph.ts"], surface: "plan.ts", friends: [{ file: "graph.ts", from: "src/app/main.ts", because: "main reads the plan graph" }] },
          { name: "other.ts", glob: "src/build/other.ts", surface: "other.ts" },
          { name: "app", glob: "src/app/**", surface: "main.ts" },
        ],
        because: "plan and graph are one seam inside a flat build directory",
      };`);

      const graph = buildModuleGraph({
        projectRoot: root,
        declaredModules: [
          {
            name: "plan",
            glob: ["src/build/plan.ts", "src/build/graph.ts"],
            surface: "plan.ts",
            friends: [{ file: "graph.ts", from: "src/app/main.ts", because: "main reads the plan graph" }],
          },
          { name: "other.ts", glob: "src/build/other.ts", surface: "other.ts" },
          { name: "app", glob: "src/app/**", surface: "main.ts" },
        ],
      });
      const plan = graph.modules.get("plan")!;
      expect(plan.rootIsFile).toBe(false);
      expect(plan.files.map((file) => file.endsWith("plan.ts") || file.endsWith("graph.ts")).every(Boolean)).toBe(true);
      expect(plan.files).toHaveLength(2);
      expect(plan.surfaceFiles).toHaveLength(1);
      expect(plan.surfaceFiles[0]).toMatch(/plan\.ts$/);
      expect(plan.boundaryRoots).toHaveLength(2);
      expect(plan.boundaryRoots.every((rootPath) => rootPath.endsWith("plan.ts") || rootPath.endsWith("graph.ts"))).toBe(true);
      expect(plan.boundaryRoots.some((rootPath) => rootPath.endsWith("other.ts"))).toBe(false);
      expect(moduleForDeclaredFile(join(root, "src/build/other.ts"), root, [
        { name: "plan", glob: ["src/build/plan.ts", "src/build/graph.ts"] },
        { name: "other.ts", glob: "src/build/other.ts", surface: "other.ts" },
      ])).toBe("other.ts");

      const result = await check(root);
      const bypasses = result.violations.filter((violation) => violation.rule === "public-surface-bypass");
      // main.ts is a friend of graph.ts and imports the surface plan.ts.
      // side.ts imports graph.ts and is not a friend.
      expect(bypasses).toHaveLength(1);
      expect(bypasses[0]?.path).toMatch(/side\.ts$/);
    });
  });

  test("a glob array spanning two directories is a config error", async () => {
    await withTempProject(async (root) => {
      write(root, "archstrict.config.ts", `export default {
        declaredModules: [{ name: "span", glob: ["src/a/a.ts", "src/b/b.ts"] }],
        because: "two directories",
      };`);
      await expect(loadConfig(join(root, "archstrict.config.ts"))).rejects.toBeInstanceOf(ReportError);
      await expect(loadConfig(join(root, "archstrict.config.ts"))).rejects.toThrow(/do not share one directory/);
    });
  });

  test("an empty glob array is a config error", async () => {
    await withTempProject(async (root) => {
      write(root, "archstrict.config.ts", `export default {
        declaredModules: [{ name: "empty", glob: [] }],
        because: "empty",
      };`);
      await expect(loadConfig(join(root, "archstrict.config.ts"))).rejects.toThrow(/non-empty array of strings/);
    });
  });
});

describe("mega-module and file-per-module notes", () => {
  test("init names a directory that holds almost every file", async () => {
    await withTempProject(async (root) => {
      for (let i = 0; i < 8; i++) write(root, `src/core/f${i}.ts`, `export const f${i} = ${i};\n`);
      write(root, "src/edge/one.ts", "export const one = 1;\n");
      const result = await init(root);
      expect(result.notes.some((note) => note.includes("module 'core' holds 8 of 9"))).toBe(true);
    });
  });

  test("recommend names a flat file-per-module inventory and a mega-module", async () => {
    await withTempProject(async (root) => {
      for (const name of ["a", "b", "c", "d"]) write(root, `src/${name}.ts`, `export const ${name} = 1;\n`);
      const flat = await recommend(root);
      expect(flat.mapNotes.map((note) => note.kind)).toEqual(["file-per-module"]);
      expect(flat.mapNotes[0]?.do).toContain('glob: ["src/a.ts", "src/b.ts"]');
    });
    await withTempProject(async (root) => {
      for (let i = 0; i < 8; i++) write(root, `src/core/f${i}.ts`, `export const f${i} = ${i};\n`);
      write(root, "src/edge/one.ts", "export const one = 1;\n");
      write(root, "archstrict.config.ts", `export default {
        declaredModules: [{ name: "core", glob: "src/core/**" }, { name: "edge", glob: "src/edge/**" }],
        because: "one module holds the tree",
      };`);
      const mega = await recommend(root);
      expect(mega.mapNotes.map((note) => note.kind)).toContain("mega-module");
      expect(mega.mapNotes.find((note) => note.kind === "mega-module")?.evidence).toContain("8 of 9");
    });
  });

  test("recommend keeps file-per-module globs relative through a symlink root", async () => {
    await withTempProject(async (root) => {
      const realRoot = join(root, "real");
      const linkedRoot = join(root, "linked");
      for (const name of ["a", "b", "c", "d"]) write(realRoot, `src/${name}.ts`, `export const ${name} = 1;\n`);
      symlinkSync(realRoot, linkedRoot, "dir");
      const result = await recommend(linkedRoot);
      expect(result.mapNotes.find((note) => note.kind === "file-per-module")?.do).toContain('glob: ["src/a.ts", "src/b.ts"]');
    });
  });

  test("check and todo say to split before freezing when one module owns the bypasses", async () => {
    await withTempProject(async (root) => {
      const imports = Array.from({ length: 8 }, (_, i) => `import { f${i} } from "../core/f${i}.ts";`).join("\n");
      const sum = Array.from({ length: 8 }, (_, i) => `f${i}`).join(" + ");
      for (let i = 0; i < 8; i++) write(root, `src/core/f${i}.ts`, `export const f${i} = ${i};\n`);
      write(root, "src/app/main.ts", `${imports}\nexport const main = ${sum};\n`);
      write(root, "archstrict.config.ts", `export default {
        exclude: ["archstrict.config.ts", "archstrict.types.ts"],
        declaredModules: [{ name: "core", glob: "src/core/**" }, { name: "app", glob: "src/app/**", surface: "main.ts" }],
        because: "core is the whole tree",
      };`);
      const result = await check(root);
      expect(result.dominantModule).toMatchObject({ name: "core", files: 8, totalFiles: 9, bypasses: 8, totalBypasses: 8 });
      const text = formatText(result);
      expect(text).toContain("split module 'core' before archstrict todo");
      expect(text.trim().split("\n").at(-1)).toBe("do: split module 'core' before archstrict todo");

      const frozen = await todo(root);
      expect(frozen.notes?.[0]).toContain("target 'core'");
      const after = await check(root);
      expect(after.violations.filter((violation) => !violation.frozen)).toHaveLength(0);
      expect(after.dominantModule?.name).toBe("core");
      expect(formatText(after)).toContain("Freezing them records one bucket");
    });
  });
});
