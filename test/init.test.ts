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
      expect(config).toContain('modules: "src/*"');
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
});
