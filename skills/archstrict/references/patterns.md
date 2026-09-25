# Boundary patterns

This page names recurring shapes seen in existing boundary-checking
configurations in public repositories, and shows the archstrict config that
expresses each one. It does not ship as a preset: archstrict has no
`--preset` flag, and `init`/`recommend` never apply one of these
automatically. Read [config.md](config.md) and [rules.md](rules.md) first for
the exact field semantics this page assumes.

## How to use this page

1. Look at the project's own tree first. Directory names, file names, and
   real import edges are the evidence - not a guess from the project's
   framework or its `package.json` dependencies.
2. Propose at most the patterns the evidence in that tree actually supports.
   A project rarely matches only one pattern; most real configs combine two
   or three.
3. Show the proposed config to the user before writing it. Name the
   `declaredModules`/`classify`/`edges` entries and the `because` for each.
4. Positive-control every new `edges` rule before trusting a clean
   `archstrict check`: inject a source file with one edge the rule should
   forbid, run `check`, confirm the violation fires under the expected rule
   id, then revert the injected file. `evaluated: 0` in `edgeRuleCoverage`
   means the rule never judged a single real edge - not that the project
   has none of that violation.

Every snippet below was run through the built CLI against a small fixture:
it loads without a config error, its `edges` rule shows `evaluated > 0` in
`edgeRuleCoverage`, and it fires on one deliberately forbidden edge while a
legitimate edge in the same fixture passes clean.

## (a) Layered order

**Recognize it.** Directory or package names that read as a ladder: for
example `routes`/`pages` above `features` above `components`/`ui` above
`lib`/`utils`. Or a monorepo library naming scheme with a small, fixed set
of category names attached to each package. Import evidence: a lower-named
directory's files never import from a higher-named one.

**Config.**

```ts
classify: [
  { glob: "src/core/**", tags: ["layer:core"] },
  { glob: "src/mid/**", tags: ["layer:mid"] },
  { glob: "src/top/**", tags: ["layer:top"] },
],
edges: {
  order: [
    {
      tagNamespace: "layer",
      sequence: { "": ["core", "mid", "top"] },
      direction: "downward-only",
      because: "a lower layer must never depend on a higher one",
    },
  ],
},
```

`sequence`'s array lists the foundation first, the outermost consumer last:
a source may depend on its own layer or an earlier one in the list, never a
later one.

**Caveats.**

- `downward-only` permits skipping a layer (`top` reaching `core` directly
  passes). To forbid a skip, add a `point` or `allowDeny` rule naming that
  specific pair.
- A same-layer edge always passes: `order` only constrains crossing
  layers, never traffic within one.
- Every real value `classify`/`classifyByDirectoryName` assigns in the
  `layer` namespace must appear somewhere in `sequence`, or `check` throws a
  config error the first time an edge carries that value.
- `sequence` is `Record<string, string[]>`, keyed by the empty string
  `""` for an unscoped rule - never a flat array on its own.

## (c) Runtime/platform environments

**Recognize it.** Sibling directories named for a runtime: `common`/
`shared` alongside `browser`, `node`, `worker`, `electron-main`,
`electron-renderer`, or a client/server split with a `shared` folder
between them. The name often recurs at more than one depth in the tree
(any file under a directory literally named `browser/`, anywhere), not
just at the project root.

**Config.**

```ts
classifyByDirectoryName: {
  tagNamespace: "env",
  names: ["common", "browser", "node", "worker"],
},
edges: {
  allowDeny: [
    { source: "env:common", targetNamespace: "env", allow: [], because: "common code must stay platform-neutral" },
    { source: "env:browser", targetNamespace: "env", allow: ["common"], because: "browser code may use common code, never node or worker code" },
    { source: "env:node", targetNamespace: "env", allow: ["common"], because: "node code may use common code, never browser or worker code" },
  ],
},
```

**Caveats.**

- `classifyByDirectoryName` matches by name only, blind to which package
  the directory belongs to: a same-named directory elsewhere in the tree
  for an unrelated reason (a test suite's own subdirectory happening to
  share a name) gets the same tag. Use an explicit `classify` glob instead
  when a name is not unique across the project.
- To also ban a platform's own npm packages or node builtins from a given
  environment, add a second `allowDeny` entry with `targetNamespace: "pkg"`
  - `deny: ["node"]` bans every node builtin at once (they all carry a
    shared `pkg:node` tag alongside their own bare name), not just the
    specific ones a rule author happened to think of.
- `allowDeny`'s own config check flags an `allow` list that, given the
  edges actually present, happens to cover every real target value in that
  namespace (`exhaustive-allow-list`) - a real trap in a small project
  where one environment's own list currently matches everything it has
  ever reached. It is a hint to re-examine the list, not a hard error.

## (d) Feature isolation with a shared kernel

**Recognize it.** A `features/`, `modules/`, or `pages/` directory holding
several independent, same-shaped subdirectories, plus one directory that
looks like a kernel (`shared`, `core`, `common`, `lib`). Import evidence:
composition happens one level up (in a router, an app shell), not between
the feature directories themselves.

The common real shape needs no `edges` rule at all: declare each feature as
its own module (see pattern (f) below); rule 1 already forbids reaching
past a sibling feature's own surface file. The stricter shape below denies
a sibling feature outright, even through its surface.

**Config.**

```ts
classify: [
  { glob: "src/features/orders/**", tags: ["feature:orders"] },
  { glob: "src/features/payments/**", tags: ["feature:payments"] },
  { glob: "src/features/reports/**", tags: ["feature:reports"] },
  { glob: "src/shared/**", tags: ["kind:shared"] },
],
edges: {
  allowDeny: [
    { source: "feature:orders", targetNamespace: "feature", allow: [], because: "a feature may not import a sibling feature" },
    { source: "feature:payments", targetNamespace: "feature", allow: [], because: "a feature may not import a sibling feature" },
    { source: "kind:shared", targetNamespace: "feature", allow: [], because: "the shared kernel must not depend on any feature" },
  ],
},
```

An `allowDeny` rule automatically exempts a target sharing the source's own
tag value: `feature:orders` importing another file still tagged
`feature:orders` never violates this rule. An import into `kind:shared`
also passes untouched - it carries no tag in the `feature` namespace at
all, so this namespace-scoped rule says nothing about it.

**Caveats.**

- `source` is one exact tag value, never a wildcard: a project with many
  features needs one `allowDeny` entry per feature, not one rule for the
  whole namespace. Real configs in the survey do exactly this (one entry
  per tag value).
- Nothing here forbids a cycle between two features formed through a third
  file; rule 2 (`cycle`) already covers that separately, project-wide.

## (f) Public entry only, leaf/pure kernel, external package confined to one area

### Public entry only

**Recognize it.** Every cross-directory import in the tree reaches only
one file per directory - most often `index.ts`, sometimes a differently
named file (`public.ts`, `facade.ts`, `contracts.ts`), or a package's own
subpath export list in `package.json`.

**Config.** This needs no `edges` rule at all - it is exactly what a
declared module's own `surface` already enforces:

```ts
declaredModules: [
  { name: "widget", glob: "src/widget/**", surface: ["index.ts", "server.ts"] },
  { name: "app", glob: "src/app/**" },
],
```

An import reaching `widget/internal.ts` from outside the module is
`public-surface-bypass`; reaching `widget/index.ts` or `widget/server.ts`
is not. `surface` as an array covers a package with more than one real,
sanctioned entry point (a client entry and a server entry, or a package's
own `exports` map) - every glob in the array is equally public.

**Caveat.** `public-surface-bypass` counts a type-only import the same as
a value import: reaching an internal file only for its types still
bypasses the surface. See pattern T below for the different, narrower
shape that lets a type-only import through a boundary.

### Leaf / pure kernel

**Recognize it.** One directory - often `utils`, `lib`, `types`,
`constants`, or `helpers` - that every other area imports from, and that
never imports anything else in the project.

**Config.**

```ts
classify: [
  { glob: "src/util/**", tags: ["kind:util"] },
  { glob: "src/app/**", tags: ["kind:app"] },
],
edges: {
  allowDeny: [
    { source: "kind:util", targetNamespace: "kind", allow: [], because: "the leaf kernel must not depend on any other area" },
    { source: "kind:util", targetNamespace: "pkg", allow: [], because: "the leaf kernel must stay pure: no npm packages, no node builtins" },
  ],
},
```

**Caveat.** A rule scoped to one namespace says nothing about an untagged
target. "Leaf" needs both an internal-project rule (`targetNamespace:
"kind"`) and, when "pure" also means no dependencies at all, a second rule
against `targetNamespace: "pkg"` - one rule alone leaves the other
namespace wide open.

### External package confined to one area

**Recognize it.** A framework, ORM, or platform-specific npm package (or a
node builtin) imported from exactly one directory in the whole project -
often an "adapters" or "infrastructure" directory in an otherwise
framework-free core.

**Config.**

```ts
classify: [
  { glob: "src/core/**", tags: ["kind:core"] },
  { glob: "src/adapters/**", tags: ["kind:adapters"] },
],
edges: {
  allowDeny: [
    { source: "kind:core", targetNamespace: "pkg", deny: ["node"], because: "core must stay runtime-neutral; only adapters may touch node builtins" },
  ],
},
```

**Caveats.**

- A package resolving through its own `@types/<name>` shadow package (no
  bundled types) is tagged under both identities at once
  (`pkg:express` and `pkg:@types/express`) - a rule targeting either name
  matches the same real edge.
- `pkg:node` bans every node builtin at once; naming individual builtins
  one at a time under-protects against the next one nobody thought to add.

## (b) Domain isolation

**Recognize it.** Business-noun directory names (`orders`, `payments`,
`sql`, `mongo`), each depending on a small, shared "core" or "framework"
domain, and rarely on each other directly. This shape was thin outside one
tag-based monorepo tool's own convention in the survey; Prisma's own
`architecture.config.json` is a public, real example of it (a domain axis
combined with a layer axis and a plane axis, each domain's own directed
allow list naming exactly which other domains it may reuse).

**Config.**

```ts
classify: [
  { glob: "src/domain/sql/**", tags: ["domain:sql"] },
  { glob: "src/domain/mongo/**", tags: ["domain:mongo"] },
  { glob: "src/domain/framework/**", tags: ["domain:framework"] },
],
edges: {
  allowDeny: [
    { source: "domain:sql", targetNamespace: "domain", allow: ["framework"], because: "sql may reuse framework, nothing else" },
    { source: "domain:mongo", targetNamespace: "domain", allow: ["framework"], because: "mongo may reuse framework, nothing else" },
    { source: "domain:framework", targetNamespace: "domain", allow: [], because: "framework is the innermost domain; it depends on no other domain" },
  ],
},
```

**Caveat.** One entry per domain, the same as pattern (d): `source` never
takes a wildcard. A directed allow list (naming exactly which other
domains a given domain may reuse, not only a shared sink) is the richer,
less common variant; a plain "may only use itself and the shared domain"
list is the more common one.

## Multi-axis tags

**Recognize it.** A path shape like `src/<domain>/<layer>/**`, where the
project layers its code the same way inside every domain. Import evidence:
a layer order (see pattern (a)) that repeats per domain, rather than one
global order for the whole project.

**Config.**

```ts
classify: [
  { glob: "src/orders/data-access/**", tags: ["domain:orders", "layer:data-access"] },
  { glob: "src/orders/ui/**", tags: ["domain:orders", "layer:ui"] },
  { glob: "src/payments/data-access/**", tags: ["domain:payments", "layer:data-access"] },
  { glob: "src/payments/ui/**", tags: ["domain:payments", "layer:ui"] },
],
edges: {
  order: [
    {
      tagNamespace: "layer",
      within: "domain",
      sequence: {
        orders: ["data-access", "ui"],
        payments: ["data-access", "ui"],
      },
      direction: "downward-only",
      because: "each domain keeps its own data-access-before-ui order; a domain's ui may not be imported by its own data-access",
    },
  ],
},
```

One `classify` entry can carry more than one tag at once, in more than one
namespace - here `domain:*` and `layer:*` together. `classify` and
`classifyByDirectoryName` can also be combined (their results union): use
`classify` for one axis and ambient `classifyByDirectoryName` for the
other when the second axis's names already recur as literal directory
names throughout the tree.

**Caveat.** Every `edges` rule is evaluated independently, blind to every
other rule's own namespace: an edge violates if any one applicable rule
says no. Two axes are two independent questions, not one combined
decision - this is the `allowDeny`/`order`/`point` semantics of ANDing every
matching rule, not a special multi-axis mode.

## Test code kept out of production

**Recognize it.** A `__tests__`, `test-utils`, or `mocks` directory that
only test files should ever import - and does not, in the tree's own
evidence, get imported by anything outside it.

**Config.**

```ts
classify: [
  { glob: "src/app/**", tags: ["kind:prod"] },
  { glob: "src/__tests__/**", tags: ["kind:test"] },
],
edges: {
  point: [
    { from: { tags: ["kind:prod"] }, to: { tags: ["kind:test"] }, because: "production code must not import test helpers" },
  ],
},
```

**Caveat.** `archstrict init` seeds a fresh config's own `exclude` with
common non-source directory names, including `test`-shaped ones. An
excluded file is not a module member, not an edge source, and not an edge
target - a test directory this pattern is meant to guard still needs its
own `declaredModules` entry (or at least stay out of `exclude`), or this
rule's own `evaluated` count stays at 0 no matter how it is written.

## Type-only across a boundary

**Recognize it.** A boundary that otherwise forbids a dependency, with one
carved-out exception: a type may cross it, but a value (a function, a
class, a runtime constant) may not.

**Config.**

```ts
classify: [
  { glob: "src/client/**", tags: ["kind:client"] },
  { glob: "src/server/**", tags: ["kind:server"] },
],
edges: {
  allowDeny: [
    { source: "kind:client", targetNamespace: "kind", deny: ["server"], edgeType: "value", because: "client code may reach server code for types only, never at runtime" },
  ],
},
```

**Caveats.**

- `edgeType`/`importForm` exist on all three of `allowDeny`, `order`, and
  `point`, with the same default (`"both"`) and the same meaning on each -
  this is a modifier on an existing rule, not a pattern of its own.
- Rule 1 (`public-surface-bypass`) has no `edgeType` of its own: a
  type-only import that reaches past a module's surface still violates
  it, even when a separate `edges` rule would let that same type-only
  import through.

## Host/plugin inversion

**Recognize it.** A host or core area that never names a concrete plugin
by import, paired with plugins that reach the host only through one
named extension-point file or directory.

**Config.**

```ts
classify: [
  { glob: "src/core/**", tags: ["kind:core"] },
  { glob: "src/plugin/**", tags: ["kind:plugin"] },
  { glob: "src/extension-point/**", tags: ["kind:extension-point"] },
],
edges: {
  allowDeny: [
    { source: "kind:core", targetNamespace: "kind", deny: ["plugin"], because: "the host must never import a concrete plugin" },
    { source: "kind:plugin", targetNamespace: "kind", allow: ["extension-point"], because: "a plugin reaches the host only through its extension point" },
  ],
},
```

**Caveat.** This is two ordinary `allowDeny` rules facing opposite
directions over the same tag namespace, not a distinct rule shape - name
it as its own pattern in a proposal because the intent ("the host never
names a plugin") is easy to miss if it is only described as "another
allow/deny rule."

## Hexagonal

**Recognize it.** `domain`, `application`/`usecases`, `ports`,
`adapters`/`infrastructure` directory names, with a domain area that
imports no framework or I/O package at all. Thin evidence in the survey -
every repository observed using this shape had well under 3,000 stars.
Say so when proposing it on thin evidence alone.

**Config.**

```ts
classify: [
  { glob: "src/domain/**", tags: ["layer:domain"] },
  { glob: "src/ports/**", tags: ["layer:ports"] },
  { glob: "src/adapters/**", tags: ["layer:adapters"] },
],
edges: {
  order: [
    {
      tagNamespace: "layer",
      sequence: { "": ["domain", "ports", "adapters"] },
      direction: "downward-only",
      because: "domain depends on nothing; ports depend only on domain; adapters depend on ports or domain",
    },
  ],
  allowDeny: [
    { source: "layer:domain", targetNamespace: "pkg", allow: [], because: "domain stays framework-free: no npm package, no node builtin" },
  ],
},
```

This combines pattern (a)'s `order` with pattern (f)'s "pure kernel" `pkg`
rule - hexagonal is a layer order plus a purity constraint on its
innermost layer, not a new rule shape.

## App vs lib

**Recognize it.** A project with one or more app directories and one or
more library directories, where an app may depend on a library but never
the reverse. Thin as its own explicit rule in the survey: most projects
that have this shape leave it implicit (a library-type ladder that simply
never lists an app as something importable), rather than writing it down.

**Config.**

```ts
classify: [
  { glob: "src/lib/**", tags: ["layer:lib"] },
  { glob: "src/cli-app/**", tags: ["layer:app"] },
  { glob: "src/web-app/**", tags: ["layer:app"] },
],
edges: {
  order: [
    {
      tagNamespace: "layer",
      sequence: { "": ["lib", "app"] },
      direction: "downward-only",
      because: "a library never depends on an app; an app may depend on any library",
    },
  ],
},
```

Two or more directories can share one tag value (`layer:app` here, for
both `cli-app` and `web-app`) - the constraint engine judges every edge by
its tags, never by which declared module a file belongs to.

## Barrel-inverse

**Recognize it.** The opposite of "public entry only": code living inside
a directory must not import that same directory's own barrel file
(`index.ts`). The motive in the surveyed repositories was almost always
import cycles or tree-shaking, not a boundary against outsiders.

**Config.**

```ts
declaredModules: [
  { name: "widget", glob: "src/widget/**" },
],
edges: {
  point: [
    { from: "src/widget/**", to: "src/widget/index.ts", because: "code inside widget must not import its own barrel" },
  ],
},
```

**Caveat.** This needs a glob-shaped `point` rule, not a tag-based one: a
tag-based rule scoped to the module's own tag would also forbid the
legitimate case pattern (f) exists to allow - an outside consumer
reaching the module through its own `index.ts`. `point`'s `from`/`to`
globs, matched against the real file path, let this rule apply only to
files genuinely inside the module, while an external importer (matching
no glob here at all) stays unaffected.
