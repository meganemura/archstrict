// Floor fixture: what `init` would emit for a flat src/* project
// (nukadoko-shaped, ~20 module dirs) under the same tag schema as the two
// oracle fixtures above. One classify catch-all plus one
// declaredModules entry per discovered dir - the shape "discovery becomes
// an init-time suggestion" produces concretely. If this needed more than a
// screen, the schema would be wrong for small projects.
import type { Config } from "../../../src/config.js";

export default {
  configPath: "<fixture>",
  modules: "src/*",
  kinds: { flat: "src/*" },
  because: "flat preset: every module carries one tag, no layering declared",

  scope: "src/**",
  surface: "index.ts",

  classify: [{ glob: "src/*", tags: ["kind:app"] }],

  declaredModules: [
    { name: "matching", glob: "src/matching/**", surface: "index.ts" },
    { name: "webmcp", glob: "src/webmcp/**", surface: "index.ts" },
    { name: "tend", glob: "src/tend/**", surface: "index.ts" },
    { name: "report", glob: "src/report/**", surface: "index.ts" },
  ],

  edges: {},
} satisfies Config;
