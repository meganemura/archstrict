// Design fixture (ticket archstrict-4bn.1): proves v1's tag schema
// expresses Prisma 8's real architecture.config.json + the six
// dependency-cruiser.config.mjs generator functions it derives. Abbreviated
// to ten classify entries; every constraint shape appears at least once, in
// the syntax an agent would type. Not wired to any rule yet - `edges` is
// typed but unimplemented until archstrict-4bn.4.
import type { Config } from "../../../src/config.js";

export default {
  configPath: "<fixture>",
  modules: "packages/*", // v0 field, unused by this fixture's own v1 shape
  kinds: { flat: "packages/*" }, // present only so Config's required v0 fields typecheck
  because: "module boundaries for a domain/layer/plane architecture, expressed as tags instead of fixed axes",

  scope: "packages/**",
  exclude: ["**/*.test.ts", "**/*.spec.ts", "**/*.d.ts", "dist/**", "coverage/**", "packages/document/**"],
  surface: "index.ts",

  classify: [
    { glob: "packages/1-framework/0-foundation/**", tags: ["domain:framework", "layer:foundation", "plane:shared"] },
    { glob: "packages/1-framework/1-core/config/**", tags: ["domain:framework", "layer:core", "plane:shared"] },
    { glob: "packages/1-framework/1-core/framework-components/src/shared/**", tags: ["domain:framework", "layer:core", "plane:shared"] },
    { glob: "packages/1-framework/1-core/framework-components/src/control/**", tags: ["domain:framework", "layer:core", "plane:migration"] },
    { glob: "packages/1-framework/1-core/framework-components/src/execution/**", tags: ["domain:framework", "layer:core", "plane:runtime"] },
    // File-level override inside a directory a broader entry already covers.
    { glob: "packages/1-framework/1-core/framework-components/src/exports/control.ts", tags: ["domain:framework", "layer:core", "plane:migration"] },
    { glob: "packages/2-sql/1-core/**", tags: ["domain:sql", "layer:core", "plane:shared"] },
    { glob: "packages/2-sql/5-runtime/**", tags: ["domain:sql", "layer:runtime", "plane:runtime"] },
    { glob: "packages/2-sql/6-adapters/**", tags: ["domain:sql", "layer:adapters", "plane:runtime"] },
    { glob: "packages/2-sql/7-drivers/**", tags: ["domain:sql", "layer:drivers", "plane:runtime"] },
  ],

  declaredModules: [
    { name: "framework-components", glob: "packages/1-framework/1-core/framework-components/**", surface: "src/exports/*.ts" },
  ],

  edges: {
    allowDeny: [
      { source: "domain:framework", targetNamespace: "domain", allow: [], because: "framework is the innermost domain and may not import from any other domain" },
      { source: "domain:sql", targetNamespace: "domain", allow: ["framework"], because: "sql domain may import only from framework" },
      { source: "domain:targets", targetNamespace: "domain", allow: ["framework", "sql", "mongo"], because: "targets may import from framework, sql, and mongo" },
      { source: "plane:shared", targetNamespace: "plane", allow: ["shared"], because: "shared code must not depend on either concrete plane" },
      { source: "plane:migration", targetNamespace: "plane", allow: ["shared", "migration"], because: "migration-time code must not depend on runtime" },
      { source: "plane:runtime", targetNamespace: "plane", allow: ["shared", "runtime"], because: "runtime code must not depend on migration-time code" },
    ],
    order: [
      {
        tagNamespace: "layer",
        within: "domain",
        sequence: {
          framework: ["foundation", "core", "authoring", "tooling"],
          sql: ["core", "authoring", "tooling", "lanes", "runtime", "adapters", "drivers", "family"],
        },
        direction: "downward-only",
        because: "dependencies flow toward core; lateral within a layer is allowed",
      },
    ],
    point: [
      {
        from: { tags: ["domain:sql"], exclude: { tags: ["layer:adapters"] } },
        to: { tags: ["domain:sql", "layer:drivers"] },
        because: "drivers can only be imported by adapters",
      },
      { from: "packages/**", to: "test/**", because: "test suites are not part of source" },
      {
        from: "packages/1-framework/3-tooling/cli/src/commands/**",
        to: "packages/1-framework/3-tooling/migration/**",
        edgeType: "value",
        because: "CLI command modules must reach migration-tools through src/control-api",
      },
    ],
  },
} satisfies Config;
