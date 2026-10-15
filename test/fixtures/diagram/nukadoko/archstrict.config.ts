import type { Config } from "./archstrict.types.js";

// Module boundaries follow how this package grows.
//
// The step contract is split into five layers with no cycle between
// them: records, the step contract itself (step definitions, the ctx
// types, fixture types), config, the context that builds ctx, and
// fixtures. Every module is a directory module with the files other
// modules already import as its surface.
// A new file stays private until a caller outside the module needs it,
// which is the moment the surface has to be updated on purpose.
//
// Layers run from the leaves up to the two process entries. A layer may
// depend on an earlier one. Checks, the runner, compat, matching, and
// mcp are not one module, so a change in one of them is not a change to
// all of them.
//
// After an edit here, run `archstrict init` to regenerate archstrict.types.ts.
export default {
  schemaVersion: 1,
  surface: ["index.ts", "index.tsx", "index.mts", "index.cts"],
  exclude: [
    "archstrict.config.ts",
    "archstrict.types.ts",
    ".*/**",
    "**/.*/**",
    "tests/**",
    "examples/**",
    "*.test.ts",
    "**/*.test.ts",
    "*.spec.ts",
    "**/*.spec.ts",
    // Not the library this package publishes. vscode/ is its own package,
    // selftest-suite/ is the harness, and a root *.ts file is tooling.
    "selftest-suite/**",
    "vscode/**",
    "*.ts",
  ],
  mustBeEmpty: [
    {
      glob: "src/core/**",
      because:
        "there is no mega-core directory. A new check, matcher, compat file, or command goes in its own module.",
    },
    {
      glob: "src/utils/**",
      because:
        "a utils directory becomes the next mega-core. A shared function gets a named module (sink, issues, env) instead.",
    },
    {
      glob: "src/shared/**",
      because:
        "a shared directory hides which seam a change belongs to. Name the module for the thing it is.",
    },
  ],
  // Leaves and package doors that should not accumulate frozen debt.
  // A bypass here is fixed by extending that module's surface, not by
  // writing it into the todo file.
  strict: ["binding", "check", "compat", "entry", "env", "feature", "issues", "matching", "mcp", "sink", "version"],
  classify: [
    { glob: "src/env/**", tags: ["layer:leaf", "pkghost:library"] },
    { glob: "src/issues/**", tags: ["layer:leaf", "pkghost:library"] },
    { glob: "src/binding/**", tags: ["layer:base", "pkghost:library"] },
    { glob: "src/compat/**", tags: ["layer:base", "pkghost:library"] },
    { glob: "src/secrets/**", tags: ["layer:base", "pkghost:library"] },
    { glob: "src/session/**", tags: ["layer:base", "pkghost:library"] },
    { glob: "src/sink/**", tags: ["layer:base", "pkghost:library"] },
    { glob: "src/record/**", tags: ["layer:record", "pkghost:library"] },
    { glob: "src/step/**", tags: ["layer:contract", "pkghost:library"] },
    { glob: "src/config/**", tags: ["layer:config", "pkghost:library"] },
    { glob: "src/context/**", tags: ["layer:context", "pkghost:library"] },
    { glob: "src/fixture/**", tags: ["layer:fixture", "pkghost:library"] },
    { glob: "src/discover/**", tags: ["layer:read", "pkghost:library"] },
    { glob: "src/feature/**", tags: ["layer:read", "pkghost:feature"] },
    { glob: "src/version.ts", tags: ["layer:read", "pkghost:library"] },
    { glob: "src/check/**", tags: ["layer:service", "pkghost:library"] },
    { glob: "src/environment/**", tags: ["layer:service", "pkghost:library"] },
    { glob: "src/report/**", tags: ["layer:service", "pkghost:library"] },
    { glob: "src/run/**", tags: ["layer:run", "pkghost:library"] },
    { glob: "src/accept/**", tags: ["layer:workflow", "pkghost:library"] },
    { glob: "src/harvest/**", tags: ["layer:workflow", "pkghost:library"] },
    { glob: "src/live/**", tags: ["layer:workflow", "pkghost:library"] },
    { glob: "src/mcp/**", tags: ["layer:workflow", "pkghost:mcp"] },
    { glob: "src/tend/**", tags: ["layer:workflow", "pkghost:library"] },
    { glob: "src/webmcp/**", tags: ["layer:workflow", "pkghost:library"] },
    { glob: "src/cli/**", tags: ["layer:adapter", "pkghost:cli"] },
    { glob: "src/external/**", tags: ["layer:adapter", "pkghost:library"] },
    { glob: "src/cli.ts", tags: ["layer:entry", "pkghost:cli"] },
    { glob: "src/index.ts", tags: ["layer:entry", "pkghost:library"] },
    { glob: "src/matching/**", tags: ["layer:entry", "pkghost:library"] },
  ],
  edges: {
    order: [
      {
        tagNamespace: "layer",
        sequence: {
          "": ["leaf", "base", "record", "contract", "config", "context", "fixture", "read", "service", "run", "workflow", "adapter", "entry"],
        },
        direction: "downward-only",
        because:
          "foundation first. Records sit under the step contract, then config, the context that builds ctx, and fixtures. Checks, the runner, matching, and mcp sit above all five, so a change in one of them does not reach back into a lower layer. compat sits below them in base, so the migration door never depends on the engine it is migrating into.",
      },
    ],
    allowDeny: [
      {
        source: "pkghost:library",
        targetNamespace: "pkg",
        deny: ["@modelcontextprotocol/client", "yargs", "@cucumber/gherkin"],
        because:
          "the MCP client, yargs, and the Gherkin parser each have one home. Library code does not grow a second one.",
      },
      {
        source: "pkghost:cli",
        targetNamespace: "pkg",
        deny: ["@modelcontextprotocol/client", "@cucumber/gherkin"],
        because:
          "the CLI may parse argv with yargs. The MCP client stays behind a dynamic import of the mcp module, and feature files are parsed by the feature module.",
      },
      {
        source: "pkghost:mcp",
        targetNamespace: "pkg",
        deny: ["yargs", "@cucumber/gherkin"],
        because:
          "mcp is the only module that links the optional MCP client. It does not parse argv or feature files.",
      },
      {
        source: "pkghost:feature",
        targetNamespace: "pkg",
        deny: ["@modelcontextprotocol/client", "yargs"],
        because:
          "feature is the only module that links @cucumber/gherkin. It does not parse argv or talk to an MCP server.",
      },
    ],
  },
  declaredModules: [
    { name: "env", glob: "src/env/**", surface: ["load-env-files.ts", "parse-env-file.ts"] },
    { name: "issues", glob: "src/issues/**", surface: ["format-issues.ts"] },
    {
      name: "binding",
      glob: "src/binding/**",
      surface: [
        "capture.ts",
        "errors.ts",
        "escape-hint.ts",
        "expression.ts",
        "parameter-type-config.ts",
        "parameter-type-errors.ts",
        "pattern.ts",
        "quote-hint.ts",
        "registry.ts",
        "schema-shape.ts",
      ],
    },
    {
      name: "compat",
      glob: "src/compat/**",
      surface: [
        "allure-runtime.ts",
        "data-table.ts",
        "declared.ts",
        "define-world.ts",
        "errors.ts",
        "hooks.ts",
        "index.ts",
        "registry.ts",
        "run-hooks.ts",
        "tag-expression.ts",
        "world.ts",
      ],
    },
    {
      name: "secrets",
      glob: "src/secrets/**",
      surface: ["build-secret-set.ts", "classify-env-files.ts", "redact.ts", "types.ts"],
    },
    {
      name: "session",
      glob: "src/session/**",
      surface: ["live-sock.ts", "lock.ts", "manage.ts", "name.ts", "paths.ts", "storage-state.ts", "store.ts"],
    },
    { name: "sink", glob: "src/sink/**", surface: ["writable-sink.ts"] },
    {
      name: "config",
      glob: "src/config/**",
      surface: ["define-config.ts", "errors.ts", "load-config.ts", "module-kind.ts", "schema.ts"],
    },
    {
      name: "context",
      glob: "src/context/**",
      surface: [
        "create-context.ts",
        "env.ts",
        "errors.ts",
        "evidence.ts",
        "poll.ts",
        "trace-actions.ts",
        "used.ts",
      ],
    },
    {
      name: "fixture",
      glob: "src/fixture/**",
      surface: ["define-fixtures.ts", "graph.ts", "resolver.ts", "step-needs.ts", "validate-fixtures.ts"],
    },
    {
      name: "record",
      glob: "src/record/**",
      surface: [
        "messages-output.ts",
        "newest-run.ts",
        "read-step-record.ts",
        "record-id.ts",
        "retention.ts",
        "run-exports.ts",
        "run-marker.ts",
        "scenario-record.ts",
        "types.ts",
        "write-step-record.ts",
      ],
    },
    {
      name: "step",
      glob: "src/step/**",
      surface: [
        "context.ts",
        "define-explore.ts",
        "define-step.ts",
        "fixture-names.ts",
        "fixture-types.ts",
        "infer-needs.ts",
        "resolve-use.ts",
        "step-fixture-names.ts",
        "strict-args.ts",
        "validate-from.ts",
        "validate-parts.ts",
      ],
    },
    {
      name: "discover",
      glob: "src/discover/**",
      surface: ["discover-steps.ts", "format-vocabulary-error.ts"],
    },
    {
      name: "feature",
      glob: "src/feature/**",
      surface: ["feature-arg-read.ts", "load-features.ts", "parse-oath.ts", "resolve-oaths.ts"],
    },
    { name: "version", glob: "src/version.ts", surface: "version.ts" },
    {
      name: "check",
      glob: "src/check/**",
      surface: [
        "analyze.ts",
        "binding-check.ts",
        "codes.ts",
        "config-check.ts",
        "done-callback.ts",
        "feature-check.ts",
        "from-order.ts",
        "types.ts",
        "unfillable-key.ts",
      ],
    },
    {
      name: "environment",
      glob: "src/environment/**",
      surface: ["name.ts", "probe-version.ts", "resolve-environment.ts"],
    },
    {
      name: "report",
      glob: "src/report/**",
      surface: ["allure/categories.ts", "allure/emitter.ts", "messages/emitter.ts", "step-records.ts"],
    },
    {
      name: "run",
      glob: "src/run/**",
      surface: [
        "match-step.ts",
        "probe-git.ts",
        "process-signal.ts",
        "progress-log.ts",
        "run-concurrent.ts",
        "run-id.ts",
        "run-scenario.ts",
        "select-pickles.ts",
      ],
    },
    { name: "accept", glob: "src/accept/**", surface: ["render-record.ts", "select-run.ts"] },
    { name: "harvest", glob: "src/harvest/**", surface: ["build-draft.ts"] },
    {
      name: "live",
      glob: "src/live/**",
      surface: ["client.ts", "live-session-notice.ts", "spawn-daemon.ts"],
    },
    {
      name: "mcp",
      glob: "src/mcp/**",
      surface: ["index.ts"],
      friends: [
        {
          file: "list-tools.ts",
          from: "src/cli/**",
          because:
            "nuka mcp-tools dynamic-imports this file so the optional MCP client stays off every other command. It is not part of the nukadoko/mcp package surface.",
        },
      ],
    },
    { name: "tend", glob: "src/tend/**", surface: ["analyze.ts", "record-parse.ts", "types.ts"] },
    { name: "webmcp", glob: "src/webmcp/**", surface: ["call-tool.ts", "list-tools.ts"] },
    { name: "cli", glob: "src/cli/**", surface: ["run-cli.ts"] },
    { name: "external", glob: "src/external/**", surface: ["record-step.ts"] },
    { name: "bin", glob: "src/cli.ts", surface: "cli.ts" },
    { name: "entry", glob: "src/index.ts", surface: "index.ts" },
    { name: "matching", glob: "src/matching/**" },
  ],
  because:
    "seams follow growth. The step contract is one module, layered between records below and config, context, and fixtures above. Checks, compat, matching, mcp, and the CLI are separate modules with explicit surfaces, so a new file in one of them does not land in a single core.",
} satisfies Config;
