// Responsibility: generated small projects vary the leak path, declaration
// kind and position, and every cross-module naming shape. Focused findings
// must equal a whole-project Program's findings on every generated shape.
// Boundary: same oracle convention as that file - a whole-project
// ts.Program built here only, never in src/.
import { test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import ts from "typescript";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModuleGraph, prepareGraph, type DeclaredModule } from "../src/module-graph.js";
import { checkTypeLeaks, type Violation } from "../src/rules/type-leak.js";

function keysOf(violations: readonly Violation[]): string[] {
  return violations.map((v) => `${v.path}:${v.line}:${v.column} ${v.evidence}`).sort();
}

const namingShapes = ["named", "alias", "star", "starChain", "starAs", "namespaceImport", "default", "defaultAs"] as const;
const declarationKinds = ["interface", "jsdocInterface", "typeAlias", "classInterface", "defaultInterface", "namespaceInterface"] as const;

function secretSource(kind: typeof declarationKinds[number], first: boolean): string {
  const prefix = first ? "" : "export interface Earlier { value: number }\n";
  switch (kind) {
    case "interface":
      return prefix + "export interface Secret { value: number }\nexport type { Secret as default };\n";
    case "jsdocInterface":
      return prefix + "/** A documented declaration. */\nexport interface Secret { value: number }\nexport type { Secret as default };\n";
    case "typeAlias":
      return prefix + "export type Secret = { value: number };\nexport type { Secret as default };\n";
    case "classInterface":
      return prefix + "export interface Secret { value: number }\nexport class Secret { value = 1 }\nexport default Secret;\n";
    case "defaultInterface":
      return prefix + "export default interface Secret { value: number }\nexport type { Secret };\n";
    case "namespaceInterface":
      return prefix + "export namespace Secret { export const value = 1 }\nexport interface Secret { value: number }\nexport default Secret;\n";
  }
}

function otherSurface(shape: typeof namingShapes[number]): { index: string; mid?: string } {
  switch (shape) {
    case "named": return { index: 'export type { Secret } from "../m/secret.js";\n' };
    case "alias": return { index: 'export type { Secret as Public } from "../m/secret.js";\n' };
    case "star": return { index: 'export * from "../m/secret.js";\n' };
    case "starChain": return { index: 'export * from "./mid.js";\n', mid: 'export * from "../m/secret.js";\n' };
    case "starAs": return { index: 'export * as ns from "../m/secret.js";\n' };
    case "namespaceImport": return { index: 'import * as NS from "../m/secret.js";\nexport { NS };\n' };
    case "default": return { index: 'export type { default } from "../m/secret.js";\n' };
    case "defaultAs": return { index: 'export type { default as Public } from "../m/secret.js";\n' };
  }
}

test("focused findings equal a whole-project Program's, over generated re-export chains and inference shapes", async () => {
  // Real filesystem, real compiler, one full graph build per case (like
  // test/init.property.test.ts's own P8) - small trees and a bounded case
  // count keep this well under the timeout on a loaded machine.
  await hegel.testAsync(async (tc) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-closure-property-")));
    try {
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "esnext", module: "nodenext", moduleResolution: "nodenext", strict: true, skipLibCheck: true, noEmit: true },
      }));
      mkdirSync(join(root, "src/m"), { recursive: true });
      const declarationKind = tc.draw(gen.sampledFrom(declarationKinds));
      const leakedDeclarationIsFirst = tc.draw(gen.booleans());
      writeFileSync(join(root, "src/m/secret.ts"), secretSource(declarationKind, leakedDeclarationIsFirst));

      const chainLength = tc.draw(gen.integers({ minValue: 0, maxValue: 3 }));
      const useAlias = tc.draw(gen.booleans());
      const useStar = tc.draw(gen.booleans());
      const wrapMode = tc.draw(gen.sampledFrom(["structural", "inference", "namespaceImport", "exportStarAs"] as const));
      // The one no-leak case: Secret given a public name directly from
      // the surface, alongside whichever wrapper mode also reaches it -
      // rule 6 must not flag it twice for having two paths to the same
      // already-named declaration.
      const givePublicName = tc.draw(gen.booleans());
      // An ambient root (R6, type-closure.ts's own reachAmbientRoot) that
      // reaches one real target through its own `declare global` block,
      // alongside an unrelated exported declaration this file also
      // holds, which reaches a separate, heavy import chain nothing else
      // in the project needs. "Findings equal a whole-project Program"
      // alone would pass even if reachAmbientRoot pulled the whole file
      // in (a whole-project Program has every file anyway) - this case
      // checks the closure's own file set directly, below.
      const includeAmbientRoot = tc.draw(gen.booleans());
      const namedByOtherModule = tc.draw(gen.sampledFrom(namingShapes));
      const moduleAugmentation = tc.draw(gen.sampledFrom([
        "none", "focused", "otherVisited", "unrelated", "unresolved",
      ] as const));
      // Location and member type vary independently. Coupling them is refused
      // because the safety decision cannot depend on whether this payload leaks.
      const nonAnalyzedAugmentation = tc.draw(gen.sampledFrom(["none", "declaration", "excluded"] as const));
      const augmentationUsesInternalType = tc.draw(gen.booleans());
      if (includeAmbientRoot) {
        writeFileSync(join(root, "src/m/ambient-used.ts"), "export const used = 1;\n");
        writeFileSync(join(root, "src/m/ambient-heavy.ts"), "export const heavy = 1;\n");
        writeFileSync(
          join(root, "src/m/ambient.ts"),
          'export {};\n' +
            'import { used } from "./ambient-used.js";\n' +
            'import { heavy } from "./ambient-heavy.js";\n' +
            "declare global {\n  interface GlobalUses { value: typeof used }\n}\n" +
            "export const unrelatedExport = heavy;\n",
        );
      }

      let specifier = "./secret.js";
      let name = "Secret";
      for (let hop = 0; hop < chainLength; hop++) {
        // `export * from` propagates every name it re-exports unchanged -
        // it cannot rename one, unlike a named re-export. Only a named
        // hop ever changes `name`.
        const isStarHop = useStar && hop === chainLength - 1;
        const nextName = isStarHop ? name : (useAlias ? `Hop${hop}` : name);
        const line = isStarHop
          ? `export * from "${specifier}";\n`
          : `export { ${name}${useAlias ? ` as ${nextName}` : ""} } from "${specifier}";\n`;
        writeFileSync(join(root, `src/m/hop${hop}.ts`), line);
        specifier = `./hop${hop}.js`;
        name = nextName;
      }

      let surface: string;
      switch (wrapMode) {
        case "inference":
          surface = `import { ${name} } from "${specifier}";\nexport function wrap() {\n  return { value: 1 } as ${name};\n}\n`;
          break;
        case "namespaceImport":
          surface = `import * as NS from "${specifier}";\nexport type Wrapper = { value: NS.${name} };\n`;
          break;
        case "exportStarAs":
          writeFileSync(join(root, "src/m/ns.ts"), `export * as NS from "${specifier}";\n`);
          surface = `import { NS } from "./ns.js";\nexport type Wrapper = { value: NS.${name} };\n`;
          break;
        default:
          surface = `import { ${name} } from "${specifier}";\nexport interface Wrapper { value: ${name} }\n`;
      }
      if (givePublicName) surface += `export { ${name} } from "${specifier}";\n`;
      writeFileSync(join(root, "src/m/index.ts"), surface);

      mkdirSync(join(root, "src/other"), { recursive: true });
      const other = otherSurface(namedByOtherModule);
      const nonAnalyzedReference = nonAnalyzedAugmentation === "declaration"
        ? '/// <reference path="./non-analyzed-augment.d.ts" />\n'
        : nonAnalyzedAugmentation === "excluded"
          ? 'import "./non-analyzed-augment.js";\n'
          : "";
      writeFileSync(join(root, "src/other/index.ts"), nonAnalyzedReference + other.index);
      if (other.mid !== undefined) writeFileSync(join(root, "src/other/mid.ts"), other.mid);
      if (moduleAugmentation === "unrelated") {
        writeFileSync(join(root, "src/other/unrelated.ts"), "export interface Unrelated { value: number }\n");
      }
      if (moduleAugmentation !== "none") {
        // The draw separates augmentation reachability from project membership.
        // A binary analyzed/external split is refused because it misses this guard.
        const target = moduleAugmentation === "focused"
          ? "../m/index.js"
          : moduleAugmentation === "otherVisited"
            ? "../m/secret.js"
            : moduleAugmentation === "unrelated"
              ? "./unrelated.js"
              : "missing-external-package";
        writeFileSync(join(root, "src/other/augment.ts"), `export {};\ndeclare module "${target}" { interface Added { value: number } }\n`);
      }
      if (nonAnalyzedAugmentation !== "none") {
        const extension = nonAnalyzedAugmentation === "declaration" ? ".d.ts" : ".ts";
        const memberType = augmentationUsesInternalType ? "AugmentationHidden" : "string";
        if (augmentationUsesInternalType) {
          writeFileSync(join(root, "src/m/augmentation-hidden.ts"), "export interface AugmentationHidden { value: number }\n");
        }
        writeFileSync(join(root, `src/other/non-analyzed-augment${extension}`), [
          ...(augmentationUsesInternalType ? ['import type { AugmentationHidden } from "../m/augmentation-hidden.js";'] : ["export {};"]),
          `declare module "../m/index.js" { interface Augmented { augmentation: ${memberType} } }`,
        ].join("\n") + "\n");
        writeFileSync(join(root, "src/m/index.ts"), surface + "export interface Augmented {}\n");
      }

      const declaredModules: DeclaredModule[] = [
        { name: "m", glob: "src/m/**" },
        { name: "other", glob: "src/other/**" },
      ];
      const exclude = nonAnalyzedAugmentation === "excluded" ? ["src/other/non-analyzed-augment.ts"] : [];
      const graph = buildModuleGraph({ projectRoot: root, declaredModules, exclude });
      assert.equal(graph.unresolvedSpecifierCount, 0);
      const closure = keysOf(graph.typeLeaksForFocus("m"));

      const prepared = prepareGraph({ projectRoot: root, declaredModules, exclude });
      const program = ts.createProgram({ rootNames: prepared.rootNames, options: prepared.compilerOptions });
      const whole = keysOf(checkTypeLeaks({ modules: graph.modules, program, checker: program.getTypeChecker(), rootDir: graph.rootDir })
        .filter((violation) => violation.todoModule === "m"));

      assert.deepEqual(closure, whole);
      // Given a public name, Secret must never leak regardless of which
      // wrapper mode also reaches it; otherwise a real leak must be
      // present - either way, an empty match on both sides for the wrong
      // reason is what this checks apart.
      const namespaceOnly = namedByOtherModule === "starAs" || namedByOtherModule === "namespaceImport";
      if (nonAnalyzedAugmentation !== "none" && augmentationUsesInternalType) {
        assert.ok(closure.some((finding) => finding.includes("AugmentationHidden")), "the augmentation's internal member type must leak");
      } else if (givePublicName || !namespaceOnly) assert.equal(closure.length, 0, "expected no leak once Secret has a public name");
      else assert.ok(closure.length >= 1, "a namespace name must not name its first declaration");

      if (nonAnalyzedAugmentation !== "none" || moduleAugmentation === "otherVisited") {
        assert.ok(graph.focusedTypeLeakNotes.some((note) => note.includes("module augmentation") && note.includes("fell back")));
      } else if (moduleAugmentation !== "none") {
        assert.ok(!graph.focusedTypeLeakNotes.some((note) => note.includes("module augmentation")));
      }

      if (includeAmbientRoot) {
        const rootFiles = graph.program.getRootFileNames();
        assert.ok(rootFiles.some((f) => f.endsWith("ambient-used.ts")), "the declare global block's own referenced target must be in the closure");
        assert.ok(!rootFiles.some((f) => f.endsWith("ambient-heavy.ts")), "an unrelated export's own heavy import chain must stay out of the closure");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, { testCases: 30 });
}, 90_000);
