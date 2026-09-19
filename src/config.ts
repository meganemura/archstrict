// Responsibility: the shape of archstrict.config.ts (minimal for v0; `init`,
// a later ticket, writes a file of this shape, and later rules and the
// generated-union-type mechanism (spike 4) grow it), plus the kind-pattern
// logic rules 3 and 4 both need: matching a pattern against a module name,
// and validating that every pattern in a config is a shape v0 supports.
// Boundary: `Config` itself is a plain data type, no behavior. Reading a
// real config file from disk is the CLI's job (a later ticket); this file
// only names the shape every reader agrees on and the one piece of logic
// (pattern matching) two rules would otherwise each reimplement.
//
// Two separate namespaces, decided after spike 4 flagged the risk of
// conflating them: `layers` (not yet used by any v0 rule) will hold *kind*
// names — declared right here in `kinds`, so a structural generic can
// check them with no generated file. `deprecated.from`/`to` (rule 5) hold
// *module* names — real directories on disk, which is what spike 4's
// generated union type exists to check. Rule 5 uses plain `string` for
// both, though, and validates them against `graph.modules` at check time
// (throwing the same way an unrecognized `kinds` pattern does) — wiring
// the generated union type into this field is deliberately deferred to
// `init` (a later ticket), since `init` is what writes the generated file
// in the first place. `layers` is not enforced against `kinds` by this
// type either (deferred the same way, to whichever ticket adds real use of
// `layers`); recorded here so neither ticket reopens the question.
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
  // config error, not a rule violation — assertKindPatternsSupported throws
  // rather than a rule silently treating it as "matches nothing".
  kinds: Record<string, string>;
  layers?: readonly string[];
  // A from -> to module edge whose count must not increase (rule 5).
  // `because` is mandatory per Q43 — a deprecated edge is exactly the kind
  // of root-level rule the spec requires a reason for.
  deprecated?: readonly {
    from: string;
    to: string;
    count: number;
    because: string;
  }[];
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

// Throws on the first unsupported kind-pattern shape. Called up front, not
// discovered by looping over `graph.modules`: `kindPatternNames` needs a
// module name to test against, but its "invalid" verdict never depends on
// which name was passed — an unsupported shape is unsupported whether or
// not any module happens to exist. Looping over modules first (as rule 3
// and rule 4 originally did) meant an empty module graph, or a graph that
// never reaches the offending kind in its iteration, let an invalid
// pattern through unvalidated. Measured: rule 4's own "no modules at all"
// case did exactly this.
export function assertKindPatternsSupported(config: Config): void {
  for (const pattern of Object.values(config.kinds)) {
    if (kindPatternNames(pattern, config.modules, "") === "invalid") {
      throw new Error(invalidKindPatternMessage(pattern, config.modules));
    }
  }
}
