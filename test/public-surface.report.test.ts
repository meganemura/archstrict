// Responsibility: the public-surface bypass result as a list - the order its
// violations come out in, and what a call focused on one file keeps.
// Boundary: which edges count as a bypass, and the text each violation
// carries, belong to public-surface.test.ts and the property test.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildModuleGraph, type ModuleGraph } from "../src/module-graph.js";
import { checkPublicSurfaceBypass } from "../src/rules/public-surface.js";

const bypassFilesWithConflictingPositionOrder: Record<string, string> = {
  "src/a/index.ts": "export const pub = 1;\n",
  "src/a/internal.ts": "export const secret = 1;\nexport const other = 2;\n",
  "src/c/deep.ts": "export const deepValue = 1;\n",
  "src/b/sub/y.ts":
    "export const unrelated = 1;\n" +
    'import { deepValue as aliasForTheDeepValue } from "../../c/deep.ts";\n',
  "src/b/x.ts":
    'import { secret } from "../a/internal.ts"; import { deepValue } from "../c/deep.ts";\n' +
    'import { pub } from "../a/index.ts";\n' +
    'import { other } from "../a/internal.ts";\n',
  "src/c/z.ts": 'import { secret } from "../a/internal.ts";\n',
};

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

function positionKey(v: { path: string; line: number; column: number }): string {
  return `${v.path}\0${String(v.line).padStart(6, "0")}\0${String(v.column).padStart(6, "0")}`;
}

describe("checkPublicSurfaceBypass result list", () => {
  let root: string;
  let graph: ModuleGraph;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-public-surface-report-")));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "esnext", module: "nodenext", moduleResolution: "nodenext", strict: true, skipLibCheck: true, noEmit: true },
    }));
    for (const [file, text] of Object.entries(bypassFilesWithConflictingPositionOrder)) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    graph = buildModuleGraph({
      projectRoot: root,
      declaredModules: ["a", "b", "c"].map((name) => ({ name, glob: `src/${name}/**` })),
    });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("violations come out by importing file in code-unit order, then line, then column, whatever order the graph lists its edges in", () => {

    expect(graph.unresolvedSpecifierCount).toBe(0);
    expect(graph.crossModuleEdges).toHaveLength(6);
    const original = graph.crossModuleEdges;
    try {
      const expected = [...checkPublicSurfaceBypass(graph)].sort((a, b) =>
        positionKey(a) < positionKey(b) ? -1 : positionKey(a) > positionKey(b) ? 1 : 0);
      expect(expected.map((v) => graph.relativePath(v.path))).toEqual([
        "src/b/sub/y.ts", "src/b/x.ts", "src/b/x.ts", "src/b/x.ts", "src/c/z.ts",
      ]);
      for (const order of permutations(original)) {
        graph.crossModuleEdges = order;
        assert.deepEqual(checkPublicSurfaceBypass(graph), expected);
      }
    } finally {
      graph.crossModuleEdges = original;
    }
  });

  test("a call focused on one file returns exactly the unscoped violations reported at that file", () => {

    const unscoped = checkPublicSurfaceBypass(graph);
    const analyzedFiles = [...graph.modules.values()].flatMap((m) => m.files);
    expect(analyzedFiles).toHaveLength(Object.keys(bypassFilesWithConflictingPositionOrder).length);
    expect(new Set(unscoped.map((v) => v.path)).size).toBe(3);
    for (const file of analyzedFiles) {
      assert.deepEqual(checkPublicSurfaceBypass(graph, file), unscoped.filter((v) => v.path === file), file);
    }
    expect(checkPublicSurfaceBypass(graph, join(root, "src/c/z.ts"))).toHaveLength(1);
    expect(checkPublicSurfaceBypass(graph, join(root, "src/a/index.ts"))).toEqual([]);
  });
});
