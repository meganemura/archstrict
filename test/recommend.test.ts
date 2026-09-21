// Responsibility: verify proposals against real filesystem imports and CLI output.
// Boundary: temporary projects only; generated expectations come from the input adjacency matrix.
import { test, expect } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { recommend, formatRecommendText } from "../src/verbs/recommend.js";

const cliPath = new URL("../dist/cli.js", import.meta.url).pathname;
function fixture(run: (root: string, put: (path: string, source: string) => void) => void) {
  const root = mkdtempSync(join(tmpdir(), "archstrict-recommend-"));
  const put = (path: string, source: string) => {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, source);
  };
  try {
    mkdirSync(join(root, "src"));
    put("tsconfig.json", JSON.stringify({ compilerOptions: { noLib: true, types: [], module: "commonjs", moduleResolution: "node" } }));
    run(root, put);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const because = "<author must state a real reason>";

test("exact pairs, file counts, deduplicated classification, and bidirectional deny proposals", () => fixture((root, put) => {
  put("src/a/index.ts", 'import "../b/index.js";');
  put("src/a/extra.ts", "export const extra = 1;");
  put("src/b/index.ts", "export const b = 1;");
  put("src/c/index.ts", "export const c = 1;");
  mkdirSync(join(root, "src/empty"));
  const result = recommend(root);
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

test("all 28 zero-cross pairs survive without caps or small-file pruning", () => fixture((root, put) => {
  for (let i = 0; i < 8; i++) put(`src/m${i}/index.ts`, "export const x = 1;");
  const result = recommend(root);
  expect(result.modules).toBe(8);
  expect(result.candidates).toBe(28);
  expect(new Set(result.pairs.map(pair => `${pair.a}/${pair.b}`)).size).toBe(28);
  expect(result.proposedClassify).toHaveLength(8);
  expect(result.proposedAllowDeny).toHaveLength(56);
}));

test("an import in either direction excludes the pair", () => fixture((root, put) => {
  put("src/a/index.ts", 'import "../b/index.js";');
  put("src/b/index.ts", "export const b = 1;");
  expect(recommend(root).pairs).toEqual([]);
  put("src/a/index.ts", "export const a = 1;");
  put("src/b/index.ts", 'import "../a/index.js";');
  expect(recommend(root).pairs).toEqual([]);
}));

function snapshot(root: string): unknown[] {
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry =>
    [entry.name, entry.isDirectory() ? snapshot(join(root, entry.name)) : readFileSync(join(root, entry.name)).toString("base64")]);
}
function cli(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [cliPath, "recommend", ...args], { cwd: root, encoding: "utf8" });
}

test("CLI JSON and text preserve every file and directory, including an existing config", () => fixture((root, put) => {
  put("src/a/index.ts", "export const a = 1;");
  put("src/b/index.ts", "export const b = 1;");
  put("archstrict.config.ts", "// Preserve this file.\nexport default {};\n");
  const before = snapshot(root);
  const json = cli(root, "--json");
  expect(json.status).toBe(0);
  expect(JSON.parse(json.stdout)).toEqual(recommend(root));
  const text = cli(root);
  expect(text.status).toBe(0);
  expect(text.stdout).toBe(formatRecommendText(recommend(root)));
  expect(snapshot(root)).toEqual(before);
}));

test("custom glob proposals use the actual directory and zero candidates succeed", () => fixture((root, put) => {
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

test("generated real import graphs partition all unordered pairs into connected or candidate pairs", () => {
  hegel.test(tc => fixture((root, put) => {
    // Bound the matrix to keep repeated real compiler builds within the test budget.
    const n = tc.draw(gen.integers({ minValue: 0, maxValue: 8 }));
    const connected = Array.from({ length: n }, () => tc.draw(gen.arrays(gen.booleans(), { minSize: n, maxSize: n })));
    for (let i = 0; i < n; i++) {
      put(`src/m${i}/index.ts`, connected[i]!.map((yes, j) => yes ? `import "../m${j}/index.js";` : "").join("\n"));
    }
    const result = recommend(root);
    expect(result.modules).toBe(n);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      expect(result.pairs.some(pair => pair.a === `m${i}` && pair.b === `m${j}`)).toBe(!connected[i]![j] && !connected[j]![i]);
    }
    expect(result.candidates).toBe(result.pairs.length);
    expect(result.proposedAllowDeny).toHaveLength(result.candidates * 2);
    expect(new Set(result.proposedClassify.map(entry => entry.glob)).size).toBe(n);
  }), { testCases: 30 });
});
