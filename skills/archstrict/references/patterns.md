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
legitimate edge in the same fixture passes clean. The friend-list pattern
(FR) has no `edges` rule at all, so it was verified differently: a named
friend stays clean and a non-friend importer of the same file gets
`public-surface-bypass` - see that section.

## How common is each pattern

[docs/boundary-patterns.md](../../../docs/boundary-patterns.md) records two
surveys: one that found repositories through code search for a dedicated
boundary tool's own vocabulary (82 repositories with a project-chosen rule),
and one that sampled the 200 most-starred public TypeScript repositories by
popularity alone (52 of them enforce a boundary; the per-pattern counts
below use 48, since 4 of the 52 already appeared in the first survey's own
82). The two disagree on
which pattern is most common, because they measure different populations -
read both counts below, not just one, before calling a pattern rare.

| Pattern | Tool-search sample (of 82) | Star-ordered sample (of 48) | Kept in the real import graph (of 50) |
|---|---|---|---|
| Public-entry-only | 17 | **22**, the most common pattern in this sample | 2 |
| Layered order | **34**, the most common pattern in this sample | 10 | 14 |
| Runtime/platform environments | 23 | 13 | 12 |
| Feature isolation with a shared kernel | 20 | 2 | 11 |
| Leaf / pure kernel | 16 | 7 | 14 |
| External package confined to one area | 13 | 14 | **43**, the most common shape kept in the graph |
| Type-only exception | 5 | 10 | not measured this way |
| Host/plugin inversion | 5 | 4 | 10 |
| Hexagonal / clean | 5 | 2 | not measured this way |
| Test code kept out of production | 9 | 4 | 30 |
| Scope/domain isolation | 9 | 2 | not measured this way |
| Barrel-inverse | 5 | 3 | not measured this way |
| App vs lib | 5 | 2 | 5 |
| Two tag axes combined | 7 | 1 | not measured this way |
| Load-path isolation | no category in this sample | 8 | not measured this way |
| Edition split | no category in this sample | 2 | not measured this way |
| Composition root | no category in this sample | 2 | not measured this way |
| Friend list | no category in this sample | 1 | not measured this way |
| Entry-graph budget | no category in this sample | 1 | not measured this way |

A third measurement, done directly against the real import graph of 50
repositories rather than against declared configs, gives the fourth column
above (see
[docs/boundary-patterns.md](../../../docs/boundary-patterns.md) for its
method and limits). It flips the public-entry-only result: the pattern most
projects declare (22 of 48) is one the graph itself keeps in only 2 of 50
repositories - declaring it is enforcing something real, not writing down
what the code already does. External-package confinement and test
separation are the opposite case: the most common shapes kept in the graph
whether or not any project declares them, so a config for either is cheap to
add as a guard on an existing habit rather than a new constraint.

The same graph survey also turned up shapes worth a proposal's own guidance,
even though none of them is a distinct pattern to configure:

- A cycle that looks balanced at the module level is often lopsided at the
  edge level - one direction carrying almost every edge, the other carrying
  one or two. Read a lopsided cycle as "one direction is intended; remove
  the few reverse edges", not as evidence the pair has no order.
- Judge a layer order on the production import graph, not the whole-file
  graph. Test files routinely import a sibling module as a fixture, which
  can turn a clean layering into a cycle only once tests are counted -
  archstrict's own cycle and order rules already read the production graph
  for this reason.
- A pattern most repositories already keep without declaring it - external
  package confinement, test code kept out of production - is cheap to
  propose as a guard: the codebase's own habit is already doing the work,
  and the rule only needs to say so.

Public-entry-only and an external package confined to one area hold up or
strengthen across both samples - propose these with confidence when the
tree's own evidence supports them. Layered order, feature isolation, and
scope/domain isolation are common among repositories that already adopted a
dedicated tag-based tool, but drop sharply in the star-ordered sample:
propose them only when directory names and import edges support them
directly, not on the strength of these counts alone. Type-only exceptions
rise from 5 of 82 to 10 of 48 - a bigger share of a smaller sample, worth
noting but not proof the true rate tripled. Host/plugin inversion (5 of 82, 4 of 48) and hexagonal/clean architecture
(5 of 82, 2 of 48) stay small in both samples. Both include large, popular
repositories in the second sample, so "thin evidence" describes the count,
not the size of the repositories that use them.

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
common non-source directory names, including `test`-shaped ones, and with
every colocated test-file naming convention it finds on disk (`*.test.ts`,
`*.spec.tsx`, `__tests__/`, and similar). An excluded file is not a module
member, not an edge source, and not an edge target - a test directory this
pattern is meant to guard still needs its own `declaredModules` entry (or
at least stay out of `exclude`), or this rule's own `evaluated` count stays
at 0 no matter how it is written.

A `__tests__`/`test-utils`/`mocks` directory, guarded above, is a different
shape from a single test file colocated beside the production file it
tests (`payment.ts` next to `payment.test.ts`, same directory). Removing
that convention's own `exclude` entry brings the file back into analysis;
tag it with a glob sharing its own directory's full literal prefix -
`{ glob: "src/app/*.test.ts", tags: ["kind:test"] }` beside
`{ glob: "src/app/**", tags: ["kind:prod"] }` - so `classify`'s
most-specific-glob-wins precedence ties on prefix length and then prefers
the fewer-wildcard entry (one `*` beats `**`'s two), giving the test file
`kind:test` and every other file in the directory `kind:prod`. A
project-wide glob like `**/*.test.ts` does not work for this: its own
literal prefix is empty, so the directory's own production glob always
outranks it, and the file stays `kind:prod`. The point rule above,
unchanged, already reads `kind:test` from either shape once the file is
tagged that way. Removing the `exclude` entry also brings back the test
file's own `public-surface-bypass` findings (rule 1): any import in it
that reaches another module's internal file, rather than that module's
own surface, is reported again - the exact noise `init`'s default exclude
removes.

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

**How common.** 5 of 82 in the tool-search survey; 4 of 48 in the
star-ordered one, including two of the three most-starred enforcing
repositories in that sample - both applications with a plugin or
extension system, enforcing exactly this shape with a hand-written
checker or a general-purpose lint rule rather than a dedicated tool. The
count stays small in both samples, but the repositories using it are not
small; look for a host/plugin split in any project that ships an
extension system,
regardless of its own popularity.

## Hexagonal

**Recognize it.** `domain`, `application`/`usecases`, `ports`,
`adapters`/`infrastructure` directory names, with a domain area that
imports no framework or I/O package at all. Thin in the tool-search survey -
every repository observed there using this shape had well under 3,000
stars - but the star-ordered survey found two large, popular repositories
enforcing this exact shape with their own hand-written checker: one names
its layers `domain`, `application`, `adapters` outright and lists the
database driver and ORM packages it confines to the `adapters` layer.
Small-project-only is no longer an accurate caveat; say instead that the
config below is the common shape once a project does adopt it, regardless
of size.

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

## Load-path isolation

No category for this in the tool-search survey (its own rule shapes would
have folded a load-path rule into an external-package or type-only
finding); 8 of 48 repositories in the star-ordered survey name it as its
own, distinct reason.

**Recognize it.** A heavy or side-effecting module (a large third-party
library, a browser API that has a real cost to touch, an optional
dependency not every install has) imported by value from an eager,
top-level load path. The stated reason is bundle size or startup time, not
architecture - the rule's own message usually names a byte size or a
concrete cost ("pulls in a multi-megabyte bundle", "hoists a heavy
dependency into the eager load path"). The rule almost always carries the
type-only exception (a type import is free at runtime) and often a dynamic
`import()` exception too, since a lazily loaded module still incurs no
eager cost.

**Config.**

```ts
classify: [
  { glob: "src/app/**", tags: ["kind:app"] },
  { glob: "src/heavy/**", tags: ["kind:heavy"] },
],
edges: {
  allowDeny: [
    {
      source: "kind:app",
      targetNamespace: "kind",
      deny: ["heavy"],
      edgeType: "value",
      importForm: "static",
      because: "heavy must stay off the eager load path; a type-only or a dynamic import is fine",
    },
  ],
},
```

`edgeType: "value"` lets a type-only import through untouched (`import
type` never counts as a value edge); `importForm: "static"` lets a dynamic
`import()` through untouched, since only a static import is evaluated
eagerly. Both filters apply before the rule's own `deny` list is checked -
narrowing what the rule can see at all, not adding an exemption after the
fact.

**Caveats.**

- Use `deny`, not an `allow` list, for this rule: on a small project, an
  `allow` list naming every other real tag value quickly becomes
  exhaustive by accident (see `exhaustive-allow-list` in
  [rules.md](rules.md)), and a `deny` list never has that failure mode.
- This is an ordinary `allowDeny` rule with both filter fields set, not a
  new rule shape - name it as its own pattern in a proposal anyway,
  because "keep this off the eager load path" is a different intent from
  an ordinary architectural boundary, even though the config looks similar
  to pattern (f)'s external-package rule.
- A project that also wants the reverse (the heavy module must never even
  be dynamically imported from a given area - a stricter "never touch this
  at all") drops `importForm` entirely, going back to the plain `pkg`-rule
  shape in pattern (f).

## Composition root

No category for this in the tool-search survey; 2 of 48 repositories in the
star-ordered survey.

**Recognize it.** Exactly one named file (often the process entry point,
or a file named for wiring things together) is the only place in the
project allowed to import a concrete implementation, driver, or plugin;
every other file in that same area must go through it. The motivating
examples in the survey confine every concrete browser-engine driver, and
every use of process control at the entry point, to one file each.

**Config.**

```ts
classify: [
  { glob: "src/server/root.ts", tags: ["kind:server", "kind:root"] },
  { glob: "src/server/**", tags: ["kind:server"] },
  { glob: "src/engine/**", tags: ["kind:engine"] },
],
edges: {
  point: [
    {
      from: { tags: ["kind:server"], exclude: { tags: ["kind:root"] } },
      to: { tags: ["kind:engine"] },
      because: "only the composition root may reach a concrete engine",
    },
  ],
},
```

`classify` gives the composition root file both its area's own tag
(`kind:server`) and a second, narrower tag (`kind:root`) that no other file
in the area carries - most-specific-glob-wins picks the file's own entry
over the directory-wide one. `point`'s `from.exclude` then reads as "every
file with `kind:server`, except one that also carries `kind:root`" - the
root file itself is invisible to this rule, so no rule exists to fire on
its own edge into `kind:engine`.

**Caveat.** A project with several concrete implementation areas the root
must reach can tag every one of them with the same value (`kind:engine`
here, even if the directories are unrelated otherwise) and keep this one
rule - `point`'s `to` matches on tags, not on a single directory, so one
shared tag value covers every area at once. Give each area a genuinely
different tag only when the root's own rule must distinguish between
them.

## Friend list

No category for this in the tool-search survey; 1 of 48 repositories in the
star-ordered survey, matching the exact shape a `declaredModules[].friends`
entry already exists to express - see [config.md](config.md) and
[rules.md](rules.md#1-public-surface-bypass).

**Recognize it.** An internal file (not the module's own public surface)
that most of the codebase must never import directly, but a small, named
group of specific files is allowed to import anyway - not "everyone", the
way `surface` grants access, and not "no one", the way an unlisted private
file works by default.

**Config.**

```ts
declaredModules: [
  {
    name: "repo",
    glob: "src/repo/**",
    friends: [
      {
        file: "internal.ts",
        from: "src/agents/allowed.ts",
        because: "only allowed.ts may reach the internal repository directly",
      },
    ],
  },
  { name: "agents", glob: "src/agents/**" },
],
```

**Caveat.** `friends` has no `edges` entry and produces no
`edgeRuleCoverage` row: rule 1 (`public-surface-bypass`) checks it directly,
before reporting a bypass. Verify it by import, not by `evaluated` count -
confirm the named friend's own import stays clean and a second, unlisted
importer of the same internal file gets `public-surface-bypass`.

## Edition split

No category for this in the tool-search survey; 2 of 48 repositories in the
star-ordered survey.

**Recognize it.** Two parallel directories hold an open (or community)
edition and a paid (or enterprise) edition of the same product. The open
edition must never import the paid edition; the reverse is allowed, since
the paid edition legitimately extends or overrides the open one.

**Config.**

```ts
classify: [
  { glob: "src/ce/**", tags: ["edition:open"] },
  { glob: "src/ee/**", tags: ["edition:paid"] },
],
edges: {
  allowDeny: [
    {
      source: "edition:open",
      targetNamespace: "edition",
      allow: [],
      because: "the open edition must never import the paid edition",
    },
  ],
},
```

Only one rule is needed: `allowDeny` never restricts the direction it
wasn't given a `source` entry for, so `edition:paid` importing
`edition:open` passes with no rule of its own required.

**Caveats.**

- A real project usually has the paid edition importing the open edition
  on purpose (it extends or overrides the open code). While an
  open-to-paid edge still exists too - the edge this rule already forbids
  - rule 2 (`cycle`) reports the same two modules as an ordinary module
  cycle, alongside this rule's own finding. `archstrict todo` can freeze
  both findings the same way. Fixing this rule's own violation (removing
  the last open-to-paid edge) also removes the cycle; do not add a
  standing `ignoredCycles` entry for it, since an entry that no longer
  matches a real cycle is itself a violation
  (`stale-cycle-exception`).
- A second real sub-shape in the survey inverts which side is restricted:
  callers throughout the codebase must reach the paid edition's own
  wrapper layer, never the open edition's internals directly, so the open
  edition can be overridden without every caller knowing which edition is
  active. That shape is pattern (f)'s public-entry-only, scoped to one
  edition's own directory, not a new rule of its own.

## Entry-graph budget - not expressible

No category for this in the tool-search survey; 1 of 48 repositories in
the star-ordered survey. **archstrict cannot express this pattern**, and
no combination of today's fields gets closer than the note below - say
this plainly rather than proposing a config that only looks like it
works.

**What it is.** A package's own named entry point (an `exports` map key)
states a maximum number of files its own value-import graph may reach at
all. It also names a list of areas that graph must never reach, even
transitively - "entry points are cost contracts." Both halves are checked
over the whole transitive closure from that one entry, not over any single
direct edge.

**Why archstrict cannot express it.** Every `edges` rule - `allowDeny`,
`order`, `point` - judges one direct edge at a time. `edgeRuleCoverage`'s
own per-rule `evaluated` count is a count of edges judged, not a count of
files reached transitively. Nothing in the constraint engine sums a file
count across a whole subgraph, and nothing sets a numeric maximum on
anything. Rule 2 (`cycle`) is the only rule that walks a transitive chain
at all, and it only ever asks "does this chain return to where it
started" - never "how many files does it touch" or "which areas does it
eventually reach".

**Closest shape available today, and its own limit (verified against a
fixture).** Forbid the specific forbidden areas directly, from the entry
file's own tag, with `edgeType: "value"` (the survey's own budget also
ignores type-only imports) - this is pattern (f)'s external-package-
confined shape, aimed at an internal area instead of an npm package:

```ts
classify: [
  { glob: "src/entry/point.ts", tags: ["kind:entry"] },
  { glob: "src/mid/**", tags: ["kind:mid"] },
  { glob: "src/area/**", tags: ["kind:forbidden-area"] },
],
edges: {
  allowDeny: [
    { source: "kind:entry", targetNamespace: "kind", deny: ["forbidden-area"], edgeType: "value", because: "the entry point must not reach the forbidden area directly" },
  ],
},
```

The rule does fire when it is given a direct edge: point the entry file
straight at the forbidden area and `check` reports the expected
`tag-boundary` violation. The limit shows up only once a hop is added. In
the fixture that proves it, `src/entry/point.ts` imports only
`src/mid/index.ts`; `src/mid/index.ts` in turn imports
`src/area/index.ts`, the forbidden area, one hop further out. With that
one hop in place, `check` reports zero violations: the rule judges the one
real edge it can see (the entry importing `mid`) and passes it, because
`mid` carries no forbidden tag itself. The entry point's own real,
transitive reach into the forbidden area - through `mid` - never gets
judged at all. This is the gap stated above, made concrete: a direct-edge
rule cannot see two hops out, and there is no config that recovers the "at
most N files reached" half of the real pattern.
