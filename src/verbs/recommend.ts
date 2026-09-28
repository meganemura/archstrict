// Responsibility: propose boundaries from the discovered import graph.
// Boundary: report data and text only; never write config or judge a module's purpose.
import { existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { applyTodo, loadConfig, runRules, type AnyViolation } from "./check.js";
import type { Config } from "../config.js";
import { createConfigLocator } from "../config-pointer.js";
import { fingerprintOf, relativizeForTodo } from "../todo-store.js";
import { buildModuleGraphForRules, DEFAULT_SURFACE, type Module, type ModuleGraph } from "../module-graph.js";
// Without a config, recommend previews init's own walk in memory (same
// argument rules, same groups and globs) instead of running its own
// single-level "src/*" discovery - the two could disagree about which
// files exist and how they group, and no user-facing command should take
// a modules glob once init itself no longer does.
import { freshRun, normalizeDirArg } from "./init.js";

export type PatternProposal = {
  pattern: string;
  // 0..1, the fraction of the pattern's own measured evidence that
  // supports it (a fully clean fit is 1) - the ranking key: at most 5
  // proposals survive, highest support first, so a project with more
  // detectable shapes than that sees only its strongest-evidenced ones.
  support: number;
  evidence: string[];
  configFragment: string;
  // How many NEW violations of this proposal's own rule id (never a
  // different rule already firing for an unrelated reason) the rule
  // pipeline reports today, run in memory against the real graph - 0
  // does not mean "safe to adopt blindly," only "no real edge violates
  // it yet."
  addedViolations: number;
  do: string;
};

export type RecommendResult = {
  modules: number;
  proposedClassify: { glob: string; tags: string[] }[];
  // How many patterns the evidence supported before the top-5 cap below -
  // visible even when every one of them got cut, so a bounded list never
  // reads as "nothing else was found."
  detected: number;
  patternProposals: PatternProposal[];
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

// Runs `proposedConfig` (the real config plus one candidate classify/edges
// addition) through the same rule pipeline `check` uses, and counts only
// NEW violations of the rule id this one proposal's own edges produce -
// never a violation some other, pre-existing rule already reported, and
// never a different rule this proposal happened to also touch. `baseConfig`
// is run first so a project that already has, say, an unrelated
// tag-boundary rule does not have its existing findings miscounted as
// this proposal's own. Rule 6 (type-leak) is skipped: it needs a
// compiler Program per module surface, a cost this in-memory preview
// pays once per proposal otherwise, for a rule no classify/edges
// addition here can ever affect.
function countAddedViolations(graph: ModuleGraph, baseConfig: Config, proposedConfig: Config, ruleId: string): number {
  const keyOf = (v: AnyViolation) => fingerprintOf(relativizeForTodo(v, graph.relativePath));
  const baseLocator = createConfigLocator(baseConfig);
  const base = applyTodo(graph, baseConfig, runRules(graph, baseConfig, { configLocator: baseLocator, skipTypeLeak: true }), { configLocator: baseLocator });
  const baseKeys = new Set(base.violations.filter(v => v.rule === ruleId).map(keyOf));
  const proposedLocator = createConfigLocator(proposedConfig);
  const proposed = applyTodo(graph, proposedConfig, runRules(graph, proposedConfig, { configLocator: proposedLocator, skipTypeLeak: true }), { configLocator: proposedLocator });
  return proposed.violations.filter(v => v.rule === ruleId && !baseKeys.has(keyOf(v))).length;
}

const PROVE_RULES_DO = "read node_modules/archstrict/skills/archstrict/references/prove-rules.md, then inject one edge this rule should forbid, run archstrict check, and confirm it fires under this rule id before trusting a clean check";

// A general layered-order detector: it does not name a project's own
// layer vocabulary (patterns.md's "app vs lib" and "layered order" are
// both this same shape, over module names instead of directory-name
// tiers) - it finds whichever direction the real edges between declared
// modules already agree on, the same reading patterns.md gives a
// lopsided cycle ("one direction is intended; remove the few reverse
// edges", not "this pair has no order").
function detectLayeredOrder(
  modules: readonly Module[],
  counts: ReadonlyMap<string, ReadonlyMap<string, number>>,
  declaredModules: readonly { name: string; glob: string }[],
  baseConfig: Config,
  graph: ModuleGraph,
): PatternProposal | undefined {
  const names = modules.map(m => m.name);
  if (names.length < 2) return undefined;
  // `before.get(X)` is every module that imports X - X must precede them
  // in `sequence` (order.ts's own downward-only direction lets a source
  // depend on its own layer or an earlier one, never a later one).
  const before = new Map<string, Set<string>>(names.map(n => [n, new Set<string>()]));
  let forward = 0;
  let reverse = 0;
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i]!;
      const b = names[j]!;
      const ab = counts.get(a)?.get(b) ?? 0; // a imports b
      const ba = counts.get(b)?.get(a) ?? 0; // b imports a
      if (ab === 0 && ba === 0) continue;
      if (ab === ba) continue; // exactly balanced: no direction to read, so no constraint either way
      const [importer, dependency, majority, minority] = ab > ba ? [a, b, ab, ba] : [b, a, ba, ab];
      before.get(dependency)!.add(importer);
      forward += majority;
      reverse += minority;
    }
  }
  if (forward === 0) return undefined; // no directional evidence between any pair at all
  // One constraint (dependency before importer) per edge `before` recorded above.
  const indegree = new Map<string, number>(names.map(n => [n, 0]));
  for (const importers of before.values()) for (const importer of importers) indegree.set(importer, indegree.get(importer)! + 1);
  const remaining = new Set(names);
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter(n => (indegree.get(n) ?? 0) === 0).sort();
    if (ready.length === 0) return undefined; // the majority graph itself has a cycle: no order to propose
    const next = ready[0]!;
    order.push(next);
    remaining.delete(next);
    for (const dependent of before.get(next) ?? []) {
      if (remaining.has(dependent)) indegree.set(dependent, indegree.get(dependent)! - 1);
    }
  }
  const support = forward / (forward + reverse);
  const classify = order.map(name => ({ glob: declaredModules.find(d => d.name === name)!.glob, tags: [`role:${name}`] }));
  const because = `${forward} of ${forward + reverse} directed edges between these modules already match this order`;
  const orderRule = { tagNamespace: "role", sequence: { "": order }, direction: "downward-only" as const, because };
  const configFragment = [
    "classify: [",
    ...classify.map(c => `  { glob: ${JSON.stringify(c.glob)}, tags: ${JSON.stringify(c.tags)} },`),
    "],",
    "edges: { order: [",
    `  { tagNamespace: "role", sequence: { "": ${JSON.stringify(order)} }, direction: "downward-only", because: ${JSON.stringify(because)} },`,
    "] },",
  ].join("\n");
  const proposedConfig: Config = {
    ...baseConfig,
    classify: [...(baseConfig.classify ?? []), ...classify],
    edges: { ...baseConfig.edges, order: [...(baseConfig.edges?.order ?? []), orderRule] },
  };
  return {
    pattern: "layered-order",
    support,
    evidence: [
      `order supported by these modules' own real edges: ${order.join(" -> ")}`,
      `${forward} of ${forward + reverse} directed edges between them match this order (the rest would need fixing, or a deliberate skip)`,
    ],
    configFragment,
    addedViolations: countAddedViolations(graph, baseConfig, proposedConfig, "tag-order"),
    do: PROVE_RULES_DO,
  };
}

// A module with real importers but zero outgoing cross-module edges of
// its own is patterns.md's "leaf / pure kernel": nothing it imports can
// ever violate this rule (there is nothing to violate it with yet), so
// support is always 1 - ranked among each other by how many real edges
// already depend on it, the strength of the reason to keep it that way.
function detectLeafKernels(
  modules: readonly Module[],
  graph: ModuleGraph,
  declaredModules: readonly { name: string; glob: string }[],
  baseConfig: Config,
): PatternProposal[] {
  const outgoing = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const edge of graph.crossModuleEdges) {
    if (edge.toModule === undefined) continue;
    outgoing.set(edge.fromModule, (outgoing.get(edge.fromModule) ?? 0) + 1);
    incoming.set(edge.toModule, (incoming.get(edge.toModule) ?? 0) + 1);
  }
  const proposals: PatternProposal[] = [];
  for (const module of modules) {
    const inCount = incoming.get(module.name) ?? 0;
    if (inCount === 0 || (outgoing.get(module.name) ?? 0) > 0) continue;
    const glob = declaredModules.find(d => d.name === module.name)!.glob;
    const tag = `kind:${module.name}`;
    const because = `'${module.name}' is imported by ${inCount} real edge(s) and imports no other declared module today`;
    const allowDenyRule = { source: tag, targetNamespace: "kind", allow: [] as string[], because };
    const proposedConfig: Config = {
      ...baseConfig,
      classify: [...(baseConfig.classify ?? []), { glob, tags: [tag] }],
      edges: { ...baseConfig.edges, allowDeny: [...(baseConfig.edges?.allowDeny ?? []), allowDenyRule] },
    };
    proposals.push({
      pattern: "leaf-kernel",
      support: 1,
      evidence: [`'${module.name}': 0 outgoing edges to another declared module; ${inCount} other module(s) import it`],
      configFragment: [
        "classify: [", `  { glob: ${JSON.stringify(glob)}, tags: ${JSON.stringify([tag])} },`, "],",
        "edges: { allowDeny: [", `  { source: ${JSON.stringify(tag)}, targetNamespace: "kind", allow: [], because: ${JSON.stringify(because)} },`, "] },",
      ].join("\n"),
      addedViolations: countAddedViolations(graph, baseConfig, proposedConfig, "tag-boundary"),
      do: PROVE_RULES_DO,
    });
  }
  return proposals;
}

// patterns.md's "public entry only": reuses the same evidence
// `proposeSurfaces` already computed (module-relative candidate files,
// ranked by real importer count) instead of re-deriving it, so the two
// can never disagree about which files a surface-less module's own
// importers actually reach. `addedViolations` is always 0 here, unlike
// the other two detectors: a `surface` narrows which import already
// counts as `public-surface-bypass` (rule 1, always on), it can only
// retire an existing finding, never create a new rule or a new kind of
// violation.
function detectPublicEntryOnly(surfaceProposals: readonly SurfaceProposal[]): PatternProposal | undefined {
  const totalImports = surfaceProposals.reduce((sum, p) => sum + p.totalImports, 0);
  if (totalImports === 0) return undefined;
  const coveredImports = surfaceProposals.reduce((sum, p) => sum + p.coveredImports, 0);
  return {
    pattern: "public-entry-only",
    support: coveredImports / totalImports,
    evidence: surfaceProposals.map(p => `'${p.module}': ${JSON.stringify(p.proposedSurface)} covers ${p.coveredImports} of ${p.totalImports} real imports into it`),
    configFragment: [
      "declaredModules: [",
      ...surfaceProposals.map(p => `  { name: ${JSON.stringify(p.module)}, glob: /* this module's existing glob */ "...", surface: ${JSON.stringify(p.proposedSurface)} },`),
      "],",
    ].join("\n"),
    addedViolations: 0,
    do: "run archstrict check to see which public-surface-bypass violations naming each proposed surface retire, then archstrict todo to freeze what remains",
  };
}

// At most 5 proposals survive, highest support first - a project with
// more detectable shapes than that sees only its strongest-evidenced
// ones; `detected` (recommend()'s own field) keeps the cut visible.
const PATTERN_PROPOSAL_CAP = 5;

function detectPatterns(
  modules: readonly Module[],
  graph: ModuleGraph,
  counts: ReadonlyMap<string, ReadonlyMap<string, number>>,
  declaredModules: readonly { name: string; glob: string }[],
  baseConfig: Config,
  surfaceProposals: readonly SurfaceProposal[],
): PatternProposal[] {
  const detected = [
    detectLayeredOrder(modules, counts, declaredModules, baseConfig, graph),
    ...detectLeafKernels(modules, graph, declaredModules, baseConfig),
    detectPublicEntryOnly(surfaceProposals),
  ].filter((p): p is PatternProposal => p !== undefined);
  return detected.sort((a, b) => b.support - a.support || a.pattern.localeCompare(b.pattern));
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
  const surfaceProposals = proposeSurfaces(graph);
  // A placeholder Config for the no-config path (freshRun's own plan, not
  // a file on disk): detectPatterns only ever reads classify/edges/because
  // off it and passes it straight to runRules, which needs a well-formed
  // Config either way, real or previewed.
  const baseConfig: Config = config ?? { configPath, declaredModules: plan!.declaredModules, exclude: plan!.exclude, surface, because: "archstrict recommend preview" };
  const detected = detectPatterns(modules, graph, counts, declaredModules, baseConfig, surfaceProposals);
  return {
    modules: modules.length,
    proposedClassify: modules.map(module => ({ glob: declaredModules.find(d => d.name === module.name)!.glob, tags: [`role:${module.name}`] })),
    detected: detected.length,
    patternProposals: detected.slice(0, PATTERN_PROPOSAL_CAP),
    surfaceProposals,
  };
}

// Text truncates a proposal's own candidate list to its top 5 (JSON keeps
// every candidate) - the same "bounded text, complete JSON" split
// check.ts's own grouped text follows for a large violation list.
const SURFACE_CANDIDATE_TEXT_CAP = 5;

export function formatRecommendText(result: RecommendResult): string {
  const quote = JSON.stringify;
  return [
    `${result.modules} modules; ${result.detected} pattern(s) detected, ${result.patternProposals.length} shown`,
    "", "proposed classify:", "[",
    ...result.proposedClassify.map(entry => `  { glob: ${quote(entry.glob)}, tags: ${quote(entry.tags)} },`),
    "]",
    ...(result.patternProposals.length === 0 ? [] : [
      "", "pattern proposals, ranked by evidence:",
      ...result.patternProposals.flatMap(proposal => [
        `  ${proposal.pattern} (support ${(proposal.support * 100).toFixed(0)}%, would add ${proposal.addedViolations} violation(s) today):`,
        ...proposal.evidence.map(line => `    ${line}`),
        `  do: ${proposal.do}`,
      ]),
    ]),
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
