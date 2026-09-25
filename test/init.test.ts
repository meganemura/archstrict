import { describe, expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { init } from "../src/verbs/init.js";

// The built CLI, spawned as a real process - the exact-stdout and exit-code
// tests below check what a real invocation prints, not just what the
// library function returns.
const CLI_PATH = new URL("../dist/cli.js", import.meta.url).pathname;

async function withTempProject(modules: string[], fn: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "archstrict-init-"));
  try {
    for (const name of modules) {
      const dir = join(root, "src", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "module.ts"), `export const ${name} = 1;\n`);
    }
    writeFileSync(join(root, "tsconfig.json"), "{}");
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// A scratch project this file builds file-by-file (a synthetic shape, not
// copied from any real project) - `put` writes one file, creating its
// parent directories as needed.
function scratchProject(prefix: string): { root: string; put: (relPath: string, contents: string) => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return {
    root,
    put(relPath: string, contents: string) {
      const full = join(root, relPath);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, contents);
    },
  };
}

describe("init", () => {
  test("writes archstrict.types.ts and archstrict.config.ts", async () => {
    await withTempProject(["app", "shared"], async (root) => {
      const result = await init(root);
      expect(result.configWritten).toBe(true);
      expect(result.moduleNames).toEqual(["app", "shared"]);

      const generated = readFileSync(result.generatedPath, "utf8");
      expect(generated).toContain('"app" | "shared"');
      expect(generated).toContain("schemaVersion?: 1");

      const config = readFileSync(result.configPath, "utf8");
      expect(config).toContain("schemaVersion: 1");
      expect(config).toContain('name: "app"');
      expect(config).toContain('name: "shared"');
      expect(config).toContain("satisfies Config");
    });
  });

  test("is idempotent: a second run does not overwrite a hand-edited config", async () => {
    await withTempProject(["app"], async (root) => {
      await init(root);
      const configPath = join(root, "archstrict.config.ts");
      writeFileSync(configPath, "// hand-edited, do not clobber\n" + readFileSync(configPath, "utf8"));

      const second = await init(root);
      expect(second.configWritten).toBe(false);
      expect(readFileSync(configPath, "utf8")).toContain("hand-edited");
    });
  });

  test("a re-run's union follows the config's own declaredModules, not a fresh directory walk", async () => {
    await withTempProject(["app"], async (root) => {
      await init(root);
      // A directory added after the first init, with NO matching
      // declaredModules entry hand-added to the config: the config on disk
      // still names only "app", so the re-run's union must too - the walk
      // that found "app" the first time is a fresh-config-only suggestion,
      // never a re-run's source of truth. The opposite bug (a hand-added
      // declaredModules entry the walk never proposed silently dropping
      // out of the union on the next run) is the next test below.
      mkdirSync(join(root, "src", "shared"), { recursive: true });
      writeFileSync(join(root, "src", "shared", "module.ts"), "export const shared = 1;\n");

      const second = await init(root);
      expect(second.moduleNames).toEqual(["app"]);
      expect(readFileSync(second.generatedPath, "utf8")).not.toContain("shared");
    });
  });

  test("a re-run's union picks up a hand-added declaredModules entry the discovery walk would never propose", async () => {
    await withTempProject(["dir1"], async (root) => {
      await init(root);
      const configPath = join(root, "archstrict.config.ts");
      writeFileSync(join(root, "src", "x.ts"), "export const x = 1;\n");
      writeFileSync(
        configPath,
        readFileSync(configPath, "utf8").replace(
          "declaredModules: [",
          'declaredModules: [\n    { name: "core", glob: "src/*.ts" },',
        ),
      );

      const second = await init(root);
      expect(second.configWritten).toBe(false);
      expect(second.moduleNames).toEqual(["core", "dir1"]);
      expect(readFileSync(second.generatedPath, "utf8")).toContain('"core" | "dir1"');
    });
  });

  test("removing a declaredModules entry by hand makes its name leave the union on the next re-run", async () => {
    await withTempProject(["app", "shared"], async (root) => {
      await init(root);
      const configPath = join(root, "archstrict.config.ts");
      const withoutShared = readFileSync(configPath, "utf8").replace(
        /\s*\{ name: "shared",[^}]*\},/,
        "",
      );
      expect(withoutShared).not.toContain('"shared"');
      writeFileSync(configPath, withoutShared);

      const second = await init(root);
      expect(second.configWritten).toBe(false);
      expect(second.moduleNames).toEqual(["app"]);
      expect(readFileSync(second.generatedPath, "utf8")).not.toContain("shared");
    });
  });

  test("a re-run with a broken config rejects and leaves archstrict.types.ts untouched", async () => {
    await withTempProject(["app"], async (root) => {
      await init(root);
      const configPath = join(root, "archstrict.config.ts");
      // Hand-add an entry naming a glob with no real matching directory - a
      // fresh discovery walk could never propose it, so the union this
      // re-run writes ("app" | "hand-added") cannot coincide with what a
      // walk, or the broken config below, would produce. Without this, the
      // fixture's own union and a walk's union were identical, so a bug
      // that silently regenerated from a fresh walk instead of the config
      // on disk went undetected.
      writeFileSync(
        configPath,
        readFileSync(configPath, "utf8").replace(
          "declaredModules: [",
          'declaredModules: [\n    { name: "hand-added", glob: "src/hand-added/**" },',
        ),
      );
      await init(root);
      const generatedPath = join(root, "archstrict.types.ts");
      const before = readFileSync(generatedPath, "utf8");
      expect(before).toContain("hand-added");
      writeFileSync(configPath, "export default {};\n");

      await expect(init(root)).rejects.toThrow(/missing required field 'declaredModules'/);
      expect(readFileSync(generatedPath, "utf8")).toBe(before);
    });
  });

  // Same defect as the missing-field case above, one layer deeper:
  // declaredModules satisfying `in` is not the same fact as it being a real
  // array of well-shaped entries. Each case here exits 1 with the exact
  // message and do:, and leaves archstrict.types.ts's exact old bytes -
  // before this check existed, init instead wrote `ModuleName = never` (or
  // invalid TypeScript for the missing-name case) over the last good union.
  describe.each([
    {
      label: "declaredModules: null",
      declaredModules: "null",
      message: "field 'declaredModules' must be an array, not object",
    },
    {
      label: "declaredModules: undefined",
      declaredModules: "undefined",
      message: "field 'declaredModules' must be an array, not undefined",
    },
    {
      label: "declaredModules is not an array (a string)",
      declaredModules: `"src/**"`,
      message: "field 'declaredModules' must be an array, not string",
    },
    {
      label: "an entry without a name",
      declaredModules: `[{ glob: "src/app/**" }]`,
      message: "field 'declaredModules[0].name' must be a non-empty string, not undefined",
    },
    {
      label: "an entry with a non-string glob",
      declaredModules: `[{ name: "app", glob: 5 }]`,
      message: "field 'declaredModules[0].glob' must be a string, not number",
    },
  ])("a re-run with $label", ({ declaredModules, message }) => {
    test("exits 1 with the exact message and do:, leaving archstrict.types.ts's exact old bytes", async () => {
      await withTempProject(["app"], async (root) => {
        await init(root);
        const configPath = join(root, "archstrict.config.ts");
        const generatedPath = join(root, "archstrict.types.ts");
        const before = readFileSync(generatedPath, "utf8");
        writeFileSync(configPath, `export default { declaredModules: ${declaredModules}, because: "test" };\n`);

        let thrown: unknown;
        try {
          await init(root);
        } catch (error) {
          thrown = error;
        }
        expect((thrown as { message: string }).message).toBe(`${configPath} ${message}`);
        expect((thrown as { do: string }).do).toContain(configPath);
        expect((thrown as { do: string }).do).toContain("then run archstrict init");
        expect(readFileSync(generatedPath, "utf8")).toBe(before);
      });
    });
  });

  test("a directory argument on a re-run is ignored (only validated), and the note line says so", async () => {
    await withTempProject(["app"], async (root) => {
      await init(root);
      const second = await init(root, "src");
      expect(second.configWritten).toBe(false);
      expect(second.messageLines).toContain(
        "the directory argument applies only when init writes a new archstrict.config.ts",
      );
    });
  });

  // A fixture shaped like a real, unconventional flat package - two
  // real module directories, four loose top-level .ts files under the
  // opened container, three noise directories, and one hidden directory
  // holding real source. Names are invented for this fixture, not taken
  // from any real project.
  test("a fixture with two directories, four loose files, noise directories, and a hidden directory: config, types, and stdout are exact", () => {
    const { root, put } = scratchProject("archstrict-init-shape-");
    put("src/build/index.ts", "export const build = 1;\n");
    put("src/runtime/index.ts", "export const runtime = 1;\n");
    put("src/alpha.ts", "export const alpha = 1;\n");
    put("src/beta.ts", "export const beta = 1;\n");
    put("src/gamma.ts", "export const gamma = 1;\n");
    put("src/delta.ts", "export const delta = 1;\n");
    put("test/some.test.ts", "export const t = 1;\n");
    put("example/notes.ts", "export const e = 1;\n");
    put("spike/notes.ts", "export const s = 1;\n");
    put(".scratch/x.ts", "export const hidden = 1;\n");
    try {
      const out = execFileSync("node", [CLI_PATH, "init"], { cwd: root, encoding: "utf8" });
      expect(out).toBe(
        `wrote ${join(root, "archstrict.config.ts")}\n` +
          `wrote ${join(root, "archstrict.types.ts")}\n` +
          `declared 6 modules, one per directory that holds .ts and one per .ts file:\n` +
          `  src/: 2 directories, 4 files\n` +
          `excluded 1 hidden directory that holds .ts: .scratch/\n` +
          `excluded 3 noise directories found on disk: test/, example/, spike/\n` +
          `do: archstrict check\n`,
      );

      const config = readFileSync(join(root, "archstrict.config.ts"), "utf8");
      expect(config).toBe(
        `import type { Config } from "./archstrict.types.js";

// Public surface: other modules may import a directory module only through
// its index.ts (named by \`surface\` below), or through the files its own
// package.json exports map names. An import that reaches any other file in
// the directory is a violation. A directory module with no such file is
// entirely private. A module whose glob names one file is that file, so its
// entry names the file itself as its surface.
export default {
  schemaVersion: 1,
  surface: "index.ts",
  // Kept out of analysis entirely:
  // - archstrict's own two files, which are never module content;
  // - hidden directories at any depth (.git, tool state), which tsc's own
  //   default include also skips;
  // - common noise directories that init found on disk (test, example, spike).
  //   Remove one of these entries if that directory holds module content.
  exclude: [
    "archstrict.config.ts",
    "archstrict.types.ts",
    ".*/**",
    "**/.*/**",
    "test/**",
    "example/**",
    "spike/**",
  ],
  // init declared one module per directory that holds .ts and one per .ts
  // file, so every file that check analyzes belongs to exactly one module.
  // Merge, rename, or remove entries freely: init never rewrites this file.
  // After an edit, run archstrict init to regenerate archstrict.types.ts.
  declaredModules: [
    // Each directory and .ts file directly in src/.
    { name: "alpha.ts", glob: "src/alpha.ts", surface: "alpha.ts" },
    { name: "beta.ts", glob: "src/beta.ts", surface: "beta.ts" },
    { name: "build", glob: "src/build/**" },
    { name: "delta.ts", glob: "src/delta.ts", surface: "delta.ts" },
    { name: "gamma.ts", glob: "src/gamma.ts", surface: "gamma.ts" },
    { name: "runtime", glob: "src/runtime/**" },
  ],
  because: "archstrict init: one module per directory that holds .ts and per .ts file, so the first check covers every file it analyzes",
} satisfies Config;
`,
      );

      const types = readFileSync(join(root, "archstrict.types.ts"), "utf8");
      expect(types).toContain('"alpha.ts" | "beta.ts" | "build" | "delta.ts" | "gamma.ts" | "runtime"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A fixture shaped like a flat package with no directories at all
  // directly under the opened container - every loose file becomes its own
  // module, and init prints the only-files line naming the whole-directory
  // alternative.
  test("a container that holds only files: prints the only-files line, and 'init .' collapses it to one directory module", () => {
    const { root, put } = scratchProject("archstrict-init-flat-");
    put("src/one.ts", "export const one = 1;\n");
    put("src/two.ts", "export const two = 1;\n");
    put("src/three.ts", "export const three = 1;\n");
    put("plugin/index.ts", "export const plugin = 1;\n");
    put("tests/some.test.ts", "export const t = 1;\n");
    try {
      const out = execFileSync("node", [CLI_PATH, "init"], { cwd: root, encoding: "utf8" });
      expect(out).toBe(
        `wrote ${join(root, "archstrict.config.ts")}\n` +
          `wrote ${join(root, "archstrict.types.ts")}\n` +
          `declared 4 modules, one per directory that holds .ts and one per .ts file:\n` +
          `  src/: 0 directories, 3 files\n` +
          `  ./ (outside src/): 1 directory, 0 files: plugin\n` +
          `excluded 1 noise directory found on disk: tests/\n` +
          `src/ holds only files, so each file is its own module. To check src/ as one module instead (then no import between two of its files is checked): delete archstrict.config.ts, then run archstrict init .\n` +
          `do: archstrict check\n`,
      );
      expect(readFileSync(join(root, "archstrict.types.ts"), "utf8")).toContain(
        '"one.ts" | "plugin" | "three.ts" | "two.ts"',
      );

      rmSync(join(root, "archstrict.config.ts"));
      rmSync(join(root, "archstrict.types.ts"));
      const rerun = execFileSync("node", [CLI_PATH, "init", "."], { cwd: root, encoding: "utf8" });
      expect(rerun).toContain("declared 2 modules, one per directory that holds .ts and one per .ts file:");
      const config = readFileSync(join(root, "archstrict.config.ts"), "utf8");
      expect(config).toContain('{ name: "plugin", glob: "plugin/**" }');
      expect(config).toContain('{ name: "src", glob: "src/**" }');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // No src/ at all - init walks the project root alone.
  test("no src/: walks the project root and declares each top-level directory and .ts file, including a *.config.ts", () => {
    const { root, put } = scratchProject("archstrict-init-nosrc-");
    put("core/loader.ts", "export const loader = 1;\n");
    put("ui/main.ts", "export const main = 1;\n");
    put("cli.ts", "export const cli = 1;\n");
    put("app.config.ts", "export const config = 1;\n");
    try {
      const out = execFileSync("node", [CLI_PATH, "init"], { cwd: root, encoding: "utf8" });
      expect(out).toContain("top level; there is no src/ directory");
      const config = readFileSync(join(root, "archstrict.config.ts"), "utf8");
      expect(config).toContain('{ name: "app.config.ts", glob: "app.config.ts", surface: "app.config.ts" }');
      expect(config).toContain('{ name: "cli.ts", glob: "cli.ts", surface: "cli.ts" }');
      expect(config).toContain('{ name: "core", glob: "core/**" }');
      expect(config).toContain('{ name: "ui", glob: "ui/**" }');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // src/ exists but holds no .ts at all (only non-source files) -
  // the default container is treated as absent, not as an empty module.
  test("src/ holds no .ts file: walks the project root with the other label", () => {
    const { root, put } = scratchProject("archstrict-init-nosrcts-");
    put("src/readme.md", "# not source\n");
    put("core/loader.ts", "export const loader = 1;\n");
    try {
      const out = execFileSync("node", [CLI_PATH, "init"], { cwd: root, encoding: "utf8" });
      expect(out).toContain("top level; src/ holds no .ts file");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Naming: a group's on-disk name, unless it collides with another
  // group's own on-disk name, in which case it takes its own
  // project-relative path instead.
  test("naming: a root file and a same-named src/ file each take their own project-relative path once they collide", async () => {
    const { root, put } = scratchProject("archstrict-init-naming-");
    put("cli.ts", "export const rootCli = 1;\n");
    put("src/cli.ts", "export const srcCli = 1;\n");
    put("context.ts", "export const rootContext = 1;\n");
    put("context/index.ts", "export const dirContext = 1;\n");
    try {
      const result = await init(root);
      expect(result.moduleNames).toEqual(["cli.ts", "context", "context.ts", "src/cli.ts"]);
      const config = readFileSync(join(root, "archstrict.config.ts"), "utf8");
      expect(config).toContain('{ name: "cli.ts", glob: "cli.ts", surface: "cli.ts" }');
      expect(config).toContain('{ name: "src/cli.ts", glob: "src/cli.ts", surface: "cli.ts" }');
      expect(config).toContain('{ name: "context", glob: "context/**" }');
      expect(config).toContain('{ name: "context.ts", glob: "context.ts", surface: "context.ts" }');

      writeFileSync(
        join(root, "tsconfig.json"),
        JSON.stringify(
          {
            compilerOptions: {
              target: "esnext",
              module: "nodenext",
              moduleResolution: "nodenext",
              strict: true,
              skipLibCheck: true,
              noEmit: true,
            },
            include: ["archstrict.config.ts", "archstrict.types.ts"],
          },
          null,
          2,
        ),
      );
      const tscPath = new URL("../node_modules/typescript/bin/tsc", import.meta.url).pathname;
      expect(() => execFileSync("node", [tscPath, "--noEmit", "-p", root], { cwd: root, stdio: "pipe" })).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Hidden directories at every depth are excluded, so a directory
  // whose only .ts sits in a hidden subdirectory is not declared at all.
  test("hidden directories at any depth give no module and no uncovered file", () => {
    const { root, put } = scratchProject("archstrict-init-hidden-");
    put(".hid/z.ts", "export const z = 1;\n");
    put("src/a/.gen/y.ts", "export const y = 1;\n");
    put("src/normal/index.ts", "export const n = 1;\n");
    try {
      const out = execFileSync("node", [CLI_PATH, "init"], { cwd: root, encoding: "utf8" });
      expect(out).toContain("excluded 1 hidden directory that holds .ts: .hid/");
      const config = readFileSync(join(root, "archstrict.config.ts"), "utf8");
      expect(config).not.toContain('"a"');
      expect(config).not.toContain(".hid");
      expect(config).not.toContain(".gen");
      expect(config).toContain('{ name: "normal", glob: "src/normal/**" }');

      const checkOut = execFileSync("node", [CLI_PATH, "check", "--json"], { cwd: root, encoding: "utf8" });
      expect(JSON.parse(checkOut).violations).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // An explicit container name matching a noise candidate is
  // opened, not excluded; and the generated config never mentions dist/ or
  // classify.
  test("init test opens test/ and writes no test/** exclude entry; the config has no dist/** and no classify", () => {
    const { root, put } = scratchProject("archstrict-init-noise-arg-");
    put("test/widgets/index.ts", "export const widgets = 1;\n");
    put("test/loose.ts", "export const loose = 1;\n");
    try {
      execFileSync("node", [CLI_PATH, "init", "test"], { cwd: root, encoding: "utf8" });
      const config = readFileSync(join(root, "archstrict.config.ts"), "utf8");
      expect(config).not.toContain("test/**");
      expect(config).not.toContain("dist/**");
      expect(config).not.toContain("classify");
      expect(config).toContain('{ name: "widgets", glob: "test/widgets/**" }');
      expect(config).toContain('{ name: "loose.ts", glob: "test/loose.ts", surface: "loose.ts" }');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A noise-dir candidate name ("test") must match a real on-disk entry
  // exactly, not through a case-insensitive filesystem lookup: a directory
  // spelled "Test" is real source (its file is analyzed and declared as a
  // module below), never the noise candidate "test".
  test("a Test/ directory is declared as a module, not excluded as the noise candidate 'test'", () => {
    const { root, put } = scratchProject("archstrict-init-case-");
    put("Test/x.ts", "export const x = 1;\n");
    try {
      const out = execFileSync("node", [CLI_PATH, "init"], { cwd: root, encoding: "utf8" });
      expect(out).not.toContain("noise director");
      const config = readFileSync(join(root, "archstrict.config.ts"), "utf8");
      expect(config).not.toContain("test/**");
      expect(config).toContain('{ name: "Test", glob: "Test/**" }');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Zero candidates - init writes neither file and exits 1.
  test("zero candidates: init exits 1, and afterwards neither file exists", () => {
    const { root } = scratchProject("archstrict-init-zero-");
    try {
      let errOut = "";
      let exitCode = 0;
      try {
        execFileSync("node", [CLI_PATH, "init"], { cwd: root, encoding: "utf8" });
      } catch (e) {
        const err = e as { status: number; stderr: string };
        exitCode = err.status;
        errOut = err.stderr;
      }
      expect(exitCode).toBe(1);
      expect(errOut).toContain("found no .ts file to declare as a module");
      expect(errOut.trim().split("\n").at(-1)).toBe(
        "do: add a .ts source file outside those directories, then run archstrict init",
      );
      expect(() => readFileSync(join(root, "archstrict.config.ts"), "utf8")).toThrow();
      expect(() => readFileSync(join(root, "archstrict.types.ts"), "utf8")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Zero candidates, but only because every analyzed .ts file sits inside a
  // noise directory: the do: names the fix that actually works
  // ("archstrict init <dir>"), not the generic one above, which is wrong
  // here (there IS a .ts file, it's just excluded).
  test("zero candidates with a .ts file under a noise directory: do: names that directory", () => {
    const { root, put } = scratchProject("archstrict-init-zero-noise-");
    put("test/a.test.ts", "export const a = 1;\n");
    try {
      let errOut = "";
      try {
        execFileSync("node", [CLI_PATH, "init"], { cwd: root, encoding: "utf8" });
      } catch (e) {
        errOut = (e as { stderr: string }).stderr;
      }
      expect(errOut.trim().split("\n").at(-1)).toBe("do: archstrict init test");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Two noise directories both hold analyzed .ts: the do: names the first
  // in NOISE_DIR_CANDIDATES list order ("test" before "example"), not
  // readdir order (this fixture writes "example" first on disk).
  test("zero candidates with two noise directories holding .ts: do: names the first in list order", () => {
    const { root, put } = scratchProject("archstrict-init-zero-noise2-");
    put("example/a.ts", "export const a = 1;\n");
    put("test/b.ts", "export const b = 1;\n");
    try {
      let errOut = "";
      try {
        execFileSync("node", [CLI_PATH, "init"], { cwd: root, encoding: "utf8" });
      } catch (e) {
        errOut = (e as { stderr: string }).stderr;
      }
      expect(errOut.trim().split("\n").at(-1)).toBe("do: archstrict init test");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Every argument-table error, with its exact message, and no
  // glob character in any do: line this verb ever prints.
  describe("argument errors", () => {
    function withArgProject(fn: (root: string) => void): void {
      const { root, put } = scratchProject("archstrict-init-args-");
      put("src/app/index.ts", "export const app = 1;\n");
      try {
        fn(root);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    function runInit(root: string, args: string[]): { status: number; stderr: string } {
      try {
        execFileSync("node", [CLI_PATH, "init", ...args], { cwd: root, encoding: "utf8" });
        return { status: 0, stderr: "" };
      } catch (e) {
        const err = e as { status: number; stderr: string };
        return { status: err.status, stderr: err.stderr };
      }
    }

    test("more than one positional", () =>
      withArgProject((root) => {
        const { status, stderr } = runInit(root, ["a", "b"]);
        expect(status).toBe(1);
        expect(stderr).toBe(
          "archstrict: init takes one directory; got 2 arguments (the shell expands an unquoted * or src/*)\ndo: archstrict init\n",
        );
      }));

    test("a glob character left after stripping", () =>
      withArgProject((root) => {
        const { status, stderr } = runInit(root, ["src/*x"]);
        expect(status).toBe(1);
        expect(stderr).toBe("archstrict: init takes a directory name, not the glob 'src/*x'\ndo: archstrict init\n");
      }));

    test("a slash left after stripping", () =>
      withArgProject((root) => {
        const { status, stderr } = runInit(root, ["packages/app"]);
        expect(status).toBe(1);
        expect(stderr).toBe(
          "archstrict: init takes one top-level directory name, not 'packages/app'\ndo: archstrict init\n",
        );
      }));

    test("a hidden directory name", () =>
      withArgProject((root) => {
        const { status, stderr } = runInit(root, [".claude"]);
        expect(status).toBe(1);
        expect(stderr).toBe(
          "archstrict: init does not open the hidden directory '.claude': the exclude that init writes skips hidden directories\ndo: archstrict init\n",
        );
      }));

    test("node_modules", () =>
      withArgProject((root) => {
        const { status, stderr } = runInit(root, ["node_modules"]);
        expect(status).toBe(1);
        expect(stderr).toBe(
          "archstrict: init does not open 'node_modules': check never analyzes it\ndo: archstrict init\n",
        );
      }));

    test("a missing explicit directory", () =>
      withArgProject((root) => {
        const { status, stderr } = runInit(root, ["nope"]);
        expect(status).toBe(1);
        expect(stderr).toBe(
          "archstrict: 'nope' is not a top-level directory that holds a .ts file check analyzes\ndo: archstrict init\n",
        );
      }));

    test("an unknown option, never read as a directory", () =>
      withArgProject((root) => {
        const { status, stderr } = runInit(root, ["--loose"]);
        expect(status).toBe(1);
        expect(stderr).toBe("archstrict: unknown option '--loose'\ndo: archstrict init\n");
      }));

    test("no do: line this verb prints ever contains a glob character", () =>
      withArgProject((root) => {
        for (const args of [["a", "b"], ["src/*x"], ["packages/app"], [".claude"], ["node_modules"], ["nope"]]) {
          const { stderr } = runInit(root, args);
          const doLine = stderr.trim().split("\n").at(-1)!;
          expect(doLine).not.toMatch(/[*?[\]{}]/);
        }
      }));
  });

  test("the exact CLI stdout for a fresh run", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-cli-init-fresh-")));
    try {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "module.ts"), "export const app = 1;\n");

      const out = execFileSync("node", [CLI_PATH, "init"], { cwd: root, encoding: "utf8" });
      expect(out).toBe(
        `wrote ${join(root, "archstrict.config.ts")}\n` +
          `wrote ${join(root, "archstrict.types.ts")}\n` +
          `declared 1 module, one per directory that holds .ts and one per .ts file:\n` +
          `  src/: 1 directory, 0 files\n` +
          `do: archstrict check\n`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the exact CLI stdout for a re-run", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-cli-init-rerun-")));
    try {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "module.ts"), "export const app = 1;\n");
      execFileSync("node", [CLI_PATH, "init"], { cwd: root });

      const out = execFileSync("node", [CLI_PATH, "init"], { cwd: root, encoding: "utf8" });
      expect(out).toBe(
        `${join(root, "archstrict.config.ts")} already exists, left untouched\n` +
          `wrote ${join(root, "archstrict.types.ts")}: 1 module name, read from archstrict.config.ts\n` +
          `do: archstrict check\n`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("re-running init on the same project writes a byte-identical config", () => {
    const { root, put } = scratchProject("archstrict-init-byte-identical-");
    put("src/app/index.ts", "export const app = 1;\n");
    put("src/shared/index.ts", "export const shared = 1;\n");
    try {
      execFileSync("node", [CLI_PATH, "init"], { cwd: root });
      const before = readFileSync(join(root, "archstrict.config.ts"), "utf8");
      execFileSync("node", [CLI_PATH, "init"], { cwd: root });
      expect(readFileSync(join(root, "archstrict.config.ts"), "utf8")).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a re-run with a broken config exits 1 with the loader's message and do:, leaving archstrict.types.ts's exact old bytes", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-cli-init-broken-")));
    try {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "module.ts"), "export const app = 1;\n");
      execFileSync("node", [CLI_PATH, "init"], { cwd: root });
      const configPath = join(root, "archstrict.config.ts");
      // Same reason as the unit-level test above: a hand-added entry the
      // walk could never propose, so the pre-existing union cannot
      // coincide with what a walk or the broken config would produce.
      writeFileSync(
        configPath,
        readFileSync(configPath, "utf8").replace(
          "declaredModules: [",
          'declaredModules: [\n    { name: "hand-added", glob: "src/hand-added/**" },',
        ),
      );
      execFileSync("node", [CLI_PATH, "init"], { cwd: root });
      const generatedPath = join(root, "archstrict.types.ts");
      const before = readFileSync(generatedPath, "utf8");
      expect(before).toContain("hand-added");
      writeFileSync(configPath, "export default {};\n");

      let caught: { status: number | null; stderr: string } | undefined;
      try {
        execFileSync("node", [CLI_PATH, "init"], { cwd: root, encoding: "utf8" });
      } catch (error) {
        caught = error as { status: number | null; stderr: string };
      }
      expect(caught).toBeDefined();
      expect(caught!.status).toBe(1);
      expect(caught!.stderr).toContain("is missing required field 'declaredModules'");
      expect(caught!.stderr).toContain("do:");
      expect(readFileSync(generatedPath, "utf8")).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("init on a project with no .ts file anywhere fails loudly, naming what's missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-init-"));
    try {
      await expect(init(root)).rejects.toThrow(/found no \.ts file to declare as a module/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Property: init only ever seeds a FRESH config from discovery; a
  // re-run's union comes from reading declaredModules back, so for any
  // set of unique valid names already in the config, the union it writes
  // is exactly those names, sorted - regardless of how many there are or
  // what real directories exist on disk (there are none here at all).
  test("hegel: a re-run's union equals the sorted, unique names already in the config's declaredModules", async () => {
    await hegel.testAsync(async (tc) => {
      const count = tc.draw(gen.integers({ minValue: 1, maxValue: 6 }));
      const offset = tc.draw(gen.integers({ minValue: 0, maxValue: 10000 }));
      const names = Array.from({ length: count }, (_, i) => `m${offset + i}`);
      const root = mkdtempSync(join(tmpdir(), "archstrict-init-hegel-"));
      try {
        const declaredModules = names.map((name) => ({ name, glob: `src/${name}/**` }));
        writeFileSync(
          join(root, "archstrict.config.ts"),
          `export default ${JSON.stringify({ declaredModules, because: "hegel" })};\n`,
        );

        const result = await init(root);
        expect(result.configWritten).toBe(false);
        expect(result.moduleNames).toEqual([...names].sort());
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  test("the generated config actually typechecks against real tsc", async () => {
    await withTempProject(["app", "shared"], async (root) => {
      await init(root);
      writeFileSync(
        join(root, "tsconfig.json"),
        JSON.stringify(
          {
            compilerOptions: {
              target: "esnext",
              module: "nodenext",
              moduleResolution: "nodenext",
              strict: true,
              skipLibCheck: true,
              noEmit: true,
            },
            include: ["archstrict.config.ts", "archstrict.types.ts"],
          },
          null,
          2,
        ),
      );

      const tscPath = new URL("../node_modules/typescript/bin/tsc", import.meta.url).pathname;
      expect(() =>
        execFileSync("node", [tscPath, "--noEmit", "-p", root], { cwd: root, stdio: "pipe" }),
      ).not.toThrow();
    });
  });

  test("a config using every optional field (deprecated, strict, ignoredCycles, exclude, classify, mustBeEmpty) typechecks against real tsc", async () => {
    await withTempProject(["app", "shared"], async (root) => {
      await init(root);
      writeFileSync(
        join(root, "archstrict.config.ts"),
        `import type { Config } from "./archstrict.types.js";
export default {
  surface: "index.ts",
  exclude: ["*.ts"],
  classify: [{ glob: "src/*", tags: ["kind:flat"] }],
  declaredModules: [
    { name: "app", glob: "src/app/**", surface: "index.ts" },
    { name: "shared", glob: "src/shared/**", surface: "index.ts" },
  ],
  deprecated: [{ from: "app", to: "shared", count: 0, because: "test" }],
  strict: ["shared"],
  ignoredCycles: [["app", "shared"]],
  mustBeEmpty: [{ glob: "src/legacy/**", because: "test" }],
  because: "test",
} satisfies Config;
`,
      );
      writeFileSync(
        join(root, "tsconfig.json"),
        JSON.stringify(
          {
            compilerOptions: {
              target: "esnext",
              module: "nodenext",
              moduleResolution: "nodenext",
              strict: true,
              skipLibCheck: true,
              noEmit: true,
            },
            include: ["archstrict.config.ts", "archstrict.types.ts"],
          },
          null,
          2,
        ),
      );

      const tscPath = new URL("../node_modules/typescript/bin/tsc", import.meta.url).pathname;
      expect(() =>
        execFileSync("node", [tscPath, "--noEmit", "-p", root], { cwd: root, stdio: "pipe" }),
      ).not.toThrow();
    });
  });

  // scope/classifyByDirectoryName/edges are the fields a fresh `init` used
  // to leave out of its own generated Config type entirely - a real config
  // using any of them would fail `tsc` with "does not exist in type
  // 'Config'", an existence error easy to misread as "this feature isn't
  // supported" rather than the real problem, whatever it was. Confirmed
  // directly this file matches the real Config in src/config.ts by
  // typechecking a config that uses all three, plus edges's own three
  // rule shapes (allowDeny/order/point), a declaredModules entry's own
  // friends field, and a declaredModules entry's own surface as an array
  // of globs, together.
  test("a config using scope, classifyByDirectoryName, edges (allowDeny/order/point), a declaredModules friends entry, and a declaredModules array surface typechecks against real tsc", async () => {
    await withTempProject(["app", "shared"], async (root) => {
      await init(root);
      writeFileSync(
        join(root, "archstrict.config.ts"),
        `import type { Config } from "./archstrict.types.js";
export default {
  scope: "src/**",
  classify: [{ glob: "src/app/**", tags: ["kind:app"] }, { glob: "src/shared/**", tags: ["kind:shared"] }],
  classifyByDirectoryName: { tagNamespace: "env", names: ["app", "shared"] },
  declaredModules: [
    { name: "app", glob: "src/app/**", surface: ["index.ts", "http.ts"] },
    {
      name: "shared",
      glob: "src/shared/**",
      surface: "index.ts",
      friends: [{ file: "internal.ts", from: "src/app/**", because: "test" }],
    },
  ],
  edges: {
    allowDeny: [
      {
        source: "kind:app",
        targetNamespace: "kind",
        allow: ["shared"],
        exceptions: [{ from: "src/app/**", to: "src/shared/**", because: "test" }],
        edgeType: "value",
        importForm: "static",
        because: "test",
      },
    ],
    order: [
      {
        tagNamespace: "kind",
        within: "env",
        sequence: { app: ["shared", "app"] },
        direction: "downward-only",
        edgeType: "value",
        importForm: "static",
        because: "test",
      },
    ],
    point: [
      {
        from: { tags: ["kind:app"], exclude: { tags: ["kind:shared"] } },
        to: { tags: ["kind:shared"] },
        because: "test",
      },
    ],
  },
  because: "test",
} satisfies Config;
`,
      );
      writeFileSync(
        join(root, "tsconfig.json"),
        JSON.stringify(
          {
            compilerOptions: {
              target: "esnext",
              module: "nodenext",
              moduleResolution: "nodenext",
              strict: true,
              skipLibCheck: true,
              noEmit: true,
            },
            include: ["archstrict.config.ts", "archstrict.types.ts"],
          },
          null,
          2,
        ),
      );

      const tscPath = new URL("../node_modules/typescript/bin/tsc", import.meta.url).pathname;
      expect(() =>
        execFileSync("node", [tscPath, "--noEmit", "-p", root], { cwd: root, stdio: "pipe" }),
      ).not.toThrow();
    });
  });

  test("a config that omits surface entirely still typechecks against the generated Config", async () => {
    await withTempProject(["app"], async (root) => {
      await init(root);
      writeFileSync(
        join(root, "archstrict.config.ts"),
        `import type { Config } from "./archstrict.types.js";
export default {
  declaredModules: [{ name: "app", glob: "src/app/**", surface: "index.ts" }],
  because: "test",
} satisfies Config;
`,
      );
      writeFileSync(
        join(root, "tsconfig.json"),
        JSON.stringify(
          {
            compilerOptions: {
              target: "esnext",
              module: "nodenext",
              moduleResolution: "nodenext",
              strict: true,
              skipLibCheck: true,
              noEmit: true,
            },
            include: ["archstrict.config.ts", "archstrict.types.ts"],
          },
          null,
          2,
        ),
      );

      const tscPath = new URL("../node_modules/typescript/bin/tsc", import.meta.url).pathname;
      expect(() =>
        execFileSync("node", [tscPath, "--noEmit", "-p", root], { cwd: root, stdio: "pipe" }),
      ).not.toThrow();
    });
  });

  test("a declaredModules entry that omits its own surface still typechecks against the generated Config", async () => {
    await withTempProject(["app"], async (root) => {
      await init(root);
      writeFileSync(
        join(root, "archstrict.config.ts"),
        `import type { Config } from "./archstrict.types.js";
export default {
  declaredModules: [{ name: "app", glob: "src/app/**" }],
  because: "test",
} satisfies Config;
`,
      );
      writeFileSync(
        join(root, "tsconfig.json"),
        JSON.stringify(
          {
            compilerOptions: {
              target: "esnext",
              module: "nodenext",
              moduleResolution: "nodenext",
              strict: true,
              skipLibCheck: true,
              noEmit: true,
            },
            include: ["archstrict.config.ts", "archstrict.types.ts"],
          },
          null,
          2,
        ),
      );

      const tscPath = new URL("../node_modules/typescript/bin/tsc", import.meta.url).pathname;
      expect(() =>
        execFileSync("node", [tscPath, "--noEmit", "-p", root], { cwd: root, stdio: "pipe" }),
      ).not.toThrow();
    });
  });
});
