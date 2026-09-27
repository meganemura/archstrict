// Responsibility: check that rule 6's own closure Program (type-closure.ts,
// wired through module-graph.ts's `graph.program`) finds exactly what a
// whole-project Program finds, on the real syntax shapes a type-leak
// finding can travel through: re-export chains with aliases, `export *`,
// `export * as ns`, a namespace import, a default import, an
// `import("./x").Y` type, a heritage clause, generic constraints/defaults,
// `typeof`, a computed property name, and four unannotated-declaration
// inference shapes (function, getter, const, `export default <expr>`).
// Boundary: the oracle helper below (a whole-project ts.Program over
// every analyzed file) lives only in this test file, never in src/ -
// shipped code has exactly one way to build rule 6's Program.
import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import ts from "typescript";
import { buildModuleGraph, prepareGraph, type DeclaredModule, type ModuleGraph } from "../src/module-graph.js";
import { checkTypeLeaks, type Violation } from "../src/rules/type-leak.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/type-leak-closure");
const declaredModules: DeclaredModule[] = [{ name: "m", glob: "src/m/**" }];

function keysOf(violations: readonly Violation[]): string[] {
  return violations.map((v) => `${v.path}:${v.line}:${v.column} ${v.evidence}`).sort();
}

// The oracle: every analyzed file as a Program root, under the root
// compiler options - the Program the closure must agree with.
function wholeProgramFindings(graph: ModuleGraph, root: string, modules: readonly DeclaredModule[]): string[] {
  const prepared = prepareGraph({ projectRoot: root, declaredModules: modules });
  const program = ts.createProgram({ rootNames: prepared.rootNames, options: prepared.compilerOptions });
  return keysOf(checkTypeLeaks({ modules: graph.modules, program, checker: program.getTypeChecker(), rootDir: graph.rootDir }));
}

// A second oracle, used only by the nested-tsconfig case below: the plain
// oracle above resolves every file's imports under the project root's own
// compiler options alone (a pre-existing, documented property of rule 6's
// Program, unrelated to the closure - a leaf tsconfig's own `paths` was
// never honored there). The closure's own resolution host resolves each
// file under ITS nearest tsconfig instead, so a fair comparison for that
// one case needs an oracle that does the same, or the two would legitimately
// disagree on a file the plain oracle never could have resolved correctly
// either.
function wholeProgramFindingsPerFileOptions(graph: ModuleGraph, root: string, modules: readonly DeclaredModule[]): string[] {
  const prepared = prepareGraph({ projectRoot: root, declaredModules: modules });
  const baseHost = ts.createCompilerHost(prepared.compilerOptions);
  const host: ts.CompilerHost = Object.create(baseHost);
  host.resolveModuleNameLiterals = (literals, containingFile, redirectedReference) =>
    literals.map((literal) =>
      ts.resolveModuleName(literal.text, containingFile, prepared.compilerOptionsForFile(containingFile), baseHost, undefined, redirectedReference));
  const program = ts.createProgram({ rootNames: prepared.rootNames, options: prepared.compilerOptions, host });
  return keysOf(checkTypeLeaks({ modules: graph.modules, program, checker: program.getTypeChecker(), rootDir: graph.rootDir }));
}

describe("rule 6's closure Program", () => {
  test("finds the same leaks a whole-project Program finds, over every syntax form the closure's own rules cover", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules });
    expect(graph.unresolvedSpecifierCount).toBe(0);

    const closureViolations = checkTypeLeaks(graph);
    const focusedViolations = graph.typeLeaksForFocus("m");
    // One violation: every one of the thirteen reference mechanisms below
    // leaks the SAME internal type (Secret, never exported by name from
    // this module's surface), grouped into one fact by (module, internal
    // type) - not thirteen.
    expect(closureViolations).toHaveLength(1);
    const leak = closureViolations[0]!;
    expect(leak.evidence.startsWith("'Secret'")).toBe(true);
    expect(leak.evidence).toContain("never exported by name from module 'm'");
    // Checked against the structured `leak.exportedAs` list, not the
    // free-text evidence string: evidence caps at ten named exports
    // before switching to "and N more" (a real, measured case elsewhere
    // needed that cap), and this fixture's own thirteen would trip it.
    for (const name of [
      "AliasedWrapper", // re-export chain with an alias, and `export *`
      "ViaStarAs", // `export * as n from`, then a namespace member access
      "ViaNamespaceImport", // a namespace import
      "ViaDefaultImport", // a default import
      "ViaImportType", // `import("./x").Y`
      "ViaNsBody", // a namespace body's own `export type {}` specifier
      "GenericWrapper", // a generic constraint and default
      "TypeofWrapper", // `typeof`, on an unannotated const
      "InferredConstWrapper", // a second, independent unannotated const
      "ComputedWrapper", // a computed property name
      "inferredFunction", // an unannotated function (inferred return)
      "GetterWrapper", // an unannotated getter (inferred return)
      "ViaDefaultExpr", // `export default <expr>` (an anonymous, unannotated function)
    ]) {
      expect(leak.leak?.exportedAs, `expected '${name}' to be named in exportedAs`).toContain(name);
    }
    // Known has a public name (re-exported directly from the surface),
    // and KnownHeritage reaches it through the exact same heritage-clause
    // mechanism HeritageWrapper uses to reach Secret - neither leaks,
    // proof this fixture's own leaks come from Secret having no public
    // name, not from any mechanism itself.
    expect(leak.evidence).not.toContain("Known");

    // The oracle: the same findings, from a whole-project Program with no
    // `noResolve` - the only correctness bar this closure has to clear.
    expect(keysOf(closureViolations)).toEqual(wholeProgramFindings(graph, FIXTURE, declaredModules));
    expect(keysOf(focusedViolations)).toEqual(keysOf(closureViolations));
  });

  test("excludes a file reachable only through a value-only import (the memory point)", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules });
    const closureFiles = graph.program.getRootFileNames();
    expect(closureFiles.some((f) => f.endsWith("value-only.ts"))).toBe(false);
    // Sanity: value-only.ts really is analyzed (a real edge exists into
    // it) - excluded because nothing ever needs its type, not because the
    // edge walk itself missed it.
    expect(graph.edges.some((e) => e.resolvedFile.endsWith("value-only.ts"))).toBe(true);
  });

  test("a normal run never falls back, and adds no note", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules });
    checkTypeLeaks(graph);
    expect(graph.programNotes).toEqual([]);
  });

  test("scope2: a namespace export does not name the target file's first declaration", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-scope2-")));
    try {
      writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"noLib":true,"types":[],"module":"esnext","moduleResolution":"bundler"}}');
      mkdirSync(join(root, "src/m"), { recursive: true });
      mkdirSync(join(root, "src/other"), { recursive: true });
      writeFileSync(join(root, "src/m/secret.ts"), "export interface Secret { value: number }\n");
      writeFileSync(join(root, "src/m/index.ts"), 'import type { Secret } from "./secret.js";\nexport interface Wrap { value: Secret }\n');
      writeFileSync(join(root, "src/other/index.ts"), 'export * as ns from "../m/secret.js";\n');
      const modules: DeclaredModule[] = [
        { name: "m", glob: "src/m/**" },
        { name: "other", glob: "src/other/**" },
      ];
      const fullGraph = buildModuleGraph({ projectRoot: root, declaredModules: modules });
      const full = checkTypeLeaks(fullGraph).filter((violation) => violation.todoModule === "m");
      const focusedGraph = buildModuleGraph({ projectRoot: root, declaredModules: modules });
      const focused = focusedGraph.typeLeaksForFocus("m");
      expect(full).toHaveLength(1);
      expect(keysOf(focused)).toEqual(keysOf(full));
      expect(focusedGraph.focusedTypeLeakNotes).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the existing type-leak fixture (structural, re-export, type-argument, inferred-return, generic-parameter, optional-array)", () => {
  test("the closure finds the same leak a whole-project Program finds", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "fixtures/type-leak");
    const modules: DeclaredModule[] = [{ name: "m", glob: "src/m/**" }];
    const graph = buildModuleGraph({ projectRoot: root, declaredModules: modules, surface: "public.ts" });
    const full = keysOf(checkTypeLeaks(graph));
    expect(full).toEqual(wholeProgramFindings(graph, root, modules));
    expect(keysOf(graph.typeLeaksForFocus("m"))).toEqual(full);
  });
});

// A small, standalone project (not a checked-in fixture: script/ambient
// roots are a project-shape concern, not this module's own detection
// logic) - a script file (no import, no export) and a `declare global`
// block each bind a name no import statement ever names, so the closure's
// own rules can only find them by scanning every analyzed file directly
// (type-closure.ts's own ambient-root rule), never by following an edge
// from a surface.
describe("ambient roots (a script file, `declare global`)", () => {
  test("a global name from a script file and from a declare global block both structurally leak, matching a whole-project Program", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-ambient-closure-")));
    try {
      // Plain commonjs, not nodenext: under moduleResolution nodenext, a
      // file with neither import nor export is not treated as a global
      // script at all here (measured directly against a real tsc run) -
      // Node's own module system has no such thing as a shared global
      // script scope across separate files. Plain commonjs is the
      // convention where a "script" file's own top-level names genuinely
      // merge into the global scope, the case R6 exists for.
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "esnext", module: "commonjs", strict: true, skipLibCheck: true, noEmit: true },
      }));
      mkdirSync(join(root, "src/m"), { recursive: true });
      // A script file: no import, no export at all - its own top-level
      // names are ambient (global), the same as a `.d.ts` global
      // declaration a project vendors by hand.
      writeFileSync(join(root, "src/m/script.ts"),
        "interface ScriptSecret { value: number }\ndeclare const scriptGlobal: ScriptSecret;\n");
      // A `declare global` block augments the global scope from inside a
      // real module (this file itself has an export, so it is not a
      // script by the other rule).
      writeFileSync(join(root, "src/m/ambient.ts"),
        "export {};\ndeclare global {\n  interface GlobalSecret { value: number }\n  const globalGlobal: GlobalSecret;\n}\n");
      writeFileSync(join(root, "src/m/index.ts"),
        "export function useScriptGlobal() {\n  return scriptGlobal;\n}\nexport function useDeclareGlobal() {\n  return globalGlobal;\n}\n");
      const modules: DeclaredModule[] = [{ name: "m", glob: "src/m/**" }];
      const graph = buildModuleGraph({ projectRoot: root, declaredModules: modules });
      expect(graph.unresolvedSpecifierCount).toBe(0);
      const closure = keysOf(checkTypeLeaks(graph));
      const focused = keysOf(graph.typeLeaksForFocus("m"));
      expect(closure.some((k) => k.includes("ScriptSecret"))).toBe(true);
      expect(closure.some((k) => k.includes("GlobalSecret"))).toBe(true);
      expect(closure).toEqual(wholeProgramFindings(graph, root, modules));
      expect(focused).toEqual(closure);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a .tsx surface", () => {
  test("a structural leak through a .tsx surface matches a whole-project Program", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-tsx-closure-")));
    try {
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "esnext", module: "nodenext", moduleResolution: "nodenext", jsx: "react-jsx",
          strict: true, skipLibCheck: true, noEmit: true },
      }));
      mkdirSync(join(root, "src/m"), { recursive: true });
      writeFileSync(join(root, "src/m/secret.ts"), "export interface Secret { value: number }\n");
      writeFileSync(join(root, "src/m/known.ts"), "export interface Known { value: number }\n");
      writeFileSync(join(root, "src/m/index.tsx"),
        'export { Known } from "./known.js";\n' +
        'import type { Secret } from "./secret.js";\n' +
        "export interface WrapsSecret { value: Secret }\n" +
        "export interface WrapsKnown { value: Known }\n",
      );
      const modules: DeclaredModule[] = [{ name: "m", glob: "src/m/**" }];
      const graph = buildModuleGraph({ projectRoot: root, declaredModules: modules });
      expect(graph.unresolvedSpecifierCount).toBe(0);
      const violations = checkTypeLeaks(graph);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.evidence).toContain("'WrapsSecret'");
      expect(violations[0]!.evidence).not.toContain("Known");
      expect(keysOf(violations)).toEqual(wholeProgramFindings(graph, root, modules));
      expect(keysOf(graph.typeLeaksForFocus("m"))).toEqual(keysOf(violations));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// The closure Program restricts module resolution through a host, not
// `noResolve`: `noResolve` also blocks every external import (a real
// npm package, @types/node, a triple-slash reference), so a generic
// external type wrapping an internal one would resolve to an error type
// and the leak through it would silently disappear. This checks three
// real external-resolution shapes at once: a project's own installed
// package (a fake one, built for this test), @types/node through this
// repository's own installed copy, and a nested tsconfig whose own
// `paths` differs from the root's.
describe("an external dependency graph (a real installed package, @types/node, a nested tsconfig's own paths)", () => {
  test("a structural leak through an external generic type matches a whole-project Program", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-external-closure-")));
    try {
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "esnext", module: "nodenext", moduleResolution: "nodenext", types: ["node"],
          strict: true, skipLibCheck: true, noEmit: true },
      }));
      writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
      mkdirSync(join(root, "node_modules/fake-pkg/internal"), { recursive: true });
      writeFileSync(join(root, "node_modules/fake-pkg/package.json"),
        '{"name":"fake-pkg","version":"1.0.0","type":"module","types":"./index.d.ts","main":"./index.js"}\n');
      writeFileSync(join(root, "node_modules/fake-pkg/index.d.ts"), 'export * from "./internal/Observable.js";\n');
      writeFileSync(join(root, "node_modules/fake-pkg/internal/Observable.d.ts"),
        "export declare class Observable<T> {\n  value: T;\n}\n");
      // This repository's own installed @types/node, not a copy - a real
      // installed checkout's own node_modules is what this case exists
      // to exercise.
      mkdirSync(join(root, "node_modules/@types"), { recursive: true });
      symlinkSync(join(dirname(fileURLToPath(import.meta.url)), "../node_modules/@types/node"),
        join(root, "node_modules/@types/node"), "dir");

      mkdirSync(join(root, "src/m/nested"), { recursive: true });
      writeFileSync(join(root, "src/m/internal.ts"),
        "export interface Internal { value: number }\nexport interface Payload { value: number }\n");
      // A leaf tsconfig read standalone (module-graph.ts's own
      // compilerOptionsForFile picks the nearest one per file, with no
      // implicit inheritance from a parent) - its own `paths` resolves
      // "@nested/internal.js" to the sibling file one directory up, a
      // mapping the root tsconfig above does not have at all.
      writeFileSync(join(root, "src/m/nested/tsconfig.json"), JSON.stringify({
        compilerOptions: { noLib: true, types: [], module: "nodenext", baseUrl: ".", paths: { "@nested/*": ["../*"] } },
      }));
      writeFileSync(join(root, "src/m/nested/g.ts"),
        'import type { Internal } from "@nested/internal.js";\nexport interface NestedWrapper { value: Internal }\n');
      writeFileSync(join(root, "src/m/index.ts"),
        'import type { Observable } from "fake-pkg";\n' +
        'import type { Internal, Payload } from "./internal.js";\n' +
        'import type { EventEmitter } from "node:events";\n' +
        'export type { NestedWrapper } from "./nested/g.js";\n' +
        "export type Wrapped = Observable<Internal>;\n" +
        "export type WrappedNode = EventEmitter<{ msg: [Payload] }>;\n",
      );
      const modules: DeclaredModule[] = [{ name: "m", glob: "src/m/**" }];
      const graph = buildModuleGraph({ projectRoot: root, declaredModules: modules });
      expect(graph.unresolvedSpecifierCount).toBe(0);
      const violations = checkTypeLeaks(graph);
      // Two internal types, each reached only through an external
      // generic (fake-pkg's own Observable<T>, @types/node's own
      // EventEmitter<T>) or through the nested tsconfig's own alias -
      // three distinct resolution paths, matching a whole-project Program.
      expect(violations).toHaveLength(2);
      expect(keysOf(violations)).toEqual(wholeProgramFindingsPerFileOptions(graph, root, modules));
      expect(keysOf(graph.typeLeaksForFocus("m"))).toEqual(keysOf(violations));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// A dynamic `import(...)` reached while inferring (an unannotated
// declaration's own value walk) reaches its target whole - checked here
// on a 5-level lazy-route chain, entirely through dynamic imports (no
// static import anywhere), so the closure's own round bound sees this in
// its very first round: every hop's own file already joins the closure
// through the inference rule, and rule 6's own safety net never has
// anything left to add.
describe("a dynamic import chain (lazy routes)", () => {
  test("a 5-level lazy-route chain never falls back and never needs a second round", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-dynamic-import-closure-")));
    try {
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "esnext", module: "nodenext", moduleResolution: "nodenext", strict: true, skipLibCheck: true, noEmit: true },
      }));
      writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
      mkdirSync(join(root, "src/m"), { recursive: true });
      // A class, not an interface: a dynamic import's own namespace
      // object exposes only runtime exports, so the target of the last
      // hop needs a real value to hand back, not merely a type name.
      writeFileSync(join(root, "src/m/secret.ts"), "export class Secret {\n  value = 1;\n}\n");
      writeFileSync(join(root, "src/m/hop4.ts"), 'export { Secret } from "./secret.js";\n');
      for (let hop = 3; hop >= 0; hop--) {
        writeFileSync(join(root, `src/m/hop${hop}.ts`),
          `export async function loadHop${hop}() {\n` +
          `  const mod = await import("./hop${hop + 1}.js");\n` +
          `  return ${hop === 3 ? "new mod.Secret()" : `mod.loadHop${hop + 1}()`};\n` +
          "}\n");
      }
      writeFileSync(join(root, "src/m/index.ts"),
        'export async function loadRoute() {\n  const mod = await import("./hop0.js");\n  return mod.loadHop0();\n}\n');
      const modules: DeclaredModule[] = [{ name: "m", glob: "src/m/**" }];
      const graph = buildModuleGraph({ projectRoot: root, declaredModules: modules });
      expect(graph.unresolvedSpecifierCount).toBe(0);
      const violations = checkTypeLeaks(graph);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.evidence).toContain("'loadRoute'");
      // The round bound: this closure resolves every dynamic import in
      // its own first pass, so the safety net's fallback note (module-graph.ts's
      // own `ensureProgram`) never fires here.
      expect(graph.programNotes).toEqual([]);
      expect(keysOf(violations)).toEqual(wholeProgramFindings(graph, root, modules));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// A dynamic import's own result handed to a generic helper (never
// destructured, never called directly) still needs its target's own
// exports loaded whole - this closure decides only which FILE needs
// loading, never which member of it a caller happens to reach.
describe("a dynamic import passed on to a generic helper", () => {
  test("reaches the target whole, matching a whole-project Program", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-passed-on-")));
    try {
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "esnext", module: "nodenext", moduleResolution: "nodenext", strict: true, skipLibCheck: true, noEmit: true },
      }));
      writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
      mkdirSync(join(root, "src/m"), { recursive: true });
      writeFileSync(join(root, "src/m/secret.ts"), "export interface Secret { value: number }\n");
      writeFileSync(join(root, "src/m/other-secret.ts"), "export interface OtherSecret { value: number }\n");
      writeFileSync(join(root, "src/m/hop.ts"),
        'import type { Secret } from "./secret.js";\n' +
        'import type { OtherSecret } from "./other-secret.js";\n' +
        "export const make: Secret = { value: 1 };\n" +
        "export const other: OtherSecret = { value: 1 };\n");
      writeFileSync(join(root, "src/m/index.ts"),
        "async function helper<T>(p: Promise<T>): Promise<T> {\n  return p;\n}\n" +
        "export function passOn() {\n  return helper(import(\"./hop.js\"));\n}\n");
      const modules: DeclaredModule[] = [{ name: "m", glob: "src/m/**" }];
      const graph = buildModuleGraph({ projectRoot: root, declaredModules: modules });
      expect(graph.unresolvedSpecifierCount).toBe(0);
      const violations = checkTypeLeaks(graph);
      expect(violations.length).toBeGreaterThan(0);
      expect(keysOf(violations)).toEqual(wholeProgramFindings(graph, root, modules));
      const closureFiles = graph.program.getRootFileNames();
      expect(closureFiles.some((f) => f.endsWith("secret.ts"))).toBe(true);
      expect(closureFiles.some((f) => f.endsWith("other-secret.ts"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// The inference rule's own narrowing: an unannotated declaration that
// calls one imported function (makeSecret) and never mentions a second,
// unrelated import at all - it reaches only the identifiers its own body
// references, so the unrelated file never joins the closure Program.
describe("an unannotated declaration referencing only one of two imports", () => {
  test("excludes the unreferenced import's own file from the closure Program", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-referenced-")));
    try {
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "esnext", module: "nodenext", moduleResolution: "nodenext", strict: true, skipLibCheck: true, noEmit: true },
      }));
      writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
      mkdirSync(join(root, "src/m"), { recursive: true });
      writeFileSync(join(root, "src/m/secret.ts"), "export interface Secret { value: number }\n");
      writeFileSync(join(root, "src/m/maker.ts"),
        'import type { Secret } from "./secret.js";\n' +
        "export function makeSecret(): Secret {\n  return { value: 1 };\n}\n");
      writeFileSync(join(root, "src/m/unrelated.ts"), "export interface Unrelated { value: number }\n");
      writeFileSync(join(root, "src/m/index.ts"),
        'import { makeSecret } from "./maker.js";\n' +
        'import type { Unrelated } from "./unrelated.js";\n' +
        "export function wrap() {\n  return makeSecret();\n}\n");
      const modules: DeclaredModule[] = [{ name: "m", glob: "src/m/**" }];
      const graph = buildModuleGraph({ projectRoot: root, declaredModules: modules });
      expect(graph.unresolvedSpecifierCount).toBe(0);
      const violations = checkTypeLeaks(graph);
      expect(keysOf(violations)).toEqual(wholeProgramFindings(graph, root, modules));
      const closureFiles = graph.program.getRootFileNames();
      expect(closureFiles.some((f) => f.endsWith("maker.ts"))).toBe(true);
      expect(closureFiles.some((f) => f.endsWith("secret.ts"))).toBe(true);
      expect(closureFiles.some((f) => f.endsWith("unrelated.ts"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
