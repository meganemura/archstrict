import type { Config } from "./archstrict.types.js";

// This repository checks its own library. The cuts follow how the code
// changes, not one module per file: `git log` shows rules landing together
// under src/rules, verbs under src/verbs, and the graph builder moving with
// the caches and config beside it. A new rule file or a new verb file then
// stays inside the module that already owns that kind of change.
//
// The analysis engine under the rules is split by domain: src/config
// holds what a project declared, src/graph holds what the code is, and
// todo-store.ts holds the ratchet file. Splitting edge extraction or the
// type closure out of src/graph was measured and refused: since
// 2026-09-01 the edge files changed with the graph in 15 of 15 commits and
// the type closure in 9 of 13, and moving only the type closure out made
// a cycle through the edge cache's resolution key. A separate diagram module under src/verbs was refused too: it
// changed in 4 commits, and its import of verbs/check.ts raised the
// verbs module's fan-in. Flat files under src/ are single-file modules:
// cli.ts, mcp-server.ts, and check-options.ts sit above verbs (the CLI
// imports verbs, and verbs import the graph), and project-path.ts and
// report-error.ts are below everything. map-shape.ts lives under verbs:
// only those verbs call it.
//
// type-leak.ts lives in src/graph, not under src/rules. The graph builder
// calls that checker while it builds rule 6's closure, and the todo store
// reads that rule's evidence marker. Leaving the file in the rules module
// made those two calls a cycle with every other rule that reads the graph.
// A new rule stays in src/rules, which the order rule keeps under verbs
// and off the core import path.
//
// No ignoredCycles: type-only edges are not cycles, and the value graph has
// none once the CLI and MCP adapter sit above verbs. No mustBeEmpty: no
// directory is required to hold zero source files.
//
// Hooks stay in .agents/hooks as plain scripts. The TypeScript packaging
// seam is the mcp module.
export default {
  schemaVersion: 1,
  surface: ["index.ts", "index.tsx", "index.mts", "index.cts"],
  // Kept out of analysis entirely:
  // - archstrict's own two files, which are never module content;
  // - hidden directories at any depth (.git, tool state), which tsc's own
  //   default include also skips;
  // - test/: a test imports across modules as a fixture; boundary rules
  //   read production code;
  // - features/ and nukadoko.config.ts: the nukadoko scenarios drive the
  //   built CLI against scratch projects; those steps and their scratch
  //   fixture are not library modules;
  // - scripts/: oracle runners and the typescript 7 probe, not library modules;
  // - vitest.config.ts, the test harness entry point, which is not a
  //   module other code imports;
  exclude: [
    "archstrict.config.ts",
    "archstrict.types.ts",
    ".*/**",
    "**/.*/**",
    "test/**",
    "features/**",
    "nukadoko.config.ts",
    "scripts/**",
    "vitest.config.ts",
  ],
  declaredModules: [
    {
      name: "cli",
      glob: "src/cli.ts",
      surface: "cli.ts",
    },
    {
      name: "mcp",
      glob: "src/mcp-server.ts",
      surface: "mcp-server.ts",
    },
    {
      // Argv parsing for the check verb. It changes with the CLI, not with
      // the graph, so it is not part of core.
      name: "check-options",
      glob: "src/check-options.ts",
      surface: "check-options.ts",
    },
    {
      name: "verbs",
      glob: "src/verbs/**",
      // Each file is a verb the CLI or the MCP adapter calls. A helper
      // added beside them stays private until it is listed here.
      surface: [
        "agents.ts",
        "check.ts",
        "diagram.ts",
        "fix.ts",
        "hotspots.ts",
        "init.ts",
        "recommend.ts",
        "rules.ts",
        "search.ts",
        "simulate.ts",
        "todo.ts",
      ],
    },
    {
      name: "rules",
      glob: "src/rules/**",
      // moves.ts is only imported by constraints.ts, so it stays off the
      // surface. A new rule joins this list when verbs/check wires it in.
      surface: [
        "config-meaning.ts",
        "constraints.ts",
        "cycles.ts",
        "deprecated.ts",
        "empty-rule.ts",
        "must-be-empty.ts",
        "public-surface.ts",
        "uncovered.ts",
      ],
    },
    {
      // What the project declared: the config schema and loader, the
      // pointers from a value back to its source text, and the glob-to-tag
      // classifier the graph applies.
      name: "config",
      glob: "src/config/**",
      surface: ["classify.ts", "config-pointer.ts", "config.ts"],
    },
    {
      // What the code is: file discovery, the import edges and their
      // caches, and the type closure behind rule 6. Every edge-engine and
      // type-surface commit also touched module-graph.ts in most cases (15
      // of 15 and 9 of 13 since 2026-09-01), so they are one module.
      // edge-engine-choice.ts is public because the CLI reads the engine
      // choice and ends the engine around every verb.
      name: "graph",
      glob: "src/graph/**",
      surface: ["edge-engine-choice.ts", "module-candidates.ts", "module-graph.ts", "type-leak.ts", "warm-graph.ts"],
    },
    {
      name: "todo-store",
      glob: "src/todo-store.ts",
      surface: "todo-store.ts",
    },
    {
      name: "project-path",
      glob: "src/project-path.ts",
      surface: "project-path.ts",
    },
    {
      name: "report-error",
      glob: "src/report-error.ts",
      surface: "report-error.ts",
    },
  ],
  classify: [
    { glob: "src/cli.ts", tags: ["layer:cli"] },
    { glob: "src/check-options.ts", tags: ["layer:cli"] },
    { glob: "src/mcp-server.ts", tags: ["layer:mcp"] },
    { glob: "src/verbs/**", tags: ["layer:verbs"] },
    { glob: "src/rules/**", tags: ["layer:rules"] },
    { glob: "src/*.ts", tags: ["layer:core", "core:base"] },
    { glob: "src/config/**", tags: ["layer:core", "core:config"] },
    { glob: "src/graph/**", tags: ["layer:core", "core:graph"] },
    { glob: "src/todo-store.ts", tags: ["layer:core", "core:todo"] },
    // The one file that may load tsrs (ARCHSTRICT_ENGINE=tsrs). It keeps its
    // layer tag; the engine tag is what the point rules below exclude.
    { glob: "src/graph/edge-engine-tsrs.ts", tags: ["layer:core", "core:graph", "engine:tsrs"] },
  ],
  edges: {
    order: [
      {
        tagNamespace: "core",
        sequence: { "": ["base", "config", "graph", "todo"] },
        direction: "downward-only",
        because:
          "inside core, the graph reads the declared config, and the todo ratchet reads the graph; config never needs the graph to load",
      },
      {
        tagNamespace: "layer",
        sequence: { "": ["core", "rules", "verbs", "mcp", "cli"] },
        direction: "downward-only",
        because:
          "core analysis sits under rules, rules under verbs, verbs under the MCP adapter and the CLI, so a new rule or verb does not pull a lower layer upward",
      },
    ],
    allowDeny: [
      {
        source: "layer:cli",
        targetNamespace: "layer",
        deny: ["rules"],
        because:
          "a new rule is wired from verbs/check; the CLI dispatcher only reaches verbs, the MCP adapter, and core",
      },
      {
        source: "layer:mcp",
        targetNamespace: "layer",
        deny: ["rules"],
        because:
          "the MCP adapter calls verbs and does not wire rules itself",
      },
    ],
    point: [
      {
        from: { tags: ["layer:core"] },
        to: { tags: ["pkg:@modelcontextprotocol/sdk"] },
        because:
          "the MCP SDK stays in the mcp adapter; core must not take a packaging dependency",
      },
      {
        from: { tags: ["layer:rules"] },
        to: { tags: ["pkg:@modelcontextprotocol/sdk"] },
        because:
          "the MCP SDK stays in the mcp adapter; a rule must not take a packaging dependency",
      },
      {
        from: { tags: ["layer:verbs"] },
        to: { tags: ["pkg:@modelcontextprotocol/sdk"] },
        because:
          "the MCP SDK stays in the mcp adapter; a verb must not take a packaging dependency",
      },
      {
        from: { tags: ["layer:cli"] },
        to: { tags: ["pkg:@modelcontextprotocol/sdk"] },
        because:
          "the MCP SDK stays in the mcp adapter; the CLI reaches that adapter through mcp-server.ts",
      },
      // tsrs is an opt-in devDependency with no Windows binary. A second
      // file that imports it would load it on the default path, or stop
      // the build where it is not installed.
      {
        from: { tags: ["layer:core"], exclude: { tags: ["engine:tsrs"] } },
        to: { tags: ["pkg:tsrs"] },
        because: "tsrs is loaded only by edge-engine-tsrs.ts, so the default engine never needs it installed",
      },
      {
        from: { tags: ["layer:rules"] },
        to: { tags: ["pkg:tsrs"] },
        because: "tsrs is loaded only by edge-engine-tsrs.ts, so the default engine never needs it installed",
      },
      {
        from: { tags: ["layer:verbs"] },
        to: { tags: ["pkg:tsrs"] },
        because: "tsrs is loaded only by edge-engine-tsrs.ts, so the default engine never needs it installed",
      },
      {
        from: { tags: ["layer:mcp"] },
        to: { tags: ["pkg:tsrs"] },
        because: "tsrs is loaded only by edge-engine-tsrs.ts, so the default engine never needs it installed",
      },
      {
        from: { tags: ["layer:cli"] },
        to: { tags: ["pkg:tsrs"] },
        because: "tsrs is loaded only by edge-engine-tsrs.ts, so the default engine never needs it installed",
      },
    ],
  },
  // Every module is clean. A later violation stays visible: todo will not
  // freeze a new one into a module on this list.
  strict: ["check-options", "cli", "config", "graph", "mcp", "project-path", "report-error", "rules", "todo-store", "verbs"],
  because:
    "Seams follow change, not one file per module: the core layer is the analysis engine, split into config (what a project declared), graph (what the code is: discovery, edges, caches, and the type closure behind rule 6), and the todo store, in that order, rules and verbs are the directories new rules and verbs land in, and cli, mcp, and check-options sit above them so packaging does not cycle back into the graph. layer order keeps that direction. The MCP SDK is confined to the mcp module.",
} satisfies Config;
