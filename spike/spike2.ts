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

  function walkStructural(
    type: ts.Type,
    exportedAs: string,
    via: Leak["via"],
    depth: number,
  ): void {
    if (depth <= 0) return;
    for (const prop of checker.getPropertiesOfType(type)) {
      const decl = prop.valueDeclaration ?? prop.getDeclarations()?.[0];
      if (decl === undefined) continue;
      const propType = checker.getTypeOfSymbolAtLocation(prop, decl);
      const sym = propType.getSymbol() ?? propType.aliasSymbol;
      if (sym !== undefined) {
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
    }
  }

  for (const symbol of exports) {
    const decl = symbol.getDeclarations()?.[0];
    if (decl === undefined) continue;

    if (ts.isTypeAliasDeclaration(decl) || ts.isInterfaceDeclaration(decl)) {
      const type = checker.getDeclaredTypeOfSymbol(symbol);
      walkStructural(type, symbol.name, "structural", 2);

      // Candidate 2: generic type parameters' constraint/default.
      if (ts.isTypeAliasDeclaration(decl) && decl.typeParameters !== undefined) {
        for (const tp of decl.typeParameters) {
          const constraintNode = tp.constraint ?? tp.default;
          if (constraintNode === undefined) continue;
          const constraintType = checker.getTypeAtLocation(constraintNode);
          const sym = constraintType.getSymbol() ?? constraintType.aliasSymbol;
          if (sym !== undefined) {
            const internal = isInternal(sym);
            if (internal !== undefined) {
              leaks.push({
                exportedAs: symbol.name,
                via: "generic-parameter",
                internalType: sym.name,
                internalFile: internal.file,
              });
            }
          }
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
      const returnSym = returnType.getSymbol() ?? returnType.aliasSymbol;
      if (returnSym !== undefined) {
        const internal = isInternal(returnSym);
        if (internal !== undefined) {
          leaks.push({
            exportedAs: symbol.name,
            via,
            internalType: returnSym.name,
            internalFile: internal.file,
          });
        }
      }
      walkStructural(returnType, symbol.name, via, 1);
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
  // Real, read-only: nukadoko's own public entry point already, so this
  // needs no provisional public.ts written into that checkout.
  measure(
    "nukadoko/src/index.ts (real, read-only)",
    NUKADOKO,
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
