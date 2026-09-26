// Responsibility: compute the file set rule 6's own checker Program must
// load to answer every real type-leak question - not every analyzed file,
// but every file reachable from a module surface by following an export
// chain, a type position, or an unannotated declaration's own inferred
// type, plus every file whose own top-level names are ambient (a script,
// or a `declare global`/`declare module "..."` body) and so bind
// regardless of who imports it. On a large project this closure is a small
// fraction of the analyzed set - the whole reason this module exists is
// that the checker's own bound SourceFile trees, not the edges archstrict
// otherwise builds, dominate memory on a codebase of tens of thousands of
// files.
//
// Boundary: syntax only. Each file is parsed once (createSourceFile,
// setParentNodes false), reduced immediately to a small per-declaration
// summary (which names it exports, which specifiers and identifiers each
// declaration references), and the AST is dropped. Specifier resolution
// never happens here - `resolvedSpecifiers` is the graph's own
// fromFile -> specifier -> resolvedFile edges, already built once by
// module-graph.ts's own per-file walk; asking `ts.resolveModuleName`
// again here would be a second resolution pass over the same specifiers.
// No rule logic and no checker: this module only names the files rule 6's
// own Program needs to see. It never decides whether that set is
// complete - module-graph.ts's own safety net makes that call, from rule
// 6's own real resolution failures on the Program this module's output
// became, not from anything this module reports about itself.
//
// An incomplete closure gets rule 6 wrong in two different directions.
// Within the syntax archstrict analyzes (ESM import/export; `import x =
// require(...)` is counted as unsupported and never followed), the
// rules below guarantee the first: a missing file that holds a
// declaration a reached export or an internal type structurally reaches
// drops a real finding, since the checker would see no declaration at
// all where that file's own export should have resolved. module-graph.ts's
// own safety net guards the second, separately: a missing file that
// holds a hop INSIDE a re-export chain (or a generic constraint's own
// reference) turns a surface's own public name into an error type, so
// rule 6's own "does a consumer already have a name for this" lookup
// reads it as absent, and an internal declaration that already had a
// real public name through that chain reads as newly, wrongly leaked -
// the net recovers this because the chain's own alias resolves to the
// checker's own unknown symbol, a fact rule 6 reports and module-graph.ts
// resolves through the edge records. A lost `export *` target is the
// rules below own responsibility, not the net's: R2 (export chains)
// already follows every file `export * from` can reach, so a missing
// target there is this module's own bug, not a case the net exists to
// paper over.
import ts from "typescript";

// A chain of identifiers/property accesses/qualified names, outermost
// first - `ns.X` becomes `["ns", "X"]`. Anything else (a call, a
// non-identifier member) has no stable name to follow and is not a
// reference this closure can resolve syntactically.
type Reference = string[];

// A specifier this declaration needs a real file for, plus which export
// of that file it needs (`import("./x").Y` -> `{ specifier: "./x",
// qualifier: ["Y"] }`; a bare `import("./x")` type, or a namespace target
// with no further qualifier, has no qualifier at all).
type ImportUse = { specifier: string; qualifier?: string[] };

type DeclInfo = {
  refs: Reference[];
  imports: ImportUse[];
};

type ImportBinding = { specifier: string; importedName: string };

type FileSummary = {
  missing: boolean;
  isScript: boolean;
  imports: Map<string, ImportBinding>; // local name -> where it comes from ("*" importedName means a namespace import)
  exportsLocal: Map<string, string>; // exported name -> local declaration name
  reexports: Map<string, ImportBinding>; // exported name -> { specifier, importedName } ("*" means `export * as n`'s own target)
  stars: string[]; // `export * from "..."` specifiers
  decls: Map<string, DeclInfo[]>; // local declaration name -> each of its declarations' own reference info (overloads: more than one)
  defaultInfo: DeclInfo | undefined; // `export default <expr>`
  exportEquals: boolean;
  exportEqualsInfo: DeclInfo | undefined;
  ambient: DeclInfo[]; // `declare global` / `declare module "..."` bodies
};

export type TypeClosureInputs = {
  readFile: (fileName: string) => string | undefined;
  languageVersion: ts.ScriptTarget;
  scriptKindFor: (fileName: string) => ts.ScriptKind;
  // Every analyzed file module-graph.ts's own per-file walk (walkFileImports)
  // already flagged as ambient (a script, or holding a `declare
  // global`/`declare module "..."` body) - a plain fact about that file's
  // own syntax, computed once during the edge walk every build already
  // does, never reparsed here. An ambient file's own membership never
  // depends on anything importing it, so it cannot be discovered by
  // following edges from a surface the way every other rule below is;
  // this is the one place that needs a list beyond the closure's own reach.
  ambientFiles: readonly string[];
  surfaceFiles: readonly string[];
  // module-graph.ts's own already-resolved edges, keyed by the importing
  // file and then by the specifier text as written.
  resolvedSpecifiers: ReadonlyMap<string, ReadonlyMap<string, string>>;
  // Files a previous round's safety net added (see type-closure's own
  // header and module-graph.ts's own round loop) - reached as a whole
  // file, the same as an ambient root, since nothing below reached it on
  // its own by the time the net fires.
  extraRoots?: readonly string[];
};

export type TypeClosureResult = {
  files: string[];
};

// TypeScript hands back a real resolvedFileName for a target the
// checker can bind (a real .ts/.tsx/.mts/.cts source, or a hand-authored
// .d.ts/.d.mts/.d.cts) - anything else (a resolved .js with no
// declaration file, a JSON import, ...) is not something a Program root
// could type, the same filter module-graph.ts's own resolution loop
// already keeps in mind when deciding whether a target is real project
// source.
function isProgramSource(file: string): boolean {
  return /\.(?:d\.)?[mc]?tsx?$/.test(file);
}

function segmentsOf(node: ts.Node): string[] | undefined {
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isQualifiedName(node)) {
    const left = segmentsOf(node.left);
    return left === undefined ? undefined : [...left, node.right.text];
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
    const left = segmentsOf(node.expression);
    return left === undefined ? undefined : [...left, node.name.text];
  }
  return undefined;
}

function isFunctionLikeWithBody(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isGetAccessorDeclaration(node);
}

function hasExportModifier(node: ts.Node): boolean {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)
    ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}
function hasDefaultModifier(node: ts.Node): boolean {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)
    ?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
}

function bindingNames(name: ts.BindingName, out: string[]): string[] {
  if (ts.isIdentifier(name)) { out.push(name.text); return out; }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) bindingNames(element.name, out);
  }
  return out;
}

function newInfo(): DeclInfo {
  return { refs: [], imports: [] };
}

// A dynamic `import(...)` call's own string-literal argument, or
// undefined for anything else - the one specifier-bearing node shape
// that is a plain CallExpression rather than its own dedicated node kind.
function dynamicImportSpecifier(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword) return undefined;
  const argument = node.arguments[0];
  return argument !== undefined && ts.isStringLiteral(argument) ? argument.text : undefined;
}

// Walks one declaration's own subtree, filling `info`. `inferring` is
// true once a value position with no type annotation has been entered -
// only then does a bare identifier/property-access count as a reference
// at all (an annotated declaration's own body/initializer is never
// walked: the annotation already says everything the checker needs).
function collect(node: ts.Node, info: DeclInfo, inferring: boolean): void {
  const visit = (n: ts.Node, inferHere: boolean): void => {
    const importTypeSpecifier = ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)
      ? n.argument.literal.text : undefined;
    const dynamicSpecifier = dynamicImportSpecifier(n);
    // A dynamic `import(...)` reached while inferring (an unannotated
    // declaration's own value walk) can resolve to any type its target
    // module exports - the same reasoning the inference rule below uses
    // for a static reference, applied to the one import shape a value
    // expression can hold. Always reaches the target whole: this closure
    // decides only which FILE needs loading, never which member of it a
    // caller happens to reach.
    if (dynamicSpecifier !== undefined && inferHere) info.imports.push({ specifier: dynamicSpecifier });

    if (ts.isTypeReferenceNode(n)) {
      const seg = segmentsOf(n.typeName);
      if (seg !== undefined) info.refs.push(seg);
      n.typeArguments?.forEach((a) => visit(a, inferHere));
      return;
    }
    if (ts.isExpressionWithTypeArguments(n)) {
      const seg = segmentsOf(n.expression);
      if (seg !== undefined) info.refs.push(seg); else visit(n.expression, true);
      n.typeArguments?.forEach((a) => visit(a, inferHere));
      return;
    }
    if (ts.isTypeQueryNode(n)) {
      const seg = segmentsOf(n.exprName);
      if (seg !== undefined) info.refs.push(seg);
      n.typeArguments?.forEach((a) => visit(a, inferHere));
      return;
    }
    if (ts.isImportTypeNode(n)) {
      if (importTypeSpecifier !== undefined) {
        info.imports.push({ specifier: importTypeSpecifier, qualifier: n.qualifier ? segmentsOf(n.qualifier) : undefined });
      }
      n.typeArguments?.forEach((a) => visit(a, inferHere));
      return;
    }
    if (ts.isComputedPropertyName(n)) { visit(n.expression, true); return; }
    // An export specifier inside a namespace or ambient-module body
    // (`export { X }`, `export type { X }`) references X the same way a
    // value expression references an identifier - nothing else visits a
    // nested ExportDeclaration, since the top-level walk only reads
    // export declarations that are direct children of a source file.
    if (ts.isExportDeclaration(n)) {
      const spec = n.moduleSpecifier !== undefined && ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : undefined;
      if (n.exportClause !== undefined && ts.isNamedExports(n.exportClause)) {
        for (const element of n.exportClause.elements) {
          const local = (element.propertyName ?? element.name).text;
          if (spec !== undefined) info.imports.push({ specifier: spec, qualifier: [local] });
          else info.refs.push([local]);
        }
      } else if (spec !== undefined) {
        info.imports.push({ specifier: spec });
      }
      return;
    }
    if (inferHere) {
      const seg = (ts.isPropertyAccessExpression(n) || ts.isIdentifier(n)) ? segmentsOf(n) : undefined;
      if (seg !== undefined) { info.refs.push(seg); return; }
    }
    // An annotated function-like/constructor/setter contributes only its
    // signature (parameters, type parameters, return type) - its body is
    // never inferred, since the annotation already fixes what the
    // checker needs. An unannotated one has its body walked in inferring
    // mode instead (the inference rule, below).
    if (isFunctionLikeWithBody(n) || ts.isConstructorDeclaration(n) || ts.isSetAccessorDeclaration(n)) {
      n.typeParameters?.forEach((p) => visit(p, inferHere));
      n.parameters.forEach((p) => visit(p, inferHere));
      if (ts.isMethodDeclaration(n) && n.name !== undefined && ts.isComputedPropertyName(n.name)) visit(n.name, inferHere);
      if (n.type !== undefined) visit(n.type, inferHere);
      else if (n.body !== undefined && isFunctionLikeWithBody(n)) visit(n.body, true);
      return;
    }
    if (ts.isBindingElement(n)) {
      if (n.name !== undefined && ts.isComputedPropertyName(n.name)) visit(n.name, inferHere);
      else if (!ts.isIdentifier(n.name)) visit(n.name, inferHere);
      if (inferHere && n.propertyName !== undefined) visit(n.propertyName, inferHere);
      return;
    }
    if (ts.isVariableDeclaration(n) || ts.isPropertyDeclaration(n) || ts.isParameter(n)) {
      if (n.name !== undefined && ts.isComputedPropertyName(n.name)) visit(n.name, inferHere);
      else if (n.name !== undefined && !ts.isIdentifier(n.name)) visit(n.name, inferHere);
      if (n.type !== undefined) visit(n.type, inferHere);
      else if (n.initializer !== undefined) visit(n.initializer, true);
      return;
    }
    ts.forEachChild(n, (child) => visit(child, inferHere));
  };
  visit(node, inferring);
}

// Per-file cache: every closure reachability function below calls this,
// and a file can be reached more than once (an export chain and a type
// reference can both name the same file) - parsed exactly once either
// way, matching this module's own header.
type Summaries = Map<string, FileSummary>;

function summarize(inputs: TypeClosureInputs, summaries: Summaries, file: string): FileSummary {
  const cached = summaries.get(file);
  if (cached !== undefined) return cached;
  const text = inputs.readFile(file);
  if (text === undefined) {
    const empty: FileSummary = {
      missing: true, isScript: false, imports: new Map(), exportsLocal: new Map(), reexports: new Map(),
      stars: [], decls: new Map(), defaultInfo: undefined, exportEquals: false, exportEqualsInfo: undefined, ambient: [],
    };
    summaries.set(file, empty);
    return empty;
  }
  const sf = ts.createSourceFile(file, text, inputs.languageVersion, false, inputs.scriptKindFor(file));
  const summary: FileSummary = {
    missing: false, isScript: !ts.isExternalModule(sf), imports: new Map(), exportsLocal: new Map(),
    reexports: new Map(), stars: [], decls: new Map(), defaultInfo: undefined, exportEquals: false,
    exportEqualsInfo: undefined, ambient: [],
  };
  const addDecl = (name: string, info: DeclInfo): void => {
    const existing = summary.decls.get(name);
    if (existing === undefined) summary.decls.set(name, [info]); else existing.push(info);
  };
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement)) {
      const spec = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
      const clause = statement.importClause;
      if (clause === undefined || spec === undefined) continue;
      if (clause.name !== undefined) summary.imports.set(clause.name.text, { specifier: spec, importedName: "default" });
      const bindings = clause.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        summary.imports.set(bindings.name.text, { specifier: spec, importedName: "*" });
      } else if (bindings !== undefined) {
        for (const element of bindings.elements) {
          summary.imports.set(element.name.text, { specifier: spec, importedName: (element.propertyName ?? element.name).text });
        }
      }
      continue;
    }
    if (ts.isImportEqualsDeclaration(statement)) {
      // `import x = require("./y")` is out of scope for analysis
      // entirely (module-graph.ts's own walk counts it as unsupported
      // syntax and never resolves it) - `import x = SomeNamespace.Y`
      // (the other, in-scope form) is a real local reference, walked
      // the same way any other declaration is.
      if (!ts.isExternalModuleReference(statement.moduleReference)) {
        const info = newInfo();
        const seg = segmentsOf(statement.moduleReference);
        if (seg !== undefined) info.refs.push(seg);
        addDecl(statement.name.text, info);
        if (hasExportModifier(statement)) summary.exportsLocal.set(statement.name.text, statement.name.text);
      }
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      const spec = statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
      if (statement.exportClause === undefined) { if (spec !== undefined) summary.stars.push(spec); continue; }
      if (ts.isNamespaceExport(statement.exportClause)) {
        if (spec !== undefined) summary.reexports.set(statement.exportClause.name.text, { specifier: spec, importedName: "*" });
        continue;
      }
      for (const element of statement.exportClause.elements) {
        const exported = element.name.text;
        const local = (element.propertyName ?? element.name).text;
        if (spec !== undefined) summary.reexports.set(exported, { specifier: spec, importedName: local });
        else summary.exportsLocal.set(exported, local);
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      const info = newInfo();
      const seg = segmentsOf(statement.expression);
      if (seg !== undefined) info.refs.push(seg); else collect(statement.expression, info, true);
      if (statement.isExportEquals === true) { summary.exportEquals = true; summary.exportEqualsInfo = info; }
      else summary.defaultInfo = info;
      continue;
    }
    // `declare global` (GlobalAugmentation) and `declare module "literal
    // name"` (a StringLiteral name) bind ambient names no import ever
    // names - a plain `namespace X {}`/`declare namespace X {}` (an
    // Identifier name, handled below with every other ordinary
    // declaration) is reachable the normal way and must not double up
    // here.
    if (ts.isModuleDeclaration(statement) &&
        (statement.name.kind === ts.SyntaxKind.StringLiteral || (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0)) {
      const info = newInfo();
      collect(statement, info, false);
      summary.ambient.push(info);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const info = newInfo();
        collect(declaration, info, false);
        for (const name of bindingNames(declaration.name, [])) {
          addDecl(name, info);
          if (hasExportModifier(statement)) summary.exportsLocal.set(name, name);
        }
      }
      continue;
    }
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isClassDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) {
      const name = statement.name !== undefined && ts.isIdentifier(statement.name) ? statement.name.text : undefined;
      const info = newInfo();
      collect(statement, info, false);
      const local = name ?? "default";
      addDecl(local, info);
      if (hasExportModifier(statement)) {
        if (hasDefaultModifier(statement)) summary.exportsLocal.set("default", local);
        else summary.exportsLocal.set(local, local);
      }
      continue;
    }
    // An expression statement, a bare block, ... - not a declaration and
    // not a form any rule above needs; a script file's own effect (R6,
    // below) never depends on what a statement here says.
  }
  summaries.set(file, summary);
  return summary;
}

export function buildTypeClosure(inputs: TypeClosureInputs): TypeClosureResult {
  const summaries: Summaries = new Map();
  const closure = new Set<string>();
  const done = new Set<string>();

  function mark(file: string): void { closure.add(file); }

  function resolve(file: string, specifier: string): string | undefined {
    const target = inputs.resolvedSpecifiers.get(file)?.get(specifier);
    return target !== undefined && isProgramSource(target) ? target : undefined;
  }

  // A declaration actually reached: every rule-followed reference/import
  // is dispatched. module-graph.ts's own safety net (a resolution failure
  // rule 6 itself reports while walking the closure Program this
  // function's own output becomes a root list for - see
  // rules/type-leak.ts's own ReportUnresolvedReference) is a separate
  // pass over the real Program, not this syntactic walk; a net built from
  // the same rules it is meant to catch a gap in could never fire.
  //
  // The inference rule reaches only the identifiers the declaration's
  // initializer or body references, resolved the same way every other
  // reference is - `collect` (above) already recorded every one of them
  // into `info.refs` while walking an unannotated declaration's own
  // value position, so the loop below needs no separate step for it.
  // Reaching every import binding of the file instead doubles rule 6's
  // own Program on a 23,000-file codebase, with no change in findings:
  // every identifier that can shape an inferred type already appears in
  // the expression itself.
  function processInfo(file: string, info: DeclInfo): void {
    for (const ref of info.refs) reachRef(file, ref);
    for (const use of info.imports) {
      const target = resolve(file, use.specifier);
      if (target === undefined) continue;
      if (use.qualifier !== undefined) reachExport(target, use.qualifier[0]!, use.qualifier.slice(1));
      else reachWhole(target);
    }
  }

  function reachRef(file: string, segments: Reference): void {
    const summary = summarize(inputs, summaries, file);
    const [head, ...rest] = segments;
    if (head === undefined) return;
    if (summary.decls.has(head)) reachLocal(file, head);
    const binding = summary.imports.get(head);
    if (binding !== undefined) {
      const target = resolve(file, binding.specifier);
      if (target === undefined) return;
      if (binding.importedName === "*") {
        if (rest.length > 0) reachExport(target, rest[0]!, rest.slice(1));
        else reachWhole(target);
      } else {
        reachExport(target, binding.importedName, rest);
      }
    }
  }

  function reachLocal(file: string, name: string): void {
    const key = `${file}\0L\0${name}`;
    if (done.has(key)) return;
    done.add(key);
    mark(file);
    const summary = summarize(inputs, summaries, file);
    for (const info of summary.decls.get(name) ?? []) processInfo(file, info);
    // A declaration and an import can share one local name only when the
    // import is itself the declaration (there is no local decls entry
    // for a plain re-bound import name) - checked regardless, since a
    // name that is only ever an import binding never appears in `decls`
    // at all, and this call would otherwise never follow it.
    if (summary.imports.has(name)) reachRef(file, [name]);
  }

  function hasExport(file: string, name: string, seen: Set<string> = new Set()): boolean {
    if (seen.has(file)) return false; // a cyclic `export *` chain has no new answer past its own start
    seen.add(file);
    const summary = summarize(inputs, summaries, file);
    if (summary.exportEquals) return true;
    if (summary.exportsLocal.has(name) || summary.reexports.has(name) || (name === "default" && summary.defaultInfo !== undefined)) return true;
    if (name === "default") return false;
    return summary.stars.some((spec) => {
      const target = resolve(file, spec);
      return target !== undefined && hasExport(target, name, seen);
    });
  }

  function reachExport(file: string, name: string, rest: readonly string[] = []): void {
    const key = `${file}\0E\0${name}\0${rest.join(".")}`;
    if (done.has(key)) return;
    done.add(key);
    const summary = summarize(inputs, summaries, file);
    if (summary.missing) return;
    if (summary.exportEquals) {
      mark(file);
      if (summary.exportEqualsInfo !== undefined) processInfo(file, summary.exportEqualsInfo);
      reachWhole(file);
      return;
    }
    const local = summary.exportsLocal.get(name);
    if (local !== undefined) {
      mark(file);
      // `export { ns }` where `ns` is itself a namespace import: the
      // export chain's own target is the imported module, qualified by
      // whatever the caller still needs past this hop.
      if (rest.length > 0 && summary.imports.get(local)?.importedName === "*") reachRef(file, [local, ...rest]);
      else reachLocal(file, local);
      return;
    }
    if (name === "default" && summary.defaultInfo !== undefined) {
      mark(file);
      processInfo(file, summary.defaultInfo);
      return;
    }
    const reexport = summary.reexports.get(name);
    if (reexport !== undefined) {
      mark(file);
      const target = resolve(file, reexport.specifier);
      if (target === undefined) return;
      if (reexport.importedName === "*") {
        if (rest.length > 0) reachExport(target, rest[0]!, rest.slice(1));
        else reachAllExports(target);
      } else {
        reachExport(target, reexport.importedName, rest);
      }
      return;
    }
    for (const spec of summary.stars) {
      const target = resolve(file, spec);
      if (target !== undefined && hasExport(target, name)) { mark(file); reachExport(target, name, rest); }
    }
  }

  function reachAllExports(file: string): void {
    const key = `${file}\0AE`;
    if (done.has(key)) return;
    done.add(key);
    const summary = summarize(inputs, summaries, file);
    if (summary.missing) return;
    mark(file);
    for (const name of summary.exportsLocal.keys()) reachExport(file, name);
    for (const name of summary.reexports.keys()) reachExport(file, name);
    if (summary.defaultInfo !== undefined) reachExport(file, "default");
    if (summary.exportEquals) reachExport(file, "=");
    for (const spec of summary.stars) {
      const target = resolve(file, spec);
      if (target !== undefined) reachAllExports(target);
    }
  }

  function reachWhole(file: string): void {
    const key = `${file}\0W`;
    if (done.has(key)) return;
    done.add(key);
    const summary = summarize(inputs, summaries, file);
    if (summary.missing) return;
    mark(file);
    reachAllExports(file);
    for (const name of summary.decls.keys()) reachLocal(file, name);
    for (const info of summary.ambient) processInfo(file, info);
  }

  for (const file of inputs.surfaceFiles) reachAllExports(file);
  for (const file of inputs.extraRoots ?? []) reachWhole(file);

  // Ambient roots: a script file (no import, no export at all) or a file
  // holding `declare global`/`declare module "..."` binds names no
  // import statement ever names, so nothing above can discover it by
  // following an edge - `inputs.ambientFiles` already names every one
  // (module-graph.ts's own per-file walk flagged each from real syntax,
  // during the pass every build already makes over every analyzed file);
  // this loop parses exactly these, never the rest.
  for (const file of inputs.ambientFiles) reachWhole(file);

  return { files: [...closure].sort() };
}
