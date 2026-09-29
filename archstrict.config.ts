import type { Config } from "./archstrict.types.js";

// This repository checks its own library. The cuts follow how the code
// changes, not one module per file: `git log` shows rules landing together
// under src/rules, verbs under src/verbs, and the graph builder moving with
// the caches and config beside it. A new rule file or a new verb file then
// stays inside the module that already owns that kind of change.
//
// Flat files under src/ are one module because they change together: the
// graph builder, config, caches, and the type-leak checker the builder
// calls. A glob array can name a subset of siblings when a flat directory
// holds more than one seam; this directory does not. cli.ts,
// mcp-server.ts, and check-options.ts are peeled off with more-specific
// globs: leaving them inside core would cycle core with verbs (the CLI
// imports verbs, and verbs import the graph). map-shape.ts lives under
// verbs: only those verbs call it.
//
// type-leak.ts lives in core, not under src/rules. The graph builder calls
// that checker while it builds rule 6's closure, and the todo store reads
// that rule's evidence marker. Leaving the file in the rules module made
// those two calls a cycle with every other rule that reads the graph.
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
  // - spike/: throwaway probes and fixtures, not the library;
  // - features/: the nukadoko scenario drives the built CLI against a
  //   scratch copy; those steps are not library modules;
  // - scripts/: oracle runners and the typescript 7 probe, not library modules;
  // - the two root tool configs (vitest, nukadoko), which are harness
  //   entry points rather than modules other code imports;
  // - allurerc.mjs, the Allure runner config, which is not a TypeScript module.
  exclude: [
    "archstrict.config.ts",
    "archstrict.types.ts",
    ".*/**",
    "**/.*/**",
    "test/**",
    "spike/**",
    "features/**",
    "scripts/**",
    "vitest.config.ts",
    "nukadoko.config.ts",
    "allurerc.mjs",
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
      name: "core",
      glob: "src/*.ts",
      // Files other modules import. augmentation-cache.ts, edge-cache.ts,
      // and gitignore.ts stay private: only the graph builder uses them.
      surface: [
        "classify.ts",
        "config-pointer.ts",
        "config.ts",
        "module-candidates.ts",
        "module-graph.ts",
        "project-path.ts",
        "report-error.ts",
        "todo-migration.ts",
        "todo-store.ts",
        "type-closure.ts",
        "type-leak.ts",
        "warm-graph.ts",
      ],
    },
  ],
  classify: [
    { glob: "src/cli.ts", tags: ["layer:cli"] },
    { glob: "src/check-options.ts", tags: ["layer:cli"] },
    { glob: "src/mcp-server.ts", tags: ["layer:mcp"] },
    { glob: "src/verbs/**", tags: ["layer:verbs"] },
    { glob: "src/rules/**", tags: ["layer:rules"] },
    { glob: "src/*.ts", tags: ["layer:core"] },
  ],
  edges: {
    order: [
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
    ],
  },
  // Every module is clean. A later violation stays visible: todo will not
  // freeze a new one into a module on this list.
  strict: ["check-options", "cli", "core", "mcp", "rules", "verbs"],
  because:
    "Seams follow change, not one file per module: core is the analysis engine (graph, config, caches, the type-leak checker the graph builder calls, and the todo ratchet), rules and verbs are the directories new rules and verbs land in, and cli, mcp, and check-options sit above them so packaging does not cycle back into the graph. layer order keeps that direction. The MCP SDK is confined to the mcp module.",
} satisfies Config;
