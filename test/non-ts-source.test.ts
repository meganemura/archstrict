// Responsibility: verify visibility counts against real files and the built CLI.
// Boundary: JavaScript contents remain outside architecture analysis.
import { expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { prepareGraph } from "../src/module-graph.js";
import { check, formatText } from "../src/verbs/check.js";

const declaredModules = [{ name: "app", glob: "src/app/**" }];
async function project(run: (root: string, put: (path: string, content: string) => void) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "archstrict-source-count-"));
  const put = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  put("src/app/index.ts", "export const value = 1;");
  put("tsconfig.json", JSON.stringify({ compilerOptions: { noLib: true, types: [] } }));
  put("archstrict.config.ts", `export default ${JSON.stringify({ declaredModules, exclude: ["*.ts"], because: "Keep boundaries explicit." })};`);
  try { await run(root, put); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

const countLine = "non-.ts source files present, not analyzed:";

test("check reports two non-TypeScript files in JSON and exact text", () => project(async (root, put) => {
  put("scripts/plugin.mjs", "export const plugin = 1;");
  put("scripts/hook.cjs", "module.exports = 1;");
  const result = await check(root);
  expect(JSON.parse(JSON.stringify(result)).nonTsSourceFiles).toBe(2);
  expect(result.violations).toEqual([]);
  expect(formatText(result)).toContain(`not covered by any declared module: 0\n${countLine} 2\n`);

  mkdirSync(join(root, "ignored"));
  renameSync(join(root, "scripts/plugin.mjs"), join(root, "ignored/plugin.mjs"));
  renameSync(join(root, "scripts/hook.cjs"), join(root, "ignored/hook.cjs"));
  put("archstrict.config.ts", `export default ${JSON.stringify({ declaredModules, exclude: ["*.ts", "ignored/**"], because: "Keep boundaries explicit." })};`);
  const excluded = await check(root);
  expect(excluded.nonTsSourceFiles).toBe(0);
  expect(formatText(excluded)).not.toContain(countLine);
}));

test("a TypeScript-only project omits the text line", () => project(async root => {
  const result = await check(root);
  expect(result.nonTsSourceFiles).toBe(0);
  expect(formatText(result)).not.toContain(countLine);
}));

test("the built check CLI includes the count in JSON", () => project((root, put) => {
  put("plugin.mjs", "export const plugin = 1;");
  put("hook.cjs", "module.exports = 1;");
  const cli = new URL("../dist/cli.js", import.meta.url).pathname;
  const output = execFileSync(process.execPath, [cli, "check", "--json"], { cwd: root, encoding: "utf8" });
  expect(JSON.parse(output).nonTsSourceFiles).toBe(2);
}));

test("counts exactly the generated JavaScript files outside excluded directories", async () => {
  await hegel.testAsync(tc => project((root, put) => {
    const files = tc.draw(gen.arrays(gen.tuples(
      gen.sampledFrom([".js", ".mjs", ".cjs", ".ts", ".d.ts", ".json"]),
      gen.sampledFrom(["src/app", "src/ignored", "src/app/node_modules/pkg", "src/app/dist"]),
    )));
    for (const [i, [extension, directory]] of files.entries()) put(`${directory}/file${i}${extension}`, "");
    const graph = prepareGraph({ projectRoot: root, declaredModules, exclude: ["src/ignored/**"] });
    const expected = files.filter(([extension, directory]) =>
      [".js", ".mjs", ".cjs"].includes(extension) && directory === "src/app").length;
    expect(graph.nonTsSourceFileCount).toBe(expected);
  }));
});
