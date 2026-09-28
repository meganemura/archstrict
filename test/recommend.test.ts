// Responsibility: verify proposals against real filesystem imports and CLI output.
// Boundary: temporary projects only; generated expectations come from the input adjacency matrix.
import { test, expect } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { recommend, formatRecommendText, minimalCoveringPrefixLength } from "../src/verbs/recommend.js";

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

test("proposedClassify names every module, deduplicated, and empty directories are ignored", async () => fixture(async (root, put) => {
  put("src/a/index.ts", 'import "../b/index.js";');
  put("src/a/extra.ts", "export const extra = 1;");
  put("src/b/index.ts", "export const b = 1;");
  put("src/c/index.ts", "export const c = 1;");
  mkdirSync(join(root, "src/empty"));
  const result = await recommend(root);
  expect(result.modules).toBe(3);
  expect(result.proposedClassify).toEqual([
    { glob: "src/a/**", tags: ["role:a"] }, { glob: "src/b/**", tags: ["role:b"] }, { glob: "src/c/**", tags: ["role:c"] },
  ]);
  const text = formatRecommendText(result);
  expect(text).toContain('proposed classify:\n[\n  { glob: "src/a/**", tags: ["role:a"] },');
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
test("no config, a src/ layout with loose files: each loose file is its own module", async () => fixture(async (root, put) => {
  put("src/build/index.ts", "export const build = 1;\n");
  put("src/one.ts", 'import "./build/index.js";\n');
  put("src/two.ts", "export const two = 1;\n");
  const result = await recommend(root);
  expect(result.modules).toBe(3);
  expect(result.proposedClassify).toEqual([
    { glob: "src/build/**", tags: ["role:build"] },
    { glob: "src/one.ts", tags: ["role:one.ts"] },
    { glob: "src/two.ts", tags: ["role:two.ts"] },
  ]);
}));

test("no config, a no-src layout: modules declare from the project root", async () => fixture(async (root, put) => {
  put("cli.ts", "export const cli = 1;\n");
  put("core/index.ts", "export const core = 1;\n");
  const result = await recommend(root);
  expect(result.modules).toBe(2);
  expect(result.proposedClassify).toEqual([
    { glob: "cli.ts", tags: ["role:cli.ts"] },
    { glob: "core/**", tags: ["role:core"] },
  ]);
}));

test("no config, a flat src/ holding only files: one module per file, none for the container", async () => fixture(async (root, put) => {
  put("src/one.ts", "export const one = 1;\n");
  put("src/two.ts", "export const two = 1;\n");
  const result = await recommend(root);
  expect(result.modules).toBe(2);
  expect(result.proposedClassify).toEqual([
    { glob: "src/one.ts", tags: ["role:one.ts"] },
    { glob: "src/two.ts", tags: ["role:two.ts"] },
  ]);
}));

test("custom glob proposals use the actual directory and zero connectivity still succeeds", async () => fixture(async (root, put) => {
  put("packages/one/index.ts", "export const x = 1;");
  const output = cli(root, "packages/*", "--json");
  expect(output.status).toBe(0);
  expect(JSON.parse(output.stdout)).toEqual({
    modules: 1, detected: 0, patternProposals: [], surfaceProposals: [],
    proposedClassify: [{ glob: "packages/one/**", tags: ["role:one"] }],
  });
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
  put("archstrict.config.ts", `export default {
    declaredModules: [{ name: "foo", glob: "packages/foo/src/**" }, { name: "bar", glob: "packages/bar/src/**" }],
    exclude: ["**/ignored.ts"],
    because: "Keep independent packages separate."
  };`);
  const declared = await recommend(root);
  expect(declared.modules).toBe(2);
  expect(declared.proposedClassify).toEqual([
    { glob: "packages/bar/src/**", tags: ["role:bar"] },
    { glob: "packages/foo/src/**", tags: ["role:foo"] },
  ]);
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

test("proposes a ranked surface for a module with no public surface present, covering at least 80% of its real imports", async () => fixture(async (root, put) => {
  put("src/app/one.ts", 'import "../shared/main.ts";\nexport const one = 1;\n');
  put("src/app/two.ts", 'import "../shared/main.ts";\nexport const two = 1;\n');
  put("src/app/three.ts", 'import "../shared/main.ts";\nexport const three = 1;\n');
  put("src/app/four.ts", 'import "../shared/main.ts";\nexport const four = 1;\n');
  put("src/other/entry.ts", 'import "../shared/other.ts";\nexport const entry = 1;\n');
  put("src/shared/main.ts", "export const main = 1;\n");
  put("src/shared/other.ts", "export const other = 1;\n");
  put("src/shared/private.ts", "export const priv = 1;\n");
  const result = await recommend(root);
  expect(result.surfaceProposals).toHaveLength(1);
  const proposal = result.surfaceProposals[0]!;
  expect(proposal.module).toBe("shared");
  expect(proposal.candidates).toEqual([
    { file: "main.ts", importers: 4 },
    { file: "other.ts", importers: 1 },
  ]);
  expect(proposal.totalImports).toBe(5);
  expect(proposal.proposedSurface).toEqual(["main.ts"]);
  expect(proposal.coveredImports).toBe(4);
  expect(proposal.remainingImports).toBe(1);
  expect(proposal.choices).toHaveLength(3);
  const text = formatRecommendText(result);
  expect(text).toContain("proposed surfaces (no public surface file present today):");
  expect(text).toContain('shared: ["main.ts"] covers 4 of 5 bypasses, 1 remaining');
  // This module also has real evidence for the public-entry-only pattern.
  const publicEntry = result.patternProposals.find(p => p.pattern === "public-entry-only");
  expect(publicEntry).toBeDefined();
  expect(publicEntry!.addedViolations).toBe(0);
}));

test("no surface proposal for a module nothing outside it imports, or one that already has a surface", async () => fixture(async (root, put) => {
  put("src/app/index.ts", 'import "../shared/index.ts";\nexport const app = 1;\n');
  put("src/shared/index.ts", "export const shared = 1;\n");
  put("src/lonely/private.ts", "export const priv = 1;\n");
  const result = await recommend(root);
  expect(result.surfaceProposals).toEqual([]);
}));

test("minimalCoveringPrefixLength: the chosen prefix covers at least the threshold, and no smaller prefix does", async () => {
  await hegel.testAsync(tc => {
    const raw = tc.draw(gen.arrays(gen.integers({ minValue: 0, maxValue: 50 }), { minSize: 0, maxSize: 12 }));
    const counts = [...raw].sort((a, b) => b - a);
    const total = counts.reduce((sum, c) => sum + c, 0);
    const k = minimalCoveringPrefixLength(counts);
    const covered = counts.slice(0, k).reduce((sum, c) => sum + c, 0);
    if (total === 0) {
      assert.equal(k, 0);
      return;
    }
    assert.ok(covered * 5 >= total * 4, `prefix of ${k} covers ${covered} of ${total}, below 80%`);
    if (k > 0) {
      const shortCovered = counts.slice(0, k - 1).reduce((sum, c) => sum + c, 0);
      assert.ok(shortCovered * 5 < total * 4, `a prefix of only ${k - 1} already reaches 80% of ${total}`);
    }
  }, { testCases: 200 });
});

test("layered-order: a clean three-module chain is detected with full support and zero added violations", async () => fixture(async (root, put) => {
  put("src/core/index.ts", "export const core = 1;\n");
  put("src/mid/index.ts", 'import "../core/index.ts";\nexport const mid = 1;\n');
  put("src/top/index.ts", 'import "../mid/index.ts";\nexport const top = 1;\n');
  const result = await recommend(root);
  const proposal = result.patternProposals.find(p => p.pattern === "layered-order");
  expect(proposal).toBeDefined();
  expect(proposal!.support).toBe(1);
  expect(proposal!.addedViolations).toBe(0);
  expect(proposal!.evidence.join(" ")).toContain("core -> mid -> top");
  expect(proposal!.configFragment).toContain('sequence: { "": ["core","mid","top"] }');
}));

test("layered-order: a reverse edge lowers support below 1 and the proposed order still reports it as an added violation", async () => fixture(async (root, put) => {
  put("src/core/index.ts", "export const core = 1;\n");
  put("src/mid/a.ts", 'import "../core/index.ts";\nexport const a = 1;\n');
  put("src/mid/b.ts", 'import "../core/index.ts";\nexport const b = 1;\n');
  put("src/mid/c.ts", 'import "../core/index.ts";\nexport const c = 1;\n');
  // One reverse edge: core importing mid, against the otherwise-unanimous direction above.
  put("src/core/back.ts", 'import "../mid/a.ts";\nexport const back = 1;\n');
  const result = await recommend(root);
  const proposal = result.patternProposals.find(p => p.pattern === "layered-order");
  expect(proposal).toBeDefined();
  expect(proposal!.support).toBeCloseTo(3 / 4);
  expect(proposal!.addedViolations).toBeGreaterThan(0);
}));

test("leaf-kernel: a module with real importers and no outgoing edges of its own is proposed", async () => fixture(async (root, put) => {
  put("src/util/index.ts", "export const util = 1;\n");
  put("src/app/one.ts", 'import "../util/index.ts";\nexport const one = 1;\n');
  put("src/app/two.ts", 'import "../util/index.ts";\nexport const two = 1;\n');
  const result = await recommend(root);
  const proposal = result.patternProposals.find(p => p.pattern === "leaf-kernel");
  expect(proposal).toBeDefined();
  expect(proposal!.support).toBe(1);
  expect(proposal!.addedViolations).toBe(0);
  expect(proposal!.evidence[0]).toContain("'util': 0 outgoing edges");
}));

test("no pattern is proposed for modules with no cross-module edges at all", async () => fixture(async (root, put) => {
  put("src/a/index.ts", "export const a = 1;\n");
  put("src/b/index.ts", "export const b = 1;\n");
  const result = await recommend(root);
  expect(result.detected).toBe(0);
  expect(result.patternProposals).toEqual([]);
  const text = formatRecommendText(result);
  expect(text).not.toContain("pattern proposals");
}));

test("at most 5 pattern proposals are shown, ranked by support, even when more are detected", async () => fixture(async (root, put) => {
  // Six independent leaf kernels, each with full support (1): more than the cap.
  for (let i = 0; i < 6; i++) {
    put(`src/util${i}/index.ts`, `export const util${i} = ${i};\n`);
    put(`src/app${i}/index.ts`, `import "../util${i}/index.ts";\nexport const app${i} = ${i};\n`);
  }
  const result = await recommend(root);
  expect(result.detected).toBeGreaterThan(5);
  expect(result.patternProposals).toHaveLength(5);
}));
