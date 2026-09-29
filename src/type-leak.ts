// Responsibility: rule 6, type leak. A module's public surface re-exports
// or otherwise exposes an internal declaration - one that lives outside
// the surface file, inside this project's own checked source - without the
// consumer having a name for it. "A name" means any name a declared
// module's own surface assigns it, resolved through an aliased re-export
// (`export { X as Y }`) and through a re-export chain, from that same
// module's surface or from any OTHER declared module's surface (a
// consumer that can already `import { Y } from "b"` has a name for the
// type, whichever module's surface structurally reaches it) - a
// declaration reached through a `node_modules` segment relative to that
// boundary is never internal either, whatever a module's glob base
// happens to contain (the consumer names it from the package, not from
// this project's own boundary - see isInternal's own boundary-check
// comment for why this is scoped to the matched boundary root, not the
// declaration's bare absolute path). Promoted from a spike
// once its definition settled (three candidates converged on one general
// case: a structural leak, which subsumes an inferred-return-type leak and
// a generic-parameter leak as named subsets, kept as their own `via` tag
// rather than a separate rule each).
// Boundary: pure predicate over a ModuleGraph (its shared program and
// checker) and a boundary root. No I/O, no output formatting.
// Lives next to the graph builder, not under src/rules: module-graph.ts
// calls checkTypeLeaks while it builds the closure. A rules-module home
// would make that call a cycle with every other rule that reads the graph.
import ts from "typescript";
import { relative } from "node:path";
import { declarationKey, sourceFileKey } from "./type-closure.js";

export type Via = "inferred-return" | "generic-parameter" | "structural";

export type LeakFinding = {
  exportedAs: string;
  via: Via;
  internalType: string;
  internalFile: string;
  line: number;
  column: number;
};

function declaredIn(symbol: ts.Symbol): string | undefined {
  return symbol.getDeclarations()?.[0]?.getSourceFile().fileName;
}

// TypeScript's own sentinel for "this alias could not be resolved to a
// real symbol" (its internal `unknownSymbol`) - not a project symbol at
// all: name "unknown", no declarations, reached whenever
// `getAliasedSymbol` runs out of a real target to point to (measured
// directly against a broken import). Detected by shape, since the public
// API exposes no dedicated flag for it.
function isUnresolvedAliasTarget(symbol: ts.Symbol): boolean {
  return symbol.name === "unknown" && symbol.getDeclarations() === undefined;
}

// A module specifier, its position, and the file it was written in, recovered by
// walking up from an unresolved alias's own declaration (an
// ImportSpecifier, a NamespaceImport, or similar) to its nearest
// import/export declaration - the same values module-graph.ts uses to find
// an edge, so a caller can map this straight to a mode-aware
// resolved file without resolving the specifier itself again.
function specifierOf(symbol: ts.Symbol): UnresolvedReference | undefined {
  let node: ts.Node | undefined = symbol.getDeclarations()?.[0];
  const declaration = node;
  if (declaration === undefined) return undefined;
  while (node !== undefined && !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) node = node.parent;
  if (node === undefined || node.moduleSpecifier === undefined || !ts.isStringLiteral(node.moduleSpecifier)) return undefined;
  const sourceFile = declaration.getSourceFile();
  const start = node.moduleSpecifier.getStart(sourceFile);
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
  return {
    file: sourceFile.fileName,
    specifier: node.moduleSpecifier.text,
    fromPosition: { line: line + 1, column: character + 1 },
  };
}

// The seam module-graph.ts's own closure Program (type-closure.ts) reads
// through `checkTypeLeaks`'s own options below: rule 6 is the only code
// that already walks every alias a surface (or an internal declaration)
// depends on, so its own resolution failures are reported back here
// instead of duplicating that walk in module-graph.ts. An unresolved
// alias names the specifier it failed to resolve, from an
// ImportSpecifier/ExportSpecifier declaration - module-graph.ts's own
// edge records already know exactly which file that specifier resolves
// to. Boundary: this reports a fact about a real resolution failure - it
// decides nothing about the closure, the round bound, or the fallback;
// module-graph.ts's own `ensureProgram` owns all of that.
export type UnresolvedReference = {
  file: string;
  specifier: string;
  fromPosition: { line: number; column: number };
};
export type ReportUnresolvedReference = (ref: UnresolvedReference) => void;

function reportIfUnresolved(symbol: ts.Symbol, target: ts.Symbol, report: ReportUnresolvedReference | undefined): void {
  if (report === undefined || !isUnresolvedAliasTarget(target)) return;
  const ref = specifierOf(symbol);
  if (ref !== undefined) report(ref);
}

// A re-export's own alias (`export { X as Y } from "./z.js"`, and a chain
// of those across several files - `verbs/index.ts` re-exporting a type
// `rules/index.ts` itself re-exported) is unwrapped one hop at a time by
// `getAliasedSymbol` - looping here follows the chain all the way to the
// symbol whose own declarations are the real, original ones, which is
// what `isInternal` below needs to compare against.
function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol, report?: ReportUnresolvedReference): ts.Symbol {
  let current = symbol;
  while (current.flags & ts.SymbolFlags.Alias) {
    const next = checker.getAliasedSymbol(current);
    if (next === current) break; // defensive: an unresolvable alias must not loop forever
    reportIfUnresolved(current, next, report);
    current = next;
  }
  return current;
}

// Every declaration a consumer can already reach under SOME public name -
// gathered once per `checkTypeLeaks` run, over every declared module's own
// surface files, not just the leaking module's own: a type a consumer can
// already `import` from module B is not a leak in module A's surface
// either (the decision behind this: rule 6 exists so a consumer has a name
// for every type it receives, and a name from ANY declared module's own
// surface satisfies that, not only the exposing module's own). Keyed by
// declaration NODE, not by symbol object or by name - `resolveAlias`'s own
// target symbol is what a plain name-based check (the old
// `exportedNames.has(symbol.name)`) missed for `export { X as Y }`: Y's own
// exported symbol resolves to X's real declaration, and that declaration
// is what `isInternal` looks up its own candidate symbol's declarations
// against.
function collectNamedDeclarations(
  program: ts.Program,
  checker: ts.TypeChecker,
  surfaceFiles: readonly string[],
  report?: ReportUnresolvedReference,
): Set<ts.Node> {
  const declarations = new Set<ts.Node>();
  for (const path of surfaceFiles) {
    const sf = program.getSourceFile(path);
    if (sf === undefined) continue;
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    if (moduleSymbol === undefined) continue;
    for (const exp of checker.getExportsOfModule(moduleSymbol)) {
      const resolved = resolveAlias(checker, exp, report);
      for (const decl of resolved.getDeclarations() ?? []) declarations.add(decl);
    }
  }
  return declarations;
}

// Namespace exports resolve to a SourceFile, which can share the first
// declaration's offset. A common position key is refused because it aliases them.
function namedDeclarationKey(node: ts.Node): string {
  if (ts.isSourceFile(node)) return sourceFileKey(node.fileName);
  const sf = node.getSourceFile();
  const start = node.getStart(sf);
  const { line, character } = sf.getLineAndCharacterOfPosition(start);
  return declarationKey(sf.fileName, line + 1, character + 1);
}

// A generic type reference (Promise<Internal>, Map<K, Internal>,
// Array<Internal>) is an Object type carrying the Reference object flag -
// a plain object literal type carries Object but not Reference.
function isTypeReference(type: ts.Type): type is ts.TypeReference {
  return (type.flags & ts.TypeFlags.Object) !== 0 && ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0;
}

// Detects every structural type leak reachable from `entrySf`'s own
// exports - the core algorithm, independent of archstrict's module
// concept, so it can run both per-module (checkTypeLeaks below) and
// directly against an arbitrary entry file (nukadoko's own src/index.ts,
// in test/type-leak.nukadoko.test.ts, matching this rule's own
// promoted-from-spike history).
export function detectTypeLeaks(
  checker: ts.TypeChecker,
  entrySf: ts.SourceFile,
  boundaryRoot: string | readonly string[],
  siblingSurfaceFiles: readonly string[] = [],
  // Declarations exported by SOME OTHER declared module's own surface
  // (checkTypeLeaks passes these in, gathered once per check with
  // collectNamedDeclarations; a standalone caller such as the nukadoko
  // harness passes none, so only this one file's own exports, folded in
  // below, apply there).
  externallyNamedDeclarations: ReadonlySet<ts.Node> = new Set(),
  // Reports every alias this walk cannot resolve (module-graph.ts's own
  // closure Program safety net) - see UnresolvedReference's own comment
  // for the seam this is. Absent for a standalone caller (the nukadoko
  // harness): a real, whole-project Program never has this problem.
  report?: ReportUnresolvedReference,
  // Public names from other surfaces arrive without checker nodes because
  // loading their closures removes the scope benefit. Object identity is
  // refused, so declarations match by stable file, line, and column keys.
  externallyNamedDeclarationKeys: ReadonlySet<string> = new Set(),
): LeakFinding[] {
  const boundaryRoots = typeof boundaryRoot === "string" ? [boundaryRoot] : boundaryRoot;
  const moduleSymbol = checker.getSymbolAtLocation(entrySf);
  if (moduleSymbol === undefined) return [];
  const exports = checker.getExportsOfModule(moduleSymbol);

  // This surface's own exports (resolved through an aliased or chained
  // re-export, e.g. `export { type Violation as AViolation }`)
  // union the caller's cross-module set. A candidate symbol with a
  // declaration in this combined set already has a public name somewhere,
  // under some name - not necessarily its own declared name.
  const namedDeclarations = new Set<ts.Node>(externallyNamedDeclarations);
  for (const exp of exports) {
    const resolved = resolveAlias(checker, exp, report);
    for (const decl of resolved.getDeclarations() ?? []) namedDeclarations.add(decl);
  }

  const leaks: LeakFinding[] = [];

  // Only a genuine, importable named type declaration is a leak candidate
  // at all - a type alias, interface, class, or enum. A method or function
  // property's own "type" resolves to a symbol too (its call signature),
  // with a real declaration site and a real name (the method's own name,
  // e.g. "run"), but that name was never a *type* a consumer could import
  // in the first place; it is structurally the same case an anonymous
  // type literal already is, just with a name borrowed from the property
  // rather than none at all. Measured directly against nukadoko's real
  // `StepDefinitionInput.run` (an inline method signature written in its
  // own interface body): without this check, `run`'s own declaration site
  // (a different file than the surface) read as a leak of a type named
  // "run", which nothing could ever "export by name" in any meaningful
  // sense - a method is not re-exportable independent of its own type.
  const NAMED_TYPE_DECLARATION =
    ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Interface | ts.SymbolFlags.Class | ts.SymbolFlags.Enum;

  function isInternal(symbol: ts.Symbol): { file: string } | undefined {
    // Also excludes a generic type parameter (a variable substituted at
    // the call site, not a declaration - its own declaration site,
    // wherever the generic function or type was written, is meaningless
    // here) and an anonymous type literal (TS names it "__type",
    // "__object", ... - it has no name a consumer could fail to import,
    // its shape already fully expanded wherever it appears): TypeParameter
    // and TypeLiteral are never among the flags above on the same symbol.
    if (!(symbol.flags & NAMED_TYPE_DECLARATION)) return undefined;
    const file = declaredIn(symbol);
    if (file === undefined) return undefined;
    // A sibling surface also gives consumers a public path to the declaration.
    if (file === entrySf.fileName || siblingSurfaceFiles.includes(file)) return undefined;
    // Has a public name somewhere - this surface's own re-export (any
    // name, any alias depth) or another declared module's surface.
    const declarations = symbol.getDeclarations();
    if (declarations?.some((d) => {
      // Checker-owned names keep their exact node identity. Converting all
      // names to strings is refused because the unscoped path already has nodes.
      if (namedDeclarations.has(d)) return true;
      // Other surfaces have no nodes in this Program. Loading them is refused
      // because it rebuilds the all-surface closure that focus avoids.
      return externallyNamedDeclarationKeys.has(namedDeclarationKey(d));
    })) return undefined;
    // TS file names are always forward-slash; boundaryRoot comes from
    // node:path's own join/dirname, which uses the platform separator on
    // Windows - a plain startsWith would then read every declaration as
    // outside the boundary there (the same class of bug module-graph.ts's
    // own isWorkspaceSiblingResolution already hit and fixed with the same
    // relative() check). This also closes a prefix hole a plain startsWith
    // has even on one platform: "src-other" starts with "src" as a string.
    //
    // Under declared modules, "internal" means inside SOME declared
    // module's own directory - not the whole project root. A single,
    // broad rootDir boundary was measured wrong: under declared mode
    // rootDir is the project root, so a root-level file's own type
    // declarations (archstrict.config.ts, a test helper, ...) would
    // incorrectly count as "this project's own checked source, must be
    // exported by name" for every module's surface. A cross-module leak
    // (module A's surface exposing a type declared in module B) still
    // counts - that's still real, still worth a name - checked against
    // every declared module's own boundary, not just the leaking
    // module's own.
    //
    // A root-based glob ("**") makes a module's
    // own directory the project root itself, which contains the project's
    // real node_modules - a dependency's own type would then read as
    // "inside the boundary" by the plain prefix test above, when the
    // consumer already has a name for it from the package it imported it
    // from, not from this project's own boundary to keep. Checked as a
    // node_modules SEGMENT in the path relative to the matched boundary
    // root specifically (not the declaration's absolute path): the
    // standalone nukadoko harness below intentionally passes a boundary
    // root that itself sits under node_modules (a real npm-installed
    // package's own source, used as a convenient real-world fixture, not a
    // dependency of the thing being analyzed) - a declaration inside THAT
    // root is still internal to it, since nothing in the path AFTER the
    // root names a nested node_modules of its own.
    const isInsideAnyBoundary = boundaryRoots.some((root) => {
      const rel = relative(root, file);
      if (rel.startsWith("..") || rel === file) return false; // rel === file: outside entirely (relative() returns the input unchanged across drives on Windows)
      return !rel.split(/[\\/]/).includes("node_modules");
    });
    if (!isInsideAnyBoundary) return undefined;
    return { file };
  }

  // A property typed with a named alias whose target is a mapped/utility
  // type resolves `getSymbol()` to that utility type's own anonymous
  // shape, not the alias a consumer actually sees on hover - checking
  // `aliasSymbol` first matches what a consumer's own experience of the
  // type is.
  //
  // `seen` (shared with the walkStructural call that follows each
  // checkType call, at every call site) is an optimization only, skipping
  // a type object already flagged or already walked within this exported
  // symbol's own recursion - it does not by itself guarantee no duplicate
  // leak in the output, since TS does not always hand back the identical
  // `ts.Type` object for what is conceptually the same declaration reached
  // two structural ways (measured directly: an array's own type argument
  // and its index signature's value type). `dedupe()` below, over the
  // fully collected `leaks`, is what actually guarantees that.
  function checkType(type: ts.Type, exportedAs: string, via: Via, position: { line: number; column: number }, seen: Set<ts.Type>): void {
    if (seen.has(type)) return;
    const sym = type.aliasSymbol ?? type.getSymbol();
    if (sym === undefined) return;
    const internal = isInternal(sym);
    if (internal !== undefined) {
      leaks.push({ exportedAs, via, internalType: sym.name, internalFile: internal.file, ...position });
    }
  }

  // Walks every type reachable from `type`'s own shape: its base types, its properties,
  // its index signatures' value types, its own type arguments if it's a
  // generic type reference (Promise<Internal>, Map<K, Internal>,
  // Array<Internal> - the wrapper's own properties don't structurally
  // contain the argument type the way a plain property does, so this is
  // its own walk target, not covered by the properties loop below), and
  // (for a union) every constituent - "any property, anywhere in an
  // exported type's shape" requires all of these, not just direct
  // properties one level down. `seen` guards against a type that
  // references itself, directly or through a cycle of aliases.
  function walkStructural(
    type: ts.Type,
    exportedAs: string,
    via: Via,
    position: { line: number; column: number },
    depth: number,
    seen: Set<ts.Type>,
  ): void {
    if (depth <= 0 || seen.has(type)) return;
    seen.add(type);

    if (type.isUnion()) {
      for (const member of type.types) {
        checkType(member, exportedAs, via, position, seen);
        walkStructural(member, exportedAs, via, position, depth - 1, seen);
      }
      return;
    }

    // No early return here, unlike the union branch above: a union's own
    // getPropertiesOfType is already the intersection of its members'
    // properties, so walking it too would just re-walk what the member
    // loop already covered. A type reference's own type arguments and its
    // own properties are each real, independent parts of its shape - a
    // user-defined generic like `Box<T> { value: T; other: Internal }`
    // needs both walked, not just one.
    if (isTypeReference(type)) {
      for (const typeArg of checker.getTypeArguments(type)) {
        checkType(typeArg, exportedAs, via, position, seen);
        walkStructural(typeArg, exportedAs, via, position, depth - 1, seen);
      }
    }

    if ((type.flags & ts.TypeFlags.Object) !== 0 &&
        ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.ClassOrInterface) !== 0) {
      for (const baseType of checker.getBaseTypes(type as ts.InterfaceType) ?? []) {
        checkType(baseType, exportedAs, via, position, seen);
        walkStructural(baseType, exportedAs, via, position, depth - 1, seen);
      }
    }

    for (const prop of checker.getPropertiesOfType(type)) {
      const decl = prop.valueDeclaration ?? prop.getDeclarations()?.[0];
      if (decl === undefined) continue;
      const propType = checker.getTypeOfSymbolAtLocation(prop, decl);
      checkType(propType, exportedAs, via, position, seen);
      walkStructural(propType, exportedAs, via, position, depth - 1, seen);
    }

    for (const indexInfo of checker.getIndexInfosOfType(type)) {
      checkType(indexInfo.type, exportedAs, via, position, seen);
      walkStructural(indexInfo.type, exportedAs, via, position, depth - 1, seen);
    }
  }

  function walkSignatures(
    type: ts.Type,
    exportedAs: string,
    position: { line: number; column: number },
  ): void {
    const signatures = [...type.getCallSignatures(), ...type.getConstructSignatures()];
    for (const sig of signatures) {
      const sigDecl = sig.getDeclaration();
      const hasExplicitReturnType = sigDecl !== undefined && ts.isFunctionLike(sigDecl) && sigDecl.type !== undefined;
      const returnType = checker.getReturnTypeOfSignature(sig);
      const via: Via = hasExplicitReturnType ? "structural" : "inferred-return";
      // The return type itself may be internal, while the structural walk
      // only inspects the return type's components.
      const returnSeen = new Set<ts.Type>();
      checkType(returnType, exportedAs, via, position, returnSeen);
      walkStructural(returnType, exportedAs, via, position, 2, returnSeen);
    }
  }

  for (const symbol of exports) {
    const decl = symbol.getDeclarations()?.[0];
    if (decl === undefined) continue;
    // Position stays on the ORIGINAL symbol's own declaration (an
    // ExportSpecifier, for `export type { Foo } from "./x.js"`) - that's
    // the line in the surface file itself, matching `path: surfacePath`.
    const start = decl.getStart(decl.getSourceFile());
    const { line, character } = decl.getSourceFile().getLineAndCharacterOfPosition(start);
    const position = { line: line + 1, column: character + 1 };

    // A re-export (`export type { Foo } from "./internal.js"`, or
    // `export { foo } from "./internal.js"`) is an Alias symbol whose own
    // "declaration" is the ExportSpecifier, never a
    // TypeAliasDeclaration/InterfaceDeclaration or a function/class - so
    // without resolving through the alias, every re-exported symbol falls
    // through to the function branch below, finds no call signatures, and
    // is silently never walked at all. Resolving to the real target
    // symbol (and ITS declaration) is what lets Foo's own shape - which
    // may still structurally reach an internal type nothing re-exports -
    // get walked, exactly as if it had been declared locally.
    const resolvedSymbol = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    if (symbol.flags & ts.SymbolFlags.Alias) reportIfUnresolved(symbol, resolvedSymbol, report);
    const resolvedDecl = resolvedSymbol.getDeclarations()?.[0];
    if (resolvedDecl === undefined) continue;

    if (ts.isTypeAliasDeclaration(resolvedDecl) || ts.isInterfaceDeclaration(resolvedDecl)) {
      const type = checker.getDeclaredTypeOfSymbol(resolvedSymbol);
      walkStructural(type, symbol.name, "structural", position, 3, new Set());

      // Both declaration kinds carry `typeParameters`; gating on the
      // alias kind alone would silently skip every interface's own
      // generics.
      if (resolvedDecl.typeParameters !== undefined) {
        for (const tp of resolvedDecl.typeParameters) {
          const constraintNode = tp.constraint ?? tp.default;
          if (constraintNode === undefined) continue;
          const constraintType = checker.getTypeAtLocation(constraintNode);
          const constraintSeen = new Set<ts.Type>();
          checkType(constraintType, symbol.name, "generic-parameter", position, constraintSeen);
          walkStructural(constraintType, symbol.name, "generic-parameter", position, 2, constraintSeen);
        }
      }
      continue;
    }

    // A plain exported binding and `export default <expression>` expose
    // their value type directly. They have no signature for the branch below.
    if (ts.isVariableDeclaration(resolvedDecl) || ts.isBindingElement(resolvedDecl) ||
        ts.isExportAssignment(resolvedDecl)) {
      const valueType = checker.getTypeOfSymbolAtLocation(resolvedSymbol, resolvedDecl);
      const valueSeen = new Set<ts.Type>();
      checkType(valueType, symbol.name, "structural", position, valueSeen);
      walkStructural(valueType, symbol.name, "structural", position, 3, valueSeen);
      // A function-valued binding exposes its signature through the value type.
      walkSignatures(valueType, symbol.name, position);
      continue;
    }

    // Functions and classes: inspect call/construct signatures' return types.
    const symbolType = checker.getTypeOfSymbolAtLocation(resolvedSymbol, resolvedDecl);
    walkSignatures(symbolType, symbol.name, position);
  }

  return dedupe(leaks);
}

// The `seen` guard inside walkStructural/checkType avoids re-flagging the
// exact same `ts.Type` OBJECT twice within one exported symbol's own walk,
// but TS does not always hand back that same object for what is
// conceptually the same type reached two structural ways - measured
// directly on nukadoko's own `used?: UsedEntryWithResult[]`: an optional
// array property's own type argument and its index signature's value type
// resolve to two distinct `ts.Type` instances for the identical
// declaration, so object identity alone under-deduplicates. This same
// under-deduplication already existed before this file ever called
// `getTypeArguments` at all - the version of `checkType` before this
// change had no `seen` check whatsoever, so two different structural
// paths to the same declaration (measured: two union members, each
// independently reaching the same inherited property) each pushed their
// own leak. A content key (which export, which via, which internal
// declaration) is what a reader actually means by "the same finding"
// regardless of which internal TS object or which structural path
// produced it, and collapsing to that key also keeps a todo fingerprint
// (rule+path+evidence) from ever getting two entries for what reads as
// one violation. The key deliberately omits line/column: position is
// always the exported symbol's own declaration site, identical for every
// leak naming that `exportedAs`, so it adds nothing to distinguish by
// today - but if `evidence` ever grows a property-path breadcrumb (rule
// 6's own known gap: two distinct properties leaking the same internal
// type today read identically), this key would need one too, or it would
// start collapsing genuinely different findings instead of duplicates.
function dedupe(leaks: readonly LeakFinding[]): LeakFinding[] {
  const seen = new Set<string>();
  const result: LeakFinding[] = [];
  for (const leak of leaks) {
    const key = `${leak.exportedAs}\n${leak.via}\n${leak.internalType}\n${leak.internalFile}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(leak);
  }
  return result;
}

export type Violation = {
  rule: "type-leak";
  path: string;
  line: number;
  column: number;
  evidence: string;
  because: string;
  do: string;
  todoModule: string;
  leak?: { internalType: string; internalFile: string; exportedAs: string[] };
};

const BECAUSE = "a consumer needs a name for every type it receives from a public surface, not just the type doing the exposing";

// The number of distinct exported symbols named in one violation's own
// evidence before it switches to "and N more" - a real, measured case (a
// heavily-generic library's own client package) had a single internal
// type referenced by 51 different exported symbols; naming all 51 in one
// evidence line stops being readable long before that.
const MAX_NAMED_EXPORTS = 10;

// The marker splitting evidence's own stable identity (which internal
// type, declared where, leaked from which module) from its mutable,
// informational suffix (which exports currently reach it - can grow or
// shrink as the source changes without the leak itself being new or
// gone). todo-store.ts's own fingerprintOf reads this to keep a frozen
// entry from reopening every time one more caller of an already-known
// leak appears - exported so the split lives in one place, not
// duplicated as a second copy of this exact string.
export const REFERENCED_BY_MARKER = " - referenced by ";

// One group per (internal type, internal file) - many exported symbols in
// the same module independently referencing the identical, never-locally-
// exported declaration is one real leak, not one per referencing export.
// Measured directly against a real, large library's own client package:
// 585 raw per-export findings collapsed to 164 distinct (module, internal
// type) pairs this way - the same underlying "this type has no public
// name here" fact was being reported as though it were up to 51 separate
// problems, when fixing it is one re-export, not 51 edits.
type LeakGroup = {
  file: string;
  type: string;
  path: string;
  line: number;
  column: number;
  exportedAs: string[];
};

function groupByInternalType(findings: readonly LeakFinding[], surfacePath: string): Map<string, LeakGroup> {
  const groups = new Map<string, LeakGroup>();
  for (const finding of findings) {
    const key = `${finding.internalFile}\n${finding.internalType}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        file: finding.internalFile,
        type: finding.internalType,
        path: surfacePath,
        line: finding.line,
        column: finding.column,
        exportedAs: [finding.exportedAs],
      });
      continue;
    }
    if (!existing.exportedAs.includes(finding.exportedAs)) existing.exportedAs.push(finding.exportedAs);
    // Earliest position wins, for a deterministic, stable anchor
    // regardless of which surface file or which exported symbol the walk
    // happened to visit first.
    if (finding.line < existing.line || (finding.line === existing.line && finding.column < existing.column)) {
      existing.line = finding.line;
      existing.column = finding.column;
      existing.path = surfacePath;
    }
  }
  return groups;
}

// Two leaks look alike in evidence but need different fixes. A type this
// module owns needs only a name on this surface. A type owned by a module
// with no surface cannot get a public name from this surface at all: that
// module needs a surface, or this surface must stop exposing the type.
// Any other owner (a module with a surface that does not name the type,
// or a file no module declares) keeps the general three-way advice.
function leakDo(
  moduleName: string,
  group: LeakGroup,
  relativeInternalFile: string,
  owner: string | undefined,
  modules: ReadonlyMap<string, { surfaceFiles: string[] }>,
  exportsShown: string,
): string {
  if (owner === moduleName) {
    return `'${group.type}' belongs to module '${moduleName}': export '${group.type}' by name from ${group.path} (it's declared in ${relativeInternalFile})`;
  }
  if (owner !== undefined && (modules.get(owner)?.surfaceFiles.length ?? 0) === 0) {
    return `${exportsShown} reaches '${group.type}', owned by module '${owner}', which has no surface: give '${owner}' a surface that exports '${group.type}', or drop ${exportsShown} from this surface`;
  }
  return `export '${group.type}' by name from ${group.path} (it's declared in ${relativeInternalFile}), change the referencing exports to not expose it, or add ${relativeInternalFile} to this module's own surface`;
}

export function checkTypeLeaks(graph: {
  modules: Map<string, { name: string; dir: string; surfaceFiles: string[]; files?: string[] }>;
  program: ts.Program;
  checker: ts.TypeChecker;
  rootDir: string;
  // Set once module-graph.ts's own `ensureProgram` has already run this
  // exact walk once, against this exact Program, to build the Program
  // itself (its safety net's own round loop) - reused here so a caller
  // that only needs graph.program/graph.checker (this call) does not pay
  // for the whole walk a second time. Skipped when `options.report` is
  // given: that call wants a fresh walk with its own reports, not a
  // stale answer from a possibly earlier round.
  cachedTypeLeaks?: Violation[];
}, options: {
  // The closure safety loop needs unresolved aliases. Silent omission is
  // refused because it can leave a required declaration outside the Program.
  report?: ReportUnresolvedReference;
  // A focused run checks one owner only. Checking every module is refused
  // because the caller would discard all findings from other surfaces.
  focusModuleName?: string;
  // Other modules still provide public names. Omitting those names is refused
  // because an already named declaration would become a false leak.
  extraNamedDeclarationKeys?: ReadonlySet<string>;
} = {}): Violation[] {
  // Forces graph.program/graph.checker first (as this always did): on a
  // graph whose Program was not built yet, that is what populates
  // `cachedTypeLeaks` as a side effect, in time for the check right after.
  void graph.program;
  void graph.checker;
  if (options.report === undefined && graph.cachedTypeLeaks !== undefined) return graph.cachedTypeLeaks;
  const violations: Violation[] = [];
  // Every declared module's own directory, not the whole project root -
  // see detectTypeLeaks' own comment on why a single, broad boundary was
  // measured wrong.
  const moduleBoundaries = [...graph.modules.values()].map((m) => m.dir);
  // Every declaration named by ANY declared module's own surface, computed
  // once for the whole check (not per module): a type a consumer can
  // already import from module B is not a leak in module A's surface
  // either - see collectNamedDeclarations' own header comment.
  const allSurfaceFiles = [...graph.modules.values()].flatMap((m) => m.surfaceFiles);
  const namedDeclarations = collectNamedDeclarations(graph.program, graph.checker, allSurfaceFiles, options.report);

  // Which declared module owns each analyzed file, for the do: line: a
  // type owned by this module needs only a name on this surface, while a
  // type owned by a module with no surface cannot get one from here.
  const ownerOf = new Map<string, string>();
  for (const [name, module] of graph.modules) for (const file of module.files ?? []) ownerOf.set(file, name);

  for (const [name, module] of graph.modules) {
    // The focused Program owns only one module's surface closure. Walking other
    // modules is refused because their absent source files cannot give safe results.
    if (options.focusModuleName !== undefined && name !== options.focusModuleName) continue;
    // A module's surface can be more than one file (a glob, not a single
    // name) - each is walked independently, but grouped together below:
    // the same internal type leaking through two different surface files
    // of the same module is still one fact about that module, not two.
    const groups = new Map<string, LeakGroup>();
    for (const surfacePath of module.surfaceFiles) {
      const sf = graph.program.getSourceFile(surfacePath);
      if (sf === undefined) continue;
      const findings = detectTypeLeaks(
        graph.checker,
        sf,
        moduleBoundaries,
        module.surfaceFiles.filter(p => p !== surfacePath),
        namedDeclarations,
        options.report,
        options.extraNamedDeclarationKeys,
      );
      for (const [key, group] of groupByInternalType(findings, surfacePath)) {
        const existing = groups.get(key);
        if (existing === undefined) {
          groups.set(key, group);
        } else {
          for (const exportedAs of group.exportedAs) {
            if (!existing.exportedAs.includes(exportedAs)) existing.exportedAs.push(exportedAs);
          }
        }
      }
    }

    for (const group of groups.values()) {
      const relativeInternalFile = relative(graph.rootDir, group.file);
      const names = [...group.exportedAs].sort();
      const shown = names.slice(0, MAX_NAMED_EXPORTS).map((n) => `'${n}'`).join(", ");
      const more = names.length > MAX_NAMED_EXPORTS ? ` (and ${names.length - MAX_NAMED_EXPORTS} more)` : "";
      violations.push({
        rule: "type-leak",
        path: group.path,
        line: group.line,
        column: group.column,
        evidence: `'${group.type}', declared in '${relativeInternalFile}', is never exported by name from module '${name}'${REFERENCED_BY_MARKER}${shown}${more}`,
        because: BECAUSE,
        do: leakDo(name, group, relativeInternalFile, ownerOf.get(group.file), graph.modules, shown + more),
        todoModule: name,
        leak: { internalType: group.type, internalFile: group.file, exportedAs: names },
      });
    }
  }
  return violations;
}
