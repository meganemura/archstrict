// Responsibility: generated small projects (a re-export chain of varying
// length and alias use, wrapped one of several ways: an annotated
// structural property, an unannotated inferred one, a namespace import,
// `export * as ns`, or given a public name outright, the one no-leak
// case) - the closure's own findings must equal a whole-project
// Program's, on every generated shape, not just the fixed cases
// test/type-leak-closure.test.ts covers.
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

test("closure findings equal a whole-project Program's, over generated re-export chains and inference shapes", async () => {
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
      writeFileSync(join(root, "src/m/secret.ts"), "export interface Secret { value: number }\n");

      const chainLength = tc.draw(gen.integers({ minValue: 0, maxValue: 3 }));
      const useAlias = tc.draw(gen.booleans());
      const useStar = tc.draw(gen.booleans());
      const wrapMode = tc.draw(gen.sampledFrom(["structural", "inference", "namespaceImport", "exportStarAs"] as const));
      // The one no-leak case: Secret given a public name directly from
      // the surface, alongside whichever wrapper mode also reaches it -
      // rule 6 must not flag it twice for having two paths to the same
      // already-named declaration.
      const givePublicName = tc.draw(gen.booleans());

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

      const declaredModules: DeclaredModule[] = [{ name: "m", glob: "src/m/**" }];
      const graph = buildModuleGraph({ projectRoot: root, declaredModules });
      assert.equal(graph.unresolvedSpecifierCount, 0);
      const closure = keysOf(checkTypeLeaks(graph));

      const prepared = prepareGraph({ projectRoot: root, declaredModules });
      const program = ts.createProgram({ rootNames: prepared.rootNames, options: prepared.compilerOptions });
      const whole = keysOf(checkTypeLeaks({ modules: graph.modules, program, checker: program.getTypeChecker(), rootDir: graph.rootDir }));

      assert.deepEqual(closure, whole);
      // Given a public name, Secret must never leak regardless of which
      // wrapper mode also reaches it; otherwise a real leak must be
      // present - either way, an empty match on both sides for the wrong
      // reason is what this checks apart.
      if (givePublicName) assert.equal(closure.length, 0, "expected no leak once Secret has a public name");
      else assert.ok(closure.length >= 1, "expected at least one leak in every generated case");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, { testCases: 30 });
}, 30_000);
