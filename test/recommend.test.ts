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
  // proposedClassify stays complete in JSON (asserted above); the text
  // output never prints it - a project with many modules would turn one
  // line per module into a block on its own, dwarfing everything else.
  const text = formatRecommendText(result);
  expect(text).not.toContain("proposed classify");
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
    modules: 1, mapNotes: [], detected: 0, patternProposals: [], surfaceProposals: [],
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
  // Its own evidence array stays per-module and complete (JSON never
  // changes); only the formatted text collapses it to counts.
  const publicEntry = result.patternProposals.find(p => p.pattern === "public-entry-only");
  expect(publicEntry).toBeDefined();
  expect(publicEntry!.addedViolations).toBe(0);
  expect(publicEntry!.evidence).toHaveLength(result.surfaceProposals.length);
  expect(text).toContain("1 module(s) have no public surface today; naming the proposed surfaces below would retire 4 bypass(es), leaving 1");
  expect(text).toContain('see "proposed surfaces" below for the per-module detail');
  expect(text).not.toContain("'shared': [\"main.ts\"] covers");
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

test("app-over-library: an app area depending on the rest, with a small reverse, still ranks into the shown 5 among many trivial leaf kernels", async () => fixture(async (root, put) => {
  // The app area: 5 forward edges into a library area, and 2 reverse
  // edges back - a real, mostly-clean fit (support well under 1), not a
  // perfectly clean one.
  for (let i = 0; i < 5; i++) {
    put(`src/app/a${i}.ts`, `import "../lib/x${i}.ts";\nexport const a${i} = ${i};\n`);
    put(`src/lib/x${i}.ts`, `export const x${i} = ${i};\n`);
  }
  put("src/lib/back0.ts", 'import "../app/a0.ts";\nexport const back0 = 1;\n');
  put("src/lib/back1.ts", 'import "../app/a1.ts";\nexport const back1 = 1;\n');
  // Six unrelated, perfectly clean leaf kernels (support 1 each) competing for the same 5 slots.
  for (let i = 0; i < 6; i++) {
    put(`src/util${i}/index.ts`, `export const util${i} = ${i};\n`);
    put(`src/consumer${i}/index.ts`, `import "../util${i}/index.ts";\nexport const consumer${i} = ${i};\n`);
  }
  const result = await recommend(root);
  const proposal = result.patternProposals.find(p => p.pattern === "app-over-library");
  expect(proposal).toBeDefined();
  expect(proposal!.support).toBeCloseTo(5 / 7);
  expect(proposal!.evidence[0]).toBe("library -> app: 2 of 7 edges; app -> library: 5");
  expect(proposal!.configFragment).toContain('sequence: { "": ["lib","app"] }');
  // app-over-library's own classify is a catch-all "lib" glob plus the
  // one distinguished "app" glob, not one line per library module -
  // real config, since classify.ts's most-specific-glob-wins already
  // lets the app module's own longer glob override the catch-all.
  expect(proposal!.configFragment).toContain('{ glob: "**", tags:');
  expect((proposal!.configFragment.match(/glob:/g) ?? []).length).toBeLessThanOrEqual(2);
}));

test("text output stays within a bounded line budget on a 28-module project", async () => fixture(async (root, put) => {
  // 1 app module importing 17 library modules (2 of which import back,
  // the small reverse a real adoption has) and 10 surface-less service
  // modules - 28 declared modules in total, several times over the
  // 5-item text cap on every list this budget depends on.
  put("src/app/main.ts", [
    ...Array.from({ length: 17 }, (_, i) => `import "../lib${i}/index.ts";`),
    ...Array.from({ length: 10 }, (_, i) => `import "../svc${i}/entry.ts";`),
    "export const main = 1;",
  ].join("\n") + "\n");
  for (let i = 0; i < 17; i++) put(`src/lib${i}/index.ts`, `export const lib${i} = ${i};\n`);
  put("src/lib0/back.ts", 'import "../app/main.ts";\nexport const back = 1;\n');
  put("src/lib1/back.ts", 'import "../app/main.ts";\nexport const back = 1;\n');
  for (let i = 0; i < 10; i++) {
    put(`src/svc${i}/entry.ts`, `export const svc${i} = ${i};\n`);
    put(`src/svc${i}/internal.ts`, `export const internal${i} = ${i};\n`);
  }
  const result = await recommend(root);
  expect(result.modules).toBe(28);
  expect(result.patternProposals.length).toBeGreaterThan(0);
  expect(result.surfaceProposals.length).toBeGreaterThan(5); // more than the text cap, to exercise the "+N more" truncation
  const text = formatRecommendText(result);
  // Under 60 lines is the design budget for this project shape: 5 pattern
  // proposals plus a summarized public-entry-only line and a
  // once-per-section (not once-per-module) set of surface do: lines.
  const lines = text.split("\n");
  expect(lines.length).toBeLessThan(60);
  // The three generic surface choices print once for the whole section,
  // not once per shown module, even though 5 modules are shown.
  expect(lines.filter(l => l.includes("add a barrel file")).length).toBe(1);
  // Each shown module still gets its own module-specific declaredModules edit.
  expect(lines.filter(l => l.includes('set { name: "')).length).toBe(5);
  // No per-module public-entry-only evidence line survives into text.
  expect(text).not.toMatch(/^\s+'svc\d/m);
}));

test("a surface proposal's own candidate list caps at 3 in text, complete in json", async () => fixture(async (root, put) => {
  // 10 external modules import shared/one.ts (the densest candidate); one
  // more external module imports the other 3 files once each - 4 real
  // candidate files in total, over the 3-item text cap.
  for (let i = 0; i < 10; i++) put(`src/ext${i}/index.ts`, `import "../shared/one.ts";\nexport const e${i} = ${i};\n`);
  put("src/app/b.ts", 'import "../shared/two.ts";\nimport "../shared/three.ts";\nimport "../shared/four.ts";\nexport const b = 1;\n');
  put("src/shared/one.ts", "export const one = 1;\n");
  put("src/shared/two.ts", "export const two = 1;\n");
  put("src/shared/three.ts", "export const three = 1;\n");
  put("src/shared/four.ts", "export const four = 1;\n");
  const result = await recommend(root);
  const proposal = result.surfaceProposals.find(p => p.module === "shared")!;
  expect(proposal).toBeDefined();
  expect(proposal.candidates.length).toBeGreaterThan(3); // json keeps all 4 candidate files
  const text = formatRecommendText(result);
  expect(text).toContain("... 1 more candidate(s); see --json");
  const oneLine = text.split("\n").find(l => l.includes("one.ts ("));
  expect(oneLine).toBeDefined(); // the densest candidate survives the cap
}));

test("no app-over-library proposal when nothing in the tree names an app/cli area", async () => fixture(async (root, put) => {
  put("src/one/index.ts", 'import "../two/index.ts";\nexport const one = 1;\n');
  put("src/two/index.ts", "export const two = 1;\n");
  const result = await recommend(root);
  expect(result.patternProposals.find(p => p.pattern === "app-over-library")).toBeUndefined();
}));

test("external-package-confined: a node builtin imported from only one module is proposed", async () => fixture(async (root, put) => {
  put("src/core/a.ts", 'import "node:fs";\nexport const a = 1;\n');
  put("src/core/b.ts", 'import "node:fs";\nexport const b = 1;\n');
  // A second module importing a different builtin - real evidence the
  // proposed rule's own targetNamespace judges at least one real edge.
  put("src/other/c.ts", 'import "node:path";\nexport const c = 1;\n');
  const result = await recommend(root);
  const proposal = result.patternProposals.find(p => p.pattern === "external-package-confined");
  expect(proposal).toBeDefined();
  expect(proposal!.support).toBe(1);
  expect(proposal!.addedViolations).toBe(0);
  expect(proposal!.evidence[0]).toContain("'fs' is imported 2 time(s), all from 'core'");
  expect(proposal!.configFragment).toContain('deny: ["fs"]');
}));

test("no external-package-confined proposal when the same package is imported from more than one module", async () => fixture(async (root, put) => {
  put("src/core/a.ts", 'import "node:fs";\nexport const a = 1;\n');
  put("src/other/b.ts", 'import "node:fs";\nexport const b = 1;\n');
  const result = await recommend(root);
  expect(result.patternProposals.find(p => p.pattern === "external-package-confined")).toBeUndefined();
}));

test("test-code-isolation: a fixtures module that imports production code, and is never imported back, is proposed", async () => fixture(async (root, put) => {
  put("src/app/one.ts", "export const one = 1;\n");
  put("src/fixtures/index.ts", 'import "../app/one.ts";\nexport const f = 1;\n');
  put("archstrict.config.ts", `export default {
    declaredModules: [{ name: "app", glob: "src/app/**" }, { name: "fixtures", glob: "src/fixtures/**" }],
    because: "Keep production and fixtures independent."
  };`);
  const result = await recommend(root);
  const proposal = result.patternProposals.find(p => p.pattern === "test-code-isolation");
  expect(proposal).toBeDefined();
  expect(proposal!.support).toBe(1);
  expect(proposal!.addedViolations).toBe(0);
  expect(proposal!.evidence[0]).toContain("'fixtures' is never imported by any of 1 production module(s) today; it imports 1 of them");
}));

test("no test-code-isolation proposal once production code already imports the fixtures module", async () => fixture(async (root, put) => {
  put("src/app/one.ts", 'import "../fixtures/index.ts";\nexport const one = 1;\n');
  put("src/fixtures/index.ts", 'import "../app/one.ts";\nexport const f = 1;\n');
  put("archstrict.config.ts", `export default {
    declaredModules: [{ name: "app", glob: "src/app/**" }, { name: "fixtures", glob: "src/fixtures/**" }],
    because: "Keep production and fixtures independent."
  };`);
  const result = await recommend(root);
  expect(result.patternProposals.find(p => p.pattern === "test-code-isolation")).toBeUndefined();
}));

test("host-plugin-inversion: a plugin depending on a host that never depends back is proposed", async () => fixture(async (root, put) => {
  put("src/plugin/a.ts", 'import "../core/index.ts";\nexport const a = 1;\n');
  put("src/core/index.ts", "export const core = 1;\n");
  const result = await recommend(root);
  const proposal = result.patternProposals.find(p => p.pattern === "host-plugin-inversion");
  expect(proposal).toBeDefined();
  expect(proposal!.support).toBe(1);
  expect(proposal!.addedViolations).toBe(0);
  expect(proposal!.evidence[0]).toBe("plugin -> host: 1 edge(s); host -> plugin: 0 edge(s)");
}));

test("no host-plugin-inversion proposal when the plugin never depends on the host", async () => fixture(async (root, put) => {
  put("src/plugin/a.ts", "export const a = 1;\n");
  put("src/core/index.ts", "export const core = 1;\n");
  const result = await recommend(root);
  expect(result.patternProposals.find(p => p.pattern === "host-plugin-inversion")).toBeUndefined();
}));

// Declared modules must name each feature separately (freshRun's own
// no-config walk collapses a nested "src/features/**" into one module for
// the whole container, giving this detector only one candidate, never
// two siblings to compare).
const FEATURE_CONFIG = `export default {
  declaredModules: [
    { name: "orders", glob: "src/features/orders/**" },
    { name: "payments", glob: "src/features/payments/**" },
    { name: "shared", glob: "src/shared/**" },
  ],
  because: "Keep features independent of each other."
};`;

test("feature-isolation: sibling features importing a shared kernel but not each other are proposed", async () => fixture(async (root, put) => {
  put("src/features/orders/index.ts", 'import "../../shared/index.ts";\nexport const orders = 1;\n');
  put("src/features/payments/index.ts", 'import "../../shared/index.ts";\nexport const payments = 1;\n');
  put("src/shared/index.ts", "export const shared = 1;\n");
  put("archstrict.config.ts", FEATURE_CONFIG);
  const result = await recommend(root);
  const proposal = result.patternProposals.find(p => p.pattern === "feature-isolation");
  expect(proposal).toBeDefined();
  expect(proposal!.support).toBe(1);
  expect(proposal!.addedViolations).toBe(0);
  expect(proposal!.evidence[0]).toBe("features -> kernel ('shared'): 2 edge(s); features -> each other: 0 edge(s)");
}));

test("no feature-isolation proposal with only one feature module under the container", async () => fixture(async (root, put) => {
  put("src/features/orders/index.ts", 'import "../../shared/index.ts";\nexport const orders = 1;\n');
  put("src/shared/index.ts", "export const shared = 1;\n");
  put("archstrict.config.ts", `export default {
    declaredModules: [{ name: "orders", glob: "src/features/orders/**" }, { name: "shared", glob: "src/shared/**" }],
    because: "Keep features independent of each other."
  };`);
  const result = await recommend(root);
  expect(result.patternProposals.find(p => p.pattern === "feature-isolation")).toBeUndefined();
}));
