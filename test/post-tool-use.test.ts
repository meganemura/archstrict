import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOOK_PATH = join(REPO_ROOT, ".agents", "hooks", "post-tool-use.mjs");
const DIST_CLI_PATH = join(REPO_ROOT, "dist", "cli.js");

// Mirrors cli.test.ts's own reasoning: node's native TypeScript stripping
// doesn't remap a .js-extension specifier to a sibling .ts file across a
// spawned process, so the hook (like the CLI itself) has to run against a
// real build, not src/cli.ts directly.

function invokedMarkerPath(projectRoot: string): string {
  return join(projectRoot, ".archstrict-bin-invoked");
}

// A real, installed project's node_modules/.bin/archstrict is a shim npm
// itself creates (and chmods executable) from package.json's own `bin`
// field - simulated here with the same shape (a shebang script that execs
// this repository's own built dist/cli.js) rather than an actual `npm
// install` of an unpublished package. Also drops a marker file before
// exec'ing: a test asserting "no violation" must prove the hook actually
// reached this binary, not merely that it returned early (say, from a
// wrong `existsSync` check) - the two are otherwise indistinguishable,
// since both emit the identical empty result.
function installArchstrictBin(projectRoot: string): void {
  const binDir = join(projectRoot, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  const binPath = join(binDir, "archstrict");
  writeFileSync(binPath, `#!/bin/sh\ntouch "${invokedMarkerPath(projectRoot)}"\nexec node "${DIST_CLI_PATH}" "$@"\n`);
  chmodSync(binPath, 0o755);
}

function withTempProject(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "archstrict-hook-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runHook(input: unknown): { hookSpecificOutput?: { hookEventName: string; additionalContext: string } } {
  const stdout = execFileSync("node", [HOOK_PATH], { input: JSON.stringify(input), encoding: "utf8" });
  return JSON.parse(stdout);
}

describe("post-tool-use hook", () => {
  test("surfaces a real violation in the tool result after a file edit", () => {
    withTempProject((root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      mkdirSync(join(root, "src", "shared"), { recursive: true });
      writeFileSync(join(root, "src", "shared", "module.ts"), "export const shared = 1;\n");
      const importer = join(root, "src", "app", "importer.ts");
      writeFileSync(importer, "import { shared } from \"../shared/module.ts\";\nexport const x = shared;\n");
      writeFileSync(
        join(root, "archstrict.types.ts"),
        "export type ModuleName = \"app\" | \"shared\";\nexport type Config = { surface?: string; declaredModules: readonly { name: string; glob: string; surface: string }[]; because: string };\n",
      );
      writeFileSync(
        join(root, "archstrict.config.ts"),
        "import type { Config } from \"./archstrict.types.js\";\nexport default { declaredModules: [{ name: \"app\", glob: \"src/app/**\", surface: \"index.ts\" }, { name: \"shared\", glob: \"src/shared/**\", surface: \"index.ts\" }], because: \"test\" } satisfies Config;\n",
      );
      installArchstrictBin(root);

      const output = runHook({
        tool_name: "Edit",
        tool_input: { file_path: importer },
        cwd: root,
      });

      expect(output.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
      expect(output.hookSpecificOutput?.additionalContext).toContain("public-surface-bypass");
      expect(output.hookSpecificOutput?.additionalContext).toContain(importer);
      expect(output.hookSpecificOutput?.additionalContext).toContain("because:");
      expect(output.hookSpecificOutput?.additionalContext).toContain("do:");
    });
  });

  test("says nothing when the edited file has no violation", () => {
    withTempProject((root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      const clean = join(root, "src", "app", "module.ts");
      writeFileSync(clean, "export const app = 1;\n");
      writeFileSync(
        join(root, "archstrict.types.ts"),
        "export type ModuleName = \"app\";\nexport type Config = { surface?: string; declaredModules: readonly { name: string; glob: string; surface: string }[]; because: string };\n",
      );
      writeFileSync(
        join(root, "archstrict.config.ts"),
        "import type { Config } from \"./archstrict.types.js\";\nexport default { declaredModules: [{ name: \"app\", glob: \"src/app/**\", surface: \"index.ts\" }], because: \"test\" } satisfies Config;\n",
      );
      installArchstrictBin(root);

      const output = runHook({ tool_name: "Edit", tool_input: { file_path: clean }, cwd: root });
      expect(output.hookSpecificOutput).toBeUndefined();
      // Proves the empty result came from a real, violation-free check
      // run, not an early return before the binary was ever invoked.
      expect(existsSync(invokedMarkerPath(root))).toBe(true);
    });
  });

  test("surfaces a clear message when the project's own config is broken, without throwing", () => {
    withTempProject((root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      const file = join(root, "src", "app", "module.ts");
      writeFileSync(file, "export const app = 1;\n");
      // A config missing required fields (declaredModules, because) - check
      // reports this as { error: string } with exit 1, not a real CheckResult.
      writeFileSync(join(root, "archstrict.config.ts"), "export default { surface: 'index.ts' };\n");
      installArchstrictBin(root);

      const output = runHook({ tool_name: "Edit", tool_input: { file_path: file }, cwd: root });
      expect(output.hookSpecificOutput?.additionalContext).toContain("archstrict: check did not run");
      expect(output.hookSpecificOutput?.additionalContext).toContain("missing required field");
      expect(output.hookSpecificOutput?.additionalContext).toContain("\ndo: ");
      expect(output.hookSpecificOutput?.additionalContext).toContain("archstrict check");
    });
  });

  test("says nothing when the project has no archstrict installed", () => {
    withTempProject((root) => {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      const file = join(root, "src", "app", "module.ts");
      writeFileSync(file, "export const app = 1;\n");
      // No node_modules/.bin/archstrict written here at all.

      const output = runHook({ tool_name: "Edit", tool_input: { file_path: file }, cwd: root });
      expect(output.hookSpecificOutput).toBeUndefined();
    });
  });

  test("ignores a tool that isn't an edit, and a non-.ts file", () => {
    const bashOutput = runHook({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: process.cwd() });
    expect(bashOutput.hookSpecificOutput).toBeUndefined();

    withTempProject((root) => {
      const jsonFile = join(root, "notes.json");
      writeFileSync(jsonFile, "{}");
      const output = runHook({ tool_name: "Edit", tool_input: { file_path: jsonFile }, cwd: root });
      expect(output.hookSpecificOutput).toBeUndefined();
    });
  });

  test("malformed stdin (not JSON) emits an empty result, never throws", () => {
    const stdout = execFileSync("node", [HOOK_PATH], { input: "not json", encoding: "utf8" });
    expect(JSON.parse(stdout)).toEqual({});
  });
});
