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

// Detects every structural type leak reachable from `entrySf`'s own
// exports - the core algorithm, independent of archstrict's module
// concept, so it can run both per-module (checkTypeLeaks below) and
// directly against an arbitrary entry file (nukadoko's own src/index.ts,
// in test/type-leak.test.ts, matching this rule's own promoted-from-spike
// history).
export function detectTypeLeaks(checker: ts.TypeChecker, entrySf: ts.SourceFile, boundaryRoot: string): LeakFinding[] {
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
    const rel = relative(boundaryRoot, file);
    if (rel.startsWith("..") || rel === file) return undefined; // outside boundaryRoot entirely (relative() returns the input unchanged across drives on Windows)
    return { file };
  }

  // A property typed with a named alias whose target is a mapped/utility
  // type resolves `getSymbol()` to that utility type's own anonymous
  // shape, not the alias a consumer actually sees on hover - checking
  // `aliasSymbol` first matches what a consumer's own experience of the
  // type is.
  function checkType(type: ts.Type, exportedAs: string, via: Via, position: { line: number; column: number }): void {
    const sym = type.aliasSymbol ?? type.getSymbol();
    if (sym === undefined) return;
    const internal = isInternal(sym);
    if (internal !== undefined) {
      leaks.push({ exportedAs, via, internalType: sym.name, internalFile: internal.file, ...position });
    }
  }

  // Walks every type reachable from `type`'s own shape: its properties,
  // its index signatures' value types, and (for a union) every
  // constituent - "any property, anywhere in an exported type's shape"
  // requires all three, not just direct properties one level down.
  // `seen` guards against a type that references itself, directly or
  // through a cycle of aliases.
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
        checkType(member, exportedAs, via, position);
        walkStructural(member, exportedAs, via, position, depth - 1, seen);
      }
      return;
    }

    for (const prop of checker.getPropertiesOfType(type)) {
      const decl = prop.valueDeclaration ?? prop.getDeclarations()?.[0];
      if (decl === undefined) continue;
      const propType = checker.getTypeOfSymbolAtLocation(prop, decl);
      checkType(propType, exportedAs, via, position);
      walkStructural(propType, exportedAs, via, position, depth - 1, seen);
    }

    for (const indexInfo of checker.getIndexInfosOfType(type)) {
      checkType(indexInfo.type, exportedAs, via, position);
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
          checkType(constraintType, symbol.name, "generic-parameter", position);
          walkStructural(constraintType, symbol.name, "generic-parameter", position, 2, new Set());
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
      checkType(returnType, symbol.name, via, position);
      walkStructural(returnType, symbol.name, via, position, 2, new Set());
    }
  }

  return leaks;
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

export function checkTypeLeaks(graph: {
  modules: Map<string, { name: string; surfacePath: string | undefined }>;
  program: ts.Program;
  checker: ts.TypeChecker;
  rootDir: string;
}): Violation[] {
  const violations: Violation[] = [];
  for (const [name, module] of graph.modules) {
    if (module.surfacePath === undefined) continue;
    const sf = graph.program.getSourceFile(module.surfacePath);
    if (sf === undefined) continue;
    const findings = detectTypeLeaks(graph.checker, sf, graph.rootDir);
    for (const finding of findings) {
      const relativeInternalFile = relative(graph.rootDir, finding.internalFile);
      violations.push({
        rule: "type-leak",
        path: module.surfacePath,
        line: finding.line,
        column: finding.column,
        evidence: `'${finding.exportedAs}' (${finding.via}) references '${finding.internalType}', declared in '${relativeInternalFile}', which module '${name}' never exports by name`,
        because: BECAUSE,
        next: `export '${finding.internalType}' by name from ${module.surfacePath} (it's declared in ${relativeInternalFile}), or change '${finding.exportedAs}' to not expose it`,
        todoModule: name,
      });
    }
  }
  return violations;
}
