// Responsibility: propose boundaries from the discovered import graph.
// Boundary: report data and text only; never write config or judge a module's purpose.
import { existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { applyTodo, loadConfig, runRules, type AnyViolation } from "./check.js";
import type { Config } from "../config.js";
import { createConfigLocator } from "../config-pointer.js";
import { fingerprintOf, relativizeForTodo } from "../todo-store.js";
import { buildModuleGraphForRules, DEFAULT_SURFACE, moduleGlobBaseDir, type Module, type ModuleGraph } from "../module-graph.js";
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

const PROVE_RULES_DO = "run archstrict simulate --json with a change set that adds one edge this rule should forbid, and confirm it fires; see node_modules/archstrict/skills/archstrict/references/prove-rules.md";

// A classify block for two groups that between them cover every present
// module: one broad catch-all glob for the larger, default-tagged group,
// then each member of the smaller, distinguished group overriding it with
// its own real glob. classify.ts's own most-specific-glob-wins already
// picks a longer literal prefix over "**"'s empty one, so this tags every
// file exactly as writing every module out by hand would - just far
// fewer lines on a project where most modules land on the default side.
// Only valid when the two groups are a true partition (nothing left
// over): a file genuinely outside every declared module also matches
// "**" and would gain the default tag it never had before - harmless for
// every detector this is used by, since none of them scope a rule by
// module coverage, only by this one classify namespace.
function partitionClassify(
  declaredModules: readonly { name: string; glob: string }[],
  defaultTag: string,
  distinguishedNames: readonly string[],
  distinguishedTag: string,
): { glob: string; tags: string[] }[] {
  return [
    { glob: "**", tags: [defaultTag] },
    ...distinguishedNames.map(name => ({ glob: moduleGlob(declaredModules, name), tags: [distinguishedTag] })),
  ];
}

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
): { proposal: PatternProposal; weight: number } | undefined {
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
    proposal: {
      pattern: "layered-order",
      support,
      evidence: [
        `order supported by these modules' own real edges: ${order.join(" -> ")}`,
        `${forward} of ${forward + reverse} directed edges between them match this order (the rest would need fixing, or a deliberate skip)`,
      ],
      configFragment,
      addedViolations: countAddedViolations(graph, baseConfig, proposedConfig, "tag-order"),
      do: PROVE_RULES_DO,
    },
    weight: forward + reverse,
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
): { proposal: PatternProposal; weight: number }[] {
  const outgoing = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const edge of graph.crossModuleEdges) {
    if (edge.toModule === undefined) continue;
    outgoing.set(edge.fromModule, (outgoing.get(edge.fromModule) ?? 0) + 1);
    incoming.set(edge.toModule, (incoming.get(edge.toModule) ?? 0) + 1);
  }
  const proposals: { proposal: PatternProposal; weight: number }[] = [];
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
      proposal: {
        pattern: "leaf-kernel",
        support: 1,
        evidence: [`'${module.name}': 0 outgoing edges to another declared module; ${inCount} other module(s) import it`],
        configFragment: [
          "classify: [", `  { glob: ${JSON.stringify(glob)}, tags: ${JSON.stringify([tag])} },`, "],",
          "edges: { allowDeny: [", `  { source: ${JSON.stringify(tag)}, targetNamespace: "kind", allow: [], because: ${JSON.stringify(because)} },`, "] },",
        ].join("\n"),
        addedViolations: countAddedViolations(graph, baseConfig, proposedConfig, "tag-boundary"),
        do: PROVE_RULES_DO,
      },
      weight: inCount,
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
function detectPublicEntryOnly(surfaceProposals: readonly SurfaceProposal[]): { proposal: PatternProposal; weight: number } | undefined {
  const totalImports = surfaceProposals.reduce((sum, p) => sum + p.totalImports, 0);
  if (totalImports === 0) return undefined;
  const coveredImports = surfaceProposals.reduce((sum, p) => sum + p.coveredImports, 0);
  return {
    proposal: {
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
    },
    weight: totalImports,
  };
}

// Every path segment before the glob's own wildcard, lowercased - the
// directory-name evidence a proposal reads (patterns.md's own "look at
// directory names first"), not the declared module's name, which a
// project can set to anything regardless of where the module lives.
function moduleSegments(glob: string): string[] {
  return moduleGlobBaseDir(glob).replace(/\.(ts|tsx|mts|cts)$/i, "").split("/").filter(Boolean).map(s => s.toLowerCase());
}

function matchesAnySegment(glob: string, pattern: RegExp): boolean {
  return moduleSegments(glob).some(segment => pattern.test(segment));
}

function moduleGlob(declaredModules: readonly { name: string; glob: string }[], name: string): string {
  return declaredModules.find(d => d.name === name)!.glob;
}

// Sums real cross-module edges from every member of `from` to every
// member of `to` - the shared unit every grouped detector below reads a
// directed edge count from, instead of each re-walking crossModuleEdges.
function edgesBetweenGroups(counts: ReadonlyMap<string, ReadonlyMap<string, number>>, from: readonly string[], to: readonly string[]): number {
  let total = 0;
  for (const a of from) for (const b of to) total += counts.get(a)?.get(b) ?? 0;
  return total;
}

// Every tag namespace `baseConfig` already assigns, real or previewed -
// `order`'s own config check throws the first time a real edge carries a
// `layer` (or whichever namespace) value missing from that rule's
// `sequence`, so proposing a namespace a real config already populates
// would make `countAddedViolations` crash instead of report, not just
// read wrong. `allowDeny`/`point` have no such throw, but reusing a live
// namespace would still misread as extending a rule the project already
// wrote for a different reason - so every new detector below picks a
// namespace free of both classify's own tags and classifyByDirectoryName.
function usedTagNamespaces(config: Config): Set<string> {
  const namespaces = new Set<string>();
  for (const entry of config.classify ?? []) for (const tag of entry.tags) namespaces.add(tag.split(":")[0] ?? tag);
  if (config.classifyByDirectoryName) namespaces.add(config.classifyByDirectoryName.tagNamespace);
  return namespaces;
}

function freeTagNamespace(config: Config, preferred: string): string {
  const used = usedTagNamespaces(config);
  if (!used.has(preferred)) return preferred;
  for (let i = 2; ; i++) if (!used.has(`${preferred}${i}`)) return `${preferred}${i}`;
}

// patterns.md's "app vs lib": an application area (a CLI entry file, or a
// directory segment named app/apps/cli/cmd anywhere in its glob) that
// depends on the rest of the project, with few or no edges back. Unlike
// `detectLayeredOrder` (which reads whichever direction the evidence
// between EVERY pair of modules agrees on), this looks for one specific,
// named direction - the shape a real adoption picked by hand over the
// general detector, because "app" and "library" are recognizable on
// sight in a way an arbitrary majority-direction graph is not.
const APP_SEGMENT_PATTERN = /^(app|apps|cli|cmd)$/;

function detectAppOverLibrary(
  modules: readonly Module[],
  counts: ReadonlyMap<string, ReadonlyMap<string, number>>,
  declaredModules: readonly { name: string; glob: string }[],
  baseConfig: Config,
  graph: ModuleGraph,
): { proposal: PatternProposal; weight: number } | undefined {
  const appNames = modules.filter(m => matchesAnySegment(moduleGlob(declaredModules, m.name), APP_SEGMENT_PATTERN)).map(m => m.name);
  const libNames = modules.map(m => m.name).filter(n => !appNames.includes(n));
  if (appNames.length === 0 || libNames.length === 0) return undefined;
  const forward = edgesBetweenGroups(counts, appNames, libNames); // app -> library, the intended direction
  const reverse = edgesBetweenGroups(counts, libNames, appNames); // library -> app, the direction this proposal forbids
  if (forward === 0) return undefined; // no evidence an app area depends on a library area at all
  const total = forward + reverse;
  const ns = freeTagNamespace(baseConfig, "tier");
  const classify = partitionClassify(declaredModules, `${ns}:lib`, appNames, `${ns}:app`);
  const because = `library -> app: ${reverse} of ${total} edges; app -> library: ${forward}`;
  const orderRule = { tagNamespace: ns, sequence: { "": ["lib", "app"] }, direction: "downward-only" as const, because };
  const proposedConfig: Config = {
    ...baseConfig,
    classify: [...(baseConfig.classify ?? []), ...classify],
    edges: { ...baseConfig.edges, order: [...(baseConfig.edges?.order ?? []), orderRule] },
  };
  const configFragment = [
    "classify: [",
    ...classify.map(c => `  { glob: ${JSON.stringify(c.glob)}, tags: ${JSON.stringify(c.tags)} },`),
    "],",
    "edges: { order: [",
    `  { tagNamespace: ${JSON.stringify(ns)}, sequence: { "": ["lib","app"] }, direction: "downward-only", because: ${JSON.stringify(because)} },`,
    "] },",
  ].join("\n");
  return {
    proposal: {
      pattern: "app-over-library",
      support: forward / total,
      evidence: [because, `app area(s): ${appNames.join(", ")}`, `library area(s): ${libNames.join(", ")}`],
      configFragment,
      addedViolations: countAddedViolations(graph, baseConfig, proposedConfig, "tag-order"),
      do: PROVE_RULES_DO,
    },
    weight: total,
  };
}

// A bare-name equivalent for a package resolved through its own
// `@types/<name>` shadow package (constraints.ts's own convention: a
// deny/allow rule against either identity matches the same real edge).
// Grouping by this bare name, not the raw resolved identity, keeps a
// package's value-import edges and its type-only `@types/` edges from
// splitting into two separate, half-evidenced candidates.
function bareExternalPackageName(name: string): string {
  if (!name.startsWith("@types/")) return name;
  const rest = name.slice("@types/".length);
  const scopeSplit = rest.indexOf("__");
  return scopeSplit === -1 ? rest : `@${rest.slice(0, scopeSplit)}/${rest.slice(scopeSplit + 2)}`;
}

// patterns.md's "external package confined to one area" - the most common
// shape kept in a real import graph even when no config declares it. Read
// from `graph.edges` (not `crossModuleEdges`): an external package's own
// target is never a declared module, so `toModule` is always undefined
// and `crossModuleEdges` filters every such edge out by construction.
// Capped to the 3 most-evidenced packages so a project with many
// confined dependencies (43 of 50 surveyed keep at least one) does not by
// itself fill every slot the overall 5-proposal cap allows.
const EXTERNAL_PACKAGE_PROPOSAL_CAP = 3;

function detectExternalPackageConfined(
  modules: readonly Module[],
  graph: ModuleGraph,
  declaredModules: readonly { name: string; glob: string }[],
  baseConfig: Config,
): { proposal: PatternProposal; weight: number }[] {
  if (modules.length < 2) return []; // "confined to one area" needs another area it is absent from
  const byPackage = new Map<string, Map<string, number>>(); // bare package name -> (owning module -> edge count)
  for (const edge of graph.edges) {
    if (edge.externalPackage === undefined) continue;
    const name = bareExternalPackageName(edge.externalPackage);
    const byModule = byPackage.get(name) ?? new Map<string, number>();
    byModule.set(edge.fromModule, (byModule.get(edge.fromModule) ?? 0) + 1);
    byPackage.set(name, byModule);
  }
  const candidates: { name: string; module: string; edgeCount: number }[] = [];
  for (const [name, byModule] of byPackage) {
    if (byModule.size !== 1) continue; // imported from more than one area: not confined
    const [module, edgeCount] = [...byModule.entries()][0]!;
    candidates.push({ name, module, edgeCount });
  }
  candidates.sort((a, b) => b.edgeCount - a.edgeCount || a.name.localeCompare(b.name));
  return candidates.slice(0, EXTERNAL_PACKAGE_PROPOSAL_CAP).map(({ name, module, edgeCount }) => {
    const ns = freeTagNamespace(baseConfig, "kind");
    const classify = partitionClassify(declaredModules, `${ns}:rest`, [module], `${ns}:confined`);
    const because = `'${name}' is imported ${edgeCount} time(s), all from '${module}'; no other module imports it today`;
    const allowDenyRule = { source: `${ns}:rest`, targetNamespace: "pkg", deny: [name], because };
    const proposedConfig: Config = {
      ...baseConfig,
      classify: [...(baseConfig.classify ?? []), ...classify],
      edges: { ...baseConfig.edges, allowDeny: [...(baseConfig.edges?.allowDeny ?? []), allowDenyRule] },
    };
    const configFragment = [
      "classify: [",
      ...classify.map(c => `  { glob: ${JSON.stringify(c.glob)}, tags: ${JSON.stringify(c.tags)} },`),
      "],",
      "edges: { allowDeny: [",
      `  { source: ${JSON.stringify(`${ns}:rest`)}, targetNamespace: "pkg", deny: ${JSON.stringify([name])}, because: ${JSON.stringify(because)} },`,
      "] },",
    ].join("\n");
    return {
      proposal: {
        pattern: "external-package-confined",
        support: 1,
        evidence: [because],
        configFragment,
        addedViolations: countAddedViolations(graph, baseConfig, proposedConfig, "tag-boundary"),
        do: PROVE_RULES_DO,
      },
      weight: edgeCount,
    };
  });
}

// patterns.md's "test code kept out of production": a test/fixture/mock
// module that already imports production code (real evidence it exists
// to exercise the rest of the project) but that no production module
// imports back today. Requiring evidence in both directions rules out an
// empty, disconnected directory that merely happens to share the name -
// zero edges either way is not a kept habit, it is silence.
const TEST_SEGMENT_PATTERN = /^(tests?|__tests__|test-utils|fixtures?|mocks?|helpers?)$/;

function detectTestCodeIsolation(
  modules: readonly Module[],
  counts: ReadonlyMap<string, ReadonlyMap<string, number>>,
  declaredModules: readonly { name: string; glob: string }[],
  baseConfig: Config,
  graph: ModuleGraph,
): { proposal: PatternProposal; weight: number }[] {
  const testNames = modules.filter(m => matchesAnySegment(moduleGlob(declaredModules, m.name), TEST_SEGMENT_PATTERN)).map(m => m.name);
  const prodNames = modules.map(m => m.name).filter(n => !testNames.includes(n));
  if (prodNames.length === 0) return [];
  const proposals: { proposal: PatternProposal; weight: number }[] = [];
  for (const testName of testNames) {
    const prodToTest = edgesBetweenGroups(counts, prodNames, [testName]);
    const testToProd = edgesBetweenGroups(counts, [testName], prodNames);
    if (prodToTest > 0 || testToProd === 0) continue; // already reached from production, or no evidence it exercises any production module
    const ns = freeTagNamespace(baseConfig, "kind");
    const classify = partitionClassify(declaredModules, `${ns}:prod`, [testName], `${ns}:test`);
    const because = `'${testName}' is never imported by any of ${prodNames.length} production module(s) today; it imports ${testToProd} of them, real evidence it exercises production code`;
    const pointRule = { from: { tags: [`${ns}:prod`] }, to: { tags: [`${ns}:test`] }, because };
    const proposedConfig: Config = {
      ...baseConfig,
      classify: [...(baseConfig.classify ?? []), ...classify],
      edges: { ...baseConfig.edges, point: [...(baseConfig.edges?.point ?? []), pointRule] },
    };
    const configFragment = [
      "classify: [",
      ...classify.map(c => `  { glob: ${JSON.stringify(c.glob)}, tags: ${JSON.stringify(c.tags)} },`),
      "],",
      "edges: { point: [",
      `  { from: { tags: [${JSON.stringify(`${ns}:prod`)}] }, to: { tags: [${JSON.stringify(`${ns}:test`)}] }, because: ${JSON.stringify(because)} },`,
      "] },",
    ].join("\n");
    proposals.push({
      proposal: {
        pattern: "test-code-isolation",
        support: 1,
        evidence: [because],
        configFragment,
        addedViolations: countAddedViolations(graph, baseConfig, proposedConfig, "point-rule"),
        do: PROVE_RULES_DO,
      },
      weight: testToProd,
    });
  }
  return proposals;
}

// patterns.md's "host/plugin inversion": a host/core area a plugin area
// already depends on, that never depends back. `support` reads below 1
// exactly like `detectLayeredOrder`'s reverse edge does - a real host
// that names one concrete plugin today is still worth proposing, with the
// existing edge counted as the added violation this proposal would create.
const HOST_SEGMENT_PATTERN = /^(core|host)$/;
const PLUGIN_SEGMENT_PATTERN = /^(plugins?|extensions?)$/;

function detectHostPluginInversion(
  modules: readonly Module[],
  counts: ReadonlyMap<string, ReadonlyMap<string, number>>,
  declaredModules: readonly { name: string; glob: string }[],
  baseConfig: Config,
  graph: ModuleGraph,
): { proposal: PatternProposal; weight: number } | undefined {
  const hostNames = modules.filter(m => matchesAnySegment(moduleGlob(declaredModules, m.name), HOST_SEGMENT_PATTERN)).map(m => m.name);
  const pluginNames = modules.filter(m => matchesAnySegment(moduleGlob(declaredModules, m.name), PLUGIN_SEGMENT_PATTERN)).map(m => m.name);
  if (hostNames.length === 0 || pluginNames.length === 0) return undefined;
  const pluginToHost = edgesBetweenGroups(counts, pluginNames, hostNames);
  const hostToPlugin = edgesBetweenGroups(counts, hostNames, pluginNames);
  if (pluginToHost === 0) return undefined; // no evidence a plugin depends on the host at all
  const total = pluginToHost + hostToPlugin;
  const ns = freeTagNamespace(baseConfig, "kind");
  const classify = [
    ...hostNames.map(name => ({ glob: moduleGlob(declaredModules, name), tags: [`${ns}:host`] })),
    ...pluginNames.map(name => ({ glob: moduleGlob(declaredModules, name), tags: [`${ns}:plugin`] })),
  ];
  const because = `plugin -> host: ${pluginToHost} edge(s); host -> plugin: ${hostToPlugin} edge(s)`;
  const allowDenyRule = { source: `${ns}:host`, targetNamespace: ns, deny: ["plugin"], because };
  const proposedConfig: Config = {
    ...baseConfig,
    classify: [...(baseConfig.classify ?? []), ...classify],
    edges: { ...baseConfig.edges, allowDeny: [...(baseConfig.edges?.allowDeny ?? []), allowDenyRule] },
  };
  const configFragment = [
    "classify: [",
    ...classify.map(c => `  { glob: ${JSON.stringify(c.glob)}, tags: ${JSON.stringify(c.tags)} },`),
    "],",
    "edges: { allowDeny: [",
    `  { source: ${JSON.stringify(`${ns}:host`)}, targetNamespace: ${JSON.stringify(ns)}, deny: ["plugin"], because: ${JSON.stringify(because)} },`,
    "] },",
  ].join("\n");
  return {
    proposal: {
      pattern: "host-plugin-inversion",
      support: pluginToHost / total,
      evidence: [because, `host area(s): ${hostNames.join(", ")}`, `plugin area(s): ${pluginNames.join(", ")}`],
      configFragment,
      addedViolations: countAddedViolations(graph, baseConfig, proposedConfig, "tag-boundary"),
      do: PROVE_RULES_DO,
    },
    weight: total,
  };
}

// patterns.md's "feature isolation with a shared kernel": at least two
// sibling modules under the same features/modules/pages container, plus
// one kernel-named module (shared/core/common/lib) they import - grouped
// by the container's own literal prefix so an unrelated directory sharing
// a feature's own name elsewhere in the tree never joins the group.
const FEATURE_CONTAINER_PATTERN = /^(features?|modules|pages)$/;
const KERNEL_SEGMENT_PATTERN = /^(shared|core|common|lib)$/;

function featureContainerKey(glob: string): string | undefined {
  const segments = moduleSegments(glob);
  const index = segments.findIndex(s => FEATURE_CONTAINER_PATTERN.test(s));
  if (index === -1 || index === segments.length - 1) return undefined; // needs a feature name segment after the container
  return segments.slice(0, index + 1).join("/");
}

function detectFeatureIsolation(
  modules: readonly Module[],
  counts: ReadonlyMap<string, ReadonlyMap<string, number>>,
  declaredModules: readonly { name: string; glob: string }[],
  baseConfig: Config,
  graph: ModuleGraph,
): { proposal: PatternProposal; weight: number }[] {
  const groups = new Map<string, string[]>();
  for (const module of modules) {
    const key = featureContainerKey(moduleGlob(declaredModules, module.name));
    if (key === undefined) continue;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(module.name);
  }
  const kernelNames = modules.filter(m => matchesAnySegment(moduleGlob(declaredModules, m.name), KERNEL_SEGMENT_PATTERN)
    && featureContainerKey(moduleGlob(declaredModules, m.name)) === undefined).map(m => m.name);
  const proposals: { proposal: PatternProposal; weight: number }[] = [];
  for (const [, featureNames] of groups) {
    if (featureNames.length < 2 || kernelNames.length === 0) continue;
    // The kernel candidate these features lean on most - the strongest
    // evidence for which shared module, if more than one name matches.
    const kernelName = [...kernelNames].sort((a, b) => edgesBetweenGroups(counts, featureNames, [b]) - edgesBetweenGroups(counts, featureNames, [a]) || a.localeCompare(b))[0]!;
    const featureToKernel = edgesBetweenGroups(counts, featureNames, [kernelName]);
    if (featureToKernel === 0) continue; // no evidence these features actually use this kernel
    const crossFeature = edgesBetweenGroups(counts, featureNames, featureNames);
    const featureNs = freeTagNamespace(baseConfig, "feature");
    const kernelNs = freeTagNamespace(baseConfig, "kind");
    const classify = [
      ...featureNames.map(name => ({ glob: moduleGlob(declaredModules, name), tags: [`${featureNs}:${name}`] })),
      { glob: moduleGlob(declaredModules, kernelName), tags: [`${kernelNs}:shared`] },
    ];
    const because = `features -> kernel ('${kernelName}'): ${featureToKernel} edge(s); features -> each other: ${crossFeature} edge(s)`;
    const allowDenyRules = featureNames.map(name => ({ source: `${featureNs}:${name}`, targetNamespace: featureNs, allow: [] as string[], because }));
    const proposedConfig: Config = {
      ...baseConfig,
      classify: [...(baseConfig.classify ?? []), ...classify],
      edges: { ...baseConfig.edges, allowDeny: [...(baseConfig.edges?.allowDeny ?? []), ...allowDenyRules] },
    };
    const configFragment = [
      "classify: [",
      ...classify.map(c => `  { glob: ${JSON.stringify(c.glob)}, tags: ${JSON.stringify(c.tags)} },`),
      "],",
      "edges: { allowDeny: [",
      ...allowDenyRules.map(r => `  { source: ${JSON.stringify(r.source)}, targetNamespace: ${JSON.stringify(featureNs)}, allow: [], because: ${JSON.stringify(because)} },`),
      "] },",
    ].join("\n");
    proposals.push({
      proposal: {
        pattern: "feature-isolation",
        support: featureToKernel / (featureToKernel + crossFeature),
        evidence: [because, `sibling features: ${featureNames.join(", ")}`],
        configFragment,
        addedViolations: countAddedViolations(graph, baseConfig, proposedConfig, "tag-boundary"),
        do: PROVE_RULES_DO,
      },
      weight: featureToKernel + crossFeature,
    });
  }
  return proposals;
}

// At most 5 proposals survive - a project with more detectable shapes than
// that sees only its strongest-evidenced ones; `detected` (recommend()'s
// own field) keeps the cut visible.
//
// Ranking cannot sort on `support` alone: a leaf kernel with exactly one
// importer scores a clean 1, tying or beating a real, near-total fit like
// an application depending on a library through hundreds of edges with a
// small, real handful of exceptions (support just under 1). `rankScore`
// shrinks `support` toward 0 by how little evidence backs it
// (`weight / (weight + RANK_SHRINKAGE)`, the same idea a ratings site
// uses so five five-star reviews don't outrank a thousand at 4.9) - a
// trivially clean proposal with almost no real evidence sinks below a
// large, mostly-clean one, without changing `support` itself (still the
// plain fraction a reader sees, and what the two existing layered-order
// tests already assert exactly).
const RANK_SHRINKAGE = 5;

const PATTERN_PROPOSAL_CAP = 5;

function rankScore(proposal: PatternProposal, weight: number): number {
  return proposal.support * (weight / (weight + RANK_SHRINKAGE));
}

function detectPatterns(
  modules: readonly Module[],
  graph: ModuleGraph,
  counts: ReadonlyMap<string, ReadonlyMap<string, number>>,
  declaredModules: readonly { name: string; glob: string }[],
  baseConfig: Config,
  surfaceProposals: readonly SurfaceProposal[],
): PatternProposal[] {
  const publicEntryOnly = detectPublicEntryOnly(surfaceProposals);
  const weighted: { proposal: PatternProposal; weight: number }[] = [
    ...[detectLayeredOrder(modules, counts, declaredModules, baseConfig, graph)].filter((w): w is { proposal: PatternProposal; weight: number } => w !== undefined),
    ...detectLeafKernels(modules, graph, declaredModules, baseConfig),
    ...(publicEntryOnly === undefined ? [] : [publicEntryOnly]),
    ...[detectAppOverLibrary(modules, counts, declaredModules, baseConfig, graph)].filter((w): w is { proposal: PatternProposal; weight: number } => w !== undefined),
    ...detectExternalPackageConfined(modules, graph, declaredModules, baseConfig),
    ...detectTestCodeIsolation(modules, counts, declaredModules, baseConfig, graph),
    ...[detectHostPluginInversion(modules, counts, declaredModules, baseConfig, graph)].filter((w): w is { proposal: PatternProposal; weight: number } => w !== undefined),
    ...detectFeatureIsolation(modules, counts, declaredModules, baseConfig, graph),
  ];
  weighted.sort((a, b) => rankScore(b.proposal, b.weight) - rankScore(a.proposal, a.weight) || a.proposal.pattern.localeCompare(b.proposal.pattern));
  return weighted.map(w => w.proposal);
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
// check.ts's own grouped text follows for a large violation list. The
// same cap bounds how many surface-less modules and how many name lists
// inside an evidence line get printed - a project with dozens of modules
// must not turn one `recommend` run's own text into hundreds of lines;
// `--json` always carries every module, every candidate, every name.
const TEXT_LIST_CAP = 5;

// Truncates a comma-separated list to its first `TEXT_LIST_CAP` items,
// appending how many were left out - `items.length` alone (not a fixed
// count) so a 6-item list reads "+1 more", never a cap that only ever
// fires past its own trigger point.
function formatCappedList(items: readonly string[]): string {
  if (items.length <= TEXT_LIST_CAP) return items.join(", ");
  return `${items.slice(0, TEXT_LIST_CAP).join(", ")}, +${items.length - TEXT_LIST_CAP} more`;
}

// Every evidence line this file's own detectors emit that names a group
// of modules by a fixed prefix, matched here so this stays a text-only
// concern: `evidence` itself (and `--json`) keeps the full list, since
// truncating a shared string array at construction time would truncate
// the JSON too, not just the text a human reads.
const EVIDENCE_LIST_PREFIXES = [/^(?:app|library|host|plugin) area\(s\): /, /^sibling features: /];

function capEvidenceLineForText(line: string): string {
  const prefix = EVIDENCE_LIST_PREFIXES.map(p => p.exec(line)?.[0]).find((m): m is string => m !== undefined);
  if (prefix === undefined) return line;
  return prefix + formatCappedList(line.slice(prefix.length).split(", "));
}

export function formatRecommendText(result: RecommendResult): string {
  const quote = JSON.stringify;
  const shownSurfaceProposals = result.surfaceProposals.slice(0, TEXT_LIST_CAP);
  return [
    `${result.modules} modules; ${result.detected} pattern(s) detected, ${result.patternProposals.length} shown`,
    ...(result.patternProposals.length === 0 ? [] : [
      "", "pattern proposals, ranked by evidence:",
      ...result.patternProposals.flatMap(proposal => [
        `  ${proposal.pattern} (support ${(proposal.support * 100).toFixed(0)}%, would add ${proposal.addedViolations} violation(s) today):`,
        ...proposal.evidence.map(line => `    ${capEvidenceLineForText(line)}`),
        `  do: ${proposal.do}`,
      ]),
    ]),
    ...(result.surfaceProposals.length === 0 ? [] : [
      "", "proposed surfaces (no public surface file present today):",
      ...shownSurfaceProposals.flatMap(proposal => [
        `  ${proposal.module}: ${quote(proposal.proposedSurface)} covers ${proposal.coveredImports} of ${proposal.totalImports} bypasses, ${proposal.remainingImports} remaining`,
        ...proposal.candidates.slice(0, TEXT_LIST_CAP).map(c => `    ${c.file} (${c.importers} importer(s))`),
        ...(proposal.candidates.length > TEXT_LIST_CAP ? [`    ... ${proposal.candidates.length - TEXT_LIST_CAP} more candidate(s); see --json`] : []),
        ...proposal.choices.map(choice => `  ${choice}`),
      ]),
      ...(result.surfaceProposals.length > TEXT_LIST_CAP ? [`  ... ${result.surfaceProposals.length - TEXT_LIST_CAP} more surface-less module(s); see --json`] : []),
    ]),
    "",
  ].join("\n");
}
