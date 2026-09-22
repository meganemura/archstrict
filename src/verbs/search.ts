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
        let target = exportSymbol;
        if (target.flags & ts.SymbolFlags.Alias) target = checker.getAliasedSymbol(target);
        const kind = target.flags & ts.SymbolFlags.Alias ? "other" : kindOf(target);
        const signature = signatureOf(checker, target, kind)
          .replace(/import\("[^"]*"(?:\s*,\s*\{[^)]*\})?\)/g, 'import("<module>")');
        matches.push({ module: module.name, surface: toProjectRelativePosix(surfacePath, prepared.projectRoot),
          name, kind, signature, score });
      }
    }
  }
  matches.sort((a, b) => b.score - a.score || a.module.localeCompare(b.module) || a.name.localeCompare(b.name));
  const shown = matches.slice(0, 20);
  return { query, total: matches.length, shown: shown.length, matches: shown };
}

export function formatSearchText(result: SearchResult): string {
  return [`${result.total} matches for "${result.query}" (showing ${result.shown})`,
    ...result.matches.map(match => `${match.module} :: ${match.name} (${match.kind}) - ${match.signature}  [score ${match.score.toFixed(2)}]`),
  ].join("\n") + "\n";
}
