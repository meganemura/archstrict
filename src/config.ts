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
  // Required, not optional: every real config comes from a file, and both
  // `check` and rule 4 (a config-vs-graph consistency check, not an edge
  // check) need somewhere to point a violation at. A test config that has
  // no real file uses a placeholder like "<test>".
  configPath: string;
  modules: string; // e.g. "src/*" — must match module-graph.ts's BuildOptions.modulesGlob
  // kind name -> path pattern. v0 supports exactly two pattern shapes:
  // the modules glob itself (matches every module — the `flat` preset's
  // single catch-all kind), or "<modules-root>/<name>" naming one exact
  // module. Any other shape (a nested wildcard like "src/features/*", for
  // instance) is out of scope for v0's single-level module model and is a
  // config error, not a rule violation — kindPatternNames throws rather
  // than silently treating it as "matches nothing".
  kinds: Record<string, string>;
  layers?: readonly string[];
  because: string;
};

// Whether `pattern` (a value of config.kinds) names `moduleName`. Shared by
// rule 3 (uncovered modules) and rule 4 (empty rule set): both need the
// same two-shapes-only pattern logic, and the throw-on-unsupported-shape
// decision belongs in one place, not copied between them.
export function kindPatternNames(
  pattern: string,
  modulesGlob: string,
  moduleName: string,
): boolean | "invalid" {
  if (pattern === modulesGlob) return true;
  const root = modulesGlob.slice(0, -1); // "src/*" -> "src/"
  if (!pattern.startsWith(root)) return "invalid";
  const rest = pattern.slice(root.length);
  if (rest.includes("*")) return "invalid"; // a nested wildcard: out of scope for v0's single-level modules
  return rest === moduleName;
}

export function invalidKindPatternMessage(pattern: string, modulesGlob: string): string {
  const root = modulesGlob.slice(0, -1);
  const meantCatchAll = pattern.startsWith(root) ? ` (did you mean '${modulesGlob}'?)` : "";
  return (
    `kind pattern '${pattern}' is not a shape v0 supports (modules glob is '${modulesGlob}')${meantCatchAll}: ` +
    `use the modules glob itself, or '<modules-root>/<exact-module-name>'`
  );
}
