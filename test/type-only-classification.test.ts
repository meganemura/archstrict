// A named import/export clause can be type-only two ways: the whole
// declaration (`import type { X } from "..."`) or per specifier
// (`import { type X } from "..."`, the modifier on one named binding).
// module-graph.ts used to check only the first form - found via a real
// config-authoring experiment against a real codebase, then reproduced
// here with a minimal, from-scratch fixture: a per-specifier-only
// type import produced a false-positive cycle, since the edge it created
// was wrongly marked isTypeOnly: false.
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkCycles } from "../src/rules/cycles.js";

function writeFixture(root: string, aImport: string): void {
  mkdirSync(join(root, "src", "a"), { recursive: true });
  mkdirSync(join(root, "src", "b"), { recursive: true });
  writeFileSync(
    join(root, "src", "a", "module.ts"),
    `${aImport}\nexport function aFn(): number { return 1; }\n`,
  );
  writeFileSync(
    join(root, "src", "b", "module.ts"),
    'import { aFn } from "../a/module.js";\nexport type BThing = { n: number };\nexport const bval = aFn();\n',
  );
}

function buildAndCheck(root: string) {
  const graph = buildModuleGraph({
    projectRoot: root,
    declaredModules: [
      { name: "a", glob: "src/a/**", surface: "index.ts" },
      { name: "b", glob: "src/b/**", surface: "index.ts" },
    ],
  });
  const aToB = graph.edges.find((e) => e.fromFile.endsWith("src/a/module.ts"));
  return { graph, aToBIsTypeOnly: aToB?.isTypeOnly, cycles: checkCycles(graph, { configPath: "<test>" }) };
}

describe("type-only classification (module-graph.ts)", () => {
  test("a per-specifier type-only import (import { type X }) is now recognized, excluding a false-positive cycle", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-type-only-"));
    try {
      writeFixture(root, 'import { type BThing } from "../b/module.js";\nexport type AUsesB = BThing;');
      const { aToBIsTypeOnly, cycles } = buildAndCheck(root);
      expect(aToBIsTypeOnly).toBe(true);
      expect(cycles).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a MIXED import (import { real, type BThing }) is still isTypeOnly: false - a real value reference exists in the same declaration", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-type-only-"));
    try {
      mkdirSync(join(root, "src", "b"), { recursive: true });
      writeFileSync(
        join(root, "src", "b", "module.ts"),
        'import { aFn } from "../a/module.js";\nexport type BThing = { n: number };\nexport const bval = aFn();\nexport const bReal = 1;\n',
      );
      mkdirSync(join(root, "src", "a"), { recursive: true });
      writeFileSync(
        join(root, "src", "a", "module.ts"),
        'import { bReal, type BThing } from "../b/module.js";\nexport function aFn(): number { return bReal; }\nexport type AUsesB = BThing;\n',
      );
      const { aToBIsTypeOnly, cycles } = buildAndCheck(root);
      expect(aToBIsTypeOnly).toBe(false);
      expect(cycles).toHaveLength(1); // now a genuine cycle: both directions are real value edges
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the existing whole-declaration import type {...} form is unaffected", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-type-only-"));
    try {
      writeFixture(root, 'import type { BThing } from "../b/module.js";\nexport type AUsesB = BThing;');
      const { aToBIsTypeOnly, cycles } = buildAndCheck(root);
      expect(aToBIsTypeOnly).toBe(true);
      expect(cycles).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a per-specifier type-only export (export { type X } from ...) is recognized, matching export type {...} from's own existing behavior", () => {
    const root = mkdtempSync(join(tmpdir(), "archstrict-type-only-"));
    try {
      mkdirSync(join(root, "src", "a"), { recursive: true });
      mkdirSync(join(root, "src", "b"), { recursive: true });
      writeFileSync(join(root, "src", "a", "module.ts"), "export type AThing = { n: number };\n");
      writeFileSync(join(root, "src", "b", "module.ts"), 'export { type AThing } from "../a/module.js";\n');

      const graph = buildModuleGraph({
        projectRoot: root,
        declaredModules: [
          { name: "a", glob: "src/a/**", surface: "index.ts" },
          { name: "b", glob: "src/b/**", surface: "index.ts" },
        ],
      });
      const bToA = graph.edges.find((e) => e.fromFile.endsWith("src/b/module.ts"));
      expect(bToA?.isTypeOnly).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
