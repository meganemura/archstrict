// Responsibility: propose boundaries from the discovered import graph.
// Boundary: report data and text only; never write config or judge a module's purpose.
import { existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { loadConfig } from "./check.js";
import { buildModuleGraphForRules, DEFAULT_SURFACE, type Module, type ModuleGraph } from "../module-graph.js";
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
  surfaceProposals: SurfaceProposal[];
};

// One file another module imports from a surface-less module, ranked by
// how many distinct files import it - the file a surface proposal covers
// first.
export type SurfaceCandidate = { file: string; importers: number };

export type SurfaceProposal = {
  module: string;
  // Every file with at least one real external importer, ranked densest
  // first - complete, not capped: JSON stays exact even though formatted
  // text truncates it (see formatRecommendText).
  candidates: SurfaceCandidate[];
  // The smallest ranked prefix of `candidates` covering at least
  // SURFACE_COVERAGE_NUMERATOR/SURFACE_COVERAGE_DENOMINATOR of
  // `totalImports` - a `surface` value for this module's declaredModules
  // entry, module-relative (config.md's own convention).
  proposedSurface: string[];
  totalImports: number;
  coveredImports: number;
  remainingImports: number;
  choices: string[];
};

// 4/5 (80%), the same threshold and the same rationale check.ts's own
// SURFACE_LESS_NOTE_THRESHOLD uses for the opposite direction (how many
// bypasses share this one root cause) - integer math so a real fraction
// (7 covered of 9) never rounds the wrong way against a float constant.
const SURFACE_COVERAGE_NUMERATOR = 4;
const SURFACE_COVERAGE_DENOMINATOR = 5;

// Pure and exported so a property test can drive it directly with
// synthetic importer counts, without building a real filesystem and
// compiler graph for every case. `counts` must already be sorted densest
// first (the same order `proposeSurfaces` ranks real candidates in) -
// this never sorts its own input, so a caller's tie-break choice (file
// path ascending) survives into which prefix wins a tie.
export function minimalCoveringPrefixLength(counts: readonly number[], numerator = SURFACE_COVERAGE_NUMERATOR, denominator = SURFACE_COVERAGE_DENOMINATOR): number {
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) return 0;
  let covered = 0;
  for (let i = 0; i < counts.length; i++) {
    covered += counts[i]!;
    if (covered * denominator >= total * numerator) return i + 1;
  }
  return counts.length;
}

function moduleRelative(module: Module, file: string): string {
  return relative(module.dir, file).split(sep).join("/");
}

// One proposal per declared module with no public surface file present
// today (module.surfaceFiles.length === 0) and at least one real external
// importer - a module nothing outside it ever imports has no evidence to
// rank a surface from, so it is left out rather than guessed.
// `rootIsFile` modules are skipped outright: a single-file module's own
// surface is that file, by construction (module-graph.ts), so it can
// never lack one here.
function proposeSurfaces(graph: ModuleGraph): SurfaceProposal[] {
  const proposals: SurfaceProposal[] = [];
  for (const module of graph.modules.values()) {
    if (module.surfaceFiles.length > 0 || module.rootIsFile) continue;
    // A pair is (importing file, imported file) - the unit both the
    // ranking key and the coverage unit share, so a file's own importer
    // count is exactly its own share of `totalImports`, and summing a
    // prefix's counts is exactly that prefix's own coverage (see this
    // module's own top-level comment on the property this keeps true).
    const pairs = new Set<string>();
    const importersByFile = new Map<string, Set<string>>();
    for (const edge of graph.crossModuleEdges) {
      if (edge.toModule !== module.name) continue;
      const pairKey = `${edge.fromFile}\0${edge.resolvedFile}`;
      if (pairs.has(pairKey)) continue;
      pairs.add(pairKey);
      let importers = importersByFile.get(edge.resolvedFile);
      if (importers === undefined) {
        importers = new Set();
        importersByFile.set(edge.resolvedFile, importers);
      }
      importers.add(edge.fromFile);
    }
    if (pairs.size === 0) continue;
    const candidates = [...importersByFile.entries()]
      .map(([file, importers]) => ({ file: moduleRelative(module, file), importers: importers.size }))
      .sort((a, b) => b.importers - a.importers || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    const prefixLength = minimalCoveringPrefixLength(candidates.map(c => c.importers));
    const proposedSurface = candidates.slice(0, prefixLength).map(c => c.file);
    const coveredImports = candidates.slice(0, prefixLength).reduce((sum, c) => sum + c.importers, 0);
    const totalImports = pairs.size;
    proposals.push({
      module: module.name,
      candidates,
      proposedSurface,
      totalImports,
      coveredImports,
      remainingImports: totalImports - coveredImports,
      choices: [
        `do: set { name: ${JSON.stringify(module.name)}, ..., surface: ${JSON.stringify(proposedSurface)} } in declaredModules to retire ${coveredImports} of ${totalImports} bypasses into '${module.name}', leaving ${totalImports - coveredImports}`,
        `do: add a barrel file re-exporting from ${proposedSurface[0] ?? "a chosen entry file"}, then name it as this module's surface instead`,
        `do: leave '${module.name}' entirely private and run archstrict todo to freeze its bypasses as debt instead`,
      ],
    });
  }
  return proposals.sort((a, b) => a.module < b.module ? -1 : a.module > b.module ? 1 : 0);
}

// Report every eligible pair, even when the count is large; a hidden cap would conceal choices the reader should make.
// Beyond empty directories, pruning heuristics would substitute the tool's priorities for the reader's decision about which boundaries matter.
// This verb proposes observed boundaries without imposing or judging them, so it offers no --apply, --write, or --prove flag.
export async function recommend(
  projectRoot: string,
  dir?: string,
  surface: string | readonly string[] = DEFAULT_SURFACE,
): Promise<RecommendResult> {
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
    ? buildModuleGraphForRules({ projectRoot, declaredModules: config.declaredModules!, exclude: config.exclude, surface: config.surface })
    : buildModuleGraphForRules({ projectRoot, declaredModules: plan!.declaredModules, exclude: plan!.exclude, surface });
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
    surfaceProposals: proposeSurfaces(graph),
  };
}

// Text truncates a proposal's own candidate list to its top 5 (JSON keeps
// every candidate) - the same "bounded text, complete JSON" split
// check.ts's own grouped text follows for a large violation list.
const SURFACE_CANDIDATE_TEXT_CAP = 5;

export function formatRecommendText(result: RecommendResult): string {
  const quote = JSON.stringify;
  return [
    `${result.modules} modules; ${result.candidates} candidates`,
    ...result.pairs.map(pair => `${pair.a} <-> ${pair.b} (${pair.filesA} files / ${pair.filesB} files)`),
    "", "proposed classify:", "[",
    ...result.proposedClassify.map(entry => `  { glob: ${quote(entry.glob)}, tags: ${quote(entry.tags)} },`),
    "]", "", "proposed edges.allowDeny:", "[",
    ...result.proposedAllowDeny.map(entry => `  { source: ${quote(entry.source)}, targetNamespace: ${quote(entry.targetNamespace)}, deny: ${quote(entry.deny)}, because: ${quote(entry.because)} },`),
    "]",
    ...(result.surfaceProposals.length === 0 ? [] : [
      "", "proposed surfaces (no public surface file present today):",
      ...result.surfaceProposals.flatMap(proposal => [
        `  ${proposal.module}: ${quote(proposal.proposedSurface)} covers ${proposal.coveredImports} of ${proposal.totalImports} bypasses, ${proposal.remainingImports} remaining`,
        ...proposal.candidates.slice(0, SURFACE_CANDIDATE_TEXT_CAP).map(c => `    ${c.file} (${c.importers} importer(s))`),
        ...(proposal.candidates.length > SURFACE_CANDIDATE_TEXT_CAP ? [`    ... ${proposal.candidates.length - SURFACE_CANDIDATE_TEXT_CAP} more candidate(s); see --json`] : []),
        ...proposal.choices.map(choice => `  ${choice}`),
      ]),
    ]),
    "",
  ].join("\n");
}
