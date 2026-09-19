// Spike 2: what counts as a "type leak" — a public
// surface re-exporting or otherwise exposing an internal module's type
// without the consumer having a name for it. Three candidate definitions
// (from the task spec): (1) an inferred return type that structurally
// includes an internal declaration, (2) a generic type parameter's
// constraint or default bound to an internal declaration, (3) any
// property, anywhere in an exported type's shape, whose declaration lives
// outside the public entry point and was never itself exported by name.
// (3) is the general case; (1) and (2) are named subsets of it, counted
// separately so the definition can be picked by what each one catches.
//
// Read-only against nukadoko's real `src/index.ts` — its own public entry
// point already, so no fixture or provisional public.ts is written into
// that checkout. Never modifies nukadoko.
import ts from "typescript";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const NUKADOKO = resolve(process.env.NUKADOKO_SRC ?? join("..", "nukadoko"));
const FIXTURE_ROOT = resolve("spike/fixtures/type-leak");

function loadOptions(projectRoot: string, tsconfigPath?: string): ts.CompilerOptions {
  if (tsconfigPath === undefined) {
    return { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext };
  }
  const { config } = ts.readConfigFile(tsconfigPath, (p) => readFileSync(p, "utf8"));
  return ts.parseJsonConfigFileContent(config, ts.sys, projectRoot).options;
}

type Leak = {
  exportedAs: string;
  via: "inferred-return" | "generic-parameter" | "structural";
  internalType: string;
  internalFile: string;
};

function declaredIn(symbol: ts.Symbol): string | undefined {
  const decl = symbol.getDeclarations()?.[0];
  return decl?.getSourceFile().fileName;
}

function measure(
  label: string,
  projectRoot: string,
  entry: string,
  tsconfigPath?: string,
): void {
  const options = loadOptions(projectRoot, tsconfigPath);
  const program = ts.createProgram({ rootNames: [entry], options });
  const checker = program.getTypeChecker();
  const entrySf = program.getSourceFile(entry);
  if (entrySf === undefined) throw new Error(`could not load ${entry}`);

  const moduleSymbol = checker.getSymbolAtLocation(entrySf);
  if (moduleSymbol === undefined) throw new Error(`${entry} has no module symbol`);
  const exports = checker.getExportsOfModule(moduleSymbol);
  const exportedNames = new Set(exports.map((s) => s.name));

  const leaks: Leak[] = [];

  function isInternal(propSymbol: ts.Symbol): { file: string } | undefined {
    // A generic type parameter (defineStep's own <TArgs, TReturns>) is not a
    // leaked internal type: it's a variable that gets substituted with
    // whatever the call site passes. Its declaration necessarily sits
    // wherever the generic function was written, which is meaningless here.
    // Measured: without this guard, walking defineStep's uninstantiated
    // return type Step<TArgs, TReturns> reports TArgs/TReturns themselves as
    // leaks, which is not what "type leak" means.
    if (propSymbol.flags & ts.SymbolFlags.TypeParameter) return undefined;
    // An anonymous type literal (TS names it "__type", "__object", etc.) has
    // no name a consumer could fail to import in the first place: its shape
    // is already fully expanded wherever it's used. Measured on nukadoko:
    // without this guard, defineStep's `run` property (an inline function
    // type written in Step's own interface body) reports as a leak, though
    // every one of its own parts (StepFixtures, output<TArgs>) is either
    // exported already or a library type.
    if (propSymbol.name.startsWith("__")) return undefined;
    const file = declaredIn(propSymbol);
    if (file === undefined) return undefined;
    if (file === entrySf.fileName) return undefined; // declared at the public entry itself
    if (exportedNames.has(propSymbol.name)) return undefined; // has its own public name
    if (!file.startsWith(projectRoot)) return undefined; // node_modules, lib.d.ts, etc.
    return { file };
  }

  // Checks whether `type` itself is an internal declaration, and records a
  // leak if so. `aliasSymbol` is checked before `getSymbol()`: a property
  // typed with a named alias whose target is a mapped/utility type (e.g.
  // `Readonly<Record<...>>`) resolves `getSymbol()` to that utility type's
  // own anonymous shape, not to the alias a consumer actually sees on
  // hover — checking the alias first is what a consumer's own experience
  // of the type matches. Measured: reversing this order silently dropped
  // `StepFromMap` (an alias over `Readonly<Record<...>>`) from the count.
  function checkType(type: ts.Type, exportedAs: string, via: Leak["via"]): void {
    const sym = type.aliasSymbol ?? type.getSymbol();
    if (sym === undefined) return;
    const internal = isInternal(sym);
    if (internal !== undefined) {
      leaks.push({
        exportedAs,
        via,
        internalType: sym.name,
        internalFile: internal.file,
      });
    }
  }

  // Walks every type reachable from `type`'s own shape: its properties, its
  // index signatures' value types, and (for a union) every constituent —
  // "any property, anywhere in an exported type's shape" (report.md's
  // definition) requires all three, not just direct properties one level
  // down. `seen` guards the recursion against a type that references
  // itself (directly or through a cycle of aliases).
  function walkStructural(
    type: ts.Type,
    exportedAs: string,
    via: Leak["via"],
    depth: number,
    seen: Set<ts.Type> = new Set(),
  ): void {
    if (depth <= 0 || seen.has(type)) return;
    seen.add(type);

    if (type.isUnion()) {
      for (const member of type.types) {
        checkType(member, exportedAs, via);
        walkStructural(member, exportedAs, via, depth - 1, seen);
      }
      return;
    }

    for (const prop of checker.getPropertiesOfType(type)) {
      const decl = prop.valueDeclaration ?? prop.getDeclarations()?.[0];
      if (decl === undefined) continue;
      const propType = checker.getTypeOfSymbolAtLocation(prop, decl);
      checkType(propType, exportedAs, via);
      walkStructural(propType, exportedAs, via, depth - 1, seen);
    }

    for (const indexInfo of checker.getIndexInfosOfType(type)) {
      checkType(indexInfo.type, exportedAs, via);
      walkStructural(indexInfo.type, exportedAs, via, depth - 1, seen);
    }
  }

  for (const symbol of exports) {
    const decl = symbol.getDeclarations()?.[0];
    if (decl === undefined) continue;

    if (ts.isTypeAliasDeclaration(decl) || ts.isInterfaceDeclaration(decl)) {
      const type = checker.getDeclaredTypeOfSymbol(symbol);
      walkStructural(type, symbol.name, "structural", 3);

      // Candidate 2: generic type parameters' constraint/default. Both
      // declaration kinds carry `typeParameters` (an interface's own
      // generics, e.g. `StepDefinitionInput<TArgs, TReturns, TFrom>`, are
      // exactly as eligible as a type alias's) — gating on the alias kind
      // alone silently skipped every interface. Measured: `StepDefinitionInput`
      // (an interface) has `TFrom extends FromMap<TFrom, TArgs>`, missed
      // until this check covered interfaces too.
      if (decl.typeParameters !== undefined) {
        for (const tp of decl.typeParameters) {
          const constraintNode = tp.constraint ?? tp.default;
          if (constraintNode === undefined) continue;
          const constraintType = checker.getTypeAtLocation(constraintNode);
          checkType(constraintType, symbol.name, "generic-parameter");
          walkStructural(
            constraintType,
            symbol.name,
            "generic-parameter",
            2,
          );
        }
      }
      continue;
    }

    // Functions and classes: inspect call/construct signatures' return types.
    const type = checker.getTypeOfSymbolAtLocation(symbol, decl);
    const signatures = [
      ...type.getCallSignatures(),
      ...type.getConstructSignatures(),
    ];
    for (const sig of signatures) {
      const sigDecl = sig.getDeclaration();
      const hasExplicitReturnType =
        sigDecl !== undefined &&
        ts.isFunctionLike(sigDecl) &&
        sigDecl.type !== undefined;
      const returnType = checker.getReturnTypeOfSignature(sig);
      const via: Leak["via"] = hasExplicitReturnType
        ? "structural"
        : "inferred-return";
      // The return type itself may BE an internal declaration (buildRecord
      // returning InternalRecord directly), not merely contain one nested
      // in a property (wrapRecord returning { record: InternalRecord }).
      // Measured on the fixture below: without this direct check, a
      // function returning a bare internal type was silently missed,
      // since walkStructural only inspects a type's OWN properties, never
      // asks whether the type itself is the leak.
      checkType(returnType, symbol.name, via);
      walkStructural(returnType, symbol.name, via, 2);
    }
  }

  const byVia = {
    "inferred-return": leaks.filter((l) => l.via === "inferred-return").length,
    "generic-parameter": leaks.filter((l) => l.via === "generic-parameter")
      .length,
    structural: leaks.filter((l) => l.via === "structural").length,
  };

  console.log(
    `--- ${label} ---\n` +
      JSON.stringify(
        {
          exportedSymbols: exports.length,
          leaksByDefinition: byVia,
          totalLeaks: leaks.length,
          leaks,
        },
        null,
        2,
      ),
  );
}

function main(): void {
  // A file path argument runs the check scoped to that one file only —
  // what the PostToolUse hook stand-in (spike3-hook.mjs) needs: per-file
  // feedback at edit time, not a whole-project run on every edit.
  const singleFile = process.argv[2];
  if (singleFile !== undefined) {
    measure(singleFile, resolve(singleFile, ".."), resolve(singleFile));
    return;
  }

  // Real, read-only: nukadoko's own public entry point already, so this
  // needs no provisional public.ts written into that checkout.
  measure(
    "nukadoko/src/index.ts (real, read-only)",
    join(NUKADOKO, "src"), // not NUKADOKO itself: node_modules sits there
    // too, and a dependency's own internal types are not nukadoko's
    // boundary to keep. Measured: without narrowing to src/, the walk
    // chased into playwright-core's and zod's own internals and reported
    // 90 "leaks" that are just how those libraries' public types are
    // shaped, nothing nukadoko's public.ts convention could fix.
    join(NUKADOKO, "src", "index.ts"),
    join(NUKADOKO, "tsconfig.json"),
  );
  // Synthetic, deliberately leaky: proves the detector fires on a known
  // positive case, since the real file above turned out to have none.
  measure(
    "spike/fixtures/type-leak/public.ts (synthetic, deliberately leaky)",
    FIXTURE_ROOT,
    join(FIXTURE_ROOT, "public.ts"),
  );
}

main();
