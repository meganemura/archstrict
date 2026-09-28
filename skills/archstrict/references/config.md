# archstrict.config.ts

Written as a plain TypeScript value satisfying the generated `Config` type (`archstrict.types.ts`, itself rewritten by every `archstrict init`). One root file - shape is never scattered per module.

```ts
import type { Config } from "./archstrict.types.js";

export default {
  schemaVersion: 1,
  surface: ["index.ts", "index.tsx", "index.mts", "index.cts"],
  exclude: ["archstrict.config.ts", "archstrict.types.ts", ".*/**", "**/.*/**"],
  declaredModules: [
    { name: "app", glob: "src/app/**" },
    { name: "shared", glob: "src/shared/**" },
    { name: "cli.ts", glob: "src/cli.ts", surface: "cli.ts" },
  ],
  because: "archstrict init: one module per directory that holds TypeScript source and per TypeScript source file, so the first check covers every file it analyzes",
} satisfies Config;
```

`declaredModules` is the only source of module boundaries - `check`/`todo` never discover modules from directory structure at runtime; only `archstrict init`'s own one-time walk does, to suggest what to declare. A file matching no `declaredModules` entry is `outsideFiles` (metric) and an `uncovered-module` violation (rule 3) unless it's `exclude`d.

Fields:

- **`schemaVersion`** (optional, current value `1`) - the schema this file was written for. `init` writes `1`. Omit it and the loader treats the file as schema 1 (a config from before the field existed is still current). Any other value is a thrown config error; `do` says to set it back to `1`. The name is camelCase, the same as every other field here.
- **`scope`** (optional) - typed on `Config`, but not yet read by any rule or verb; declaring it has no effect on what `classify`, `declaredModules`, or the constraint engine see. Wiring it in (an analysis boundary narrower than the whole project) is real, not-yet-done work, not a decision that was made and reversed.
- **`exclude`** (optional) - glob patterns kept out of analysis entirely: not a module member, not an edge source, not an edge target, not counted as `outsideFiles` either. `init` always writes its own two files (`archstrict.config.ts`, `archstrict.types.ts`) and two fixed hidden-directory patterns (`.*/**`, `**/.*/**` - matching `tsc`'s own default `include`, which already skips hidden paths); it also adds one entry per common non-source directory name it found for real on disk (`test`, `example`, `spike`, and similar), and one entry per colocated test-file naming convention it found for real on disk (`*.test.ts`, `*.spec.tsx`, `__tests__/`, and similar - see [docs/init-singleton-modules.md](../../../docs/init-singleton-modules.md) for the full list). A file `init`'s own walk covers is declared as its own module instead of excluded - a loose file added later, matching neither, is `uncovered-module` until a project adds its own `exclude` entry or `declaredModules` entry for it.
- **`surface`** (optional, default `["index.ts", "index.tsx", "index.mts", "index.cts"]`, one entry per analyzed source extension) - the public-surface file name every module is checked against. Not fixed by the tool: a project names its own. A `declaredModules` entry's own `surface` can override this per module, and can itself be a glob (a module's public surface can be more than one file) - or an array of them, when a package's own `exports` map names several real, differently-shaped entry points at once (e.g. `surface: ["index.ts", "http.ts", "observable/index.ts"]`); `surfaceFiles` is the union of every glob's own matches, and every one is equally, unconditionally public (unlike `friends`, whose whole point is a narrower, named-consumer exception - reach for `surface` as an array first when a package's own real entry points are meant for every importer equally). A `.d.ts` file is excluded from analysis by default (most are a third-party ambient declaration or a generated twin of a real `.ts` file, not module content) - the one exception is a `.d.ts` a `declaredModules` entry's own `surface` explicitly names, recognizing a real convention (a webpack-built package publishing `"types": "./types.d.ts"` with no `index.ts` at all).
  When a module is a real npm package, check its own `package.json` for an `"exports"` map before setting `surface` - `"main"` alone only names the package's first, default entry point. A package can publish several real, sanctioned entry points at once (e.g. `"."`, `"./testing"`, `"./internal"`), each its own key in `exports`; `surface` should be a glob matching every one of them, not just the file `main` resolves to (measured directly: authoring a config against a real monorepo, overriding `surface` per `main` correctly handled seven packages that published from a non-default path, but missed one package whose `exports` map named six real entry points while `main` alone showed only the first).
- **`declaredModules`** (required) - `{ name, glob, surface?, friends? }[]`, the source of truth for module boundaries. Replaces v0's index.ts-presence discovery (measured wrong: a barrel `index.ts` is not evidence of an enforced boundary, in NestJS's or Drizzle's own real code). An entry's own `friends` (optional, `{ file, from, because }[]`) is rule 1's "friend" exception: `file` (relative to this module, may itself be a glob) is public to exactly the importers `from` (a project-relative glob) matches, private to everyone else - unlike `surface`, which is public to every importer equally. Narrower than `surface`: use it for one specific internal file meant for one specific, named group of consumers, not for a package's own multiple real public entry points (that's `surface` as a glob, see above).

  A glob may name a single file (`src/index.ts`). That file is the module. `surface` and `friends` still resolve relative to a directory — the file's parent — so `{ glob: "src/index.ts", surface: "index.ts" }` means the file itself.

  An entry's own `surface` is optional. `init` leaves it out entirely on every directory entry it writes - a per-entry `surface` always wins outright, so setting one would turn off the `exports` derivation below for that module. Which directories are declared as modules stays a decision, hand-authored here - but once that decision is made, a declared module's own surface, when a real `package.json` sits at its own root, is inventory: derived at graph-build time from that package's real `exports` map, not hand-transcribed. Every real entry point named there is resolved back to its own real source file - directly, when the map carries a source-pointing condition (a project-specific key ending in `-source`, e.g. `@acme/pkg-source`); otherwise by stripping a `dist/`-style build-output prefix and swapping the built extension for a real source one, then confirming the guess is a real, existing file. If even one entry can't be confidently resolved this way, or there's no `exports` map at all, the whole module falls back to the project's own top-level `surface` default instead - never a partial or guessed-wrong array. Setting `surface` by hand on an entry always wins outright, exactly as before; this only fills the gap when it's absent.
- **`classify`** (optional) - `{ glob, tags }[]`, glob -> tags, most-specific-glob-wins (longest literal prefix, then fewest wildcards; a tie between two equally-specific entries naming different tags for the same file is a config error). Independent of `declaredModules` - tags classify any file in scope, whether or not it belongs to a declared module.
- **`classifyByDirectoryName`** (optional) - `{ tagNamespace, names }`, ambient tagging by directory-name segment (VS Code's `code-layering.ts` convention): the nearest path segment matching one of `names`, walking from the file outward, becomes `${tagNamespace}:${name}`. Independent of `classify` - a file can carry tags from both mechanisms at once; their results union. Ambient matching is name-only, blind to which package or module that name actually belongs to - a name that recurs elsewhere in the tree for an unrelated reason (a test suite's own subdirectory named after the package it happens to test, not that package itself) gets mistagged the same way (measured directly: 96 real, non-injected false violations from exactly this in one config-authoring pass). Use `classify` with an explicit glob prefix instead when a name isn't unique to one package.
- **`edges`** (optional) - the constraint engine (rule 7: `tag-boundary`/`tag-order`/`point-rule`), each shape generalizing rules 1/2's fixed module vocabulary to tags. See [rules.md](rules.md#7-tag-boundary--tag-order--point-rule-the-constraint-engine) for the full shape of `allowDeny`, `order`, and `point`, and what each one's violation looks like. Every configured `edges` rule's own real, evaluated-edge count is in `check`'s own `edgeRuleCoverage` field, and a rule that evaluates zero is also reported as rule 4's `empty-rule-set` - see [rules.md](rules.md#4-empty-rule-set) for why a zero here needs the same scrutiny a genuinely clean pass does.
- **`deprecated`** (optional) - `{ from, to, count, because }[]`, a `from -> to` module edge whose actual count must never increase. `because` is mandatory: a deprecated edge names a real design tradeoff, and a root-level rule with no stated reason is a decision no future reader can judge.
- **`strict`** (optional) - module names whose todo entries may only shrink, never gain a new one, not even on `todo`'s first run. `check` reports any existing entry for a strict module as its own violation (`clean-module-has-todo`) - marking a module strict never hides a violation, old or new.
- **`ignoredCycles`** (optional) - `readonly [string, string][]`, e.g. `[["a", "b"]]`. Names any two modules of a known cycle, in either order; exempts the whole strongly-connected component they belong to from rule 2 (`cycle`), not just that one edge. A pair matching no real cycle at all is itself flagged (`stale-cycle-exception`) - remove it rather than leave it.
- **`mustBeEmpty`** (optional) - `{ glob, because }[]`. A directory a project decided must hold no code at all. A violation is any file matching the glob - zero matches is a clean pass, not silence. The glob is project-root-relative. See [rules.md](rules.md#must-be-empty).
- **`because`** (required) - the config's own reason for its shape as a whole (the preset choice, the module boundaries). Same reasoning as `deprecated`'s own `because`: a decision with no stated reason is one nobody later can judge.

A `classify` glob matching zero real files, or zero `declaredModules` entries at all, is a reported violation (rule 4, `empty-rule-set`), not a thrown error - `check` still runs and reports everything else it can. A `schemaVersion` other than `1` is a thrown config error, validated up front before any rule runs. A `deprecated` entry naming a module that doesn't exist is a thrown config error, validated up front the same way. An `order` rule's `sequence` missing a layer value classify actually assigns within a scope it does cover is also a thrown config error, but checked lazily instead - only once `checkOrder` walks an edge that actually carries the missing value, not before any rule runs. `edges` itself not being a plain object with only `allowDeny`/`order`/`point` keys, an `order` entry's own `sequence` not being a plain object, or an unknown field on any `allowDeny`/`order`/`point` entry, are each thrown config errors too, validated up front the same way - a project's own `archstrict.config.ts` may only ever import types from `archstrict.types.ts` (`import type`, never `import`), so nothing else validates this shape for you, not even `tsc`, unless a project separately runs it over the config file itself.

## Glob syntax

Every glob-bearing field on this page - `exclude`, `declaredModules[].glob`, `declaredModules[].surface`, `declaredModules[].friends[].file`/`.from`, `classify[].glob`, `mustBeEmpty[].glob`, `edges.allowDeny[].exceptions[].from`/`.to`, and `edges.point[].from`/`.to` when written as a string - supports exactly two wildcards: `*` (any characters within one path segment - never crosses a `/`) and `**` (any depth, including zero segments). Every other character is a literal, matched exactly - never the shell/minimatch meaning it looks like it should have. Brace expansion (`{a,b}`), extglob (`+(a|b)`, `@(...)`, `!(...)`, `?(...)`), a bare `?` (one character), and bracket sets (`[...]`) all match nothing when written into one of these globs. Config loading rejects a glob containing `{`, `}`, `(`, `)`, `[`, `]`, `?`, or `!` up front, naming the field and the glob, rather than letting it silently match zero files - the failure mode otherwise is every file the glob was meant to cover staying `uncovered-module`, with nothing pointing back at the glob as the cause.

A module spanning several top-level directories needs one `declaredModules` entry per directory today; there is no multi-root glob or brace-expansion shorthand for "these directories are one module."

## `edges`'s own shape

Each `allowDeny` entry must specify `allow` or `deny`.
When `allow` is absent, `deny` must contain at least one value.
Config loading rejects entries that omit both lists or specify only `deny: []`, before any rule runs.
The error identifies the entry by its `source` and `targetNamespace`.
An empty `allow: []` remains valid: it rejects every target value in the selected namespace.
When both lists are present, `allow` retains precedence.

This shape check cannot detect an `allow` list that covers every target tag value present in the project.
That case depends on project data; static validation cannot distinguish an intended restriction from a list that happens to cover all current values.

`edges` is one object with up to three named lists, not a single array of rule entries - easy to misread from a prose description of each rule shape alone:

```ts
edges: {
  allowDeny: [
    { source: "domain:sql", targetNamespace: "domain", allow: ["framework"], because: "..." },
  ],
  order: [
    {
      tagNamespace: "layer",
      within: "domain", // omit `within` entirely for an unscoped rule
      sequence: {
        // one key per REAL `within` value classify assigns - "" is the
        // literal key for a rule with no `within` at all, not a placeholder
        sql: ["core", "runtime", "adapters"],
      },
      direction: "downward-only",
      because: "...",
    },
  ],
  point: [
    { from: "packages/**", to: "test/**", because: "..." },
  ],
},
```

`sequence` is `Record<string, string[]>`, never a flat `string[]` - see [rules.md](rules.md#7-tag-boundary--tag-order--point-rule-the-constraint-engine) for what each key means. `edgeType`/`importForm` exist on all three of `allowDeny`, `order`, and `point`, with the same default (`"both"`) and the same semantics on each.

## tsconfig.json resolution

Every import is resolved using the nearest `tsconfig.json` to the importing file (walking up from that file's own directory, the same convention TypeScript itself follows for a real per-package override) - not always the project root's own config, so a monorepo package with its own `paths` alias, `jsx` setting, or `moduleResolution` override resolves the way that package's own build actually does, instead of inflating `unresolvedSpecifiers` for every aliased import in it (measured directly against a real per-package alias: 58 fewer false-unresolved specifiers in one package alone, out of 152). This is scoped to module resolution only - the single, shared `ts.Program` every module is checked against (rule 6's `TypeChecker`) still uses the project root's own compiler options for the whole project; a leaf package's own incompatible option (a different `target`, a different `jsx` mode) can still affect how `ts.createProgram` itself sees that package's files, independent of this fix. Mixing genuinely incompatible per-file compiler options into one shared checked program is a separate, larger question this does not attempt to solve.

When `unresolvedSpecifiers` (the plain count) is nonzero, `check`'s own `unresolvedSpecifierBreakdown` names which specifiers - the top 10 distinct prefixes, most frequent first, each with its own count. A bare or unscoped specifier (`lodash`, `lodash/fp`) groups by its own first path segment (`lodash`); a scoped specifier (`@scope/name` or any of its own subpaths, `@scope/name/sub-path`) groups by `@scope/name` together, since a scope alone would merge every unrelated package under it into one meaningless bucket, and a bare package name doesn't distinguish its own subpaths from each other the way a scoped one's would. Text output prints the same breakdown as one summary line right under the plain count, omitted entirely when nothing is unresolved.

## Persistent graph cache

`check` (and `todo`, `rules`, `recommend`, `fix`'s own baseline, and `search`) keeps a per-file
cache in `node_modules/.cache/archstrict/` in the analyzed project, so a repeat run reparses only a
changed or new file and re-resolves only when a real input to resolution has moved. Two limits: an
edit that keeps a file's exact byte size and whose mtime is restored (or never advances) is not
detected, and an edit made directly to an already-installed dependency's own file, leaving its
package.json untouched, is not detected either. Deleting `node_modules/.cache/archstrict` clears
the cache and forces a full, cold rebuild on the next run - always safe, never required for
correctness otherwise.
