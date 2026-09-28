export default {
  declaredModules: [{ name: "m", glob: "src/m/**", surface: "index.ts" }],
  exclude: ["archstrict.config.ts"],
  because: "Expose all public types by name.",
};
