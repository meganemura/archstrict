import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const CLI_PATH = new URL("../dist/cli.js", import.meta.url).pathname;

// check prints compiler paths with `/`, including on Windows, where
// realpath and join keep `\`.
function compilerSpelling(path: string): string {
  return path.split("\\").join("/");
}

// Built, not run from src/ directly: this project's internal imports use
// nodenext's .js-extension convention (matching nukadoko's, depug's, and
// solarsql's own source, and their bin fields all point at dist/ for the
// same reason). Node's native TypeScript type-stripping strips syntax but
// does not remap a ".js" specifier to a sibling ".ts" file the way a
// bundler or vitest's own resolver does, so running src/cli.ts as a
// separate node process (as this file's tests do) needs the real .js
// files a build produces. Measured: `node src/cli.ts init` failed with
// ERR_MODULE_NOT_FOUND for "./verbs/init.js" before this fix.

const CLI_VERBS = [
  "init",
  "check",
  "todo",
  "rules",
  "agents",
  "recommend",
  "fix",
  "simulate",
  "search",
  "hotspots",
  "mcp",
] as const;

const WRITING_VERBS = new Set<string>(["init", "todo", "fix", "agents"]);

function projectFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else found.push(path.slice(root.length));
    }
  };
  walk(root);
  return found.sort();
}

describe("cli", () => {
  test("prints usage with no arguments", () => {
    expect(() => execFileSync("node", [CLI_PATH], { encoding: "utf8" })).toThrow();
  });

  test("help prints each verb's usage and writes no file", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-cli-help-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "app.ts"), "export const app = 1;\n");
      const before = projectFiles(root);
      const run = (args: string[]) =>
        execFileSync("node", [CLI_PATH, ...args], { cwd: root, encoding: "utf8", timeout: 5000 });

      const table = run(["--help"]);
      expect(projectFiles(root)).toEqual(before);
      expect(run(["-h"])).toBe(table);
      expect(run(["help"])).toBe(table);
      for (const verb of CLI_VERBS) {
        const line = table.split("\n").find((item) => item.includes(`archstrict ${verb}`));
        expect(line, verb).toBeDefined();
        expect(line!.includes("[writes files]"), verb).toBe(WRITING_VERBS.has(verb));
        expect(run([verb, "--help"]).trim()).toBe(line!.trim());
        expect(run(["help", verb]).trim()).toBe(line!.trim());
        expect(run(["--help", verb]).trim()).toBe(line!.trim());
        expect(run([verb, "-h"]).trim()).toBe(line!.trim());
        expect(run([verb, "src/app.ts", "--help"]).trim()).toBe(line!.trim());
        expect(projectFiles(root)).toEqual(before);
      }
      const checkLine = table.split("\n").find((item) => item.includes("archstrict check "));
      expect(run(["check", "--module", "init", "--help"]).trim()).toBe(checkLine!.trim());
      expect(projectFiles(root)).toEqual(before);

      let exitCode = 0;
      let stderr = "";
      try {
        run(["chek"]);
      } catch (error) {
        const err = error as { status: number; stderr: string };
        exitCode = err.status;
        stderr = err.stderr;
      }
      expect(exitCode).toBe(1);
      expect(stderr).toContain("unknown verb 'chek'");
      for (const verb of CLI_VERBS) expect(stderr).toContain(`archstrict ${verb}`);
      expect(projectFiles(root)).toEqual(before);

      let searchCode = 0;
      let searchStdout = "";
      let searchStderr = "";
      try {
        searchStdout = run(["search", "help"]);
      } catch (error) {
        const err = error as { status: number; stdout: string; stderr: string };
        searchCode = err.status;
        searchStdout = err.stdout;
        searchStderr = err.stderr;
      }
      expect(searchCode).not.toBe(0);
      expect(searchStdout).not.toContain("Rank names exported");
      expect(searchStderr).not.toContain("usage:");
      expect(projectFiles(root)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("init writes the two files and prints a do: line", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-cli-init-"));
    try {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "module.ts"), "export const app = 1;\n");

      const out = execFileSync("node", [CLI_PATH, "init"], { cwd: root, encoding: "utf8" });
      expect(out).toContain("do: archstrict check");
      expect(readFileSync(join(root, "archstrict.types.ts"), "utf8")).toContain('"app"');
      expect(readFileSync(join(root, "archstrict.config.ts"), "utf8")).toContain("satisfies Config");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("init reports which noise directories it found and excluded", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-cli-init-noise-"));
    try {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "module.ts"), "export const app = 1;\n");
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "test", "some.test.ts"), "export const t = 1;\n");
      mkdirSync(join(root, "spike"), { recursive: true });
      writeFileSync(join(root, "spike", "notes.ts"), "export const s = 1;\n");

      const out = execFileSync("node", [CLI_PATH, "init"], { cwd: root, encoding: "utf8" });
      expect(out).toContain("excluded 2 noise directories found on disk: test/, spike/");
      expect(readFileSync(join(root, "archstrict.config.ts"), "utf8")).toContain(
        '"archstrict.config.ts",\n    "archstrict.types.ts",\n    ".*/**",\n    "**/.*/**",\n    "test/**",\n    "spike/**",',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("init <dir> actually threads the argument through - a real layout other than src/", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-cli-init-glob-"));
    try {
      mkdirSync(join(root, "packages", "core"), { recursive: true });
      writeFileSync(join(root, "packages", "core", "module.ts"), "export const core = 1;\n");

      // The default container (src/) doesn't exist here at all - if the CLI
      // silently dropped the argument and fell back to it, this would open
      // no container and declare "packages" as one top-level directory
      // module instead of opening it and declaring its own child "core".
      const out = execFileSync("node", [CLI_PATH, "init", "packages"], { cwd: root, encoding: "utf8" });
      expect(out).toContain("do: archstrict check");
      expect(readFileSync(join(root, "archstrict.types.ts"), "utf8")).toContain('"core"');
      expect(readFileSync(join(root, "archstrict.config.ts"), "utf8")).toContain("packages/core/**");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("init then check: exit 1 and a do: todo line when a violation exists", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-cli-check-"));
    try {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      mkdirSync(join(root, "src", "shared"), { recursive: true });
      writeFileSync(join(root, "src", "shared", "module.ts"), "export const shared = 1;\n");
      writeFileSync(
        join(root, "src", "app", "module.ts"),
        "import { shared } from \"../shared/module.ts\";\nexport const x = shared;\n",
      );
      execFileSync("node", [CLI_PATH, "init"], { cwd: root });

      let out = "";
      let exitCode = 0;
      try {
        out = execFileSync("node", [CLI_PATH, "check"], { cwd: root, encoding: "utf8" });
      } catch (e) {
        const err = e as { status: number; stdout: string };
        exitCode = err.status;
        out = err.stdout;
      }
      expect(exitCode).toBe(1);
      expect(out).toContain("[public-surface-bypass]");
      expect(out.split("\n").filter((line) => line.startsWith("do: "))).toEqual([
        "do: archstrict todo (the first run freezes once)",
        "do: archstrict recommend --json # read surfaceProposals for a ranked surface per module, from its own real importers",
        "do: archstrict hotspots",
        "do: read node_modules/archstrict/skills/archstrict/references/rearchitect.md",
      ]);

      let jsonOut = "";
      try {
        jsonOut = execFileSync("node", [CLI_PATH, "check", "--json"], { cwd: root, encoding: "utf8" });
      } catch (e) {
        jsonOut = (e as { stdout: string }).stdout;
      }
      const json = JSON.parse(jsonOut);
      expect(json.violations).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("check --json is byte-identical before and after the edge cache warms", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-cli-json-stability-"));
    try {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      mkdirSync(join(root, "src", "shared"), { recursive: true });
      writeFileSync(join(root, "src", "app", "index.ts"), 'import { value } from "../shared/internal.js"; export { value };\n');
      writeFileSync(join(root, "src", "shared", "internal.ts"), "export const value = 1;\n");
      execFileSync("node", [CLI_PATH, "init"], { cwd: root });

      const run = () => {
        try {
          return execFileSync("node", [CLI_PATH, "check", "src/app/index.ts", "--json"], { cwd: root, encoding: "utf8" });
        } catch (error) {
          return (error as { stdout: string }).stdout;
        }
      };
      expect(run()).toBe(run());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a config error prints a clean message, not a raw stack trace", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-cli-config-error-"));
    try {
      writeFileSync(join(root, "archstrict.config.ts"), "export default { modules: 'src/*' };\n");

      let out = "";
      let errOut = "";
      let exitCode = 0;
      try {
        out = execFileSync("node", [CLI_PATH, "check"], { cwd: root, encoding: "utf8" });
      } catch (e) {
        const err = e as { status: number; stdout: string; stderr: string };
        exitCode = err.status;
        out = err.stdout;
        errOut = err.stderr;
      }

      expect(exitCode).toBe(1);
      expect(out).toBe("");
      expect(errOut).toContain("missing required field");
      expect(errOut).not.toMatch(/^\s+at /m);
      const lines = errOut.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[1]).toMatch(/^do: .*archstrict check$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("init on a project with no .ts file anywhere prints a clean message, not a raw stack trace", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-cli-init-error-"));
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
      expect(errOut).not.toMatch(/^\s+at /m);
      const lines = errOut.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[1]).toBe("do: add a .ts source file outside those directories, then run archstrict init");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a config error with --json prints a structured error object", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-cli-config-error-json-"));
    try {
      writeFileSync(join(root, "archstrict.config.ts"), "export default { modules: 'src/*' };\n");

      let out = "";
      let exitCode = 0;
      try {
        out = execFileSync("node", [CLI_PATH, "check", "--json"], { cwd: root, encoding: "utf8" });
      } catch (e) {
        const err = e as { status: number; stdout: string };
        exitCode = err.status;
        out = err.stdout;
      }

      expect(exitCode).toBe(1);
      const json = JSON.parse(out);
      expect(json.error).toContain("missing required field");
      expect(json.do).toContain("archstrict check");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("check with no archstrict.config.ts names archstrict init", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-cli-no-config-"));
    try {
      let errOut = "";
      let jsonOut = "";
      let exitCode = 0;
      try {
        execFileSync("node", [CLI_PATH, "check"], { cwd: root, encoding: "utf8" });
      } catch (e) {
        const err = e as { status: number; stderr: string };
        exitCode = err.status;
        errOut = err.stderr;
      }
      expect(exitCode).toBe(1);
      expect(errOut.trim().split("\n").at(-1)).toBe("do: archstrict init");

      try {
        jsonOut = execFileSync("node", [CLI_PATH, "check", "--json"], { cwd: root, encoding: "utf8" });
      } catch (e) {
        jsonOut = (e as { stdout: string }).stdout;
      }
      expect(JSON.parse(jsonOut)).toMatchObject({ do: "archstrict init" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("check from a subdirectory names the ancestor that has the config", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-cli-subdir-config-")));
    const nested = join(root, "src");
    try {
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(root, "archstrict.config.ts"), "export default { declaredModules: [], because: \"test\" };\n");

      let errOut = "";
      let jsonOut = "";
      let exitCode = 0;
      try {
        execFileSync("node", [CLI_PATH, "check"], { cwd: nested, encoding: "utf8" });
      } catch (e) {
        const err = e as { status: number; stderr: string };
        exitCode = err.status;
        errOut = err.stderr;
      }
      const project = compilerSpelling(root);
      expect(exitCode).toBe(1);
      expect(errOut).toContain(`${project}/archstrict.config.ts is the nearest config`);
      expect(errOut.trim().split("\n").at(-1)).toBe(`do: cd ${project} && archstrict check`);

      try {
        jsonOut = execFileSync("node", [CLI_PATH, "check", "--json"], { cwd: nested, encoding: "utf8" });
      } catch (e) {
        jsonOut = (e as { stdout: string }).stdout;
      }
      expect(JSON.parse(jsonOut)).toMatchObject({
        do: `cd ${project} && archstrict check`,
      });

      let todoErr = "";
      try {
        execFileSync("node", [CLI_PATH, "todo"], { cwd: nested, encoding: "utf8" });
      } catch (e) {
        todoErr = (e as { stderr: string }).stderr;
      }
      expect(todoErr.trim().split("\n").at(-1)).toBe(`do: cd ${project} && archstrict todo`);

      const deeper = join(nested, "app");
      mkdirSync(deeper);
      errOut = "";
      exitCode = 0;
      try {
        execFileSync("node", [CLI_PATH, "check"], { cwd: deeper, encoding: "utf8" });
      } catch (e) {
        const err = e as { status: number; stderr: string };
        exitCode = err.status;
        errOut = err.stderr;
      }
      expect(exitCode).toBe(1);
      expect(errOut.trim().split("\n").at(-1)).toBe(`do: cd ${project} && archstrict check`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("check <nonexistent-file> prints a clean message, not a raw stack trace", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-cli-missing-file-"));
    try {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "module.ts"), "export const app = 1;\n");
      execFileSync("node", [CLI_PATH, "init"], { cwd: root });

      let errOut = "";
      let exitCode = 0;
      try {
        execFileSync("node", [CLI_PATH, "check", "src/app/missing.ts"], { cwd: root, encoding: "utf8" });
      } catch (e) {
        const err = e as { status: number; stderr: string };
        exitCode = err.status;
        errOut = err.stderr;
      }

      expect(exitCode).toBe(1);
      expect(errOut).toContain("no such file");
      expect(errOut).not.toMatch(/^\s+at /m);
      expect(errOut.trim().split("\n").at(-1)).toBe("do: archstrict check");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("todo rejects unknown arguments without freezing violations", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-cli-todo-unknown-"));
    try {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      mkdirSync(join(root, "src", "shared"), { recursive: true });
      writeFileSync(join(root, "src", "shared", "module.ts"), "export const shared = 1;\n");
      writeFileSync(
        join(root, "src", "app", "module.ts"),
        "import { shared } from \"../shared/module.ts\";\nexport const x = shared;\n",
      );
      execFileSync("node", [CLI_PATH, "init"], { cwd: root });

      let exitCode = 0;
      let stdout = "";
      try {
        stdout = execFileSync("node", [CLI_PATH, "todo", "--help"], { cwd: root, encoding: "utf8" });
      } catch (e) {
        const err = e as { status: number; stdout: string };
        exitCode = err.status;
        stdout = err.stdout;
      }
      expect(exitCode).toBe(0);
      expect(stdout).toContain("archstrict todo [--json]:");
      expect(stdout).toContain("[writes files]");
      expect(existsSync(join(root, "archstrict.todo.json"))).toBe(false);

      exitCode = 0;
      let stderr = "";
      try {
        execFileSync("node", [CLI_PATH, "todo", "--dry-run"], { cwd: root, encoding: "utf8" });
      } catch (e) {
        const err = e as { status: number; stderr: string };
        exitCode = err.status;
        stderr = err.stderr;
      }
      expect(exitCode).toBe(1);
      expect(stderr).toBe("archstrict: unknown option '--dry-run'\ndo: archstrict todo [--json]\n");
      expect(existsSync(join(root, "archstrict.todo.json"))).toBe(false);

      const first = JSON.parse(execFileSync("node", [CLI_PATH, "todo", "--json"], { cwd: root, encoding: "utf8" }));
      expect(first).toEqual({ firstRun: true, added: 1, pruned: 0 });
      const todoPath = join(root, "archstrict.todo.json");
      const frozen = readFileSync(todoPath, "utf8");
      const helpAgain = execFileSync("node", [CLI_PATH, "todo", "--help"], { cwd: root, encoding: "utf8" });
      expect(helpAgain).toContain("archstrict todo [--json]:");
      expect(readFileSync(todoPath, "utf8")).toBe(frozen);
      for (const args of [["--dry-run"], ["--json", "--dry-run"], ["unexpected.ts"]]) {
        expect(() => execFileSync("node", [CLI_PATH, "todo", ...args], { cwd: root, stdio: "pipe" })).toThrow();
        expect(readFileSync(todoPath, "utf8")).toBe(frozen);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("todo --json prints a structured TodoResult, on the first run and on a later prune-only run", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-cli-todo-json-"));
    try {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      mkdirSync(join(root, "src", "shared"), { recursive: true });
      writeFileSync(join(root, "src", "shared", "module.ts"), "export const shared = 1;\n");
      writeFileSync(
        join(root, "src", "app", "module.ts"),
        "import { shared } from \"../shared/module.ts\";\nexport const x = shared;\n",
      );
      execFileSync("node", [CLI_PATH, "init"], { cwd: root });

      const first = JSON.parse(execFileSync("node", [CLI_PATH, "todo", "--json"], { cwd: root, encoding: "utf8" }));
      expect(first).toEqual({ firstRun: true, added: 1, pruned: 0 });

      const second = JSON.parse(execFileSync("node", [CLI_PATH, "todo", "--json"], { cwd: root, encoding: "utf8" }));
      expect(second).toEqual({ firstRun: false, added: 0, pruned: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a real config's classify + edges.allowDeny produces a tag-boundary violation through check, and todo freezes it", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-cli-constraints-"));
    try {
      mkdirSync(join(root, "src", "core"), { recursive: true });
      mkdirSync(join(root, "src", "feature"), { recursive: true });
      writeFileSync(join(root, "src", "core", "index.ts"), "export const core = 1;\n");
      writeFileSync(
        join(root, "src", "feature", "module.ts"),
        "import { core } from \"../core/index.ts\";\nexport const x = core;\n",
      );
      writeFileSync(
        join(root, "archstrict.config.ts"),
        `import type { Config } from "./archstrict.types.js";\n` +
          `export default {\n` +
          `  declaredModules: [\n` +
          `    { name: "core", glob: "src/core/**", surface: "index.ts" },\n` +
          `    { name: "feature", glob: "src/feature/**", surface: "index.ts" },\n` +
          `  ],\n` +
          `  exclude: ["*.ts"],\n` +
          `  classify: [\n` +
          `    { glob: "src/core/**", tags: ["domain:core"] },\n` +
          `    { glob: "src/feature/**", tags: ["domain:feature"] },\n` +
          `  ],\n` +
          `  edges: {\n` +
          `    allowDeny: [\n` +
          `      { source: "domain:feature", targetNamespace: "domain", allow: [], because: "feature must not depend on core directly" },\n` +
          `    ],\n` +
          `  },\n` +
          `  because: "test",\n` +
          `} satisfies Config;\n`,
      );

      let out = "";
      try {
        out = execFileSync("node", [CLI_PATH, "check"], { cwd: root, encoding: "utf8" });
      } catch (e) {
        out = (e as { stdout: string }).stdout;
      }
      expect(out).toContain("[tag-boundary]");

      let jsonOut = "";
      try {
        jsonOut = execFileSync("node", [CLI_PATH, "check", "--json"], { cwd: root, encoding: "utf8" });
      } catch (e) {
        jsonOut = (e as { stdout: string }).stdout;
      }
      const json = JSON.parse(jsonOut);
      expect(json.violations).toHaveLength(1);
      expect(json.violations[0].rule).toBe("tag-boundary");
      expect(json.violations[0].todoModule).toBe("feature");

      const todoResult = JSON.parse(execFileSync("node", [CLI_PATH, "todo", "--json"], { cwd: root, encoding: "utf8" }));
      expect(todoResult).toEqual({ firstRun: true, added: 1, pruned: 0 });

      const afterFreeze = JSON.parse(execFileSync("node", [CLI_PATH, "check", "--json"], { cwd: root, encoding: "utf8" }));
      expect(afterFreeze.violations).toHaveLength(0);
      expect(afterFreeze.todo).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a single-file declaredModules glob does not crash todo or check", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-cli-file-module-"));
    try {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "index.ts"), "export const value = 1;\n");
      writeFileSync(join(root, "src", "secret.ts"), "export const secret = 1;\n");
      writeFileSync(
        join(root, "src", "app", "index.ts"),
        "import { value } from \"../index.ts\";\nimport { secret } from \"../secret.ts\";\nexport const x = [value, secret];\n",
      );
      writeFileSync(
        join(root, "archstrict.config.ts"),
        `export default {\n` +
          `  declaredModules: [\n` +
          `    { name: "src-index", glob: "src/index.ts", surface: "index.ts" },\n` +
          `    { name: "secret", glob: "src/secret.ts", surface: "index.ts" },\n` +
          `    { name: "app", glob: "src/app/**", surface: "index.ts" },\n` +
          `  ],\n` +
          `  exclude: ["*.ts"],\n` +
          `  because: "test",\n` +
          `};\n`,
      );

      let jsonOut = "";
      let exitCode = 0;
      try {
        jsonOut = execFileSync("node", [CLI_PATH, "check", "--json"], { cwd: root, encoding: "utf8" });
      } catch (e) {
        const err = e as { status: number; stdout: string; stderr: string };
        exitCode = err.status;
        jsonOut = err.stdout;
        expect(err.stderr).not.toContain("ENOTDIR");
      }
      const json = JSON.parse(jsonOut);
      expect(json.error).toBeUndefined();
      expect(exitCode).toBe(1);
      const bypasses = json.violations.filter((v: { rule: string }) => v.rule === "public-surface-bypass");
      expect(bypasses).toHaveLength(1);
      expect(bypasses[0].todoModule).toBe("secret");
      expect(bypasses[0].do).toBe(
        "set surface on 'secret' to match src/secret.ts, or stop importing it; this module is that file, not a directory",
      );
      expect(bypasses[0].do).not.toContain("secret/");

      const todoResult = JSON.parse(execFileSync("node", [CLI_PATH, "todo", "--json"], { cwd: root, encoding: "utf8" }));
      expect(todoResult).toEqual({ firstRun: true, added: 1, pruned: 0 });
      const todoFile = JSON.parse(readFileSync(join(root, "archstrict.todo.json"), "utf8"));
      expect(todoFile.modules.secret).toHaveLength(1);
      expect(todoFile.modules.secret[0].rule).toBe("public-surface-bypass");
      expect(existsSync(join(root, "src", "secret.ts.archstrict.todo.json"))).toBe(false);

      const after = JSON.parse(execFileSync("node", [CLI_PATH, "check", "--json"], { cwd: root, encoding: "utf8" }));
      expect(after.violations.filter((v: { rule: string }) => v.rule === "public-surface-bypass")).toEqual([]);
      expect(after.todo).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("todo --json on a broken config prints a structured error object, not the text do: line", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-cli-todo-json-error-"));
    try {
      writeFileSync(join(root, "archstrict.config.ts"), "export default { modules: 'src/*' };\n");

      let out = "";
      let exitCode = 0;
      try {
        out = execFileSync("node", [CLI_PATH, "todo", "--json"], { cwd: root, encoding: "utf8" });
      } catch (e) {
        const err = e as { status: number; stdout: string };
        exitCode = err.status;
        out = err.stdout;
      }

      expect(exitCode).toBe(1);
      const json = JSON.parse(out);
      expect(json.error).toContain("missing required field");
      expect(json.do).toContain("archstrict check");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("todo's first run refuses while an uncovered-module violation exists: text and --json both carry the error and do", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-cli-todo-uncovered-"));
    try {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "index.ts"), "export const app = 1;\n");
      writeFileSync(join(root, "src", "extra.ts"), "export const extra = 1;\n"); // matches no declared module
      writeFileSync(
        join(root, "archstrict.config.ts"),
        `export default { declaredModules: [{ name: "app", glob: "src/app/**", surface: "index.ts" }], exclude: ["archstrict.config.ts"], because: "test" };\n`,
      );

      let errOut = "";
      let exitCode = 0;
      try {
        execFileSync("node", [CLI_PATH, "todo"], { cwd: root, encoding: "utf8" });
      } catch (e) {
        const err = e as { status: number; stderr: string };
        exitCode = err.status;
        errOut = err.stderr;
      }
      expect(exitCode).toBe(1);
      expect(errOut).toBe(
        "archstrict: todo's first run refuses: 1 file matches no declared module: src/extra.ts\n" +
          "do: archstrict check --rule uncovered-module\n",
      );

      let jsonOut = "";
      try {
        jsonOut = execFileSync("node", [CLI_PATH, "todo", "--json"], { cwd: root, encoding: "utf8" });
      } catch (e) {
        jsonOut = (e as { stdout: string }).stdout;
      }
      expect(JSON.parse(jsonOut)).toEqual({
        error: "todo's first run refuses: 1 file matches no declared module: src/extra.ts",
        do: "archstrict check --rule uncovered-module",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("check prints one note for a file it did not analyze, and --json keeps an empty violation list", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-cli-unanalyzed-")));
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-cli-outside-")));
    try {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "index.ts"), "export const app = 1;\n");
      writeFileSync(join(root, "src", "app", "main.test.ts"), "export const t = 1;\n");
      writeFileSync(join(root, "src", "app", "types.d.ts"), "export interface T { value: number }\n");
      writeFileSync(join(root, "package.json"), "{\"type\":\"module\"}\n");
      writeFileSync(join(root, "archstrict.config.ts"), [
        "export default {",
        "  declaredModules: [{ name: \"app\", glob: \"src/app/**\", surface: \"index.ts\" }],",
        "  exclude: [\"**/*.test.ts\", \"archstrict.config.ts\"],",
        "  because: \"test\",",
        "};\n",
      ].join("\n"));
      const outside = join(outsideDir, "other.ts");
      writeFileSync(outside, "export const x = 1;\n");

      const cases = [
        ["src/app/main.test.ts", "note: src/app/main.test.ts is excluded, so it was not analyzed"],
        [outside, `note: ${outside} is outside the project, so it was not analyzed`],
        ["package.json", "note: package.json was not analyzed"],
        ["src/app/types.d.ts", "note: src/app/types.d.ts was not analyzed"],
      ] as const;
      for (const [file, note] of cases) {
        const text = execFileSync("node", [CLI_PATH, "check", file], { cwd: root, encoding: "utf8" });
        expect(text.split("\n").filter((line) => line.startsWith("note:"))).toEqual([note]);
        const json = JSON.parse(execFileSync("node", [CLI_PATH, "check", file, "--json"], { cwd: root, encoding: "utf8" }));
        expect(json.violations).toEqual([]);
        expect(json.error).toBeUndefined();
        expect(JSON.stringify(json)).not.toContain("was not analyzed");
        expect(JSON.stringify(json)).not.toContain("is excluded");
        expect(JSON.stringify(json)).not.toContain("outside the project");
      }

      const analyzed = execFileSync("node", [CLI_PATH, "check", "src/app/index.ts"], { cwd: root, encoding: "utf8" });
      expect(analyzed.split("\n").filter((line) => line.startsWith("note:"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("fix on a missing file exits 1 with a no such file report", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-cli-fix-missing-")));
    try {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      writeFileSync(join(root, "src", "app", "index.ts"), "export const app = 1;\n");
      writeFileSync(join(root, "archstrict.config.ts"), "export default { declaredModules: [{ name: \"app\", glob: \"src/app/**\", surface: \"index.ts\" }], because: \"test\" };\n");

      let errOut = "";
      let exitCode = 0;
      try {
        execFileSync("node", [CLI_PATH, "fix", "src/shared/nope.ts"], { cwd: root, encoding: "utf8" });
      } catch (e) {
        const err = e as { status: number; stderr: string };
        exitCode = err.status;
        errOut = err.stderr;
      }
      expect(exitCode).toBe(1);
      expect(errOut).toContain("fix src/shared/nope.ts: no such file");
      expect(errOut).not.toMatch(/^\s+at /m);
      expect(errOut.trim().split("\n").at(-1)).toBe("do: archstrict fix");

      let jsonOut = "";
      try {
        jsonOut = execFileSync("node", [CLI_PATH, "fix", "src/shared/nope.ts", "--json"], { cwd: root, encoding: "utf8" });
      } catch (e) {
        jsonOut = (e as { stdout: string }).stdout;
      }
      expect(JSON.parse(jsonOut)).toEqual({
        error: "fix src/shared/nope.ts: no such file",
        do: "archstrict fix",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
