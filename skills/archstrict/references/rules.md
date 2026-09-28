# The rules

Every rule's violation carries `rule`, `path`, `line`, `column`, `evidence`, `because`, `config`, and `do`. `config` is one pointer or an array of pointers. Each pointer has `{ path, pointer, value, line, column, role }`. `pointer` is a property path such as `edges.allowDeny[0].deny[1]`. `value` is the JSON value at that path. `line` and `column` locate its source text. `role` is `fired` when the value produced the violation, `governs` when the value makes the rule apply, or `edit-here` when the remediation names a different config location. An array keeps the `fired` pointer first. Text output prints the same data as `config: <path>:<line>:<column> <pointer> (<role>)` before `do:`. Rules 1, 2, 6, and 7 (the constraint engine) also carry `todoModule` - the module a violation belongs to, and the only rules `archstrict todo` can freeze (a violation with no `todoModule` names a module directory, a module pair, or the config file, none of which `todo` has anywhere to freeze it into).

## 1. public-surface-bypass

An import from outside a module reaches a file other than that module's surface file (or the module has no surface file at all - every external import into it violates). Counts a type-only (`import type`) edge the same as a value edge, and an `import("./x").Y` type-position reference the same as either: reaching an internal file for its types alone still reaches past the public surface. A `declaredModules` entry's own `friends` (see below) is checked before a bypass is reported: an importer matching a `friends` entry's `from` glob, reaching that entry's own `file` glob, is exempt - every other importer of that file still violates.

- because: "a module's public surface is its only public surface; everything else is private"
- do: `add a <surface> to <module>/ naming what it exports`, or `import from <module>/<surface> instead, or add the needed export there`. When the module's glob names a single file, there is no directory to add a surface file into: `set surface on '<module>' to match <file>, or stop importing it; this module is that file, not a directory` (or `import from <file> instead, or add the needed export there` when a surface file is already present).
- `todoModule`: the module whose surface was bypassed (the import's target, not its source)

### `friends` - a per-consumer exception

A module's `surface` is public to every importer equally, or private to all. `declaredModules[].friends` (`{ file, from, because }[]`) is narrower: `file` (relative to the module, may itself be a glob) is public to exactly the importers `from` (a project-relative glob) matches, private to everyone else. A real, motivating case: a large monorepo's own semi-private internal-utilities file documented two legitimate consumer classes (that package's own implementation code, plus a specific first-party group of other packages routed through one particular re-export) with different rules for each - a shape `surface` alone cannot express, since it only ever grants or denies visibility project-wide.

Decided as a field on `declaredModules[]` entries, not a new top-level `Config` field - this is a property of one module's own surface, not a project-wide rule.

Alternative refused: `edges.allowDeny`'s own `exceptions` field already has the right shape (`{ from, to, because }` glob pairs) and could in principle be read by rule 1 too, adding zero new schema. Refused because `exceptions` lives inside one specific `allowDeny` rule's own evaluation loop (confirmed: `isExemptedByGlobPair` in src/rules/constraints.ts is only ever called from within `computeAllowDeny`'s per-rule pass) - a project with no `edges` rules at all, but one real friend relationship, would have to author a vacuous `allowDeny` rule purely to host the exception. A dedicated field on `declaredModules[]` needs no such rule to exist first.

Not the same gap as a package's own multiple real entry points (see the `surface`-as-glob guidance in config.md): a public entry point covers everyone equally, and `surface` already handles that (a glob matching every entry point a package's own `exports` map names). `friends` is for a file that is genuinely private to most importers and public to a specific, named few - a narrower, different relationship.

## 2. cycle

A module-level cycle: two or more modules import each other, directly or through a chain, forming a strongly-connected component. One violation per component, regardless of its size or how many edges it contains. Only non-type-only edges count - a type-only cycle has no runtime consequence, and TypeScript itself allows it.

- because: "modules that import each other cannot be reasoned about, tested, or replaced independently"
- evidence: the shortest simple cycle within the component, e.g. `a -> b -> c -> a`
- do: `break the cycle at <from file> -> <to file> (module <m1> -> <m2>), or merge the modules involved - real import chain: <chain>`, e.g. `break the cycle at src/a/index.ts -> src/b/index.ts (module a -> b), or merge the modules involved - real import chain: src/a/index.ts -> src/b/index.ts, src/b/index.ts -> src/a/index.ts`
- `todoModule`: the name-first module among the ones in the component

A pair of modules in the component is lopsided when it has value edges in both directions, one direction has at most 3 edges, and the other has at least 3 times as many. The small side is usually the accidental import. The pair can be any two modules in the component, not only the two next to each other in the evidence cycle. When a component has a lopsided pair, `do:` names that pair's minority imports first, then gives the break-the-cycle text as the alternative, e.g. `remove the 1 import(s) from b to a (a imports b 6 times, so b -> a is likely the unintended direction): src/b/index.ts -> src/a/index.ts; alternatively, break the cycle at ...`. The count is import statements; the file list names each file pair once. When several pairs are lopsided, the highest majority-to-minority ratio wins, and a tie goes to module-name order. Without a lopsided pair, `do:` is the break-the-cycle text alone. `evidence` and the fingerprint never change.

A known cycle can be exempted by naming any two of its modules in config's `ignoredCycles` (order doesn't matter): `ignoredCycles: [["a", "b"]]` suppresses the whole component both belong to, not just that one edge - a cycle is one finding regardless of how many modules or edges it spans. An `ignoredCycles` pair that no longer matches any real cycle is itself a violation (`stale-cycle-exception`, below) - an exception that hides nothing real must be visible, not silently kept.

## 3. uncovered-module

A real file (not excluded) matches no `declaredModules` entry - the same fact `graph.outsideFiles` already tracks, reported here instead of silently skipped. Not freezable: the file belongs to no module, so there is no module directory to freeze it into - the only fix is a config change (declare a module for it, or exclude it).

- because: "a file matching no declared module is unchecked, not passing"
- `path`: the file itself
- do, for a lone file: `add { name: "sqlite.ts", glob: "src/sqlite.ts", surface: "sqlite.ts" } to declaredModules in archstrict.config.ts, or add "src/sqlite.ts" to exclude if it is not module content; then run archstrict init`
- do, for a directory (this and every other uncovered file directly inside it): `add { name: "extra", glob: "src/extra/**" } to declaredModules in archstrict.config.ts, or add "src/extra/**" to exclude if it is not module content; then run archstrict init`

A file entry always names itself as `surface`: an entry without one makes that single-file module entirely private (its default surface, `index.ts`/`index.tsx`/`index.mts`/`index.cts`, resolves to a different file), so following the `do:` literally would create a public-surface-bypass instead of fixing the coverage gap. `archstrict rules <path>` prints the identical entry for the same file, and `archstrict init`'s own re-run lists one `declare:`/`or exclude:` pair per uncovered directory or file the same way. `archstrict check`'s own footer changes while any `uncovered-module` violation exists: `do: add each uncovered-module file to declaredModules or exclude in archstrict.config.ts, then run archstrict check`, not `do: archstrict todo` - the same reason this rule isn't freezable applies to the whole run, not just this one violation.

## 4. empty-rule-set

A configured rule that structurally cannot match anything: zero `declaredModules` entries at all, a `classify` glob matching zero real files in scope, a `deprecated` entry whose actual edge count is exactly 0 (handed off from rule 5, which deliberately does not report that case itself), or an `edges` rule (`allowDeny`/`order`/`point`) whose own source/target combination never applies to any real edge in the graph. A rule that checks nothing must not look like a pass. `check`'s own `edgeRuleCoverage` field reports, per configured `edges` rule, how many real edges it actually evaluated - the same number this violation's own zero case reads off, exposed directly so authoring a new rule doesn't need a throwaway script against the graph to tell "0 violations, genuinely clean" from "0 violations, checked nothing" (a real, measured trap: writing an `edges` rule whose `targetNamespace` names a tag classify never assigns to anything in scope produces exactly this silent, meaningless "clean" pass - a workspace's own sibling-package imports were a concrete, previously-real instance of this, before this project's resolver learned to tell a workspace sibling apart from a genuine external dependency; see rule 7 below).

**A zero from an `edges` rule you haven't seen fire is an untested hypothesis, not evidence.** `evaluated > 0` only proves the rule had real edges to judge, not that its `allow`/`deny`/`sequence`/`from`/`to` shape is the one you meant to write. Before trusting a clean pass on a newly-written rule, inject a real edge you expect it to forbid, confirm the violation actually fires, then revert - a positive control any rule-writer should apply before trusting a rule that reports zero.

- because: "a rule that checks nothing must not look like a pass"
- `path`: the config file, not a module
- `do` (one of four, depending on which case fired):
  - zero `declaredModules` entries: `add at least one declaredModules entry in archstrict.config.ts`
  - a `classify` glob matching no file: `remove this classify entry from archstrict.config.ts, or point its glob at real files`
  - a `deprecated` entry whose actual edge count fell to 0: `remove the '<from> -> <to>' entry from deprecated in archstrict.config.ts`
  - an `edges` rule (`allowDeny`/`order`/`point`) with `evaluated: 0`: `remove or correct this <kind> entry in archstrict.config.ts's edges - its own source/target never applies to any real edge this project has (a workspace-sibling import may resolve as an external package rather than a project tag; see rules.md)`

### exhaustive-allow-list

An `allowDeny` rule whose `allow` list names every value of its `targetNamespace` that exists in the graph today. Such a rule cannot fire on any current or future edge between those values, so it passes without checking anything - the same failure rule 4 reports, reached by a list instead of by a missing target.

- The universe is every value of `targetNamespace` that any file in the graph carries, not only the values this rule's source reaches today. A value reached only by another source still counts.
- The source's own tag is left out of the universe: a target that shares it is always exempt.
- `exceptions`, `edgeType`, and `importForm` do not shrink the universe. A value that only exempted, type-only, or dynamic edges reach still keeps the list from being exhaustive.
- Only `allow` lists are checked. A `deny` list may name a value that does not exist yet, to guard against a future edge.
- A rule with `evaluated: 0` is reported as `empty-rule-set` instead, never as both.
- On a small graph, a list can become exhaustive by accident. Add a value the rule must forbid (or wait until one exists) before you trust the rule.

- evidence: `allowDeny rule '<identifier>' allows every real target value with allow [...]`
- because: the rule's own `because`
- `path`: the config file
- do: `narrow the allow list for '<identifier>' in archstrict.config.ts to a genuine subset of real target values, or remove the rule if it should forbid nothing today`

## 5. deprecated-edge-increased / deprecated-edge-decreased

A `deprecated` entry in the config names an edge between two modules and a `count` it must not exceed - tach's own deprecated-dependency idea (warn, don't forbid), with "must not grow" added on top. The actual edge count exceeding the declared `count` is a violation (`rule: "deprecated-edge-increased"`); the actual count falling strictly between 0 and the declared count is a `suggestion` under a different rule id (`rule: "deprecated-edge-decreased"`, informational, never affects the exit code - the edge shrank, which is progress, not a failure). `because` is mandatory in the config; deprecating an edge without a reason is a decision no future reader can judge.

- violation (`deprecated-edge-increased`) do: `reduce <from> -> <to> back to <count> edges, or raise count in archstrict.config.ts and record why the increase was accepted`
- suggestion (`deprecated-edge-decreased`) do: `update count to <actual> for <from> -> <to> in archstrict.config.ts`
- Does not suppress rule 1: a deprecated edge that also bypasses its target's surface is still a rule-1 violation.

## 6. type-leak

A module's surface file re-exports or otherwise exposes an internal declaration - one declared inside a real declared module's own directory (never a loose file outside every module, and never under `node_modules`) and named by NO declared module's own surface - without the consumer ever having a name for it. "Named by" resolves through an aliased re-export (`export { X as Y }`) and through a chain of re-exports, and counts a name from ANY declared module's own surface, not only the exposing module's own: a type a consumer can already `import { Y } from "b"` is not a leak in module `a`'s surface either, even though `a`'s own surface never re-exports it itself. A structural leak: recurses through an exported symbol's properties, index signatures, union members, a generic type reference's own type arguments (`Promise<Internal>`, `Map<K, Internal>`, `Array<Internal>`), and a function's return type directly. A generic type parameter (a substitutable variable, not a declaration) and an anonymous type literal are excluded - neither has a name a consumer could fail to import. A type declared outside every declared module's own directory (a loose root-level file, or one inside a module that isn't declared) is never flagged by this rule at all - it belongs to no module's own boundary, so it can't leak from one. Neither is a type declared under `node_modules` - a real dependency's own type, whatever module's glob base happens to contain it (a root-based glob like `"**"` puts the project's own `node_modules` inside a module's literal directory, but the consumer already names that type from the package it imported it from, not from this project's own boundary to keep).

One violation per (module, internal type), not per exported symbol that reaches it: a single never-exported internal type can be referenced by many different exported symbols in the same module at once (measured directly, against a real, large library's own client package: a single internal type referenced by 51 different exported symbols) - that is one real fact (this type has no public name here), not 51 separate ones, and fixing it (one re-export) resolves every one of those references at once. `evidence` names every referencing exported symbol, up to 10 - past that, "(and N more)". The named exports are sorted alphabetically (plain ascending string sort), not by declaration order or by which export the walk happened to visit first - a rerun of `check` names them in the same order every time, regardless of file-system walk order.

The violation's own `line`/`column` anchor to the earliest referencing export's own declaration site: whichever exported symbol's own position sorts first by line, then by column, among every export that references the leaking type in one surface file. This is a deterministic, stable anchor independent of which exported symbol the walk happened to visit first - the same reasoning as the alphabetical evidence order above, applied to position instead of naming. When a module's surface is more than one file (`surface` as a glob or array), the anchor is the position within whichever surface file the leak's group was first assembled from, not necessarily the earliest position across every surface file combined.

A module can have more than one surface file. A type declared in one surface file and used in another does not count as a leak. For a type from an internal file, you can add that file to the module's `surface`, re-export the type, or remove its exposure. Consider the wider surface when you adopt module boundaries one file at a time. To compare results, run `archstrict check`, edit the real config, then run `archstrict check` again. `archstrict simulate` also previews a proposed config: include `archstrict.config.ts` and its proposed content in `changes`, alongside or instead of source changes.

- because: "a consumer needs a name for every type it receives from a public surface, not just the type doing the exposing"
- evidence: `'<InternalType>', declared in '<relative path>', is never exported by name from module '<module>' - referenced by '<Exported1>', '<Exported2>', ...`
- do: `export '<InternalType>' by name from <surface absolute path> (it's declared in <relative path>), change the referencing exports to not expose it, or add <relative path> to this module's own surface` - `<surface absolute path>` is the surface file's full absolute path (e.g. `/project/src/m/index.ts`), unlike rule 1's own `<surface>` placeholder above, which is the bare file name
- `todoModule`: the module owning the leaking surface (a leak is a self-violation, not a cross-module edge)

## 7. tag-boundary / tag-order / point-rule (the constraint engine)

Three shapes over `config.edges`, generalizing rules 1/2's fixed module vocabulary to tags (`classify`/`classifyByDirectoryName`). Each rule is evaluated independently, blind to every other rule's namespace: an edge violates if ANY ONE applicable rule says no. A rule scoped to a tag namespace says nothing about a target with no tag in that namespace at all (that's rule 3's territory, not this rule's concern) - an edge into an untagged file or an untagged external package simply never matches. `edgeType` (`"value"`/`"type"`/`"both"`, default `"both"`) and `importForm` (`"static"`/`"dynamic"`/`"both"`, default `"both"`) filter which edges a given `allowDeny`/`order`/`point` rule can match at all, checked before its own allow/deny, sequence, or from/to logic runs - the same filter, on all three shapes.

An edge reaching a genuinely external target (a real npm package, a node builtin) carries a synthesized `pkg:<name>` tag instead of the real file's classify tags - a `targetNamespace: "pkg"` rule constrains what a source may import from outside the project at all (VS Code's own per-layer external-package restrictions are the motivating case). A workspace's own sibling package - symlinked into `node_modules` by the package manager, which resolves exactly like a real dependency to TypeScript - is not treated as external: the edge's target keeps this project's own `classify` tags, so a `kind:`/`domain:`/`layer:` rule can constrain traffic between a monorepo's own packages, the same way it constrains traffic between plain directories.

`<name>` is the resolved module's real identity, not always the bare specifier a rule author wrote: a package shipping no bundled type declarations of its own resolves through its own `@types/<name>` shadow package instead (TypeScript's own resolver, several real, common npm packages this way) - so a rule targeting the bare name alone would silently match nothing, with `edgeRuleCoverage`'s own `evaluated` count still nonzero (the edge WAS judged, just under the wrong identity - rule 4's `evaluated: 0` case can't catch this, since the rule did fire). Both identities are tagged (`pkg:express` and `pkg:@types/express`, for a package resolving that way), so a rule written against either one matches the same real edge.

A node builtin also carries a second, shared `pkg:node` tag alongside its own bare-name tag (`pkg:fs` and `pkg:node`, for `node:fs`) - a rule targeting `pkg:node` alone bans every builtin at once (a real, common need for code that must never touch a Node API at all, a browser-runtime layer being the motivating case), without a rule author having to enumerate each specific builtin they currently know is imported and silently under-protecting against the next one nobody thought to add.

**`allowDeny`** (`rule: "tag-boundary"`): a `source` tag's allow-or-deny list over one `targetNamespace` at a time. A target sharing the source's own tag value is unconstrained by that rule - "the same group as source" is never restricted. An `exceptions` list (`{ from, to, because }[]`, glob pairs on the real file paths) overrides the rule either way for a specific edge - `allowDeny`'s own field only; `point` (below) has no `exceptions` of its own, since its `from`/`to` predicates are already as explicit as a rule gets.

- because: whatever the `allowDeny` entry's own `because` gives (mandatory)
- evidence: `'<specifier>' (from '<source tag>') reaches '<violating tag>'`
- do: `remove this edge, or add '<value>' to '<source>'s allow list in archstrict.config.ts and record why`
- `todoModule`: the edge's own source module

**`order`** (`rule: "tag-order"`): a `tagNamespace`'s values must appear in `sequence`, in declared order, `direction: "downward-only"` meaning a source may depend on its own layer or an earlier one, never a later one. `within` scopes the rule to edges sharing the same value in a second namespace (e.g. one `sequence` per `domain`) - a `within` value with no `sequence` entry at all is silently out of scope for that rule, not an error (a domain legitimately needing no internal layering); a `within` value that DOES have a `sequence` but doesn't list one of the two layer values classify actually assigned is a thrown config error (a real omission, not a design choice).

- because: whatever the `order` entry's own `because` gives (mandatory)
- evidence: `'<specifier>' reaches '<target layer>' from '<source layer>' (<namespace> sequence: <a> -> <b> -> ...)`
- do: `move this edge to depend only on '<namespace>' values at or before '<source layer>' in archstrict.config.ts's sequence, or restructure the code so it does`
- `todoModule`: the edge's own source module

**`point`** (`rule: "point-rule"`): an explicit forbidden `from -> to` edge, each side either a glob (matched against the real project-relative path; never matches an external target) or a tag predicate - `from` may be `{ tags, exclude? }` (every listed tag must be present, and if `exclude` is given, none of its tags may all be present at once), but `to` is `{ tags }` only, with no `exclude` of its own. The narrowest, most explicit of the three shapes - a specific pair a broader `allowDeny`/`order` rule doesn't already cover.

- because: whatever the `point` entry's own `because` gives (mandatory)
- evidence: `'<specifier>' matches a forbidden edge`
- do: `remove this edge, or narrow the point rule '<from> -> <to>' in archstrict.config.ts if it's too broad`. Glob values appear unchanged; tag predicates use `JSON.stringify` for `<from>` and `<to>`.
- `todoModule`: the edge's own source module

## must-be-empty

A directory a team decided must hold no code at all (e.g. a project that keeps rich models and no service objects declares `app/services` must stay empty, an anti-pattern guard). Distinct from rule 4 (`empty-rule-set`): that rule flags a rule that structurally cannot match anything; this one flags a real file existing where config says none should. A violation is any file matching config's `mustBeEmpty` glob at all - zero matches is a clean pass, not silence. The glob is project-root-relative, the same convention every rule follows now that `check`/`todo` only ever build a declared-mode module graph.

- because: whatever `mustBeEmpty`'s own entry gives (mandatory, same as every other root-level rule with a reason to record)
- `path`: the matching file itself; `line`/`column` are always `1`/`1` (no single line is "the" violation - the file's existence is)
- do: `move '<file>' out of '<glob>', or drop this mustBeEmpty entry in archstrict.config.ts if the restriction no longer applies`
- Not freezable: a file that shouldn't exist at all isn't debt to track, it's a file to move or a rule to remove.

## Not a rule of its own: stale-todo, clean-module-has-todo, and stale-cycle-exception

`stale-todo`: a todo entry matches no current violation. `path` is `archstrict.todo.json`, at that entry's own line - fix it there with `archstrict todo`; don't leave it, an unmatched entry hides nothing real. `entryPath` is the entry's own stored file (the importer, for rules 1 and 7; a cycle's own arbitrary anchor edge; a type-leak's own surface) - a `check <file>` scoped to that exact file, or a `check <dir>` scoped to a directory containing it, still surfaces this violation (matched through `entryPath`, not `path`), so the moment an edit retires a frozen violation the agent sees the stale entry it just created.

`clean-module-has-todo`: a module in the config's `strict` list has any todo entries at all, existing or new. `path` is `archstrict.todo.json`, at that module's own key - config-level, so only a plain, unscoped `check` reports it; a `check <file>` or `check <dir>` never does. Staying clean means no debt, not debt frozen at whatever existed when the module was marked - fix the violation(s), then run `archstrict todo` to prune.

`stale-cycle-exception`: an `ignoredCycles` entry names two modules that aren't part of any real cycle at all (never were, or no longer are). `path` is the config file. Remove the entry - same reasoning as `stale-todo`: an exception that hides nothing real must be visible, not silently kept.
