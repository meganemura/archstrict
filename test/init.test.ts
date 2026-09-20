import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { init } from "../src/verbs/init.js";

function withTempProject(modules: string[], fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "archstrict-init-"));
  try {
    for (const name of modules) {
      const dir = join(root, "src", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "module.ts"), `export const ${name} = 1;\n`);
    }
    writeFileSync(join(root, "tsconfig.json"), "{}");
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("init", () => {
  test("writes archstrict.generated.ts and archstrict.config.ts", () => {
    withTempProject(["app", "shared"], (root) => {
      const result = init(root);
      expect(result.configWritten).toBe(true);
      expect(result.moduleNames).toEqual(["app", "shared"]);

      const generated = readFileSync(result.generatedPath, "utf8");
      expect(generated).toContain('"app" | "shared"');

      const config = readFileSync(result.configPath, "utf8");
      expect(config).toContain('name: "app"');
      expect(config).toContain('name: "shared"');
      expect(config).toContain("satisfies Config");
    });
  });

  test("is idempotent: a second run does not overwrite a hand-edited config", () => {
    withTempProject(["app"], (root) => {
      init(root);
      const configPath = join(root, "archstrict.config.ts");
      writeFileSync(configPath, "// hand-edited, do not clobber\n" + readFileSync(configPath, "utf8"));

      const second = init(root);
      expect(second.configWritten).toBe(false);
      expect(readFileSync(configPath, "utf8")).toContain("hand-edited");
    });
  });

  test("regenerates archstrict.generated.ts on every run, since init owns that file", () => {
    withTempProject(["app"], (root) => {
      init(root);
      // Add a module after the first init, then run again.
      mkdirSync(join(root, "src", "shared"), { recursive: true });
      writeFileSync(join(root, "src", "shared", "module.ts"), "export const shared = 1;\n");

      const second = init(root);
      expect(second.moduleNames).toEqual(["app", "shared"]);
      expect(readFileSync(second.generatedPath, "utf8")).toContain('"app" | "shared"');
    });
  });

  test("the generated config actually typechecks against real tsc", () => {
    withTempProject(["app", "shared"], (root) => {
      init(root);
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
            include: ["archstrict.config.ts", "archstrict.generated.ts"],
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

  test("a config using every optional field (deprecated, strict, ignoredCycles, exclude, classify, mustBeEmpty) typechecks against real tsc", () => {
    withTempProject(["app", "shared"], (root) => {
      init(root);
      writeFileSync(
        join(root, "archstrict.config.ts"),
        `import type { Config } from "./archstrict.generated.js";
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
            include: ["archstrict.config.ts", "archstrict.generated.ts"],
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
  // rule shapes (allowDeny/order/point) together.
  test("a config using scope, classifyByDirectoryName, and edges (allowDeny/order/point) typechecks against real tsc", () => {
    withTempProject(["app", "shared"], (root) => {
      init(root);
      writeFileSync(
        join(root, "archstrict.config.ts"),
        `import type { Config } from "./archstrict.generated.js";
export default {
  scope: "src/**",
  classify: [{ glob: "src/app/**", tags: ["kind:app"] }, { glob: "src/shared/**", tags: ["kind:shared"] }],
  classifyByDirectoryName: { tagNamespace: "env", names: ["app", "shared"] },
  declaredModules: [
    { name: "app", glob: "src/app/**", surface: "index.ts" },
    { name: "shared", glob: "src/shared/**", surface: "index.ts" },
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
            include: ["archstrict.config.ts", "archstrict.generated.ts"],
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

  test("a config that omits surface entirely still typechecks against the generated Config", () => {
    withTempProject(["app"], (root) => {
      init(root);
      writeFileSync(
        join(root, "archstrict.config.ts"),
        `import type { Config } from "./archstrict.generated.js";
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
            include: ["archstrict.config.ts", "archstrict.generated.ts"],
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

  test("init on a project with no src/ at all fails loudly, naming what's missing", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-init-"));
    try {
      // No src/ directory created at all — the likely first-run state for
      // a brand-new project, since init is the first verb anyone runs.
      expect(() => init(root)).toThrow(/does not exist/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
