// Second oracle fixture: VS Code's environment layering (code-layering.ts's
// directory-name algorithm plus code-import-patterns' external-package
// restrictions), ported to the same tag schema the Prisma fixture uses.
// Proves `classifyByDirectoryName` and an external `pkg:` target compose
// with the same `allowDeny` shape, no special case.
import type { Config } from "../../../src/config.js";

export default {
  configPath: "<fixture>",
  because: "environment layering (common/browser/node/electron-*), ambient-tagged by directory name",

  scope: "src/vs/**",
  surface: "index.ts",

  classifyByDirectoryName: {
    tagNamespace: "env",
    names: ["common", "browser", "node", "electron-browser", "electron-utility", "electron-main"],
  },

  edges: {
    allowDeny: [
      { source: "env:node", targetNamespace: "env", allow: ["common"], because: "node code may use common, not browser or electron" },
      { source: "env:browser", targetNamespace: "env", allow: ["common"], because: "browser code may use common, not node or electron" },
      { source: "env:electron-main", targetNamespace: "env", allow: ["common", "node", "electron-utility"], because: "electron-main may use common, node, and electron-utility" },
      // External targets: a synthesized `pkg:` tag (a resolve landing
      // outside scope becomes a tag under this namespace), not a file/tag
      // inside scope.
      { source: "env:node", targetNamespace: "pkg", allow: ["fs", "child_process"], because: "only node-capable layers may use node builtins" },
      { source: "env:browser", targetNamespace: "pkg", allow: [], because: "browser code must not depend on node builtins" },
    ],
  },
} satisfies Config;
