import type { Config } from "./archstrict.types.js";

export default {
  schemaVersion: 1,
  exclude: ["archstrict.config.ts", "archstrict.types.ts"],
  declaredModules: [
    { name: "kernel", glob: "src/kernel/**" },
    { name: "domain", glob: "src/domain/**" },
    { name: "shell", glob: "src/shell/**" },
    {
      name: "store",
      glob: "src/store/**",
      surface: [],
      friends: [{ file: "db.ts", from: "src/shell/**", because: "only the shell opens the database" }],
    },
    { name: "vendor", glob: "src/vendor/**", surface: "lib.ts" },
    { name: 'odd & "name"', glob: "src/odd/**" },
    ...Array.from({ length: 12 }, (_, i) => ({ name: `tool${i}`, glob: `src/tools/t${i}/**` })),
  ],
  classify: [
    { glob: "src/kernel/**", tags: ["layer:kernel", "io:pure"] },
    { glob: "src/domain/**", tags: ["layer:domain", "io:pure"] },
    { glob: "src/domain/y.ts", tags: ["layer:kernel", "io:pure"] },
    { glob: "src/domain/z.ts", tags: ["io:pure"] },
    { glob: "src/shell/**", tags: ["layer:shell", "io:effect"] },
    { glob: "src/store/**", tags: ["layer:shell", "io:effect"] },
    { glob: "src/tools/**", tags: ["kind:tool"] },
  ],
  mustBeEmpty: [{ glob: "src/utils/**", because: "a utils directory hides which module owns a helper" }],
  ignoredCycles: [["kernel", "domain"]],
  deprecated: [{ from: "shell", to: "store", count: 3, because: "the shell reaches the store through one file" }],
  edges: {
    order: [
      {
        tagNamespace: "layer",
        sequence: { "": ["kernel", "domain", "shell", "command"] },
        direction: "downward-only",
        edgeType: "value",
        because: "a layer uses only the layers below it",
      },
      {
        tagNamespace: "tier",
        within: "layer",
        sequence: { kernel: ["low", "high"], shell: ["inner", "outer"] },
        direction: "downward-only",
        edgeType: "type",
        because: "inside a layer, tiers keep the same direction",
      },
    ],
    allowDeny: [
      {
        source: "layer:shell",
        targetNamespace: "layer",
        allow: ["domain", "kernel"],
        because: "the shell reaches the domain and the kernel, nothing else",
      },
      {
        source: "io:pure",
        targetNamespace: "pkg",
        deny: ["fs", "path"],
        edgeType: "value",
        because: "pure code takes values, not files",
      },
      {
        source: "kind:tool",
        targetNamespace: "pkg",
        allow: ["zlib"],
        because: "tools compress with zlib and use nothing else from npm",
      },
      {
        source: "kind:tool",
        targetNamespace: "layer",
        deny: ["shell"],
        importForm: "static",
        exceptions: [{ from: "src/tools/t0/**", to: "src/shell/**", because: "tool0 is the shell's own helper" }],
        because: "tools stay below the shell",
      },
    ],
    point: [
      {
        from: { tags: ["io:pure"], exclude: { tags: ["layer:kernel"] } },
        to: "src/store/**",
        because: "only the kernel reads the store directly",
      },
      { from: "src/vendor/**", to: { tags: ["pkg:node"] }, because: "vendored code stays free of Node builtins" },
      {
        from: { tags: ["layer:nothing"] },
        to: { tags: ["pkg:left-pad"] },
        importForm: "dynamic",
        because: "a tag no file carries draws an empty selector",
      },
    ],
  },
  because: "The kitchen sink: one of everything the diagram can draw.",
} satisfies Config;
