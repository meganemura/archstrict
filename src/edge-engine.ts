// Responsibility: the edge walk's engine seam - parse one analyzed file,
// list its import/export/dynamic-import/import-type specifiers, and resolve
// each one to a file. Two engines implement it: typescript 6.0.3 (the
// default, and the code this walk always ran) and tsrs (opt-in through
// ARCHSTRICT_ENGINE=tsrs, edge-engine-tsrs.ts; the choice itself is
// edge-engine-choice.ts).
// Boundary: per-file syntax and per-specifier resolution only. Module
// membership, builtins, caches, and the edge records themselves stay in
// module-graph.ts. Rule 6, search, fix, and everything else that needs a
// ts.Program, the checker, or a CompilerHost stay on typescript 6.0.3 with
// either engine: tsrs answers each checker call over IPC, which measured 6
// to 13 times slower than the in-process checker for rule 6's walk.
import ts from "typescript";
import { edgeEngineFromEnvironment, type EdgeEngineName } from "./edge-engine-choice.js";
import { openTsrsEdgeSession } from "./edge-engine-tsrs.js";

export type Position = { line: number; column: number };

// The outcome of resolving one specifier, in the shape the edge cache
// stores - an engine's own result object never leaves this seam.
export type EdgeResolution = { resolvedFile: string; isExternalLibraryImport?: true; packageName?: string } | "unresolved";

export type EdgeSessionInputs = {
  // The typescript engine resolves through this host and these caches,
  // exactly as the edge walk did before the seam existed.
  host: ts.ModuleResolutionHost;
  resolutionCacheFor(options: ts.CompilerOptions): ts.ModuleResolutionCache;
  // simulate's in-memory change set (null deletes a file). The typescript
  // engine already sees it through `host`; tsrs has no host, so it gets the
  // same files as a filesystem layer over the disk.
  overlayFiles?: ReadonlyMap<string, string | null>;
};

// One graph build's use of an engine. `close` releases what the build
// opened (tsrs resolvers, a snapshot); the tsrs server process itself
// outlives a session so a long-lived MCP server does not respawn it per
// call - edge-engine-choice.ts's closeEdgeEngine ends it.
export type EdgeSession = {
  readonly engine: EdgeEngineName;
  // Part of the edge cache's identity: an entry one engine wrote is never
  // read back as the other engine's answer.
  readonly cacheTag: string;
  walkFile(
    fileName: string,
    text: string,
    languageVersion: ts.ScriptTarget,
    compilerOptions: ts.CompilerOptions,
    impliedNodeFormat: ts.ResolutionMode,
  ): FileImportWalk;
  resolve(specifier: string, containingFile: string, compilerOptions: ts.CompilerOptions, mode: ts.ResolutionMode): EdgeResolution;
  close(): void;
};

export function openEdgeSession(inputs: EdgeSessionInputs, env: NodeJS.ProcessEnv = process.env): EdgeSession {
  return edgeEngineFromEnvironment(env) === "tsrs" ? openTsrsEdgeSession(inputs) : openTypescriptEdgeSession(inputs);
}

// Converts an engine's result to the cached shape. Both engines use it, so
// both record the same three facts.
export function edgeResolutionOf(resolved: {
  resolvedFileName: string; isExternalLibraryImport?: boolean | undefined; packageId?: { name: string } | undefined;
} | null | undefined): EdgeResolution {
  // tsrs answers an unresolved specifier with null, typescript with undefined.
  return resolved === undefined || resolved === null ? "unresolved" : {
    resolvedFile: resolved.resolvedFileName,
    ...(resolved.isExternalLibraryImport ? { isExternalLibraryImport: true as const } : {}),
    ...(resolved.packageId?.name !== undefined ? { packageName: resolved.packageId.name } : {}),
  };
}

function openTypescriptEdgeSession(inputs: EdgeSessionInputs): EdgeSession {
  const { host, resolutionCacheFor } = inputs;
  return {
    engine: "typescript",
    cacheTag: "typescript",
    walkFile: (fileName, text, languageVersion, compilerOptions, impliedNodeFormat) =>
      parseFileForImports(fileName, text, languageVersion, compilerOptions, impliedNodeFormat),
    // No redirected project reference: the edge walk resolves every
    // analyzed file under its own nearest tsconfig, never through one.
    resolve: (specifier, containingFile, compilerOptions, mode) => edgeResolutionOf(ts.resolveModuleName(
      specifier, containingFile, compilerOptions, host, resolutionCacheFor(compilerOptions), undefined, mode,
    ).resolvedModule),
    close: () => {},
  };
}

// A named import/export clause is type-only either as a whole
// (`import type { X } from "..."`) or per specifier
// (`import { type X } from "..."`, the modifier on one named binding
// rather than the whole declaration) - TypeScript allows both forms, and
// only the first was ever checked here (measured directly: a minimal
// two-module fixture whose only edge is `import { type X } from "../b"`
// reported `isTypeOnly: false`, producing a false-positive cycle with a
// real value edge the other way). A default import binding
// (`import Foo, { type X } from "..."`) can never be per-specifier
// type-only itself, so its presence always makes the whole import a real
// value reference regardless of any named specifier's own modifier; same
// for a namespace import (`import * as X`), which has no per-specifier
// form at all. So: type-only only when the whole declaration says so, OR
// every named specifier does and neither a default nor a namespace
// binding exists on the same declaration.
function isEffectivelyTypeOnlyImport(importClause: ts.ImportClause | undefined): boolean {
  if (importClause === undefined) return false; // a side-effect-only `import "./x"` is a real reference
  if (importClause.isTypeOnly) return true;
  if (importClause.name !== undefined) return false;
  const bindings = importClause.namedBindings;
  if (bindings === undefined || ts.isNamespaceImport(bindings)) return false;
  return bindings.elements.length > 0 && bindings.elements.every((el) => el.isTypeOnly);
}

// The export-side twin of isEffectivelyTypeOnlyImport - `export { type X }
// from "..."` has the identical per-specifier-vs-whole-declaration
// distinction `export type { X } from "..."` already gets right.
function isEffectivelyTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (clause === undefined || !ts.isNamedExports(clause)) return false;
  return clause.elements.length > 0 && clause.elements.every((el) => el.isTypeOnly);
}

// One import/export/dynamic-import specifier found while walking a single
// file, before resolution - resolution needs the file's own nearest
// compiler options and a live host, neither of which this record carries,
// so it is a pure, resolution-independent fact about the file's own
// syntax. warm-graph.ts caches exactly this shape (keyed by file path and
// mtime) to skip re-parsing an unchanged file while still resolving every
// specifier afresh on each refresh.
export type ImportRecord = {
  specifier: string;
  fromPosition: Position;
  isTypeOnly: boolean;
  isDynamic: boolean;
  // undefined moduleKind vs resolutionMode strings: same TS enum
  // (ResolutionMode is ModuleKind.CommonJS | ModuleKind.ESNext |
  // undefined) - undefined under a resolution strategy that does not
  // vary by usage (classic, and node10/"node" without package.json
  // exports/imports resolution), and defined under node16/nodenext and
  // bundler, which pick export conditions by it. Computed here,
  // from the real AST node (the one place that still has it - see this
  // module-graph.ts's own header on staying AST-free past this walk), so the
  // resolver never re-parses a file just to learn a specifier's own mode.
  mode: ts.ResolutionMode;
};

export type ModuleAugmentationSpecifier = {
  specifier: string;
  mode: ts.ResolutionMode;
};

export type FileImportWalk = {
  imports: ImportRecord[];
  unsupportedSyntaxCount: number;
  // Both read by type-closure.ts's own ambient-root rule (R6): a file
  // with neither import nor export binds its own top-level names into
  // the global scope, the same as a `declare global` or a
  // `declare module "literal name"` body does from inside a real module.
  // Computed once here, from real syntax, so the closure never re-parses
  // a file just to answer this - see walkFileImports' own header.
  isScript: boolean;
  hasAmbientDeclarations: boolean;
  // A module augmentation can add names outside a focused Program. A later
  // reparse is refused because this walk already has the required syntax.
  hasModuleAugmentation: boolean;
  // The guard resolves only these syntax-owned targets. Treating every
  // augmentation as local is refused because external packages are common.
  moduleAugmentationSpecifiers: ModuleAugmentationSpecifier[];
};

// A top-level string-named module declaration carries the only syntax the
// scoped safety guard needs. Keeping this extraction separate is required
// because non-analyzed files must not pay for the full import walk.
export function moduleAugmentationSpecifiers(
  sf: ts.SourceFile,
  compilerOptions: ts.CompilerOptions,
  includeScripts: boolean,
): ModuleAugmentationSpecifier[] {
  // A script declaration defines an ambient module. The analyzed-file walk
  // refuses to label it as an augmentation because the script is a root.
  if (!includeScripts && !ts.isExternalModule(sf)) return [];
  const result: ModuleAugmentationSpecifier[] = [];
  for (const statement of sf.statements) {
    if (!ts.isModuleDeclaration(statement) || !ts.isStringLiteral(statement.name)) continue;
    result.push({
      specifier: statement.name.text,
      mode: ts.getModeForUsageLocation(sf, statement.name, compilerOptions),
    });
  }
  return result;
}

// TypeScript's own default (ensureScriptKind, applied when a caller of
// ts.createSourceFile omits scriptKind) already maps every analyzed
// extension this way - .tsx to TSX, everything else (.ts/.mts/.cts) to
// plain TS, since ts.ScriptKind itself has no separate Mts/Cts member.
// Made explicit here rather than left to that implicit default: this
// project's per-file parse is deliberate about which of TypeScript's own
// two source dialects (JSX-capable or not) it invokes, not a place that
// should silently follow whatever TypeScript's own default happens to be
// this version. Exported: warm-graph.ts's own per-file cache parses a
// file the same way, outside this module's own buildPreparedGraph.
export function scriptKindForFile(fileName: string): ts.ScriptKind {
  return fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

// The per-file half of the edge walk: every import/export/dynamic-import/
// import-type specifier syntax recognizes, plus a count of syntax it doesn't
// (require(), import x = require(...)) - no resolution, no Program, no
// module graph. Kept separate from buildPreparedGraph's own resolution
// loop below so warm-graph.ts can memoize exactly this part.
// `compilerOptions` is this file's own effective options (compilerOptionsForFile,
// not necessarily the project root's) - passed through unchanged to
// ts.getModeForUsageLocation for every specifier, so the mode recorded
// here is the same one the resolver (buildPreparedGraph's own
// resolveModule) will resolve that same specifier under. `sf` must have
// been parsed with `setParentNodes: true`: getModeForUsageLocation reads
// `usage.parent` (and, for `import type ... with { "resolution-mode" }`,
// `usage.parent.parent`) - measured directly, a parent-less literal makes
// it throw rather than return undefined.
export function walkFileImports(sf: ts.SourceFile, compilerOptions: ts.CompilerOptions): FileImportWalk {
  const imports: ImportRecord[] = [];
  let unsupportedSyntaxCount = 0;

  ts.forEachChild(sf, function walk(node) {
    let specifier: ts.Expression | undefined;
    let isTypeOnly = false;
    let isDynamic = false;

    if (ts.isImportDeclaration(node)) {
      specifier = node.moduleSpecifier;
      isTypeOnly = isEffectivelyTypeOnlyImport(node.importClause);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      specifier = node.moduleSpecifier;
      isTypeOnly = isEffectivelyTypeOnlyExport(node);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifier = node.arguments[0];
      isDynamic = true;
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      // `import("./x").Y` in a type position: a real type dependency on
      // the target file, not syntax that merely mentions a module name.
      // Recorded as type-only (never dynamic - "dynamic" here means the
      // runtime `import()` expression, which this is not) so rule 1
      // (public-surface bypass) and the edge constraints see it; without
      // this, `import("../b/internal.js").T` reached past a surface unseen.
      specifier = node.argument.literal;
      isTypeOnly = true;
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      // `import x = require("./y")`: a CommonJS-only form, outside the
      // ESM scope this project analyzes.
      unsupportedSyntaxCount++;
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      unsupportedSyntaxCount++;
    }

    if (specifier !== undefined && ts.isStringLiteral(specifier)) {
      const start = specifier.getStart(sf);
      const { line, character } = sf.getLineAndCharacterOfPosition(start);
      imports.push({
        specifier: specifier.text,
        fromPosition: { line: line + 1, column: character + 1 },
        isTypeOnly,
        isDynamic,
        mode: ts.getModeForUsageLocation(sf, specifier, compilerOptions),
      });
    }

    ts.forEachChild(node, walk);
  });

  const isScript = !ts.isExternalModule(sf);
  const hasAmbientDeclarations = sf.statements.some((statement) =>
    isGlobalAugmentationOrAmbientModule(statement) || (isScript && isTopLevelDeclaration(statement)));
  const augmentations = moduleAugmentationSpecifiers(sf, compilerOptions, false);
  return {
    imports, unsupportedSyntaxCount, isScript, hasAmbientDeclarations,
    hasModuleAugmentation: augmentations.length > 0,
    moduleAugmentationSpecifiers: augmentations,
  };
}

// Parses one file with typescript 6.0.3 and walks it for imports: the
// default engine, and the one place its parse happens, so the edge walk
// and warm-graph.ts compute the same resolution mode the same way.
// `impliedNodeFormat` (needed before the mode of any specifier inside can
// be known - see walkFileImports' own header) is the caller's, from
// ts.getImpliedNodeFormatForFile, so both engines read one answer for it.
// `setExternalModuleIndicator` is deliberately NOT set here (unlike a real
// ts.Program, which sets it via getSetExternalModuleIndicator): that
// indicator, not impliedNodeFormat, decides `isScript` (via
// ts.isExternalModule) for a file with no import/export syntax of its own,
// and setting it would reclassify an import-less "type": "module" file as
// a module.
export function parseFileForImports(
  fileName: string,
  text: string,
  languageVersion: ts.ScriptTarget,
  compilerOptions: ts.CompilerOptions,
  impliedNodeFormat: ts.ResolutionMode,
): FileImportWalk {
  const sf = ts.createSourceFile(fileName, text, { languageVersion, impliedNodeFormat }, true, scriptKindForFile(fileName));
  return walkFileImports(sf, compilerOptions);
}

// `declare global { ... }` (GlobalAugmentation) or `declare module "literal
// name"` (a StringLiteral name) - binds names no import ever names,
// unlike a plain `namespace X {}`/`declare namespace X {}` (an Identifier
// name), which is an ordinary, reachable local declaration.
function isGlobalAugmentationOrAmbientModule(statement: ts.Statement): boolean {
  return ts.isModuleDeclaration(statement) &&
    (statement.name.kind === ts.SyntaxKind.StringLiteral || (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0);
}

// Every top-level statement shape type-closure.ts's own per-file summary
// treats as a named declaration - mirrored here only to decide whether a
// script file actually binds anything into the global scope, not to
// summarize its own references (that stays type-closure.ts's own job).
function isTopLevelDeclaration(statement: ts.Statement): boolean {
  return ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isClassDeclaration(statement) ||
    ts.isFunctionDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement) ||
    ts.isVariableStatement(statement) ||
    (ts.isImportEqualsDeclaration(statement) && !ts.isExternalModuleReference(statement.moduleReference));
}
