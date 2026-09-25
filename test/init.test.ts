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
      const generatedPath = join(root, "archstrict.types.ts");
      const before = readFileSync(generatedPath, "utf8");
      writeFileSync(join(root, "archstrict.config.ts"), "export default {};\n");

      await expect(init(root)).rejects.toThrow(/missing required field 'declaredModules'/);
      expect(readFileSync(generatedPath, "utf8")).toBe(before);
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

  test("seeds exclude with real noise directories found on disk", async () => {
    await withTempProject(["app"], async (root) => {
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "test", "some.test.ts"), "export const x = 1;\n");
      mkdirSync(join(root, "spike"), { recursive: true });
      writeFileSync(join(root, "spike", "notes.ts"), "export const y = 1;\n");

      const result = await init(root);
      expect(result.configWritten).toBe(true);
      expect(result.seededExcludeDirs).toEqual(["test", "spike"]);

      const config = readFileSync(result.configPath, "utf8");
      const match = config.match(/exclude: (\[[^\]]*\])/);
      expect(match).not.toBeNull();
      expect(JSON.parse(match![1]!)).toEqual(["*.ts", "test/**", "spike/**"]);
    });
  });

  test("leaves exclude at just *.ts when none of the candidate noise directories exist", async () => {
    await withTempProject(["app"], async (root) => {
      const result = await init(root);
      expect(result.configWritten).toBe(true);
      expect(result.seededExcludeDirs).toEqual([]);

      const config = readFileSync(result.configPath, "utf8");
      const match = config.match(/exclude: (\[[^\]]*\])/);
      expect(match).not.toBeNull();
      expect(JSON.parse(match![1]!)).toEqual(["*.ts"]);
    });
  });

  test("never touches an already-existing config, even when noise directories exist on disk", async () => {
    await withTempProject(["app"], async (root) => {
      await init(root);
      const configPath = join(root, "archstrict.config.ts");
      const original = "// hand-edited, do not clobber\n" + readFileSync(configPath, "utf8");
      writeFileSync(configPath, original);

      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "test", "some.test.ts"), "export const x = 1;\n");

      const result = await init(root);
      expect(result.configWritten).toBe(false);
      expect(result.seededExcludeDirs).toEqual([]);
      expect(readFileSync(configPath, "utf8")).toBe(original);
    });
  });

  test("the seeded exclude actually resolves the uncovered-module noise it's meant to prevent", async () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-init-noise-"));
    try {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "index.ts"), "export const app = 1;\n");
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "test", "some.test.ts"), "export const t = 1;\n");
      writeFileSync(join(root, "tsconfig.json"), "{}");

      await init(root);

      const { check } = await import("../src/verbs/check.js");
      const result = await check(root);
      const uncoveredUnderTest = result.violations.filter(
        (v: { rule: string; path: string }) => v.rule === "uncovered-module" && v.path.includes(`${join("test", "")}`),
      );
      expect(uncoveredUnderTest).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("init on a project with no src/ at all fails loudly, naming what's missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-init-"));
    try {
      // No src/ directory created at all — the likely first-run state for
      // a brand-new project, since init is the first verb anyone runs.
      // A fresh run's own discovery walk throws before any await, but
      // init() is itself async now, so the throw surfaces as a rejection,
      // not a synchronous exception.
      await expect(init(root)).rejects.toThrow(/does not exist/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
          `wrote ${join(root, "archstrict.types.ts")}: 1 module names, read from archstrict.config.ts\n` +
          `do: archstrict check\n`,
      );
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
      const generatedPath = join(root, "archstrict.types.ts");
      const before = readFileSync(generatedPath, "utf8");
      writeFileSync(join(root, "archstrict.config.ts"), "export default {};\n");

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
});
