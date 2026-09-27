// Responsibility: verify proposals against real filesystem imports and CLI output.
// Boundary: temporary projects only; generated expectations come from the input adjacency matrix.
import { test, expect } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { recommend, formatRecommendText } from "../src/verbs/recommend.js";

const cliPath = new URL("../dist/cli.js", import.meta.url).pathname;
async function fixture(run: (root: string, put: (path: string, source: string) => void) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "archstrict-recommend-"));
  const put = (path: string, source: string) => {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, source);
  };
  try {
    mkdirSync(join(root, "src"));
    put("tsconfig.json", JSON.stringify({ compilerOptions: { noLib: true, types: [], module: "commonjs", moduleResolution: "node" } }));
    await run(root, put);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const because = "<author must state a real reason>";

test("exact pairs, file counts, deduplicated classification, and bidirectional deny proposals", async () => fixture(async (root, put) => {
  put("src/a/index.ts", 'import "../b/index.js";');
  put("src/a/extra.ts", "export const extra = 1;");
  put("src/b/index.ts", "export const b = 1;");
  put("src/c/index.ts", "export const c = 1;");
  mkdirSync(join(root, "src/empty"));
  const result = await recommend(root);
  expect(result).toEqual({ modules: 3, candidates: 2,
    pairs: [{ a: "a", b: "c", filesA: 2, filesB: 1 }, { a: "b", b: "c", filesA: 1, filesB: 1 }],
    proposedClassify: [
      { glob: "src/a/**", tags: ["role:a"] }, { glob: "src/b/**", tags: ["role:b"] }, { glob: "src/c/**", tags: ["role:c"] },
    ],
    proposedAllowDeny: [
      { source: "role:a", targetNamespace: "role", deny: ["c"], because },
      { source: "role:c", targetNamespace: "role", deny: ["a"], because },
      { source: "role:b", targetNamespace: "role", deny: ["c"], because },
      { source: "role:c", targetNamespace: "role", deny: ["b"], because },
    ],
  });
  const text = formatRecommendText(result);
  expect(text).toContain("3 modules; 2 candidates\na <-> c (2 files / 1 files)");
  expect(text).toContain('proposed classify:\n[\n  { glob: "src/a/**", tags: ["role:a"] },');
  expect(text).toContain('proposed edges.allowDeny:\n[\n  { source: "role:a", targetNamespace: "role", deny: ["c"], because: "<author must state a real reason>" },');
}));

test("all 28 zero-cross pairs survive without caps or small-file pruning", async () => fixture(async (root, put) => {
  for (let i = 0; i < 8; i++) put(`src/m${i}/index.ts`, "export const x = 1;");
  const result = await recommend(root);
  expect(result.modules).toBe(8);
  expect(result.candidates).toBe(28);
  expect(new Set(result.pairs.map(pair => `${pair.a}/${pair.b}`)).size).toBe(28);
  expect(result.proposedClassify).toHaveLength(8);
  expect(result.proposedAllowDeny).toHaveLength(56);
}));

test("an import in either direction excludes the pair", async () => fixture(async (root, put) => {
  put("src/a/index.ts", 'import "../b/index.js";');
  put("src/b/index.ts", "export const b = 1;");
  expect((await recommend(root)).pairs).toEqual([]);
  put("src/a/index.ts", "export const a = 1;");
  put("src/b/index.ts", 'import "../a/index.js";');
  expect((await recommend(root)).pairs).toEqual([]);
}));

// node_modules/.cache/archstrict/ is recommend's own persistent graph
// cache (module-graph.ts's own buildModuleGraphForRules), not user
// content - excluded here so this test's own "preserves every file"
// claim is about the project's own files, the ones a user actually wrote.
function snapshot(root: string): unknown[] {
  return readdirSync(root, { withFileTypes: true }).filter(entry => entry.name !== "node_modules")
    .sort((a, b) => a.name.localeCompare(b.name)).map(entry =>
    [entry.name, entry.isDirectory() ? snapshot(join(root, entry.name)) : readFileSync(join(root, entry.name)).toString("base64")]);
}
function cli(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [cliPath, "recommend", ...args], { cwd: root, encoding: "utf8" });
}

test("CLI JSON and text preserve every file and directory, including an existing config", async () => fixture(async (root, put) => {
  put("src/a/index.ts", "export const a = 1;");
  put("src/b/index.ts", "export const b = 1;");
  put("archstrict.config.ts", '// Preserve this file.\nexport default { declaredModules: [{ name: "a", glob: "src/a/**" }, { name: "b", glob: "src/b/**" }], because: "Keep the two modules independent." };\n');
  const before = snapshot(root);
  const json = cli(root, "--json");
  expect(json.status).toBe(0);
  expect(JSON.parse(json.stdout)).toEqual(await recommend(root));
  const text = cli(root);
  expect(text.status).toBe(0);
  expect(text.stdout).toBe(formatRecommendText(await recommend(root)));
  expect(snapshot(root)).toEqual(before);
}));

// Without a config, recommend now runs init's own walk in memory instead
// of a v0 single-level "src/*" discovery - these three fixtures are the
// shapes that walk treats differently from v0 (loose files directly in
// the container become their own single-file modules, a no-src tree
// declares from the project root, and a container holding only files
// declares one module per file, none per container).
test("no config, a src/ layout with loose files: each loose file is its own module, exact result", async () => fixture(async (root, put) => {
  put("src/build/index.ts", "export const build = 1;\n");
  put("src/one.ts", 'import "./build/index.js";\n');
  put("src/two.ts", "export const two = 1;\n");
  const result = await recommend(root);
  expect(result).toEqual({
    modules: 3, candidates: 2,
    pairs: [
      { a: "build", b: "two.ts", filesA: 1, filesB: 1 },
      { a: "one.ts", b: "two.ts", filesA: 1, filesB: 1 },
    ],
    proposedClassify: [
      { glob: "src/build/**", tags: ["role:build"] },
      { glob: "src/one.ts", tags: ["role:one.ts"] },
      { glob: "src/two.ts", tags: ["role:two.ts"] },
    ],
    proposedAllowDeny: [
      { source: "role:build", targetNamespace: "role", deny: ["two.ts"], because },
      { source: "role:two.ts", targetNamespace: "role", deny: ["build"], because },
      { source: "role:one.ts", targetNamespace: "role", deny: ["two.ts"], because },
      { source: "role:two.ts", targetNamespace: "role", deny: ["one.ts"], because },
    ],
  });
}));

test("no config, a no-src layout: modules declare from the project root", async () => fixture(async (root, put) => {
  put("cli.ts", "export const cli = 1;\n");
  put("core/index.ts", "export const core = 1;\n");
  const result = await recommend(root);
  expect(result).toEqual({
    modules: 2, candidates: 1,
    pairs: [{ a: "cli.ts", b: "core", filesA: 1, filesB: 1 }],
    proposedClassify: [
      { glob: "cli.ts", tags: ["role:cli.ts"] },
      { glob: "core/**", tags: ["role:core"] },
    ],
    proposedAllowDeny: [
      { source: "role:cli.ts", targetNamespace: "role", deny: ["core"], because },
      { source: "role:core", targetNamespace: "role", deny: ["cli.ts"], because },
    ],
  });
}));

test("no config, a flat src/ holding only files: one module per file, none for the container", async () => fixture(async (root, put) => {
  put("src/one.ts", "export const one = 1;\n");
  put("src/two.ts", "export const two = 1;\n");
  const result = await recommend(root);
  expect(result).toEqual({
    modules: 2, candidates: 1,
    pairs: [{ a: "one.ts", b: "two.ts", filesA: 1, filesB: 1 }],
    proposedClassify: [
      { glob: "src/one.ts", tags: ["role:one.ts"] },
      { glob: "src/two.ts", tags: ["role:two.ts"] },
    ],
    proposedAllowDeny: [
      { source: "role:one.ts", targetNamespace: "role", deny: ["two.ts"], because },
      { source: "role:two.ts", targetNamespace: "role", deny: ["one.ts"], because },
    ],
  });
}));

test("custom glob proposals use the actual directory and zero candidates succeed", async () => fixture(async (root, put) => {
  put("packages/one/index.ts", "export const x = 1;");
  const output = cli(root, "packages/*", "--json");
  expect(output.status).toBe(0);
  expect(JSON.parse(output.stdout)).toEqual({ modules: 1, candidates: 0, pairs: [],
    proposedClassify: [{ glob: "packages/one/**", tags: ["role:one"] }], proposedAllowDeny: [] });
}));

test("CLI rejects invalid arguments and discovery errors with exit one", () => fixture((root) => {
  for (const args of [["--prove"], ["--apply"], ["--write"], ["src/*", "extra"], ["src/**"], ["missing/*"]]) {
    const result = cli(root, ...args, "--json");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error).toEqual(expect.any(String));
  }
}));

test("a bad directory argument's error and do: name recommend, not init", async () => fixture(async (root) => {
  let thrown: unknown;
  try {
    await recommend(root, "src/*x");
  } catch (error) {
    thrown = error;
  }
  expect((thrown as { message: string }).message).toBe("recommend takes a directory name, not the glob 'src/*x'");
  expect((thrown as { do: string }).do).toBe("archstrict recommend");
}));

test("an empty tree gives no .ts file to declare, same as init", () => fixture((root) => {
  // mkdirSync(root, "src") in fixture() leaves src/ present but empty, and
  // no other .ts file exists anywhere - the same zero-candidate case
  // init itself refuses, since recommend's no-config path now runs
  // init's own walk in memory.
  return expect(recommend(root)).rejects.toThrow(/found no \.ts file to declare as a module/);
}));

test("generated real import graphs partition all unordered pairs into connected or candidate pairs", async () => {
  await hegel.testAsync(tc => fixture(async (root, put) => {
    // Bound the matrix to keep repeated real compiler builds within the test budget.
    // n starts at 1: n = 0 leaves no .ts file anywhere, the zero-candidate
    // case covered by its own test above, not this property.
    const n = tc.draw(gen.integers({ minValue: 1, maxValue: 8 }));
    const connected = Array.from({ length: n }, () => tc.draw(gen.arrays(gen.booleans(), { minSize: n, maxSize: n })));
    for (let i = 0; i < n; i++) {
      put(`src/m${i}/index.ts`, connected[i]!.map((yes, j) => yes ? `import "../m${j}/index.js";` : "").join("\n"));
    }
    const result = await recommend(root);
    expect(result.modules).toBe(n);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      expect(result.pairs.some(pair => pair.a === `m${i}` && pair.b === `m${j}`)).toBe(!connected[i]![j] && !connected[j]![i]);
    }
    expect(result.candidates).toBe(result.pairs.length);
    expect(result.proposedAllowDeny).toHaveLength(result.candidates * 2);
    expect(new Set(result.proposedClassify.map(entry => entry.glob)).size).toBe(n);
  }), { testCases: 30 });
});

test("declared boundaries replace discovery and preserve their exact globs", async () => fixture(async (root, put) => {
  put("src/flat/index.ts", "export const flat = 1;");
  put("packages/foo/src/index.ts", "export const foo = 1;");
  put("packages/bar/src/index.ts", "export const bar = 1;");
  put("packages/foo/src/ignored.ts", 'import "../../bar/src/index.js";');
  const discovered = await recommend(root);
  // The new no-config walk declares a module per top-level entry, not
  // just per src/ child: src/flat and the top-level packages/ directory.
  // ignored.ts's own import stays inside the packages/ group either way.
  expect(discovered.modules).toBe(2);
  expect(discovered.pairs).toEqual([{ a: "flat", b: "packages", filesA: 1, filesB: 3 }]);
  put("archstrict.config.ts", `export default {
    declaredModules: [{ name: "foo", glob: "packages/foo/src/**" }, { name: "bar", glob: "packages/bar/src/**" }],
    exclude: ["**/ignored.ts"],
    because: "Keep independent packages separate."
  };`);
  const declared = await recommend(root);
  expect(declared).toEqual({
    modules: 2, candidates: 1,
    pairs: [{ a: "bar", b: "foo", filesA: 1, filesB: 1 }],
    proposedClassify: [
      { glob: "packages/bar/src/**", tags: ["role:bar"] },
      { glob: "packages/foo/src/**", tags: ["role:foo"] },
    ],
    proposedAllowDeny: [
      { source: "role:bar", targetNamespace: "role", deny: ["foo"], because },
      { source: "role:foo", targetNamespace: "role", deny: ["bar"], because },
    ],
  });
  expect(declared).not.toEqual(discovered);
  const output = cli(root, "--json");
  expect(output.status).toBe(0);
  expect(JSON.parse(output.stdout)).toEqual(declared);
  // A declared config determines scope even when the fallback glob cannot resolve.
  const ignoredGlob = cli(root, "missing/*", "--json");
  expect(ignoredGlob.status).toBe(0);
  expect(JSON.parse(ignoredGlob.stdout)).toEqual(declared);
  rmSync(join(root, "archstrict.config.ts"));
  expect(await recommend(root)).toEqual(discovered);
}));

test("CLI reports a config without declaredModules instead of using discovery", () => fixture((root, put) => {
  put("src/a/index.ts", "export const a = 1;");
  put("archstrict.config.ts", 'export default { because: "Keep modules independent." };');
  const output = cli(root, "--json");
  expect(output.status).toBe(1);
  expect(JSON.parse(output.stdout)).toEqual({
    error: `${join(realpathSync(root), "archstrict.config.ts")} is missing required field 'declaredModules'`,
    do: `add 'declaredModules' to the default export in ${join(realpathSync(root), "archstrict.config.ts")}, then run archstrict check`,
  });
}));
