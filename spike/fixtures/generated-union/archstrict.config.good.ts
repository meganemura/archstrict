import type { Config } from "./config-type.js";
import type { ModuleName } from "./archstrict.generated.js";

export default {
  modules: "src/*",
  layers: ["app", "features", "shared"],
  deprecated: [
    { from: "features", to: "shared", count: 1, because: "trial" },
  ],
  because: "flat preset",
} satisfies Config<ModuleName>;
