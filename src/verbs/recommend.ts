// Responsibility: propose boundaries from the discovered import graph.
// Boundary: report data and text only; never write config or judge a module's purpose.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./check.js";
import { buildModuleGraph, DEFAULT_SURFACE } from "../module-graph.js";
// Without a config, recommend previews init's own walk in memory (same
// argument rules, same groups and globs) instead of running its own
// single-level "src/*" discovery - the two could disagree about which
// files exist and how they group, and no user-facing command should take
// a modules glob once init itself no longer does.
import { freshRun, normalizeDirArg } from "./init.js";

export type RecommendResult = {
  modules: number;
  candidates: number;
  pairs: { a: string; b: string; filesA: number; filesB: number }[];
  proposedClassify: { glob: string; tags: string[] }[];
  proposedAllowDeny: { source: string; targetNamespace: string; deny: string[]; because: string }[];
};

// Report every eligible pair, even when the count is large; a hidden cap would conceal choices the reader should make.
// Beyond empty directories, pruning heuristics would substitute the tool's priorities for the reader's decision about which boundaries matter.
// This verb proposes observed boundaries without imposing or judging them, so it offers no --apply, --write, or --prove flag.
export async function recommend(projectRoot: string, dir?: string, surface = DEFAULT_SURFACE): Promise<RecommendResult> {
  const configPath = resolve(projectRoot, "archstrict.config.ts");
  const config = existsSync(configPath) ? await loadConfig(configPath) : undefined;
  // A config supplies its own scope regardless of `dir` - unchanged from
  // before. Without one, `dir` means init's own directory argument (its
  // same normalization rules), not a glob: recommend walks in memory
  // exactly what init would write. Passing "recommend" as the verb keeps a
  // bad argument's own error and `do:` naming the command that was
  // actually run, not init.
  const plan = config ? undefined : freshRun(projectRoot, normalizeDirArg(dir, "recommend"), "recommend");
  const declaredModules = config ? config.declaredModules! : plan!.declaredModules;
  const graph = config
    ? buildModuleGraph({ projectRoot, declaredModules: config.declaredModules!, exclude: config.exclude })
    : buildModuleGraph({ projectRoot, declaredModules: plan!.declaredModules, exclude: plan!.exclude, surface });
  // An empty directory has no files to import or be imported by within this graph.
  // It cannot form a real candidate pair, so reporting it would add noise rather than information.
  const modules = [...graph.modules.values()].filter(module => module.files.length > 0).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const counts = new Map<string, Map<string, number>>();
  for (const edge of graph.crossModuleEdges) {
    if (edge.toModule === undefined) continue;
    const targets = counts.get(edge.fromModule) ?? new Map<string, number>();
    targets.set(edge.toModule, (targets.get(edge.toModule) ?? 0) + 1);
    counts.set(edge.fromModule, targets);
  }
  const pairs: RecommendResult["pairs"] = [];
  // A candidate boundary requires independence in both directions today.
  // Even one edge in either direction establishes an existing dependency, so checking only one direction would propose a boundary already crossed.
  for (const [i, a] of modules.entries()) {
    for (const b of modules.slice(i + 1)) {
      if ((counts.get(a.name)?.get(b.name) ?? 0) === 0 && (counts.get(b.name)?.get(a.name) ?? 0) === 0) {
        pairs.push({ a: a.name, b: b.name, filesA: a.files.length, filesB: b.files.length });
      }
    }
  }
  return {
    modules: modules.length,
    candidates: pairs.length,
    pairs,
    proposedClassify: modules.map(module => ({ glob: declaredModules.find(d => d.name === module.name)!.glob, tags: [`role:${module.name}`] })),
    // An allow list of everything currently reached has the shape that the exhaustive-allow-list check exists to catch.
    // A deny rule can guard against a future crossing of an observed boundary.
    // Each pair needs two deny entries because a rule guards only its source direction.
    proposedAllowDeny: pairs.flatMap(({ a, b }) => [[a, b], [b, a]].map(([source, target]) => ({
      source: `role:${source}`, targetNamespace: "role", deny: [target!], because: "<author must state a real reason>",
    }))),
  };
}

export function formatRecommendText(result: RecommendResult): string {
  const quote = JSON.stringify;
  return [
    `${result.modules} modules; ${result.candidates} candidates`,
    ...result.pairs.map(pair => `${pair.a} <-> ${pair.b} (${pair.filesA} files / ${pair.filesB} files)`),
    "", "proposed classify:", "[",
    ...result.proposedClassify.map(entry => `  { glob: ${quote(entry.glob)}, tags: ${quote(entry.tags)} },`),
    "]", "", "proposed edges.allowDeny:", "[",
    ...result.proposedAllowDeny.map(entry => `  { source: ${quote(entry.source)}, targetNamespace: ${quote(entry.targetNamespace)}, deny: ${quote(entry.deny)}, because: ${quote(entry.because)} },`),
    "]", "",
  ].join("\n");
}
