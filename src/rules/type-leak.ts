// Responsibility: rule 6, type leak. A module's public surface re-exports
// or otherwise exposes an internal declaration - one that lives outside
// the surface file, inside this project's own checked source, and was
// never itself exported by name from that surface - without the consumer
// having a name for it. Promoted from a spike once its definition settled
// (three candidates converged on one general case: a structural leak,
// which subsumes an inferred-return-type leak and a generic-parameter
// leak as named subsets, kept as their own `via` tag rather than a
// separate rule each).
// Boundary: pure predicate over a ModuleGraph (its shared program and
// checker) and a boundary root. No I/O, no output formatting.
import ts from "typescript";
import { relative } from "node:path";

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
): LeakFinding[] {
  const boundaryRoots = typeof boundaryRoot === "string" ? [boundaryRoot] : boundaryRoot;
  const moduleSymbol = checker.getSymbolAtLocation(entrySf);
  if (moduleSymbol === undefined) return [];
  const exports = checker.getExportsOfModule(moduleSymbol);
  const exportedNames = new Set(exports.map((s) => s.name));

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
    if (file === entrySf.fileName) return undefined; // declared at the surface itself
    if (exportedNames.has(symbol.name)) return undefined; // has its own public name
    // TS file names are always forward-slash; boundaryRoot comes from
    // node:path's own join/dirname, which uses the platform separator on
    // Windows - a plain startsWith would then read every declaration as
    // outside the boundary there (the same class of bug moduleForFile in
    // module-graph.ts already hit and fixed with the same relative()
    // check). This also closes a prefix hole a plain startsWith has even
    // on one platform: "src-other" starts with "src" as a string.
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
    const isInsideAnyBoundary = boundaryRoots.some((root) => {
      const rel = relative(root, file);
      return !(rel.startsWith("..") || rel === file); // rel === file: outside entirely (relative() returns the input unchanged across drives on Windows)
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

  // Walks every type reachable from `type`'s own shape: its properties,
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

    // Functions and classes: inspect call/construct signatures' return types.
    const symbolType = checker.getTypeOfSymbolAtLocation(resolvedSymbol, resolvedDecl);
    const signatures = [...symbolType.getCallSignatures(), ...symbolType.getConstructSignatures()];
    for (const sig of signatures) {
      const sigDecl = sig.getDeclaration();
      const hasExplicitReturnType = sigDecl !== undefined && ts.isFunctionLike(sigDecl) && sigDecl.type !== undefined;
      const returnType = checker.getReturnTypeOfSignature(sig);
      const via: Via = hasExplicitReturnType ? "structural" : "inferred-return";
      // The return type itself may BE an internal declaration, not
      // merely contain one nested in a property - walkStructural only
      // inspects a type's own properties, never the type itself.
      const returnSeen = new Set<ts.Type>();
      checkType(returnType, symbol.name, via, position, returnSeen);
      walkStructural(returnType, symbol.name, via, position, 2, returnSeen);
    }
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
  next: string;
  todoModule: string;
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

export function checkTypeLeaks(graph: {
  modules: Map<string, { name: string; dir: string; surfaceFiles: string[] }>;
  program: ts.Program;
  checker: ts.TypeChecker;
  rootDir: string;
}): Violation[] {
  const violations: Violation[] = [];
  // Every declared module's own directory, not the whole project root -
  // see detectTypeLeaks' own comment on why a single, broad boundary was
  // measured wrong.
  const moduleBoundaries = [...graph.modules.values()].map((m) => m.dir);

  for (const [name, module] of graph.modules) {
    // A module's surface can be more than one file (a glob, not a single
    // name) - each is walked independently, but grouped together below:
    // the same internal type leaking through two different surface files
    // of the same module is still one fact about that module, not two.
    const groups = new Map<string, LeakGroup>();
    for (const surfacePath of module.surfaceFiles) {
      const sf = graph.program.getSourceFile(surfacePath);
      if (sf === undefined) continue;
      const findings = detectTypeLeaks(graph.checker, sf, moduleBoundaries);
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
        next: `export '${group.type}' by name from ${group.path} (it's declared in ${relativeInternalFile}), or change the referencing exports to not expose it`,
        todoModule: name,
      });
    }
  }
  return violations;
}
