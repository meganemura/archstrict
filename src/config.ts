import type { ModuleGraph } from "./module-graph.js";
import { ReportError } from "./report-error.js";

// The only schema loadConfig accepts. init writes this value into a new
// archstrict.config.ts. A config that omits the field is this same schema
// (the field arrived after the first configs); any other value is a config
// error, not a silent misread of a future shape.
export const SCHEMA_VERSION = 1 as const;

// Responsibility: the shape of archstrict.config.ts.
// Boundary: `Config` itself is a plain data type, no behavior. Reading a
// real config file from disk is the CLI's job.
//
// modules/kinds/layers are gone as of the CLI cutover - `layers` was never
// wired to any rule across two epics; `kinds`/`modules` were superseded by
// declaredModules and classify once rules 3/4 migrated onto tags (rule 3
// is now module-graph.ts's own `outsideFiles`; rule 4's classify-glob
// check is the classification layer's own version of "a kind that
// matches no module"). Pre-publish, so removing them costs nothing -
// no real project's config exists yet to break.
export type Config = {
  // Required, not optional: every real config comes from a file, and both
  // `check` and rule 4 (a config-vs-graph consistency check, not an edge
  // check) need somewhere to point a violation at. A test config that has
  // no real file uses a placeholder like "<test>".
  configPath: string;
  // See SCHEMA_VERSION. Optional so a config written before the field
  // existed still typechecks; loadConfig rejects any value other than 1.
  schemaVersion?: typeof SCHEMA_VERSION;
  // The public-surface file name(s) (module-graph.ts's own `surface`
  // option) - a single string, or an array, the same shape a per-module
  // `declaredModules[].surface` already accepts. Not fixed by the tool: a
  // project names its own, and `init` writes the default (DEFAULT_SURFACE,
  // one entry per analyzed source extension) explicitly rather than
  // detecting an existing convention. Optional here so a hand-written
  // config that omits it still typechecks; module-graph.ts applies the
  // same default when it's absent.
  surface?: string | readonly string[];
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
  // Module names whose todo entries may only shrink, never gain a new one -
  // not even on todo's first run. check treats any existing entry for a
  // strict module as a violation in its own right (clean means no
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

  // --- v1 schema (the only schema now that modules/kinds/layers are gone;
  // see the header comment above).

  // Intended as the analysis boundary (was `modules`' role under v0's
  // discovery model): a glob bounding which files `classify` and the
  // constraint engine ever look at, module boundaries coming from
  // `declaredModules` instead of being discovered under it. Declared here,
  // typechecked, and documented - but not yet read anywhere; no rule or
  // verb narrows its own file scan by it. Wiring it is real, deferred work,
  // not a design decision made and reversed.
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
    // One glob, or several paths that share one directory. An array names
    // a seam inside a flat directory without moving files. Paths in
    // different directories are a config error; use one entry per directory.
    glob: string | readonly string[];
    // A single glob, or several - a real package can publish more than
    // one real, differently-shaped public entry point at once (a
    // package.json `exports` map naming several real paths, not just its
    // default `main`); surfaceFiles is the union of every glob's matches.
    // Optional: when absent, a real package.json's own exports map (if
    // one sits at this module's own root) is derived back to source at
    // graph-build time instead of being hand-transcribed - falling back
    // to the project's own top-level `surface` default when there's no
    // exports map, or even one entry in it can't be confidently resolved
    // to a real, existing source file.
    surface?: string | readonly string[];
    // Rule 1's own "friend" exception (ArchUnit's term): `file` (relative
    // to this module, may itself be a glob) is public to exactly the
    // importers `from` (a project-relative glob) matches, private to
    // everyone else - unlike `surface`, which is public to every importer
    // equally. A real, motivating case: a package's own semi-private
    // internal-utilities file meant for one specific group of consumers,
    // not the general public and not fully private either. `because` is
    // mandatory, the same convention every other exception field here
    // already follows.
    friends?: readonly { file: string; from: string; because: string }[];
  }[];

  // archspec's own "empty component" concept: a directory that must stay
  // empty - an anti-pattern guard (e.g. vanilla_rails's app/services must
  // hold nothing), distinct from rule 4's "a rule that matches no module."
  // A violation is any file matching the glob at all; 0 is a clean pass,
  // not silence, the same convention every other rule here follows.
  mustBeEmpty?: readonly { glob: string; because: string }[];

  // Constraint engine shape - checked by src/rules/constraints.ts, wired
  // into runRules (rule 7: tag-boundary/tag-order/point-rule). `allowDeny`'s
  // own `exceptions`: a from/to glob or tag-predicate pair that overrides
  // that rule either way for one specific edge. `point` has no exceptions
  // of its own - its from/to predicates are already as explicit as a rule
  // gets.
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
      // Same convention as allowDeny/point's own edgeType/importForm:
      // default "both". A real, motivating case (typeorm/typeorm's own
      // *DataSourceOptions extending its base options type via
      // `import type`): a structural back-reference that's real but
      // benign, contaminating an order rule's own findings with the same
      // recurring pattern unless it can be excluded the way an allowDeny
      // rule already could.
      edgeType?: "value" | "type" | "both";
      importForm?: "static" | "dynamic" | "both";
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

// Checked before required-field validation: a future schema may rename
// those fields, and the version mismatch is the fact to report first.
export function assertSchemaVersion(configPath: string, raw: object): void {
  if (!("schemaVersion" in raw)) return;
  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (version === SCHEMA_VERSION) return;
  throw new ReportError(
    `${configPath} schemaVersion ${JSON.stringify(version)} is not supported; this archstrict reads schemaVersion ${SCHEMA_VERSION}`,
    `set schemaVersion to ${SCHEMA_VERSION} in ${configPath}, then run archstrict check`,
  );
}

// Throws if any `deprecated` entry names a module that doesn't exist.
// Shared by rule 4 and rule 5: without a single shared check, the two
// rules can disagree about the same config. Measured: rule 4's own
// zero-modules early return skips its `deprecated` loop entirely, so a
// `deprecated` entry naming a nonexistent module reached rule 4's "count
// is 0, edge no longer exists" case instead of a config error — a name
// that never existed is not the same fact as an edge that used to exist
// and shrank to nothing, and reporting it that way is misleading, not
// just imprecise.
export function assertDeprecatedModulesExist(graph: ModuleGraph, config: Config): void {
  for (const entry of config.deprecated ?? []) {
    for (const moduleName of [entry.from, entry.to]) {
      if (!graph.modules.has(moduleName)) {
        throw new ReportError(
          `deprecated entry '${entry.from} -> ${entry.to}' names module '${moduleName}', which does not exist`,
          `declare '${moduleName}' in ${config.configPath}, or remove that deprecated entry, then run archstrict check`,
        );
      }
    }
  }
}

// loadConfig reads a real config file with ts.transpileModule (strips
// types, never fully type-checks - see loadConfig's own comment for why),
// so a malformed `edges` value is otherwise invisible to both the type
// system and every rule: writing `edges` as an array instead of the real
// `{ allowDeny?, order?, point? }` object produces zero rules, zero
// violations, and - critically - no empty-rule-set violation either
// (rule 4 has nothing to see, since no rule was ever parsed into
// existence), indistinguishable from a config that never used `edges` at
// all. Measured directly, via a fresh agent authoring a real config from
// scratch: this was the single silent failure among several very similar
// ones (an `order` entry's own `sequence` written as a flat array instead
// of `Record<string, string[]>`, a real, unsupported key mistyped onto a
// rule entry) - the `sequence` case happens to surface today via rule 4's
// own `evaluated: 0`, but neither it nor an unsupported key should depend
// on a downstream rule noticing a side effect. A config shape error is a
// config error, thrown up front, the same as an unsupported `deprecated`
// entry already is above.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Exported: loadConfig's own declaredModules validation (check.ts) needs
// the same wording for the same kind of shape mismatch, rather than a
// second, differently-worded describer for the same fact.
export function describeShape(value: unknown): string {
  return Array.isArray(value) ? "an array" : typeof value;
}

function assertKnownKeys(value: Record<string, unknown>, known: readonly string[], context: string): void {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) {
      throw new ReportError(
        `${context} has an unknown field '${key}' - supported fields are ${known.join(", ")}`,
        `remove '${key}' from ${context} in archstrict.config.ts, then run archstrict check`,
      );
    }
  }
}

function assertEntries(value: unknown, keys: readonly string[], context: string): readonly Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ReportError(
      `config.edges.${context} must be an array of entries, not ${describeShape(value)}`,
      `set config.edges.${context} to an array of entries in archstrict.config.ts, then run archstrict check`,
    );
  }
  return value.map((entry, i) => {
    if (!isPlainObject(entry)) {
      throw new ReportError(
        `config.edges.${context}[${i}] must be an object, not ${describeShape(entry)}`,
        `make config.edges.${context}[${i}] an object in archstrict.config.ts, then run archstrict check`,
      );
    }
    assertKnownKeys(entry, keys, `config.edges.${context}[${i}]`);
    return entry;
  });
}

const ALLOW_DENY_KEYS = [
  "source",
  "targetNamespace",
  "allow",
  "deny",
  "exceptions",
  "edgeType",
  "importForm",
  "because",
];
const ORDER_KEYS = ["tagNamespace", "within", "sequence", "direction", "edgeType", "importForm", "because"];
const POINT_KEYS = ["from", "to", "edgeType", "importForm", "because"];

export function assertEdgesShapeValid(config: Config): void {
  const edges: unknown = config.edges;
  if (edges === undefined) return;
  if (!isPlainObject(edges)) {
    throw new ReportError(
      `config.edges must be an object with allowDeny/order/point fields (e.g. { allowDeny: [...] }), not ${describeShape(edges)}`,
      "set config.edges to an object with allowDeny, order, and point in archstrict.config.ts, then run archstrict check",
    );
  }
  assertKnownKeys(edges, ["allowDeny", "order", "point"], "config.edges");

  for (const entry of assertEntries(edges.allowDeny, ALLOW_DENY_KEYS, "allowDeny")) {
    // These shapes cannot reject any edge, even when coverage is nonzero.
    if (
      entry.allow === undefined &&
      (entry.deny === undefined || (Array.isArray(entry.deny) && entry.deny.length === 0))
    ) {
      throw new Error(
        `config.edges.allowDeny entry with source '${entry.source}' and targetNamespace '${entry.targetNamespace}' must specify allow or a non-empty deny list`,
      );
    }
  }
  assertEntries(edges.point, POINT_KEYS, "point");
  for (const entry of assertEntries(edges.order, ORDER_KEYS, "order")) {
    const sequence: unknown = entry.sequence;
    if (sequence !== undefined && !isPlainObject(sequence)) {
      throw new ReportError(
        `an edges.order entry's sequence must be an object keyed by the 'within' scope (e.g. { "": ["a", "b"] }), not ${describeShape(sequence)}`,
        "set that sequence to an object keyed by the within scope in archstrict.config.ts, then run archstrict check",
      );
    }
  }
}

// compileGlob (classify.ts) only ever special-cases `*` and `**`; every
// other character - including brace (`{a,b}`), extglob (`+(a|b)`,
// `@(...)`, `!(...)`, `?(...)`), `?`, and bracket (`[...]`) syntax a shell
// or a real glob library would treat specially - falls through its own
// literal branch, escaped for RegExp use. A config author who writes one
// of those, expecting shell/minimatch semantics, gets a glob that matches
// nothing: every file it was meant to cover instead surfaces as
// uncovered-module, silently, with no hint the glob itself was the
// problem. Caught here, once, for every field a glob can appear in,
// rather than as a downstream "why is this file uncovered" mystery.
//
// A bare `+` or `@` is left alone (both appear in ordinary literal paths -
// a scoped package directory name, a filename with a `+` in it); only the
// bracket/brace/question-mark/bang characters below are checked, and `(`
// alone already catches the extglob forms (`+(`, `@(`, `!(`, `?(`) without
// needing to special-case them.
const UNSUPPORTED_GLOB_PATTERN = /[{}()[\]?!]/;

function assertGlobSupported(configPath: string, field: string, glob: unknown, verb: string): void {
  // A non-string value here is a different validator's problem (shape
  // checks above, or the field's own type in Config) - this check only
  // ever looks at strings that already made it this far.
  if (typeof glob !== "string" || !UNSUPPORTED_GLOB_PATTERN.test(glob)) return;
  throw new ReportError(
    `${configPath} field '${field}' has an unsupported glob '${glob}' - only '*' (any characters within one path segment) and '**' (any depth, including zero segments) are supported; '{', '}', '(', ')', '[', ']', '?', and '!' all match nothing, including in an extglob form like '+(...)' or '@(...)'`,
    `rewrite '${field}' in ${configPath} using only * and **, or split it into one entry per directory, in archstrict.config.ts, then run ${verb}`,
  );
}

// One entry per glob-bearing field the config schema has (see Config's own
// fields above). Walked defensively (typeof/Array.isArray guards, not the
// Config type) because loadConfig calls this on a value ts.transpileModule
// only stripped types from, never type-checked - a field can hold any
// runtime shape a hand-written config puts there.
export function assertGlobsSupported(config: Config, verb: string): void {
  const configPath = config.configPath;

  for (const [i, glob] of (config.exclude ?? []).entries()) {
    assertGlobSupported(configPath, `exclude[${i}]`, glob, verb);
  }
  for (const [i, entry] of (config.classify ?? []).entries()) {
    assertGlobSupported(configPath, `classify[${i}].glob`, entry?.glob, verb);
  }
  for (const [i, entry] of (config.mustBeEmpty ?? []).entries()) {
    assertGlobSupported(configPath, `mustBeEmpty[${i}].glob`, entry?.glob, verb);
  }
  for (const [i, mod] of (config.declaredModules ?? []).entries()) {
    const glob = mod?.glob;
    if (Array.isArray(glob)) {
      for (const [j, entry] of glob.entries()) {
        assertGlobSupported(configPath, `declaredModules[${i}].glob[${j}]`, entry, verb);
      }
    } else {
      assertGlobSupported(configPath, `declaredModules[${i}].glob`, glob, verb);
    }
    const surface = mod?.surface;
    if (Array.isArray(surface)) {
      for (const [j, s] of surface.entries()) {
        assertGlobSupported(configPath, `declaredModules[${i}].surface[${j}]`, s, verb);
      }
    } else if (surface !== undefined) {
      assertGlobSupported(configPath, `declaredModules[${i}].surface`, surface, verb);
    }
    for (const [j, friend] of (mod?.friends ?? []).entries()) {
      assertGlobSupported(configPath, `declaredModules[${i}].friends[${j}].file`, friend?.file, verb);
      assertGlobSupported(configPath, `declaredModules[${i}].friends[${j}].from`, friend?.from, verb);
    }
  }

  for (const [i, rule] of (config.edges?.allowDeny ?? []).entries()) {
    for (const [j, exception] of (rule?.exceptions ?? []).entries()) {
      assertGlobSupported(configPath, `edges.allowDeny[${i}].exceptions[${j}].from`, exception?.from, verb);
      assertGlobSupported(configPath, `edges.allowDeny[${i}].exceptions[${j}].to`, exception?.to, verb);
    }
  }
  // point's from/to are each either a glob (string) or a tag predicate
  // (an object) - only the string form is a glob this check applies to.
  for (const [i, rule] of (config.edges?.point ?? []).entries()) {
    assertGlobSupported(configPath, `edges.point[${i}].from`, rule?.from, verb);
    assertGlobSupported(configPath, `edges.point[${i}].to`, rule?.to, verb);
  }
}
