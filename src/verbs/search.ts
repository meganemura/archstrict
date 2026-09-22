// Responsibility: rank public surface exports by name-token overlap with a query.
// Boundary: reads declared modules; does not search private declarations or change project files.
import { resolve } from "node:path";
import ts from "typescript";
import { buildPreparedGraph, prepareGraph, toProjectRelativePosix } from "../module-graph.js";
import { loadConfig } from "./check.js";

export type SearchMatch = {
  module: string;
  surface: string;
  name: string;
  kind: "function" | "class" | "interface" | "type-alias" | "enum" | "variable" | "namespace" | "other";
  signature: string;
  score: number;
};
export type SearchResult = { query: string; total: number; shown: number; matches: SearchMatch[] };

// Punctuation alone leaves JSONConfig as one token. These transitions separate
// lowercase from uppercase and an acronym from the next word without splitting its letters.
// Thus parseJSONConfig becomes ["parse", "json", "config"], not separate acronym letters.
export function tokenize(text: string): string[] {
  return text.replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/).filter(Boolean).map(token => token.toLowerCase());
}

function kindOf(symbol: ts.Symbol): SearchMatch["kind"] {
  if (symbol.flags & ts.SymbolFlags.Function) return "function";
  if (symbol.flags & ts.SymbolFlags.Class) return "class";
  if (symbol.flags & ts.SymbolFlags.Interface) return "interface";
  if (symbol.flags & ts.SymbolFlags.TypeAlias) return "type-alias";
  if (symbol.flags & ts.SymbolFlags.Enum) return "enum";
  if (symbol.flags & ts.SymbolFlags.Variable) return "variable";
  if (symbol.flags & ts.SymbolFlags.Module) return "namespace";
  return "other";
}

// Interfaces and type aliases have no value type; they need getDeclaredTypeOfSymbol.
// Enums also use their declared type here, rather than their runtime value type.
// Functions, classes, variables, and namespaces backed by source files need
// getTypeOfSymbolAtLocation to describe the exported value.
// A namespace Foo {} block has neither supported shape cheaply available here.
// An empty signature avoids a guess about that block's type.
function signatureOf(checker: ts.TypeChecker, target: ts.Symbol, kind: SearchMatch["kind"]): string {
  const declaration = target.declarations?.[0];
  if (declaration === undefined) return "";
  if (kind === "interface" || kind === "type-alias" || kind === "enum") {
    return checker.typeToString(checker.getDeclaredTypeOfSymbol(target));
  }
  if (kind === "function" || kind === "class" || kind === "variable" ||
      (kind === "namespace" && ts.isSourceFile(declaration))) {
    return checker.typeToString(checker.getTypeOfSymbolAtLocation(target, declaration));
  }
  return "";
}

export async function search(projectRoot: string, query: string): Promise<SearchResult> {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) throw new Error("archstrict search: query must contain at least one word");
  const config = await loadConfig(resolve(projectRoot, "archstrict.config.ts"));
  const options = { projectRoot, declaredModules: config.declaredModules, exclude: config.exclude };
  const prepared = prepareGraph(options);
  const graph = buildPreparedGraph(prepared);
  const checker = graph.checker;
  const matches: SearchMatch[] = [];
  for (const module of graph.modules.values()) {
    for (const surfacePath of module.surfaceFiles) {
      const sf = graph.program.getSourceFile(surfacePath);
      if (sf === undefined) continue;
      const moduleSymbol = checker.getSymbolAtLocation(sf);
      if (moduleSymbol === undefined) continue;
      for (const exportSymbol of checker.getExportsOfModule(moduleSymbol)) {
        const name = exportSymbol.name;
        const tokens = tokenize(name);
        const score = queryTokens.filter(queryToken => tokens.some(token =>
          token.includes(queryToken) || queryToken.includes(token))).length / queryTokens.length;
        if (score === 0) continue;
        // Public surfaces commonly re-export names from internal files. getExportsOfModule
        // returns Alias symbols for those names; their flags would give a generic kind.
        // Resolve the underlying symbol first so the kind describes the actual export.
        let target = exportSymbol;
        if (target.flags & ts.SymbolFlags.Alias) target = checker.getAliasedSymbol(target);
        const kind = target.flags & ts.SymbolFlags.Alias ? "other" : kindOf(target);
        // typeToString can expose an internal declaring path through typeof import("...")
        // for export * as ns or a const that holds an imported module.
        // Output must identify the module and its public surface, not that internal file.
        // enclosingDeclaration was rejected: it makes the path relative but retains the reference.
        // Apply replacement to every kind: a function's return object can contain the same type.
        const signature = signatureOf(checker, target, kind)
          .replace(/import\("[^"]*"(?:\s*,\s*\{[^)]*\})?\)/g, 'import("<module>")');
        // The surface path gives an agent a legal import destination. The internal
        // declaring path would invite the public-surface bypass that rule 1 rejects.
        matches.push({ module: module.name, surface: toProjectRelativePosix(surfacePath, prepared.projectRoot),
          name, kind, signature, score });
      }
    }
  }
  matches.sort((a, b) => b.score - a.score || a.module.localeCompare(b.module) || a.name.localeCompare(b.name));
  // Search presents the best ranked matches with a visible total count.
  // A top-K limit serves that query; recommend instead reports its whole candidate set.
  const shown = matches.slice(0, 20);
  return { query, total: matches.length, shown: shown.length, matches: shown };
}

export function formatSearchText(result: SearchResult): string {
  return [`${result.total} matches for "${result.query}" (showing ${result.shown})`,
    ...result.matches.map(match => `${match.module} :: ${match.name} (${match.kind}) - ${match.signature}  [score ${match.score.toFixed(2)}]`),
  ].join("\n") + "\n";
}
