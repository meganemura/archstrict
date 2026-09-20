import type { Config } from "../../../src/config.js";

export default {
  configPath: "<generated>",
  modules: "src/vs/*",
  kinds: { flat: "src/vs/*" },
  because: "converted from code-layering.ts's own table",
  scope: "src/vs/**",
  classifyByDirectoryName: {
  "tagNamespace": "env",
  "names": [
    "common",
    "node",
    "browser",
    "electron-browser",
    "electron-utility",
    "electron-main"
  ]
},
  edges: {
  "allowDeny": [
    {
      "source": "env:common",
      "targetNamespace": "env",
      "allow": [],
      "because": "common may only reach: (nothing outside its own layer)"
    },
    {
      "source": "env:node",
      "targetNamespace": "env",
      "allow": [
        "common"
      ],
      "because": "node may only reach: common"
    },
    {
      "source": "env:browser",
      "targetNamespace": "env",
      "allow": [
        "common"
      ],
      "because": "browser may only reach: common"
    },
    {
      "source": "env:electron-browser",
      "targetNamespace": "env",
      "allow": [
        "common",
        "browser"
      ],
      "because": "electron-browser may only reach: common, browser"
    },
    {
      "source": "env:electron-utility",
      "targetNamespace": "env",
      "allow": [
        "common",
        "node"
      ],
      "because": "electron-utility may only reach: common, node"
    },
    {
      "source": "env:electron-main",
      "targetNamespace": "env",
      "allow": [
        "common",
        "node",
        "electron-utility"
      ],
      "because": "electron-main may only reach: common, node, electron-utility"
    }
  ]
},
} satisfies Config;
