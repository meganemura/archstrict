// Responsibility: verify check --frozen surfaces todo-matched violations without flipping the exit code.
// Boundary: one small fixture with exactly one freezable violation; the CLI's own JSON/text and exit code.
import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check } from "../src/verbs/check.js";
import { todo } from "../src/verbs/todo.js";

const CLI_PATH = new URL("../dist/cli.js", import.meta.url).pathname;

function writeBypassProject(root: string): void {
  mkdirSync(join(root, "src", "app"), { recursive: true });
  mkdirSync(join(root, "src", "shared"), { recursive: true });
  writeFileSync(join(root, "src", "shared", "module.ts"), "export const shared = 1;\n");
  writeFileSync(
    join(root, "src", "app", "module.ts"),
    "import { shared } from \"../shared/module.ts\";\nexport const x = shared;\n",
  );
  writeFileSync(
    join(root, "archstrict.config.ts"),
    `export default ${JSON.stringify({
      declaredModules: [{ name: "app", glob: "src/app/**" }, { name: "shared", glob: "src/shared/**" }],
      exclude: ["archstrict.config.ts"],
      because: "test",
    })};`,
  );
}

function withTempProject(fn: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "archstrict-check-frozen-"));
  return Promise.resolve()
    .then(() => fn(root))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

describe("check --frozen", () => {
  test("a frozen violation is absent without --frozen, present and marked with it, and never fails the exit code", () => withTempProject(async (root) => {
    writeBypassProject(root);
    await todo(root);

    const plain = await check(root);
    expect(plain.violations).toHaveLength(0);

    const frozen = await check(root, undefined, { frozen: true });
    expect(frozen.violations).toHaveLength(1);
    expect(frozen.violations[0]!.rule).toBe("public-surface-bypass");
    expect(frozen.violations[0]!.frozen).toBe(true);

    const plainOut = execFileSync("node", [CLI_PATH, "check"], { cwd: root, encoding: "utf8" });
    expect(plainOut).not.toContain("public-surface-bypass");

    const frozenOut = execFileSync("node", [CLI_PATH, "check", "--frozen"], { cwd: root, encoding: "utf8" });
    expect(frozenOut).toContain("[public-surface-bypass]");
    expect(frozenOut).toContain("frozen: true");

    const frozenJson = JSON.parse(execFileSync("node", [CLI_PATH, "check", "--frozen", "--json"], { cwd: root, encoding: "utf8" }));
    expect(frozenJson.violations).toHaveLength(1);
    expect(frozenJson.violations[0].frozen).toBe(true);
  }));

  test("--frozen combines with --rule and --module", () => withTempProject(async (root) => {
    writeBypassProject(root);
    await todo(root);

    const byRule = await check(root, undefined, { frozen: true, rules: ["public-surface-bypass"] });
    expect(byRule.violations).toHaveLength(1);
    const byWrongRule = await check(root, undefined, { frozen: true, rules: ["cycle"] });
    expect(byWrongRule.violations).toHaveLength(0);

    const byModule = await check(root, undefined, { frozen: true, modules: ["shared"] });
    expect(byModule.violations).toHaveLength(1);
    const byWrongModule = await check(root, undefined, { frozen: true, modules: ["app"] });
    expect(byWrongModule.violations).toHaveLength(0);
  }));

  test("--frozen never fails the CLI's own exit code on an otherwise clean project", () => withTempProject((root) => {
    writeBypassProject(root);
    execFileSync("node", [CLI_PATH, "todo"], { cwd: root, encoding: "utf8" });
    const result = execFileSync("node", [CLI_PATH, "check", "--frozen"], { cwd: root, encoding: "utf8" });
    expect(result).toContain("frozen: true");
  }));
});
