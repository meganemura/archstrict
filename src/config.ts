import type { ModuleGraph } from "./module-graph.js";

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
  // Optional as of the CLI cutover: `init` no longer writes it (declaredModules
  // is the source of truth now), and check/todo build the graph from
  // declaredModules unconditionally. Still read by rules 3/4 (uncovered,
  // empty-rule-set) and their `kinds` field, both still keyed on it until
  // a later ticket migrates them onto tags; both rules return no violations
  // at all when it's absent (an honest interim gap, not a crash) rather
  // than assuming every project still has it.
  modules?: string; // e.g. "src/*" — must match module-graph.ts's BuildOptions.modulesGlob
  // The public-surface file name (module-graph.ts's own `surface` option).
  // Not fixed by the tool: a project names its own, and `init` writes the
  // default ("index.ts") explicitly rather than detecting an existing
  // convention. Optional here so a hand-written config that omits it still
  // typechecks; module-graph.ts applies the same default when it's absent.
  surface?: string;
  // kind name -> path pattern. v0 supports exactly two pattern shapes:
  // the modules glob itself (matches every module — the `flat` preset's
  // single catch-all kind), or "<modules-root>/<name>" naming one exact
  // module. Any other shape (a nested wildcard like "src/features/*", for
  // instance) is out of scope for v0's single-level module model and is a
  // config error, not a rule violation — assertKindPatternsSupported throws
  // rather than a rule silently treating it as "matches nothing".
  // Optional for the same reason `modules` is - see its own comment.
  kinds?: Record<string, string>;
  layers?: readonly string[];
  // A from -> to module edge whose count must not increase (rule 5).
  // `because` is mandatory: a deprecated edge names a real design tradeoff,
  // and a root-level rule with no stated reason is a decision no future
  // reader can judge.
  deprecated?: readonly {
    from: string;
    to: string;
    count: number;
    because: string;
  }[];
  // Module names whose todo file may only shrink, never gain a new entry -
  // not even on todo's first run. check treats any existing entry in a
  // strict module's todo as a violation in its own right (clean means no
  // debt, not debt frozen at whatever existed when the module was added
  // here), so marking a module strict never hides a violation from check,
  // old or new.
  strict?: readonly string[];
  // A specific known cycle (naming any two modules in it, in either
  // order - Nx's own enforce-module-boundaries convention) exempted from
  // rule 2. An entry naming a pair no longer in any real cycle is itself
  // flagged (a distinct "stale-cycle-exception" violation - a stale
  // exception hides nothing real, same reasoning as stale-todo).
  ignoredCycles?: readonly (readonly [string, string])[];
  because: string;

  // --- v1 schema (additive; wired into rules by later tickets, not this
  // one). `modules`/`kinds`/`layers` above stay authoritative for every v0
  // rule until each has migrated - removing them here would break every
  // rule and verb that reads them in the same commit that adds this shape,
  // which the implement-phase gate (typecheck + test, every ticket) does
  // not allow. Their removal is itself a later ticket's job, once nothing
  // reads them anymore.

  // Analysis boundary (was `modules`' role under v0's discovery model).
  // Under v1, module boundaries come from `declaredModules` instead of
  // being discovered under this glob - `scope` only bounds which files
  // `classify` and the constraint engine ever look at.
  scope?: string;
  exclude?: readonly string[];

  // glob -> tags, most-specific-glob-wins (src/classify.ts). A file can
  // also gain tags from `classifyByDirectoryName` - the two mechanisms are
  // independent and their results union.
  classify?: readonly { glob: string; tags: readonly string[] }[];

  // Ambient tagging by directory-name segment (VS Code's code-layering.ts
  // convention): the nearest segment matching one of `names`, walking from
  // the file outward, becomes `${tagNamespace}:${name}`.
  classifyByDirectoryName?: {
    tagNamespace: string;
    names: readonly string[];
  };

  // Declared modules replace v0's index.ts-presence discovery (measured
  // wrong: a barrel index.ts is not evidence of an enforced boundary in
  // NestJS or Drizzle). `surface` may itself be a glob - a module's public
  // surface can be more than one file.
  declaredModules?: readonly {
    name: string;
    glob: string;
    surface: string;
  }[];

  // archspec's own "empty component" concept: a directory that must stay
  // empty - an anti-pattern guard (e.g. vanilla_rails's app/services must
  // hold nothing), distinct from rule 4's "a rule that matches no module."
  // A violation is any file matching the glob at all; 0 is a clean pass,
  // not silence, the same convention every other rule here follows.
  mustBeEmpty?: readonly { glob: string; because: string }[];

  // Constraint engine shape (typed here, implemented in a later ticket).
  // One `exceptions` shape shared across `allowDeny` and `point`: a from/to
  // glob or tag-predicate pair that overrides the enclosing rule either way.
  edges?: {
    allowDeny?: readonly {
      source: string;
      targetNamespace: string;
      allow?: readonly string[];
      deny?: readonly string[];
      exceptions?: readonly { from: string; to: string; because: string }[];
      // Default "both" - rule 1's own convention (a type-only edge still
      // reaches past a public surface). "static"/"dynamic" default "both"
      // too: Prisma's own domain/plane rules never distinguish; VS Code's
      // per-layer external-package restrictions are the motivating case
      // for edgeType (a type-only import of a forbidden package is
      // arguably not the same risk as a value import of it).
      edgeType?: "value" | "type" | "both";
      importForm?: "static" | "dynamic" | "both";
      because: string;
    }[];
    order?: readonly {
      tagNamespace: string;
      within?: string;
      sequence: Record<string, readonly string[]>;
      direction: "downward-only";
      because: string;
    }[];
    point?: readonly {
      from: string | { tags: readonly string[]; exclude?: { tags: readonly string[] } };
      to: string | { tags: readonly string[] };
      edgeType?: "value" | "type" | "both";
      importForm?: "static" | "dynamic" | "both";
      because: string;
    }[];
  };
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
  if (config.kinds === undefined || config.modules === undefined) return; // no v0-style kinds declared at all: nothing to validate
  const modules = config.modules;
  for (const pattern of Object.values(config.kinds)) {
    if (kindPatternNames(pattern, modules, "") === "invalid") {
      throw new Error(invalidKindPatternMessage(pattern, modules));
    }
  }
}

// Throws if any `deprecated` entry names a module that doesn't exist.
// Shared by rule 4 and rule 5 for the same reason `assertKindPatternsSupported`
// is: without a single shared check, the two rules can disagree about the
// same config. Measured: rule 4's own zero-modules early return skips its
// `deprecated` loop entirely, so a `deprecated` entry naming a nonexistent
// module reached rule 4's "count is 0, edge no longer exists" case instead
// of a config error — a name that never existed is not the same fact as an
// edge that used to exist and shrank to nothing, and reporting it that way
// is misleading, not just imprecise.
export function assertDeprecatedModulesExist(graph: ModuleGraph, config: Config): void {
  for (const entry of config.deprecated ?? []) {
    for (const moduleName of [entry.from, entry.to]) {
      if (!graph.modules.has(moduleName)) {
        throw new Error(
          `deprecated entry '${entry.from} -> ${entry.to}' names module '${moduleName}', which does not exist`,
        );
      }
    }
  }
}
