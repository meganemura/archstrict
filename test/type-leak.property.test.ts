// Property: a structural leak is flagged exactly when an exported type
// alias's property references a declaration that (a) lives outside the
// surface file, (b) is not itself exported by name from it, and (c) is not
// an anonymous type literal — checked against which properties were drawn
// to reference an internal-only type, not just a leak count. Covers the
// definition's own three walk targets (a direct property, a union member,
// an index signature's value type) plus one level of nesting and a generic
// type reference's own type argument (Promise<T>), not just a bare
// property — the fixture-based example test already covers each shape
// once; this draws a random mix of all of them together.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkTypeLeaks } from "../src/rules/type-leak.js";

const PROPERTY_COUNT = 4;

// Each property is drawn to reference an internal-only type directly, or
// through one of the shapes the definition names as requiring a walk (a
// union member, an index signature's value type, one level of nesting) —
// each still a leak — or one of the two exempted shapes: the same
// internal type re-exported by name (not a leak - it has a name a
// consumer can use), or an anonymous inline literal (not a leak - nothing
// to hide a name for).
const PROPERTY_KINDS = [
  "internal-only",
  "internal-in-union",
  "internal-in-index",
  "internal-nested",
  "internal-in-type-argument",
  "re-exported",
  "re-exported-aliased",
  "anonymous",
] as const;
type PropertyKind = (typeof PROPERTY_KINDS)[number];

const propertyKinds = gs.arrays(gs.sampledFrom(PROPERTY_KINDS), {
  minSize: PROPERTY_COUNT,
  maxSize: PROPERTY_COUNT,
});

function writeProject(root: string, kinds: readonly PropertyKind[]): void {
  const dir = join(root, "src", "m");
  mkdirSync(dir, { recursive: true });

  const internalTypeDecls = kinds.map((_kind, i) => `export type Internal${i} = { id: string };`).join("\n");
  writeFileSync(join(dir, "internal.ts"), `${internalTypeDecls}\n`);

  const reExports = kinds
    .map((kind, i) => {
      if (kind === "re-exported") return `export type { Internal${i} } from "./internal.js";`;
      // A re-export under a generated alias, not the type's own declared
      // name - still gives the consumer a real, importable name for it
      // (e.g. `export { type X as Y }`).
      if (kind === "re-exported-aliased") return `export type { Internal${i} as Alias${i} } from "./internal.js";`;
      return undefined;
    })
    .filter((line) => line !== undefined);

  const properties = kinds.map((kind, i) => {
    if (kind === "anonymous") return `  prop${i}: { anon: string };`;
    if (kind === "internal-in-union") return `  prop${i}: Internal${i} | string;`;
    if (kind === "internal-in-index") return `  prop${i}: { [k: string]: Internal${i} };`;
    if (kind === "internal-nested") return `  prop${i}: { inner: Internal${i} };`;
    if (kind === "internal-in-type-argument") return `  prop${i}: Promise<Internal${i}>;`;
    return `  prop${i}: Internal${i};`;
  });

  writeFileSync(
    join(dir, "public.ts"),
    [
      `import type { ${kinds.map((_k, i) => `Internal${i}`).join(", ")} } from "./internal.js";`,
      ...reExports,
      "export type Shape = {",
      ...properties,
      "};",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "esnext",
          module: "nodenext",
          moduleResolution: "nodenext",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
      },
      null,
      2,
    ),
  );
}

describe("checkTypeLeaks (property)", () => {
  test("a leak is reported exactly for the properties drawn as internal-only", () => {
    hegel.test(
      (tc) => {
        const kinds = tc.draw(propertyKinds);

        const root = mkdtempSync(join(tmpdir(), "archstrict-type-leak-"));
        try {
          writeProject(root, kinds);
          const graph = buildModuleGraph({ projectRoot: root, modulesGlob: "src/*", surface: "public.ts" });
          assert.equal(graph.unresolvedSpecifierCount, 0);

          const violations = checkTypeLeaks(graph);

          const leaksThroughThisKind = new Set<PropertyKind>([
            "internal-only",
            "internal-in-union",
            "internal-in-index",
            "internal-nested",
            "internal-in-type-argument",
          ]);
          const expectedLeakedTypes = kinds
            .map((kind, i) => (leaksThroughThisKind.has(kind) ? `Internal${i}` : undefined))
            .filter((name): name is string => name !== undefined);

          const actualLeakedTypes = violations.map((v) => {
            // Evidence now leads with the internal type's own name (one
            // violation per (module, internal type), not per referencing
            // export) - each of this fixture's Internal0/Internal1/...
            // names is still distinct per property index, so no two
            // properties here ever collapse into the same violation.
            const match = /^'(\w+)'/.exec(v.evidence);
            if (match === null) throw new Error(`evidence has no internal type name: ${v.evidence}`);
            return match[1];
          });

          assert.deepEqual([...actualLeakedTypes].sort(), [...expectedLeakedTypes].sort());
          assert.ok(violations.every((v) => v.rule === "type-leak"));
          assert.ok(violations.every((v) => v.because.length > 0));
          assert.ok(violations.every((v) => v.todoModule === "m"));
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
      { testCases: 25 },
    );
  }, 20_000);
});

test("generated sibling surfaces expose their named types while private files still leak", () => {
  hegel.test(tc => {
    const suffix = tc.draw(gs.fromRegex("[a-z]{1,12}"));
    const publicType = `Public${suffix}`;
    const hiddenType = `Hidden${suffix}`;
    const first = `a${suffix}.public.ts`;
    const second = `b${suffix}.public.ts`;
    const surface = tc.draw(gs.booleans()) ? "*.public.ts" : [first, second];
    const root = mkdtempSync(join(tmpdir(), "archstrict-sibling-types-"));
    try {
      const dir = join(root, "src/m");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { noLib: true, types: [] } }));
      writeFileSync(join(dir, first), `export interface ${publicType} { value: string }`);
      writeFileSync(join(dir, "private.ts"), `export interface ${hiddenType} { secret: string }`);
      writeFileSync(join(dir, second), `import type { ${publicType} } from "./${first.replace(/\.ts$/, ".js")}";
import type { ${hiddenType} } from "./private.js";
export interface Wrapper { publicValue: ${publicType}; privateValue: ${hiddenType} }`);
      const graph = buildModuleGraph({ projectRoot: root, declaredModules: [{ name: "m", glob: "src/m/**", surface }] });
      assert.equal(graph.unresolvedSpecifierCount, 0);
      const violations = checkTypeLeaks(graph);
      assert.deepEqual(violations.map(violation => violation.leak?.internalType), [hiddenType]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, { testCases: 25 });
});
