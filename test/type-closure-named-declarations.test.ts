// Responsibility: computeSyntacticNamedDeclarations (type-closure.ts) must
// give each candidate declaration the same named answer as a real checker
// walking `checker.getExportsOfModule` and following every alias
// - the one correctness bar rule 6's own scoped mode (check.ts's focus,
// module-graph.ts's own ensureProgram) depends on: a name the checker
// would find but the syntactic walk misses reads an already-named
// declaration as unnamed the next time it's checked, a false leak.
// Boundary: the checker-side oracle lives only in this test file. Set
// equality is refused because a SourceFile and the first declaration can
// hide a collision. Each declaration receives its own boolean comparison.
import { describe, expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import ts from "typescript";
import { buildModuleGraph, prepareGraph, scriptKindForFile, type DeclaredModule, type ModuleGraph } from "../src/module-graph.js";
import { computeSyntacticNamedDeclarations, declarationKey, sourceFileKey, type TypeClosureInputs } from "../src/type-closure.js";

function namedDeclarationsFromChecker(program: ts.Program, checker: ts.TypeChecker, surfaceFiles: readonly string[]): Set<ts.Node> {
  const declarations = new Set<ts.Node>();
  for (const path of surfaceFiles) {
    const sf = program.getSourceFile(path);
    if (sf === undefined) continue;
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    if (moduleSymbol === undefined) continue;
    for (const exp of checker.getExportsOfModule(moduleSymbol)) {
      let current = exp;
      while (current.flags & ts.SymbolFlags.Alias) {
        const next = checker.getAliasedSymbol(current);
        if (next === current) break;
        current = next;
      }
      for (const decl of current.getDeclarations() ?? []) declarations.add(decl);
    }
  }
  return declarations;
}

function keyOfNode(node: ts.Node): string {
  if (ts.isSourceFile(node)) return sourceFileKey(node.fileName);
  const sf = node.getSourceFile();
  const start = node.getStart(sf);
  const { line, character } = sf.getLineAndCharacterOfPosition(start);
  return declarationKey(sf.fileName, line + 1, character + 1);
}

function candidateDeclarations(program: ts.Program): ts.Node[] {
  const candidates: ts.Node[] = [];
  for (const sf of program.getSourceFiles()) {
    if (!program.getRootFileNames().includes(sf.fileName)) continue;
    for (const statement of sf.statements) {
      if (ts.isVariableStatement(statement)) candidates.push(...statement.declarationList.declarations);
      else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ||
          ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement) ||
          ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement) ||
          ts.isImportEqualsDeclaration(statement) || ts.isExportAssignment(statement)) candidates.push(statement);
    }
  }
  return candidates;
}

// Builds the same TypeClosureInputs shape module-graph.ts's own
// ensureProgram builds for buildTypeClosure - resolvedSpecifiers comes
// straight from the graph's own already-resolved edges, never re-resolved.
function inputsFor(graph: ModuleGraph, root: string, modules: readonly DeclaredModule[]): TypeClosureInputs {
  const prepared = prepareGraph({ projectRoot: root, declaredModules: modules });
  const resolvedSpecifiers = new Map<string, Map<string, string>>();
  for (const edge of graph.edges) {
    let perFile = resolvedSpecifiers.get(edge.fromFile);
    if (perFile === undefined) { perFile = new Map(); resolvedSpecifiers.set(edge.fromFile, perFile); }
    perFile.set(edge.specifier, edge.resolvedFile);
  }
  return {
    readFile: (f) => ts.sys.readFile(f),
    languageVersion: prepared.compilerOptions.target ?? ts.ScriptTarget.ESNext,
    scriptKindFor: scriptKindForFile,
    ambientFiles: [],
    surfaceFiles: [],
    resolvedSpecifiers,
    analyzedFiles: new Set(prepared.rootNames),
  };
}

function expectNamedAnswersEqual(
  root: string,
  modules: readonly DeclaredModule[],
  surfaceFiles: readonly string[],
  syntacticKeys: ReadonlySet<string>,
): void {
  const prepared = prepareGraph({ projectRoot: root, declaredModules: modules });
  const program = ts.createProgram({ rootNames: prepared.rootNames, options: prepared.compilerOptions });
  const checkerNamed = namedDeclarationsFromChecker(program, program.getTypeChecker(), surfaceFiles);
  for (const declaration of candidateDeclarations(program)) {
    expect(syntacticKeys.has(keyOfNode(declaration)), keyOfNode(declaration))
      .toBe(checkerNamed.has(declaration));
  }
}

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/type-leak-closure");

describe("computeSyntacticNamedDeclarations", () => {
  test("matches the checker's own named-declaration set on the fixed closure fixture", () => {
    const declaredModules: DeclaredModule[] = [{ name: "m", glob: "src/m/**" }];
    const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules });
    const surfaceFiles = [...graph.modules.values()].flatMap((m) => m.surfaceFiles);
    const inputs = inputsFor(graph, FIXTURE, declaredModules);
    const result = computeSyntacticNamedDeclarations(inputs, surfaceFiles);
    expect(result.unresolvable).toBe(false);
    expectNamedAnswersEqual(FIXTURE, declaredModules, surfaceFiles, result.keys);
    expect(result.keys.size).toBeGreaterThan(0);
  });

  // A cycle of `export *` sources, two `export *` sources naming the
  // same identifier, a local export shadowing a star export, `export
  // default` passing through a star (which resolves to nothing - a real
  // ESM rule, not this project's own choice), `export * as ns`, aliased
  // named exports, a type-only export, and declaration merging - one
  // project, not one test per shape, since the resolver has to agree
  // with the checker on every one of them at once, the same way a real
  // surface file would combine several.
  test("matches the checker on export-* cycles, shadowing, default-through-star, export * as ns, aliases, type-only exports, declaration merging, an aliased default export, and a parenthesized default expression", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-named-decls-")));
    try {
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "esnext", module: "nodenext", moduleResolution: "nodenext", strict: true, skipLibCheck: true, noEmit: true },
      }));
      mkdirSync(join(root, "src/m"), { recursive: true });

      // export * cycle: cycleA <-> cycleB, each also naming its own real export.
      writeFileSync(join(root, "src/m/cycleA.ts"), 'export * from "./cycleB.js";\nexport interface FromA { a: number }\n');
      writeFileSync(join(root, "src/m/cycleB.ts"), 'export * from "./cycleA.js";\nexport interface FromB { b: number }\n');

      // two star sources naming the same identifier - first in declared order wins.
      writeFileSync(join(root, "src/m/dupA.ts"), "export interface Dup { a: number }\n");
      writeFileSync(join(root, "src/m/dupB.ts"), "export interface Dup { b: number }\n");
      writeFileSync(join(root, "src/m/twoStars.ts"), 'export * from "./dupA.js";\nexport * from "./dupB.js";\n');

      // a local export shadows a star export of the same name.
      writeFileSync(join(root, "src/m/shadowed.ts"), "export interface Shadow { real: boolean }\n");
      writeFileSync(join(root, "src/m/shadow.ts"), 'export * from "./shadowed.js";\nexport interface Shadow { fake: boolean }\n');

      // default passing through export * never resolves (real ESM rule).
      writeFileSync(join(root, "src/m/hasDefault.ts"), "export default class DefaultClass {}\n");
      writeFileSync(join(root, "src/m/starDefault.ts"), 'export * from "./hasDefault.js";\n');

      // declaration merging across two statements in the same file (the
      // checker reports every one of the merged declarations).
      writeFileSync(join(root, "src/m/merged.ts"), "export interface Merged { a: number }\nexport interface Merged { b: number }\n");

      // type-only export - the same resolution path as a value export.
      writeFileSync(join(root, "src/m/typeOnly.ts"), "export interface TypeOnlyThing { x: number }\n");

      // a namespace import, re-exported by name - `nsTarget.ts` carries a
      // leading comment, so `export * as ns`'s own SourceFile-shaped
      // resolution must skip that trivia the same way the checker does,
      // not land on line 1.
      writeFileSync(join(root, "src/m/nsTarget.ts"), "// a license header\n// second line\nexport interface NsMember { x: number }\n");
      writeFileSync(join(root, "src/m/reimportNs.ts"), 'import * as NS from "./nsTarget.js";\nexport { NS };\n');

      // `export default Foo;` (a bare identifier) is an alias to Foo's
      // own declaration, not a new anonymous one.
      writeFileSync(join(root, "src/m/aliasTarget.ts"), "export class AliasTarget { v = 1; }\n");
      writeFileSync(join(root, "src/m/aliasDefault.ts"), 'import { AliasTarget } from "./aliasTarget.js";\nexport default AliasTarget;\n');

      // a parenthesized class expression as a default export - an
      // anonymous value, not an alias; the ExportAssignment's own
      // position is the real answer, same as any other expression.
      writeFileSync(join(root, "src/m/parenDefault.ts"), "export default (class ParenClass {});\n");

      writeFileSync(join(root, "src/m/index.ts"), [
        'export * from "./cycleA.js";',
        'export * from "./twoStars.js";',
        'export { Shadow } from "./shadow.js";',
        'export { default as ReexportedDefault } from "./starDefault.js";',
        'export { Merged } from "./merged.js";',
        'export type { TypeOnlyThing } from "./typeOnly.js";',
        'export { TypeOnlyThing as AliasedTypeOnly } from "./typeOnly.js";',
        'export * as NsAsStar from "./nsTarget.js";',
        'export { NS } from "./reimportNs.js";',
        'export { default as AliasedDefault } from "./aliasDefault.js";',
        'export { default as ParenDefault } from "./parenDefault.js";',
      ].join("\n") + "\n");

      const declaredModules: DeclaredModule[] = [{ name: "m", glob: "src/m/**" }];
      const graph = buildModuleGraph({ projectRoot: root, declaredModules });
      expect(graph.unresolvedSpecifierCount).toBe(0);
      const surfaceFiles = [...graph.modules.values()].flatMap((m) => m.surfaceFiles);
      const inputs = inputsFor(graph, root, declaredModules);
      const result = computeSyntacticNamedDeclarations(inputs, surfaceFiles);
      expect(result.unresolvable).toBe(false);
      expectNamedAnswersEqual(root, declaredModules, surfaceFiles, result.keys);
      expect(result.visitedFiles.has(realpathSync(join(root, "src/m/nsTarget.ts")))).toBe(true);
      expect(result.visitedFiles.has(realpathSync(join(root, "src/m/cycleB.ts")))).toBe(true);
      // A real assertion that this fixture actually exercises the merge
      // and the cycle, not just an empty agreement.
      expect(result.keys.size).toBeGreaterThanOrEqual(8);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an exported `import x = SomeNamespace.Y` reports unresolvable, not a silently wrong key", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-named-decls-importeq-")));
    try {
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "esnext", module: "nodenext", moduleResolution: "nodenext", strict: true, skipLibCheck: true, noEmit: true },
      }));
      mkdirSync(join(root, "src/m"), { recursive: true });
      writeFileSync(join(root, "src/m/index.ts"), [
        "namespace NS { export interface Y { v: number } }",
        "export import X = NS.Y;",
      ].join("\n") + "\n");
      const declaredModules: DeclaredModule[] = [{ name: "m", glob: "src/m/**" }];
      const graph = buildModuleGraph({ projectRoot: root, declaredModules });
      const surfaceFiles = [...graph.modules.values()].flatMap((m) => m.surfaceFiles);
      const inputs = inputsFor(graph, root, declaredModules);
      const result = computeSyntacticNamedDeclarations(inputs, surfaceFiles);
      expect(result.unresolvable).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("generated re-export chains (varying length, alias, export * from, export * as ns) agree with the checker", async () => {
    await hegel.testAsync(async (tc) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-named-decls-property-")));
      try {
        writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
          compilerOptions: { target: "esnext", module: "nodenext", moduleResolution: "nodenext", strict: true, skipLibCheck: true, noEmit: true },
        }));
        mkdirSync(join(root, "src/m"), { recursive: true });
        writeFileSync(join(root, "src/m/base.ts"), "export interface Base { v: number }\n");

        const chainLength = tc.draw(gen.integers({ minValue: 0, maxValue: 3 }));
        const useAlias = tc.draw(gen.booleans());
        const useStar = tc.draw(gen.booleans());
        const useStarAs = tc.draw(gen.booleans());

        let specifier = "./base.js";
        let name = "Base";
        for (let hop = 0; hop < chainLength; hop++) {
          const isStarHop = useStar && hop === chainLength - 1;
          const nextName = isStarHop ? name : (useAlias ? `Hop${hop}` : name);
          const line = isStarHop
            ? `export * from "${specifier}";\n`
            : `export { ${name}${useAlias ? ` as ${nextName}` : ""} } from "${specifier}";\n`;
          writeFileSync(join(root, `src/m/hop${hop}.ts`), line);
          specifier = `./hop${hop}.js`;
          name = nextName;
        }

        const surface = useStarAs
          ? `export * as NS from "${specifier}";\n`
          : `export { ${name} } from "${specifier}";\n`;
        writeFileSync(join(root, "src/m/index.ts"), surface);

        const declaredModules: DeclaredModule[] = [{ name: "m", glob: "src/m/**" }];
        const graph = buildModuleGraph({ projectRoot: root, declaredModules });
        if (graph.unresolvedSpecifierCount !== 0) return; // a drawn shape this project's own resolver can't reach either
        const surfaceFiles = [...graph.modules.values()].flatMap((m) => m.surfaceFiles);
        const inputs = inputsFor(graph, root, declaredModules);
        const result = computeSyntacticNamedDeclarations(inputs, surfaceFiles);
        expect(result.unresolvable).toBe(false);
        expectNamedAnswersEqual(root, declaredModules, surfaceFiles, result.keys);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, { testCases: 25 });
  }, 30_000);

  test("uses disjoint SourceFile keys and normalizes every file path", () => {
    expect(sourceFileKey("C:\\repo\\first.ts")).toBe("C:/repo/first.ts\0<sourcefile>");
    expect(declarationKey("C:\\repo\\first.ts", 1, 1)).toBe(["C:/repo/first.ts", "1", "1"].join("\0"));
    expect(sourceFileKey("C:\\repo\\first.ts")).not.toBe(declarationKey("C:\\repo\\first.ts", 1, 1));
  });
});
