// Responsibility: the shape of archstrict.config.ts. Minimal for v0: only
// what rule 3 (uncovered modules) needs. `init` (a later ticket) writes a
// file of this shape; later rules and the generated-union-type mechanism
// (spike 4) grow it.
// Boundary: a plain data type, no behavior. Reading and validating a real
// config file is the CLI's job (a later ticket); this file only names the
// shape every reader agrees on.
//
// Two separate namespaces, decided after spike 4 flagged the risk of
// conflating them: `layers` (not yet used by any v0 rule) will hold *kind*
// names — declared right here in `kinds`, so a structural generic can
// check them with no generated file. `deprecated.from`/`to` (rule 5, not
// yet built) will hold *module* names — real directories on disk, which is
// what spike 4's generated union type exists to check. This type does not
// yet enforce that separation (deferred to whichever ticket adds
// `layers`/`deprecated`); recorded here so that ticket does not reopen it.
export type Config = {
  modules: string; // e.g. "src/*" — must match module-graph.ts's BuildOptions.modulesGlob
  // kind name -> path pattern. v0 supports exactly two pattern shapes:
  // the modules glob itself (matches every module — the `flat` preset's
  // single catch-all kind), or "<modules-root>/<name>" naming one exact
  // module. Any other shape (a nested wildcard like "src/features/*", for
  // instance) is out of scope for v0's single-level module model and is a
  // config error, not a rule violation — checkUncoveredModules throws
  // rather than silently treating it as "matches nothing".
  kinds: Record<string, string>;
  layers?: readonly string[];
  because: string;
};
