// Reads survey-out/*.json and survey-out/_log.jsonl, decides per pattern
// whether each measured repository shows it (thresholds below, stated in the
// report), and writes survey-out/report.md plus survey-out/summary.json.
//
// usage: node survey/aggregate.mjs [survey-out]
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2] ?? new URL("../survey-out", import.meta.url).pathname;
const log = readFileSync(join(OUT, "_log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const byRepo = new Map();
for (const f of readdirSync(OUT).filter((f) => f.endsWith(".json") && f !== "summary.json")) {
  const d = JSON.parse(readFileSync(join(OUT, f), "utf8")); byRepo.set(d.repo, d);
}
// Star order is the log's order; the last line for a repo wins (retries).
const lastStatus = new Map(); for (const l of log) lastStatus.set(l.repo, l);
const order = [...new Set(log.map((l) => l.repo))];
// The sample is the first SAMPLE_SIZE measured repositories in star order;
// a retry that succeeds pushes the tail out, which is recorded.
const SAMPLE_SIZE = Number(process.env.SURVEY_SAMPLE_SIZE ?? 50);
const allMeasured = order.filter((r) => lastStatus.get(r).status === "measured" && byRepo.has(r)).map((r) => byRepo.get(r));
const measured = allMeasured.slice(0, SAMPLE_SIZE);
const beyond = allMeasured.slice(SAMPLE_SIZE).map((d) => d.repo);
const skipped = order.map((r) => lastStatus.get(r)).filter((l) => l.status === "skipped");
const failed = order.map((r) => lastStatus.get(r)).filter((l) => l.status === "error");

// A manual reading of each flagged lint config, when present, replaces the
// automatic detector's yes/no (which also matches rules that restrict only
// third-party packages).
const verifiedPath = join(OUT, "declared-verified.json");
const verified = (() => { try { return JSON.parse(readFileSync(verifiedPath, "utf8")); } catch { return {}; } })();
const declares = (d) => verified[d.repo] ? verified[d.repo].kind === "internal-boundary" : d.declaredBoundaryConfig.present;
const declaredText = (d) => verified[d.repo] ? `${verified[d.repo].kind}: ${verified[d.repo].note}` : d.declaredBoundaryConfig.present ? d.declaredBoundaryConfig.where.join("; ") : "no";
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const tsxHeavy = (d) => (d.counts.totalTsxFiles ?? 0) > d.counts.totalTsFiles;
const COMMONISH = new Set(["common", "shared"]);
const envName = (p) => (p.startsWith("electron-") ? "electron" : p);

// Each pattern: test(d) -> { present, evidence, score } ; score orders examples.
const PATTERNS = [
  {
    key: "layered", title: "Layered order",
    threshold: "production value graph with >= 4 modules, longest path >= 2 edges, and at most 10% of modules inside value cycles",
    test(d) {
      const p = d.production, N = d.counts.modules;
      const inCycles = p.cycles.modulesInValueCycles;
      const present = N >= 4 && p.order.longestPathEdges >= 2 && inCycles <= 0.1 * N;
      return { present, score: p.order.longestPathEdges * 1000 + N,
        evidence: `${N} modules, longest path ${p.order.longestPathEdges} edges, ${inCycles} modules in value cycles; ${p.order.comparablePairs} comparable vs ${p.order.incomparablePairs} incomparable pairs` };
    },
  },
  {
    key: "platform", title: "Runtime/platform environments",
    threshold: "at least two platform directory names (common/browser/node/worker/electron-*/client/server/shared) with >= 10 files each, and edges in a forbidden direction (common/shared -> a specific platform, browser <-> node, client <-> server) <= 1% of cross-platform production value edges",
    test(d) {
      const files = d.platforms.files, big = Object.entries(files).filter(([, n]) => n >= 10).map(([k]) => k);
      const edges = Object.entries(d.platforms.crossPlatformValueEdges);
      const total = edges.reduce((a, [, n]) => a + n, 0);
      const forbidden = edges.filter(([k]) => {
        const [a, b] = k.split(" -> ").map(envName);
        return (COMMONISH.has(a) && !COMMONISH.has(b)) || (a === "browser" && b === "node") || (a === "node" && b === "browser") ||
          (a === "client" && b === "server") || (a === "server" && b === "client") || (a === "worker" && b === "node") || (a === "browser" && b === "electron");
      });
      const bad = forbidden.reduce((a, [, n]) => a + n, 0);
      const present = big.length >= 2 && total > 0 && bad <= 0.01 * total;
      return { present, score: total,
        evidence: `platform dirs ${big.map((k) => `${k} ${files[k]}`).join(", ")}; ${total} cross-platform value edges, ${bad} in a forbidden direction${bad ? ` (${forbidden.map(([k, n]) => `${k}: ${n}`).join(", ")})` : ""}` };
    },
  },
  {
    key: "featureKernel", title: "Feature isolation around a shared kernel",
    threshold: "a group of >= 4 sibling modules (same parent directory) with >= 70% of pairs having no edge either way, plus a hub module imported by >= half of the other modules",
    test(d) {
      const p = d.production;
      const g = p.siblings.groups.filter((g) => g.modules >= 4 && g.share >= 0.7).sort((a, b) => b.modules - a.modules)[0];
      const hub = p.hubs.list[0];
      return { present: Boolean(g && hub), score: g ? g.modules : 0,
        evidence: g ? `siblings under ${g.parent}: ${g.modules} modules, ${g.isolatedPairs}/${g.pairs} pairs isolated (${pct(g.share)})${hub ? `; hub ${hub.module} imported by ${hub.inDegree} of ${d.counts.modules - 1}` : "; no hub"}` : "no sibling group >= 4 with >= 70% isolation" };
    },
  },
  {
    key: "publicEntry", title: "Public entry only",
    threshold: ">= 90% of all cross-module production value edges land on the target module's entry file (an edge into a module with no entry file counts as not landing), over >= 20 edges",
    test(d) {
      const e = d.publicEntry, n = e.valueEdgesToEntry + e.valueEdgesToDeeperFile + e.valueEdgesToModuleWithoutEntry;
      const share = n ? e.valueEdgesToEntry / n : 0;
      return { present: n >= 20 && share >= 0.9, score: n,
        evidence: `${e.valueEdgesToEntry}/${n} edges land on an entry file (${n ? pct(share) : "n/a"}); ${e.modulesWithEntry}/${d.counts.modules} modules have an entry file; check reports ${d.check?.publicSurfaceBypass ?? "n/a"} bypasses (${d.check?.publicSurfaceBypassFromTests ?? "n/a"} from tests)` };
    },
  },
  {
    key: "leafKernel", title: "Leaf/pure kernel",
    threshold: "a module with no outgoing production value edge to another project module, imported by >= max(3, 30% of the other modules)",
    test(d) {
      const N = d.counts.modules, need = Math.max(3, Math.ceil(0.3 * (N - 1)));
      const leaf = d.production.leaves.top.find((l) => l.inDegree >= need);
      return { present: Boolean(leaf), score: leaf ? leaf.inDegree / Math.max(1, N - 1) : 0,
        evidence: leaf ? `${leaf.module} (${leaf.files} files) imports no project module and is imported by ${leaf.inDegree} of ${N - 1}` : `no leaf imported by >= ${need} modules` };
    },
  },
  {
    key: "externalConfined", title: "External package confined to one area",
    threshold: ">= 4 modules and >= 5 third-party packages imported from production code, with >= 50% of those packages imported by exactly one module",
    test(d) {
      const x = d.external, share = x.packages ? x.confinedToOneModule / x.packages : 0;
      return { present: d.counts.modules >= 4 && x.packages >= 5 && share >= 0.5, score: x.confinedToOneModule,
        evidence: `${x.confinedToOneModule}/${x.packages} packages used by one module (${pct(share)}); e.g. ${x.confined.slice(0, 3).join(", ")}; widest: ${x.widest.slice(0, 2).join(", ")}` };
    },
  },
  {
    key: "appLib", title: "App vs lib",
    threshold: ">= 20 files under apps/ (or app/, examples/) and >= 20 under packages/ (or libs/, lib/), with zero production value edges from the library side into the app side",
    test(d) {
      const a = d.appLib; if (!a) return { present: false, score: 0, evidence: "not measured (older analyzer run)" };
      return { present: a.appFiles >= 20 && a.libFiles >= 20 && a.libToApp === 0, score: a.appToLib,
        evidence: `apps ${a.appFiles} files, libs ${a.libFiles} files; app -> lib ${a.appToLib}, lib -> app ${a.libToApp}` };
    },
  },
  {
    key: "tests", title: "Test code kept out of production",
    threshold: ">= 10 test files analyzed and zero edges from a non-test file into a test file",
    test(d) {
      return { present: d.counts.testFilesAnalyzed >= 10 && d.tests.prodToTestEdges === 0, score: d.counts.testFilesAnalyzed,
        evidence: `${d.counts.testFilesAnalyzed} test files, ${d.tests.prodToTestEdges} production -> test edges${d.tests.examples.length ? ` (e.g. ${d.tests.examples[0]})` : ""}` };
    },
  },
  {
    key: "hostPlugin", title: "Host/plugin inversion",
    threshold: "a plugin-area directory (contrib/plugins/extensions/addons/integrations/adapters/providers/nodes) with >= 3 members, where members import the host, <= 3 host files import into the area, and member-to-member edges are <= 5% of member-to-host edges",
    test(d) {
      const a = (d.pluginAreas ?? []).filter((a) => !/(^|\/)(examples?|tests?|__tests__|fixtures)(\/|$)/.test(a.area)).find((a) => a.pluginToHost > 0 && a.hostFilesImportingArea <= 3 && a.pluginToOtherPlugin <= 0.05 * a.pluginToHost);
      return { present: Boolean(a), score: a ? a.members : 0,
        evidence: a ? `${a.area}: ${a.members} members, ${a.files} files; member -> host ${a.pluginToHost}, host files importing the area ${a.hostFilesImportingArea}${a.hostFilesExamples.length ? ` (${a.hostFilesExamples.join(", ")})` : ""}, member -> member ${a.pluginToOtherPlugin}` : d.pluginAreas ? `${d.pluginAreas.length} plugin areas, none meets the threshold` : "not measured (older analyzer run)" };
    },
  },
];

const rows = measured.map((d) => ({ d, results: Object.fromEntries(PATTERNS.map((p) => [p.key, p.test(d)])) }));
const summary = PATTERNS.map((p) => {
  const hits = rows.filter((r) => r.results[p.key].present);
  const judged = rows.filter((r) => !/not measured/.test(r.results[p.key].evidence));
  return { key: p.key, title: p.title, threshold: p.threshold, judged: judged.length, present: hits.length,
    presentDeclaring: hits.filter((r) => declares(r.d)).length,
    presentTsxHeavy: hits.filter((r) => tsxHeavy(r.d)).length,
    repos: hits.map((r) => r.d.repo),
    examples: [...hits].sort((a, b) => b.results[p.key].score - a.results[p.key].score).slice(0, 3).map((r) => ({ repo: r.d.repo, evidence: r.results[p.key].evidence })) };
});

// Findings that are not on the pattern list, measured the same way.
const extra = {
  mutualPairs: rows.filter((r) => r.d.production.cycles.mutualPairCount > 0).map((r) => ({ repo: r.d.repo, pairs: r.d.production.cycles.mutualPairs.slice(0, 3) })),
  testFoldedCycles: rows.filter((r) => r.d.includingTests.cycles.modulesInValueCycles > r.d.production.cycles.modulesInValueCycles)
    .map((r) => ({ repo: r.d.repo, production: r.d.production.cycles.modulesInValueCycles, withTests: r.d.includingTests.cycles.modulesInValueCycles, modules: r.d.counts.modules })),
  typeOnlyCycles: rows.filter((r) => r.d.production.cycles.modulesInAnyCycle > r.d.production.cycles.modulesInValueCycles)
    .map((r) => ({ repo: r.d.repo, value: r.d.production.cycles.modulesInValueCycles, withTypes: r.d.production.cycles.modulesInAnyCycle })),
  nearlyDisconnected: rows.filter((r) => r.d.counts.modules >= 5 && r.d.production.edges.distinctValueModulePairs <= r.d.counts.modules / 2)
    .map((r) => ({ repo: r.d.repo, modules: r.d.counts.modules, pairs: r.d.production.edges.distinctValueModulePairs })),
  bigCycle: rows.filter((r) => r.d.production.cycles.largestValueScc >= Math.max(3, 0.3 * r.d.counts.modules))
    .map((r) => ({ repo: r.d.repo, largest: r.d.production.cycles.largestValueScc, modules: r.d.counts.modules })),
};

writeFileSync(join(OUT, "summary.json"), JSON.stringify({ generatedAt: new Date().toISOString(), measured: measured.length, skipped, failed, beyond,
  sample: measured.map((d) => ({ repo: d.repo, sha: d.sha, granularity: d.granularity, ts: d.counts.totalTsFiles, tsx: d.counts.totalTsxFiles, modules: d.counts.modules,
    declared: { internalBoundary: declares(d), detail: declaredText(d) }, patterns: Object.fromEntries(Object.entries(rows.find((r) => r.d === d).results).map(([k, v]) => [k, v.present])) })),
  patterns: summary, extra }, null, 2));

// ---- report.md -----------------------------------------------------------
const L = [];
const date = measured[0]?.measuredAt.slice(0, 10);
L.push("# Boundaries real TypeScript projects keep in their import graph", "");
L.push(`Measured ${measured.length} repositories on ${date}. Every number below comes from the parsed import graph of one shallow clone per repository; statements about intent are marked as inferences.`, "");
L.push("## Method", "");
L.push("- Sample: GitHub repositories with language TypeScript and more than 5,000 stars, in star order (top 200). Lists, tutorials, templates, type-definition collections, and repositories with fewer than 50 `.ts` files were skipped with a recorded reason; the first 50 that remain were measured.");
L.push("- Each repository was cloned with `--depth 1`. Nothing from the clone was installed, built, or run. Workspace packages were made resolvable by symlinking `node_modules/<name>` to the package directory from its `package.json`; third-party packages stay unresolved.");
L.push("- Module granularity: one module per workspace package in a monorepo; otherwise archstrict's own init walk (one module per directory holding `.ts` under `src/`, or the root); for a codebase over 5,000 `.ts` files, the largest top-level tree only (descending into a single wrapper directory that holds >= 80% of the files).");
L.push("- The graph is archstrict's `buildModuleGraph` over `.ts` files. \"Production\" drops edges whose importing file is test code. Value and type-only edges are kept apart; cycles and order use value edges.");
L.push("- A topological order is not unique. \"Longest path\" is the depth of the longest chain of module dependencies; \"incomparable\" pairs have no path either way and so no order in the data.", "");

L.push("## Per pattern", "");
L.push(`"Declare a boundary config" means a root-level config file with rules restricting imports between areas of the project itself, read by hand at the measured commit (${Object.keys(verified).filter((k) => !k.startsWith("_")).length} flagged configs read; ${measured.filter(declares).length} of ${measured.length} repositories qualify). Configs kept elsewhere (per-package, nested) were not searched.`, "");
L.push("| Pattern | Repos showing it | of which declare a boundary config | of which mostly `.tsx` |", "|---|---|---|---|");
for (const s of summary) L.push(`| ${s.title} | ${s.present} / ${s.judged} | ${s.presentDeclaring} | ${s.presentTsxHeavy} |`);
L.push("");
for (const s of summary) {
  L.push(`### ${s.title}`, "", `Present in **${s.present} of ${s.judged}** measured repositories (${s.presentDeclaring} of those declaring a boundary config).`, "", `Threshold: ${s.threshold}.`, "");
  for (const e of s.examples) L.push(`- **${e.repo}**: ${e.evidence}`);
  if (s.repos.length) L.push("", `All: ${s.repos.join(", ")}.`);
  L.push("");
}

L.push("### Domain isolation", "", "Not counted separately. In the import graph, domain isolation (sibling business domains that do not import each other) has the same shape as feature isolation; telling them apart needs to know what a directory means, which structure alone does not show. The sibling-isolation numbers above cover both.", "");
L.push("## Patterns found that are not on the list", "");
L.push(`- **Test code folds a clean layering into one cycle.** In ${extra.testFoldedCycles.length} repositories the value graph has more modules inside cycles once test files are counted than in production code alone (e.g. ${extra.testFoldedCycles.slice(0, 3).map((x) => `${x.repo}: ${x.production} -> ${x.withTests} of ${x.modules}`).join("; ")}). Inference: package tests import sibling packages as fixtures; the production graph is what a boundary rule should read.`);
L.push(`- **One stray import makes a mutual pair.** ${extra.mutualPairs.length} repositories have at least one production two-module value cycle; the edge counts are often lopsided (e.g. ${extra.mutualPairs.slice(0, 3).map((x) => `${x.repo}: ${x.pairs[0]}`).join("; ")}). Inference: one side is the intended direction and the few reverse edges are exceptions.`);
L.push(`- **Type-only back edges.** In ${extra.typeOnlyCycles.length} repositories, adding type-only edges puts more modules in cycles than value edges alone (e.g. ${extra.typeOnlyCycles.slice(0, 3).map((x) => `${x.repo}: ${x.value} -> ${x.withTypes}`).join("; ")}).`);
L.push(`- **Nearly disconnected workspaces.** ${extra.nearlyDisconnected.length} repositories with >= 5 modules have at most one distinct production value dependency per two modules (e.g. ${extra.nearlyDisconnected.slice(0, 3).map((x) => `${x.repo}: ${x.pairs} pairs over ${x.modules} modules`).join("; ")}).`);
L.push(`- **One large cycle.** ${extra.bigCycle.length} repositories have a production value cycle covering >= 30% of modules (e.g. ${extra.bigCycle.slice(0, 3).map((x) => `${x.repo}: ${x.largest} of ${x.modules}`).join("; ")}); these show no layered order at this granularity.`, "");

L.push("## Limits", "");
L.push("- One commit per repository, shallow clone; no history, so nothing here says whether a boundary is kept on purpose over time.");
L.push("- Only `.ts` files are parsed. Repositories where `.tsx` outnumbers `.ts` are counted but flagged; their graph omits most UI code.");
L.push("- Third-party imports are unresolved (no install). External confinement uses specifier text; a path alias that failed to resolve could be miscounted as a package.");
L.push("- Granularity is a choice. A pattern kept inside one module (for example platform folders inside one package) is only visible to the file-level measurements (platform, app vs lib, plugin areas, tests).");
L.push("- Entry files for workspace packages were taken from archstrict's own derivation of `exports`, falling back to `src/index.ts`, `index.ts`, `lib/index.ts`, or `src/main.ts`.");
L.push("- Thresholds are ours; the numbers per repository are in the per-repo JSON files so a different threshold can be applied.");
L.push("- Intent is inferred from structure only.", "");

L.push("## Sample", "");
L.push("| # | Repository | SHA | Granularity | .ts | .tsx | Modules | Declared config |", "|---|---|---|---|---|---|---|---|");
measured.forEach((d, i) => L.push(`| ${i + 1} | ${d.repo} | \`${d.sha.slice(0, 10)}\` | ${d.granularity.kind}${d.granularity.dir ? ` (${d.granularity.dir})` : ""} | ${d.counts.totalTsFiles} | ${d.counts.totalTsxFiles ?? "?"} | ${d.counts.modules} | ${declaredText(d)} |`));
L.push("", "### Skipped", "");
for (const s of skipped) L.push(`- ${s.repo}: ${s.reason}`);
if (failed.length) { L.push("", "### Not measured", ""); for (const s of failed) L.push(`- ${s.repo}: ${s.reason}`); }
if (beyond.length) L.push("", "### Measured but outside the sample", "", `${beyond.join(", ")}: measured before a retry of an earlier repository succeeded, which moved them past position ${SAMPLE_SIZE}. Their JSON files are kept but not counted.`);
writeFileSync(join(OUT, "report.md"), L.join("\n") + "\n");
console.log(summary.map((s) => `${s.title}: ${s.present}/${s.judged}`).join("\n"));
