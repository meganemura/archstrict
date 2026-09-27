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
  // Set on every top-level declaration `summarize` below produces (the
  // `decls`/`defaultInfo`/`exportEqualsInfo` entries `computeSyntacticNamedDeclarations`
  // can resolve a name to - never on an `ambient` entry, which no export
  // chain ever resolves a name to). The same (file, line, column) the
  // checker's own declaration node would report through `declarationKey`,
  // computed from the SAME syntax the checker itself binds, so the two
  // never drift apart on a shape both sides can express - see
  // `declarationKey`'s own comment for why position alone, not a node
  // reference, is what a syntactic parse (no bound Program, no live
  // symbol) and a checker's own declaration can still agree on.
  position?: { file: string; line: number; column: number };
  // Set only for `import x = SomeNamespace.Y` (the non-`require` form,
  // the one case `summarize` below still creates a real decl entry for -
  // see its own comment). `computeSyntacticNamedDeclarations` cannot
  // reproduce what the checker resolves this to without binding
  // namespace members, which is out of this module's own syntax-only
  // boundary - resolving a name to one of these reports "unresolvable"
  // rather than guess.
  isImportEquals?: boolean;
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
  // `export default <expr>` where the expression is a single identifier
  // (`export default Foo;`) is an alias to Foo's own declaration, the
  // same as a named re-export - the checker resolves through it, never
  // stopping at the ExportAssignment itself (measured directly). A
  // qualified name (`export default ns.Foo;`) has no single local name
  // to resolve and reports unresolvable instead. undefined for every
  // other `export default <expr>` shape (a class/function expression, a
  // literal, ...), where the ExportAssignment's own position (already on
  // `defaultInfo` above) IS the checker's own answer.
  defaultAlias: { name: string } | { qualified: true } | undefined;
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

// Each bound name, paired with the node the checker itself reports as its
// own declaration - a plain identifier binding (`const x = 1`) resolves to
// the VariableDeclaration itself; a destructured one (`const { a } = x`,
// `const [a] = x`) resolves to that ONE binding element, not the
// declaration as a whole (measured directly against a real checker: two
// names destructured from the same declarator get two different
// positions) - `contextNode` starts as the declaration and becomes each
// binding element in turn as the pattern nests.
function bindingElements(name: ts.BindingName, contextNode: ts.Node, out: { name: string; node: ts.Node }[]): { name: string; node: ts.Node }[] {
  if (ts.isIdentifier(name)) { out.push({ name: name.text, node: contextNode }); return out; }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) bindingElements(element.name, element, out);
  }
  return out;
}

function newInfo(): DeclInfo {
  return { refs: [], imports: [] };
}

// The same (file, line, column) `declarationKey` (below) turns into one
// string - kept as a plain position, not a node reference, so a
// declaration reached through a syntax-only parse (no bound Program, no
// live symbol) can still be compared against one the checker itself
// returned for the identical source text.
function positionOf(node: ts.Node, sf: ts.SourceFile, file: string): { file: string; line: number; column: number } {
  const start = node.getStart(sf);
  const { line, character } = sf.getLineAndCharacterOfPosition(start);
  return { file, line: line + 1, column: character + 1 };
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
      stars: [], decls: new Map(), defaultInfo: undefined, defaultAlias: undefined, exportEquals: false,
      exportEqualsInfo: undefined, ambient: [],
    };
    summaries.set(file, empty);
    return empty;
  }
  const sf = ts.createSourceFile(file, text, inputs.languageVersion, false, inputs.scriptKindFor(file));
  const summary: FileSummary = {
    missing: false, isScript: !ts.isExternalModule(sf), imports: new Map(), exportsLocal: new Map(),
    reexports: new Map(), stars: [], decls: new Map(), defaultInfo: undefined, defaultAlias: undefined,
    exportEquals: false, exportEqualsInfo: undefined, ambient: [],
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
        info.position = positionOf(statement, sf, file);
        info.isImportEquals = true;
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
      // `export default <expr>` (an anonymous expression, no separate
      // named declaration of its own): the checker's own declaration for
      // it is this ExportAssignment statement itself - EXCEPT when the
      // expression is a single identifier (`export default Foo;`),
      // which is an alias to Foo's own declaration (FileSummary's own
      // `defaultAlias` comment; a qualified name has no local name to
      // resolve, so it is left for the resolver to report unresolvable).
      info.position = positionOf(statement, sf, file);
      if (statement.isExportEquals === true) { summary.exportEquals = true; summary.exportEqualsInfo = info; }
      else {
        summary.defaultInfo = info;
        summary.defaultAlias = seg === undefined ? undefined : seg.length === 1 ? { name: seg[0]! } : { qualified: true };
      }
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
        // Each bound name gets its OWN position (bindingElements' own
        // comment) - a shared `info` object would give every name
        // destructured from the same declarator the same position,
        // which the checker itself never does.
        for (const { name, node } of bindingElements(declaration.name, declaration, [])) {
          addDecl(name, { refs: info.refs, imports: info.imports, position: positionOf(node, sf, file) });
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
      info.position = positionOf(statement, sf, file);
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

// A resolved edge that isn't real Program source (module-graph.ts's own
// resolvedSpecifiers can carry one - a resolved .js with no declaration
// file, a JSON import, ...) is not a target either builder below can ever
// load - lifted to module scope (not a closure over one `inputs`) so both
// `buildTypeClosure` and `computeSyntacticNamedDeclarations` share the identical
// answer for the identical edge, never two independently-written copies
// that could drift.
function resolveTarget(inputs: TypeClosureInputs, file: string, specifier: string): string | undefined {
  const target = inputs.resolvedSpecifiers.get(file)?.get(specifier);
  return target !== undefined && isProgramSource(target) ? target : undefined;
}

// Whether `file` exports `name` at all, following `export *` (a cyclic
// chain answers false past its own start - the same reasoning
// `reachExport`'s own `done` guard applies, restated per-call here since
// this can run inside more than one root's own walk). This function
// alone does NOT enforce real ESM's own rule that `export *` never
// carries a "default" - it still answers true for a star target with a
// direct default of its own (the `name === "default" &&
// summary.defaultInfo !== undefined` disjunct below matches on THAT
// target file directly, regardless of how it was reached). `reachExport`
// above tolerates the resulting over-inclusion (a star-only re-export of
// "default" it can never really satisfy still marks the target file
// reached) since a bigger-than-needed closure is still a correct one;
// `computeSyntacticNamedDeclarations`'s own resolveNamed cannot tolerate
// that for a NAMED answer, so it never lets `name === "default"` reach
// this function's own stars branch at all (`resolveNamed`'s own comment
// on `export *` and "default" has the caller-side guard).
function hasExport(inputs: TypeClosureInputs, summaries: Summaries, file: string, name: string, seen: Set<string> = new Set()): boolean {
  if (seen.has(file)) return false;
  seen.add(file);
  const summary = summarize(inputs, summaries, file);
  if (summary.exportEquals) return true;
  if (summary.exportsLocal.has(name) || summary.reexports.has(name) || (name === "default" && summary.defaultInfo !== undefined)) return true;
  if (name === "default") return false;
  return summary.stars.some((spec) => {
    const target = resolveTarget(inputs, file, spec);
    return target !== undefined && hasExport(inputs, summaries, target, name, seen);
  });
}

export function buildTypeClosure(inputs: TypeClosureInputs): TypeClosureResult {
  const summaries: Summaries = new Map();
  const closure = new Set<string>();
  const done = new Set<string>();

  function mark(file: string): void { closure.add(file); }

  function resolve(file: string, specifier: string): string | undefined {
    return resolveTarget(inputs, file, specifier);
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
      if (target !== undefined && hasExport(inputs, summaries, target, name)) { mark(file); reachExport(target, name, rest); }
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
  //
  // reachAmbientRoot reaches only the ambient content itself
  // (`summary.ambient`, every `declare global`/`declare module "..."`
  // body) and, for an actual script (no import/export at all - the
  // checker treats it as a global scope, not a module), every one of its
  // top-level declarations - never `reachAllExports` and never every
  // `decls` key unconditionally: an ordinary MODULE that also augments the
  // global scope (`export {}; declare global { ... }`) binds nothing
  // ambient beyond that block, so its own unrelated exports and locals
  // stay reachable the normal way, by whoever actually imports them - not
  // forced in as a root just because the same file also happens to hold a
  // `declare global`. `processInfo` on each reached declaration already
  // follows every type position, inferred reference, and import it
  // actually uses, the same as any other reached declaration - a plain
  // import at the top of an ambient file joins the closure only when one
  // of these declarations references it, never unconditionally.
  function reachAmbientRoot(file: string): void {
    const key = `${file}\0AR`;
    if (done.has(key)) return;
    done.add(key);
    const summary = summarize(inputs, summaries, file);
    if (summary.missing) return;
    mark(file);
    for (const info of summary.ambient) processInfo(file, info);
    if (summary.isScript) {
      for (const name of summary.decls.keys()) reachLocal(file, name);
    }
  }
  for (const file of inputs.ambientFiles) reachAmbientRoot(file);

  return { files: [...closure].sort() };
}

export type NamedDeclarationsResult = { keys: ReadonlySet<string>; unresolvable: boolean };

// The one place a checker-derived declaration (type-leak.ts's own
// `collectNamedDeclarations`) and a syntactically-parsed one (this
// module's own `computeSyntacticNamedDeclarations`, below) are turned into
// the same string, so the two can be compared - or merged into one set -
// by value, never by object identity (a syntactic parse has no bound
// Program, so it can never share a node reference with the checker's
// own). Position alone (file, 1-based line, 1-based column of the
// declaration's own start) is enough: two different declarations can
// never share one file's one offset, so a declared NAME is never part of
// the key at all.
export function declarationKey(file: string, line: number, column: number): string {
  return `${file.replaceAll("\\", "/")}\0${line}\0${column}`;
}

// A SourceFile and its first declaration can start at the same offset.
// Reusing a position key is refused because it can make that declaration public.
export function sourceFileKey(file: string): string {
  return `${file.replaceAll("\\", "/")}\0<sourcefile>`;
}

// The syntactic twin of type-leak.ts's own `collectNamedDeclarations`:
// every declaration a consumer can already reach under some public name,
// computed from syntax alone (export chains, `export *`, aliases - the
// same rules `reachExport`/`hasExport` above already follow for file
// reachability), instead of a bound checker walking a real Program. Exists
// so rule 6 can be scoped to one module's own surface files - a closure
// Program that never loads every OTHER surface's own files still needs to
// know every name those other surfaces expose, the one thing scoping the
// Program cannot also scope away (a type a consumer can already import
// from a module outside the closure is still not a leak).
//
// `unresolvable`: true the moment this walk crosses a shape it cannot
// answer as confidently as the checker would (an `export =` target, or an
// `import x = SomeNamespace.Y` export - DeclInfo's own `isImportEquals`
// comment). The caller falls back to treating every surface as a closure
// root and the checker's own named set when this is true, the same as if
// scoping had never been requested. Silently omitting a name here instead
// would read an already-named declaration as unnamed on its next surface
// - a false leak - so an unresolvable shape stops the whole computation
// rather than under-reporting one name and continuing.
export function computeSyntacticNamedDeclarations(
  inputs: TypeClosureInputs,
  surfaceFiles: readonly string[],
): NamedDeclarationsResult {
  const summaries: Summaries = new Map();
  const keys = new Set<string>();
  let unresolvable = false;
  const resolvedAllExportsOf = new Set<string>();
  const resolvedNames = new Set<string>();

  function addDeclInfo(info: DeclInfo): void {
    // Every DeclInfo this walk can reach `summarize` sets a position on -
    // `isImportEquals` is the one shape known in advance to need the
    // fallback instead (DeclInfo's own comment); a missing position on
    // any other shape would be this module's own bug, not a real project
    // input, so it takes the same safe path rather than silently
    // dropping the name.
    if (info.isImportEquals === true || info.position === undefined) { unresolvable = true; return; }
    keys.add(declarationKey(info.position.file, info.position.line, info.position.column));
  }

  // A namespace-shaped resolution names the target SourceFile. A position
  // key is refused because the first declaration can start at the same offset.
  function addSourceFileKey(target: string): void {
    keys.add(sourceFileKey(target));
  }

  // `export default <expr>` where `expr` is a single identifier
  // (`export default Foo;`) is an alias - resolved exactly like a named
  // export of that local name (FileSummary's own `defaultAlias`
  // comment), never at the ExportAssignment's own position. Every other
  // shape (a class/function expression, a literal, ...) keeps the
  // ExportAssignment's own position, already on `defaultInfo`.
  function resolveDefault(file: string, summary: FileSummary): void {
    const alias = summary.defaultAlias;
    if (alias === undefined) { addDeclInfo(summary.defaultInfo!); return; }
    if ("qualified" in alias) { unresolvable = true; return; }
    const decls = summary.decls.get(alias.name);
    if (decls !== undefined) { for (const info of decls) addDeclInfo(info); return; }
    const binding = summary.imports.get(alias.name);
    if (binding !== undefined) {
      const target = resolveTarget(inputs, file, binding.specifier);
      if (target === undefined) return;
      if (binding.importedName === "*") { addSourceFileKey(target); return; }
      resolveNamed(target, binding.importedName);
      return;
    }
    unresolvable = true;
  }

  // Resolves `file`'s own export named `name` to every real declaration
  // it names - the same priority order `reachExport` follows above (a
  // local export, then `default`, then a named re-export, then `export
  // *`, first match in declared order wins), which is what makes this
  // agree with a real checker on which of two `export *` sources naming
  // the same identifier wins, and on a local export that shadows one.
  function resolveNamed(file: string, name: string): void {
    const key = `${file}\0${name}`;
    if (resolvedNames.has(key)) return;
    resolvedNames.add(key);
    const summary = summarize(inputs, summaries, file);
    if (summary.missing) return; // an edge with no real target: the checker's own symbol there has no declarations either
    if (summary.exportEquals) { unresolvable = true; return; }

    const local = summary.exportsLocal.get(name);
    if (local !== undefined) {
      const decls = summary.decls.get(local);
      if (decls !== undefined) { for (const info of decls) addDeclInfo(info); return; }
      const binding = summary.imports.get(local);
      if (binding !== undefined) {
        const target = resolveTarget(inputs, file, binding.specifier);
        if (target === undefined) return; // an external or unresolved import: no declarations on either side
        // A re-exported namespace import (`import * as NS from "./x";
        // export { NS };`): the checker's own declaration for it is the
        // target's own SourceFile, the same as `export * as ns` below.
        if (binding.importedName === "*") { addSourceFileKey(target); return; }
        resolveNamed(target, binding.importedName);
        return;
      }
      // `exportsLocal` named a local that is neither a real declaration
      // nor an import binding - not a shape this walk expects to exist;
      // treated as unresolvable rather than guessed at.
      unresolvable = true;
      return;
    }
    if (name === "default" && summary.defaultInfo !== undefined) {
      resolveDefault(file, summary);
      return;
    }

    const reexport = summary.reexports.get(name);
    if (reexport !== undefined) {
      const target = resolveTarget(inputs, file, reexport.specifier);
      if (target === undefined) return;
      // `export * as ns from "./x"`: the checker's own declaration for
      // `ns` is `./x`'s own SourceFile (measured directly against a real
      // checker), not any one declaration inside it.
      if (reexport.importedName === "*") { addSourceFileKey(target); return; }
      resolveNamed(target, reexport.importedName);
      return;
    }

    // `export *` never carries a "default" of its own - hasExport's own
    // header - so a plain `export {default as X} from` a star-only
    // source resolves to nothing here too, matching a real checker
    // exactly (measured directly: `getExportsOfModule` gives that name no
    // declarations at all in that shape).
    if (name === "default") return;
    for (const spec of summary.stars) {
      const target = resolveTarget(inputs, file, spec);
      if (target !== undefined && hasExport(inputs, summaries, target, name)) { resolveNamed(target, name); return; }
    }
  }

  // Every name reachable through `file`'s own `export *` chain (not
  // `file`'s own direct names - callers already have those from
  // `exportsLocal`/`reexports`/`defaultInfo` directly) - never "default"
  // (hasExport's own header: `export *` carries no default). `seen`
  // guards a cyclic chain the same way `hasExport`'s own does.
  function collectStarNames(file: string, seen: Set<string> = new Set()): Set<string> {
    const names = new Set<string>();
    if (seen.has(file)) return names;
    seen.add(file);
    const summary = summarize(inputs, summaries, file);
    if (summary.missing) return names;
    for (const name of summary.exportsLocal.keys()) names.add(name);
    for (const name of summary.reexports.keys()) names.add(name);
    for (const spec of summary.stars) {
      const target = resolveTarget(inputs, file, spec);
      if (target !== undefined) for (const name of collectStarNames(target, seen)) names.add(name);
    }
    return names;
  }

  // Every name `file` itself claims to export, including one it only
  // gets through `export *` - the syntactic mirror of `reachAllExports`
  // above, over export NAMES instead of files to load. Every name -
  // direct or star-inherited alike - resolves through `resolveNamed(file,
  // name)`, never `resolveNamed(target, name)` on a star's own target
  // directly: `resolveNamed`'s own stars loop is what decides which of
  // several `export *` sources naming the same identifier wins (the
  // first, in declared order) - calling straight into a star's own
  // target here instead would add every one of them, the same
  // over-inclusion `reachAllExports` above tolerates for file
  // reachability (see hasExport's own header) but a NAMED answer cannot:
  // the checker names exactly one declaration for a colliding name, not
  // every source that happens to offer one.
  function resolveAllExportsOf(file: string): void {
    if (resolvedAllExportsOf.has(file)) return;
    resolvedAllExportsOf.add(file);
    const summary = summarize(inputs, summaries, file);
    if (summary.missing) return;
    if (summary.exportEquals) { unresolvable = true; return; }
    for (const name of summary.exportsLocal.keys()) resolveNamed(file, name);
    for (const name of summary.reexports.keys()) resolveNamed(file, name);
    if (summary.defaultInfo !== undefined) resolveNamed(file, "default");
    for (const spec of summary.stars) {
      const target = resolveTarget(inputs, file, spec);
      if (target === undefined) continue;
      for (const name of collectStarNames(target)) resolveNamed(file, name);
    }
  }

  for (const file of surfaceFiles) resolveAllExportsOf(file);
  return { keys, unresolvable };
}
