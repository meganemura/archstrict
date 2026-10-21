// Responsibility: the tsrs implementation of the edge walk's engine seam
// (edge-engine.ts): parse one analyzed file with tsrs, list its specifiers,
// and resolve each one through a tsrs module resolver. Also owns the tsrs
// server process: loading the package, starting it, reconnecting once
// after it dies, and closing it.
// Boundary: nothing here builds a Program or calls the checker. Two facts
// stay on typescript 6.0.3 even with this engine, because tsrs has no
// equivalent outside a tsrs Program and building one per run measured
// slower than the per-file walk: a file's implied module format
// (ts.getImpliedNodeFormatForFile, computed by the caller) and the usage
// mode of each specifier (ts.getModeForUsageLocation, probed once per
// format below). Neither one parses the analyzed file.
//
// tsrs is loaded with require() at first use, never at import time, so a
// run on the default engine never loads it and a project without it
// installed is unaffected. require() rather than import(): the whole graph
// build is synchronous, and Node loads an ES module through require()
// synchronously (Node 22.12 and later), so no verb has to become async to
// select an engine.
import ts from "typescript";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type * as TsrsSync from "tsrs/unstable/sync";
import type * as TsrsAst from "tsrs/unstable/ast";
import type * as TsrsFs from "tsrs/unstable/fs";
import { compilerDirname } from "./project-path.js";
import { ReportError } from "./report-error.js";
import { TSRS_INSTALL, TSRS_VERSION, onEdgeEngineClose } from "./edge-engine-choice.js";
import { edgeResolutionOf, type EdgeResolution, type EdgeSession, type EdgeSessionInputs,
  type FileImportWalk, type ImportRecord, type ModuleAugmentationSpecifier } from "./edge-engine.js";

type Tsrs = { sync: typeof TsrsSync; ast: typeof TsrsAst; fs: typeof TsrsFs; version: string };

const UNSET = "unset ARCHSTRICT_ENGINE to use the default typescript engine";

function refusal(message: string): ReportError {
  return new ReportError(message, `${TSRS_INSTALL}, or ${UNSET}`);
}

let loaded: Tsrs | undefined;

// archstrict's own location first (an install that hoists tsrs beside
// archstrict), then the project in the working directory (a layout such as
// pnpm's, where archstrict's own node_modules holds only its dependencies,
// and tsrs is the project's dependency, not archstrict's).
function loadTsrs(): Tsrs {
  if (loaded !== undefined) return loaded;
  for (const base of [import.meta.url, pathToFileURL(join(process.cwd(), "package.json")).href]) {
    const require = createRequire(base);
    let version: unknown;
    try { version = (require("tsrs/package.json") as { version?: unknown }).version; } catch { continue; }
    if (version !== TSRS_VERSION) {
      throw refusal(`ARCHSTRICT_ENGINE=tsrs needs tsrs ${TSRS_VERSION}, the version archstrict was checked against; the installed tsrs is ${String(version)}`);
    }
    try {
      loaded = {
        sync: require("tsrs/unstable/sync") as typeof TsrsSync,
        ast: require("tsrs/unstable/ast") as typeof TsrsAst,
        fs: require("tsrs/unstable/fs") as typeof TsrsFs,
        version,
      };
      return loaded;
    } catch (error) {
      throw refusal(`ARCHSTRICT_ENGINE=tsrs, but tsrs ${TSRS_VERSION} could not be loaded on Node ${process.version}: ${messageOf(error)}`);
    }
  }
  throw refusal("ARCHSTRICT_ENGINE=tsrs, but tsrs is not installed where archstrict or the project in the working directory can load it");
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0]!;
}

let api: TsrsSync.API | undefined;
let exitHookInstalled = false;

function startApi(tsrs: Tsrs): TsrsSync.API {
  if (api !== undefined) return api;
  try {
    api = new tsrs.sync.API({ cwd: process.cwd() });
  } catch (error) {
    throw refusal(`ARCHSTRICT_ENGINE=tsrs, but tsrs could not start its native binary on ${process.platform}-${process.arch}: ${messageOf(error)}. ` +
      "tsrs ships binaries for linux x64 and arm64 (glibc and musl) and darwin arm64 only");
  }
  // A caller that never reaches closeEdgeEngine (a test, a thrown verb)
  // still ends the server with this process.
  if (!exitHookInstalled) { exitHookInstalled = true; process.once("exit", closeTsrsEngine); onEdgeEngineClose(closeTsrsEngine); }
  return api;
}

function closeTsrsEngine(): void {
  const current = api;
  api = undefined;
  try { current?.close(); } catch { /* The server is already gone; there is nothing left to close. */ }
}

// The spike killed the server mid-session and the next call threw
// `EBADF: bad file descriptor, write`; a closed pipe can also surface as
// EPIPE. Only these mean "start a new server"; any other error is a real
// answer and propagates unchanged.
function serverGone(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (code === "EBADF" || code === "EPIPE" || code === "ECONNRESET" || code === "ERR_STREAM_DESTROYED") return true;
  return error instanceof Error && /\b(EBADF|EPIPE|ECONNRESET)\b/.test(error.message);
}

// TypeScript 7, which tsrs follows, removed `baseUrl` lookups and the
// node10 and classic resolution strategies. Under those options tsrs gives
// no error, it just resolves fewer specifiers (measured: a `baseUrl` import
// came back unresolved). That is a different graph reported as the same
// project, so the build stops instead. The strategy mirrors typescript
// 6.0.3's own default: classic for module none/amd/umd/system, and a
// node16/nodenext/bundler default for every other module kind.
function unsupportedResolution(options: ts.CompilerOptions): string | undefined {
  if (options.baseUrl !== undefined) return "sets baseUrl";
  const resolution = options.moduleResolution;
  if (resolution === ts.ModuleResolutionKind.Classic) return "sets moduleResolution classic";
  if (resolution === ts.ModuleResolutionKind.Node10) return "sets moduleResolution node10";
  if (resolution === undefined && options.module !== undefined && [ts.ModuleKind.None, ts.ModuleKind.AMD, ts.ModuleKind.UMD, ts.ModuleKind.System].includes(options.module)) {
    return "sets a module kind (none, amd, umd, or system) that resolves with classic";
  }
  return undefined;
}

// typescript 6.0.3's own answer for the two usage shapes the walk records
// without a `resolution-mode` attribute: a static import/export (also an
// import type and an augmentation name, which take the same file-level
// mode) and a dynamic import(). That answer depends only on the options,
// the file's implied format, and whether its extension is .cts/.cjs or
// .mts/.mjs - never on the file's text - so a two-line probe file answers
// it once per combination. Reimplementing TypeScript's rule here was
// refused: it reads four derived compiler options, and a copy would be one
// more place to disagree with the default engine.
type UsageModes = { static: ts.ResolutionMode; dynamic: ts.ResolutionMode };
const usageModeProbes = new WeakMap<ts.CompilerOptions, Map<string, UsageModes>>();

function usageModes(fileName: string, options: ts.CompilerOptions, impliedNodeFormat: ts.ResolutionMode): UsageModes {
  const extension = /\.[cm]ts$|\.[cm]js$/.exec(fileName)?.[0] ?? ".ts";
  const key = `${extension}\0${String(impliedNodeFormat)}`;
  let byKey = usageModeProbes.get(options);
  if (byKey === undefined) { byKey = new Map(); usageModeProbes.set(options, byKey); }
  const cached = byKey.get(key);
  if (cached !== undefined) return cached;
  const probe = ts.createSourceFile(`/archstrict-mode-probe${extension}`, 'import "a";\nimport("b");\n',
    { languageVersion: ts.ScriptTarget.ESNext, impliedNodeFormat }, true, ts.ScriptKind.TS);
  const staticLiteral = (probe.statements[0] as ts.ImportDeclaration).moduleSpecifier as ts.StringLiteral;
  const dynamicLiteral = ((probe.statements[1] as ts.ExpressionStatement).expression as ts.CallExpression).arguments[0] as ts.StringLiteral;
  const modes = {
    static: ts.getModeForUsageLocation(probe, staticLiteral, options),
    dynamic: ts.getModeForUsageLocation(probe, dynamicLiteral, options),
  };
  byKey.set(key, modes);
  return modes;
}

function walkTsrsFile(
  tsrs: Tsrs,
  sf: TsrsAst.SourceFile,
  modes: UsageModes,
): FileImportWalk {
  const { ast } = tsrs;
  const K = ast.SyntaxKind;
  const imports: ImportRecord[] = [];
  let unsupportedSyntaxCount = 0;

  // typescript's getResolutionModeOverride: exactly one attribute, named
  // "resolution-mode" by a string literal, valued "import" or "require".
  const stringLiteralLike = (node: TsrsAst.Node): node is TsrsAst.StringLiteral | TsrsAst.NoSubstitutionTemplateLiteral =>
    ast.isStringLiteral(node) || ast.isNoSubstitutionTemplateLiteral(node);
  const override = (attributes: TsrsAst.ImportAttributes | undefined): ts.ResolutionMode => {
    if (attributes === undefined || attributes.attributes.length !== 1) return undefined;
    const attribute = attributes.attributes[0]!;
    if (!stringLiteralLike(attribute.name) || attribute.name.text !== "resolution-mode") return undefined;
    if (!stringLiteralLike(attribute.value)) return undefined;
    if (attribute.value.text === "import") return ts.ModuleKind.ESNext;
    if (attribute.value.text === "require") return ts.ModuleKind.CommonJS;
    return undefined;
  };

  sf.forEachChild(function walk(node: TsrsAst.Node): undefined {
    let specifier: TsrsAst.Node | undefined;
    let isTypeOnly = false;
    let isDynamic = false;
    let mode: ts.ResolutionMode = modes.static;

    if (ast.isImportDeclaration(node)) {
      specifier = node.moduleSpecifier;
      isTypeOnly = typeOnlyImport(tsrs, node.importClause);
      // typescript honors the attribute on a declaration only when the
      // whole declaration is type-only, not when every specifier is.
      if (node.importClause?.phaseModifier === K.TypeKeyword) mode = override(node.attributes) ?? mode;
    } else if (ast.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      specifier = node.moduleSpecifier;
      isTypeOnly = typeOnlyExport(tsrs, node);
      if (node.isTypeOnly) mode = override(node.attributes) ?? mode;
    } else if (
      ast.isCallExpression(node) &&
      node.expression.kind === K.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ast.isStringLiteral(node.arguments[0])
    ) {
      specifier = node.arguments[0];
      isDynamic = true;
      mode = modes.dynamic;
    } else if (
      ast.isImportTypeNode(node) &&
      ast.isLiteralTypeNode(node.argument) &&
      ast.isStringLiteral(node.argument.literal)
    ) {
      specifier = node.argument.literal;
      isTypeOnly = true;
      mode = override(node.attributes) ?? mode;
    } else if (ast.isImportEqualsDeclaration(node) && ast.isExternalModuleReference(node.moduleReference)) {
      unsupportedSyntaxCount++;
    } else if (ast.isCallExpression(node) && ast.isIdentifier(node.expression) && node.expression.text === "require") {
      unsupportedSyntaxCount++;
    }

    if (specifier !== undefined && ast.isStringLiteral(specifier)) {
      const { line, character } = sf.getLineAndCharacterOfPosition(specifier.getStart(sf));
      imports.push({ specifier: specifier.text, fromPosition: { line: line + 1, column: character + 1 }, isTypeOnly, isDynamic, mode });
    }

    node.forEachChild(walk);
    return undefined;
  });

  const isScript = !ast.isExternalModule(sf);
  const hasAmbientDeclarations = sf.statements.some((statement) =>
    globalAugmentationOrAmbientModule(tsrs, sf, statement) || (isScript && topLevelDeclaration(tsrs, statement)));
  const augmentations: ModuleAugmentationSpecifier[] = [];
  if (!isScript) {
    for (const statement of sf.statements) {
      if (ast.isModuleDeclaration(statement) && ast.isStringLiteral(statement.name)) {
        augmentations.push({ specifier: statement.name.text, mode: modes.static });
      }
    }
  }
  return {
    imports, unsupportedSyntaxCount, isScript, hasAmbientDeclarations,
    hasModuleAugmentation: augmentations.length > 0,
    moduleAugmentationSpecifiers: augmentations,
  };
}

// The same two rules as edge-engine.ts's isEffectivelyTypeOnlyImport and
// isEffectivelyTypeOnlyExport, over tsrs nodes.
function typeOnlyImport(tsrs: Tsrs, clause: TsrsAst.ImportClause | undefined): boolean {
  if (clause === undefined) return false;
  // TypeScript 7 spells `import type` as a phase modifier on the clause.
  if (clause.phaseModifier === tsrs.ast.SyntaxKind.TypeKeyword) return true;
  if (clause.name !== undefined) return false;
  const bindings = clause.namedBindings;
  if (bindings === undefined || tsrs.ast.isNamespaceImport(bindings)) return false;
  return bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
}

function typeOnlyExport(tsrs: Tsrs, node: TsrsAst.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (clause === undefined || !tsrs.ast.isNamedExports(clause)) return false;
  return clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly);
}

// typescript 6.0.3 marks `declare global {}` with a GlobalAugmentation node
// flag; tsrs has no such flag and reports the same `module` keyword for
// `declare global {}` and `module global {}`. The source text tells them
// apart: a global augmentation has no `module` or `namespace` keyword
// before its name.
function globalAugmentationOrAmbientModule(tsrs: Tsrs, sf: TsrsAst.SourceFile, statement: TsrsAst.Statement): boolean {
  const { ast } = tsrs;
  if (!ast.isModuleDeclaration(statement)) return false;
  if (ast.isStringLiteral(statement.name)) return true;
  if (!ast.isIdentifier(statement.name) || statement.name.text !== "global") return false;
  const head = sf.text.slice(statement.getStart(sf), statement.name.getStart(sf))
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ");
  return !/\b(module|namespace)\b/.test(head);
}

function topLevelDeclaration(tsrs: Tsrs, statement: TsrsAst.Statement): boolean {
  const { ast } = tsrs;
  return ast.isInterfaceDeclaration(statement) || ast.isTypeAliasDeclaration(statement) || ast.isClassDeclaration(statement) ||
    ast.isFunctionDeclaration(statement) || ast.isEnumDeclaration(statement) || ast.isModuleDeclaration(statement) ||
    ast.isVariableStatement(statement) ||
    (ast.isImportEqualsDeclaration(statement) && !ast.isExternalModuleReference(statement.moduleReference));
}

export function openTsrsEdgeSession(inputs: EdgeSessionInputs): EdgeSession {
  const tsrs = loadTsrs();
  const resolvers = new Map<ts.CompilerOptions, TsrsSync.ModuleResolver>();
  let snapshot: TsrsSync.Snapshot | undefined;
  let reconnected = false;

  const release = () => {
    for (const resolver of resolvers.values()) { try { resolver.dispose(); } catch { /* its server is gone */ } }
    resolvers.clear();
    try { snapshot?.dispose(); } catch { /* its server is gone */ }
    snapshot = undefined;
  };

  // Every server call goes through here. One reconnect per session: a
  // second failure in the same build is a server that cannot stay up, and
  // retrying it again would loop.
  const call = <T>(operation: (api: TsrsSync.API) => T): T => {
    try {
      return operation(startApi(tsrs));
    } catch (error) {
      if (reconnected || !serverGone(error)) throw error;
      reconnected = true;
      release();
      closeTsrsEngine();
      return operation(startApi(tsrs));
    }
  };

  const overlay = inputs.overlayFiles;
  const snapshotFor = (current: TsrsSync.API): TsrsSync.Snapshot | undefined => {
    if (overlay === undefined || overlay.size === 0) return undefined;
    if (snapshot === undefined) {
      const files = [...overlay].filter((entry): entry is [string, string] => entry[1] !== null);
      const removedPaths = [...overlay].filter(([, content]) => content === null).map(([file]) => file);
      snapshot = current.createSnapshot({ fileSystem: tsrs.fs.createFileSystemLayer(files, { removedPaths }) });
    }
    return snapshot;
  };

  const resolverFor = (current: TsrsSync.API, options: ts.CompilerOptions): TsrsSync.ModuleResolver => {
    let resolver = resolvers.get(options);
    if (resolver === undefined) {
      const reason = unsupportedResolution(options);
      if (reason !== undefined) {
        const config = typeof options.configFilePath === "string" ? options.configFilePath : "the default compiler options";
        throw new ReportError(
          `ARCHSTRICT_ENGINE=tsrs follows TypeScript 7 module resolution, which drops baseUrl lookups and the node10 and classic strategies; ${config} ${reason}, so tsrs would resolve a different graph`,
          `${UNSET} for this project`,
        );
      }
      // typescript 6.0.3's own parsed options, as is: the per-file nearest
      // tsconfig lookup (and its `extends` chain) stays the default
      // engine's, so both engines resolve under one set of options.
      resolver = current.createModuleResolver(options as unknown as TsrsSync.CompilerOptions);
      resolvers.set(options, resolver);
    }
    return resolver;
  };

  return {
    engine: "tsrs",
    cacheTag: `tsrs@${tsrs.version}`,
    walkFile(fileName, text, _languageVersion, compilerOptions, impliedNodeFormat) {
      const modes = usageModes(fileName, compilerOptions, impliedNodeFormat);
      const scriptKind = fileName.endsWith(".tsx") ? tsrs.sync.ScriptKind.TSX : tsrs.sync.ScriptKind.TS;
      return call((current) => {
        const lease = current.createSourceFile(fileName, text, { scriptKind });
        try { return walkTsrsFile(tsrs, lease.sourceFile, modes); }
        finally { lease.dispose(); }
      });
    },
    resolve(specifier, containingFile, compilerOptions, mode): EdgeResolution {
      // tsrs keys resolution by the containing directory, not the file.
      // typescript's own answer depends on the file only through its
      // directory too, once the options are fixed (which they are: one
      // resolver per options object).
      const directory = compilerDirname(containingFile);
      return call((current) => {
        const resolver = resolverFor(current, compilerOptions);
        const layer = snapshotFor(current);
        const result = resolver.resolveModuleName(specifier, directory, mode as TsrsSync.ResolutionMode,
          layer === undefined ? undefined : { snapshot: layer });
        return edgeResolutionOf(result.resolvedModule);
      });
    },
    close: release,
  };
}
