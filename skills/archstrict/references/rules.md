# The rules

Every rule's violation carries `rule`, `path`, `line`, `column`, `evidence`, `because`, `next`. Rules 1, 2, 6, and 7 (the constraint engine) also carry `todoModule` - the module a violation belongs to, and the only rules `archstrict todo` can freeze (a violation with no `todoModule` names a module directory, a module pair, or the config file, none of which `todo` has anywhere to freeze it into).

## 1. public-surface-bypass

An import from outside a module reaches a file other than that module's surface file (or the module has no surface file at all - every external import into it violates). Counts a type-only (`import type`) edge the same as a value edge: reaching an internal file for its types alone still reaches past the public surface.

- because: "a module's public surface is its only public surface; everything else is private"
- next: `add a <surface> to <module>/ naming what it exports`, or `import from <module>/<surface> instead, or add the needed export there`
- `todoModule`: the module whose surface was bypassed (the import's target, not its source)

## 2. cycle

A module-level cycle: two or more modules import each other, directly or through a chain, forming a strongly-connected component. One violation per component, regardless of its size or how many edges it contains. Only non-type-only edges count - a type-only cycle has no runtime consequence, and TypeScript itself allows it.

- because: "modules that import each other cannot be reasoned about, tested, or replaced independently"
- evidence: the shortest simple cycle within the component, e.g. `a -> b -> c -> a`
- next: `break the cycle at <m1> -> <m2>, or merge the modules involved`
- `todoModule`: the name-first module among the ones in the component

A known cycle can be exempted by naming any two of its modules in config's `ignoredCycles` (order doesn't matter): `ignoredCycles: [["a", "b"]]` suppresses the whole component both belong to, not just that one edge - a cycle is one finding regardless of how many modules or edges it spans. An `ignoredCycles` pair that no longer matches any real cycle is itself a violation (`stale-cycle-exception`, below) - an exception that hides nothing real must be visible, not silently kept.

## 3. uncovered-module

A real file (not excluded) matches no `declaredModules` entry - the same fact `graph.outsideFiles` already tracks, reported here instead of silently skipped. Not freezable: the file belongs to no module, so there is no module directory to freeze it into - the only fix is a config change (declare a module for it, or exclude it).

- because: "a file matching no declared module is unchecked, not passing (deptrac's --fail-on-uncovered)"
- `path`: the file itself
- next: `add a declaredModules entry covering '<file>' in archstrict.config.ts, or add it to exclude if it isn't module content`

## 4. empty-rule-set

A configured rule that structurally cannot match anything: zero `declaredModules` entries at all, a `classify` glob matching zero real files in scope, a `deprecated` entry whose actual edge count is exactly 0 (handed off from rule 5, which deliberately does not report that case itself), or an `edges` rule (`allowDeny`/`order`/`point`) whose own source/target combination never applies to any real edge in the graph. ArchUnitTS's own "Empty Test Protection": a rule that checks nothing must not look like a pass. `check`'s own `edgeRuleCoverage` field reports, per configured `edges` rule, how many real edges it actually evaluated - the same number this violation's own zero case reads off, exposed directly so authoring a new rule doesn't need a throwaway script against the graph to tell "0 violations, genuinely clean" from "0 violations, checked nothing" (a real, measured trap: writing an `edges` rule whose `targetNamespace` names a tag classify never assigns to anything in scope produces exactly this silent, meaningless "clean" pass - a workspace's own sibling-package imports were a concrete, previously-real instance of this, before this project's resolver learned to tell a workspace sibling apart from a genuine external dependency; see rule 7 below).

**A zero from an `edges` rule you haven't seen fire is an untested hypothesis, not evidence.** `evaluated > 0` only proves the rule had real edges to judge, not that its `allow`/`deny`/`sequence`/`from`/`to` shape is the one you meant to write. Before trusting a clean pass on a newly-written rule, inject a real edge you expect it to forbid, confirm the violation actually fires, then revert - the same discipline this project's own oracle scripts (`scripts/run-prisma-oracle.mjs`, `scripts/run-vscode-oracle.mjs`) use as a positive control.

- because: "a rule that checks nothing must not look like a pass (ArchUnitTS's Empty Test Protection)"
- `path`: the config file, not a module
- `next` (one of four, depending on which case fired):
  - zero `declaredModules` entries: `add at least one declaredModules entry in archstrict.config.ts`
  - a `classify` glob matching no file: `remove this classify entry from archstrict.config.ts, or point its glob at real files`
  - a `deprecated` entry whose actual edge count fell to 0: `remove the '<from> -> <to>' entry from deprecated in archstrict.config.ts`
  - an `edges` rule (`allowDeny`/`order`/`point`) with `evaluated: 0`: `remove or correct this <kind> entry in archstrict.config.ts's edges - its own source/target never applies to any real edge this project has (a workspace-sibling import may resolve as an external package rather than a project tag; see rules.md)`

## 5. deprecated-edge-increased / deprecated-edge-decreased

A `deprecated` entry in the config names an edge between two modules and a `count` it must not exceed - tach's own deprecated-dependency idea (warn, don't forbid), with "must not grow" added on top. The actual edge count exceeding the declared `count` is a violation (`rule: "deprecated-edge-increased"`); the actual count falling strictly between 0 and the declared count is a `suggestion` under a different rule id (`rule: "deprecated-edge-decreased"`, informational, never affects the exit code - the edge shrank, which is progress, not a failure). `because` is mandatory in the config; deprecating an edge without a reason is a decision no future reader can judge.

- violation (`deprecated-edge-increased`) next: `reduce <from> -> <to> back to <count> edges, or raise count in archstrict.config.ts and record why the increase was accepted`
- suggestion (`deprecated-edge-decreased`) next: `update count to <actual> for <from> -> <to> in archstrict.config.ts`
- Does not suppress rule 1: a deprecated edge that also bypasses its target's surface is still a rule-1 violation.

## 6. type-leak

A module's surface file re-exports or otherwise exposes an internal declaration - one declared inside a real declared module's own directory (never a loose file outside every module) and never itself exported by name from that module's surface - without the consumer ever having a name for it. A structural leak: recurses through an exported symbol's properties, index signatures, union members, a generic type reference's own type arguments (`Promise<Internal>`, `Map<K, Internal>`, `Array<Internal>`), and a function's return type directly. A generic type parameter (a substitutable variable, not a declaration) and an anonymous type literal are excluded - neither has a name a consumer could fail to import. A type declared outside every declared module's own directory (a loose root-level file, or one inside a module that isn't declared) is never flagged by this rule at all - it belongs to no module's own boundary, so it can't leak from one.

- because: "a consumer needs a name for every type it receives from a public surface, not just the type doing the exposing"
- next: `export '<InternalType>' by name from <surface absolute path> (it's declared in <relative path>), or change '<Exported>' to not expose it` - `<surface absolute path>` is the surface file's full absolute path (e.g. `/project/src/m/index.ts`), unlike rule 1's own `<surface>` placeholder above, which is the bare file name
- `todoModule`: the module owning the leaking surface (a leak is a self-violation, not a cross-module edge)

## 7. tag-boundary / tag-order / point-rule (the constraint engine)

Three shapes over `config.edges`, generalizing rules 1/2's fixed module vocabulary to tags (`classify`/`classifyByDirectoryName`). Each rule is evaluated independently, blind to every other rule's namespace: an edge violates if ANY ONE applicable rule says no. A rule scoped to a tag namespace says nothing about a target with no tag in that namespace at all (that's rule 3's territory, not this rule's concern) - an edge into an untagged file or an untagged external package simply never matches. `edgeType` (`"value"`/`"type"`/`"both"`, default `"both"`) and `importForm` (`"static"`/`"dynamic"`/`"both"`, default `"both"`) filter which edges a given `allowDeny`/`order`/`point` rule can match at all, checked before its own allow/deny, sequence, or from/to logic runs - the same filter, on all three shapes.

An edge reaching a genuinely external target (a real npm package, a node builtin) carries a synthesized `pkg:<name>` tag instead of the real file's classify tags - a `targetNamespace: "pkg"` rule constrains what a source may import from outside the project at all (VS Code's own per-layer external-package restrictions are the motivating case). A workspace's own sibling package - symlinked into `node_modules` by the package manager, which resolves exactly like a real dependency to TypeScript - is not treated as external: the edge's target keeps this project's own `classify` tags, so a `kind:`/`domain:`/`layer:` rule can constrain traffic between a monorepo's own packages, the same way it constrains traffic between plain directories.

**`allowDeny`** (`rule: "tag-boundary"`): a `source` tag's allow-or-deny list over one `targetNamespace` at a time (dependency-cruiser's own `mayImportFrom`/`forbid` generators, unified into one shape). A target sharing the source's own tag value is unconstrained by that rule - "the same group as source" is never restricted. An `exceptions` list (`{ from, to, because }[]`, glob pairs on the real file paths) overrides the rule either way for a specific edge - `allowDeny`'s own field only; `point` (below) has no `exceptions` of its own, since its `from`/`to` predicates are already as explicit as a rule gets.

- because: whatever the `allowDeny` entry's own `because` gives (mandatory)
- evidence: `'<specifier>' (from '<source tag>') reaches '<violating tag>'`
- next: `remove this edge, or add '<value>' to '<source>'s allow list in archstrict.config.ts and record why`
- `todoModule`: the edge's own source module

**`order`** (`rule: "tag-order"`): a `tagNamespace`'s values must appear in `sequence`, in declared order, `direction: "downward-only"` meaning a source may depend on its own layer or an earlier one, never a later one (dependency-cruiser's own layer generator). `within` scopes the rule to edges sharing the same value in a second namespace (e.g. one `sequence` per `domain`) - a `within` value with no `sequence` entry at all is silently out of scope for that rule, not an error (a domain legitimately needing no internal layering); a `within` value that DOES have a `sequence` but doesn't list one of the two layer values classify actually assigned is a thrown config error (a real omission, not a design choice).

- because: whatever the `order` entry's own `because` gives (mandatory)
- evidence: `'<specifier>' reaches '<target layer>' from '<source layer>' (<namespace> sequence: <a> -> <b> -> ...)`
- next: `move this edge to depend only on '<namespace>' values at or before '<source layer>' in archstrict.config.ts's sequence, or restructure the code so it does`
- `todoModule`: the edge's own source module

**`point`** (`rule: "point-rule"`): an explicit forbidden `from -> to` edge, each side either a glob (matched against the real project-relative path; never matches an external target) or a tag predicate - `from` may be `{ tags, exclude? }` (every listed tag must be present, and if `exclude` is given, none of its tags may all be present at once), but `to` is `{ tags }` only, with no `exclude` of its own. The narrowest, most explicit of the three shapes - a specific pair a broader `allowDeny`/`order` rule doesn't already cover.

- because: whatever the `point` entry's own `because` gives (mandatory)
- evidence: `'<specifier>' matches a forbidden edge`
- next: `remove this edge, or narrow the point rule in archstrict.config.ts if it's too broad`
- `todoModule`: the edge's own source module

## must-be-empty

A directory a team decided must hold no code at all - archspec's own "empty component" idea (e.g. a project that keeps rich models and no service objects declares `app/services` must stay empty, an anti-pattern guard). Distinct from rule 4 (`empty-rule-set`): that rule flags a rule that structurally cannot match anything; this one flags a real file existing where config says none should. A violation is any file matching config's `mustBeEmpty` glob at all - zero matches is a clean pass, not silence. The glob is project-root-relative, the same convention every rule follows now that `check`/`todo` only ever build a declared-mode module graph.

- because: whatever `mustBeEmpty`'s own entry gives (mandatory, same as every other root-level rule with a reason to record)
- `path`: the matching file itself; `line`/`column` are always `1`/`1` (no single line is "the" violation - the file's existence is)
- next: `move '<file>' out of '<glob>', or drop this mustBeEmpty entry in archstrict.config.ts if the restriction no longer applies`
- Not freezable: a file that shouldn't exist at all isn't debt to track, it's a file to move or a rule to remove.

## Not a rule of its own: stale-todo, clean-module-has-todo, and stale-cycle-exception

`stale-todo`: a todo entry matches no current violation. Prune it with `archstrict todo`, don't leave it - an unmatched entry hides nothing real.

`clean-module-has-todo`: a module in the config's `strict` list has any todo entries at all, existing or new. Staying clean means no debt, not debt frozen at whatever existed when the module was marked - fix the violation(s), then run `archstrict todo` to prune.

`stale-cycle-exception`: an `ignoredCycles` entry names two modules that aren't part of any real cycle at all (never were, or no longer are). `path` is the config file. Remove the entry - same reasoning as `stale-todo`: an exception that hides nothing real must be visible, not silently kept.
