import type { Config } from "./config-type.js";
import type { ModuleName } from "./archstrict.generated.js";

export default {
  modules: "src/*",
  layers: ["app", "features", "shared"],
  deprecated: [
    // Typo: "featurse" is not a real module name.
    { from: "featurse", to: "shared", count: 1, because: "trial" },
  ],
  because: "flat preset",
} satisfies Config<ModuleName>;
