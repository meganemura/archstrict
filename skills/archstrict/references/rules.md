# The rules

Every rule's violation carries `rule`, `path`, `line`, `column`, `evidence`, `because`, `next`. Rules 1, 2, and 6 also carry `todoModule` - the module a violation belongs to, and the only three rules `archstrict todo` can freeze (a violation with no `todoModule` names a module directory, a module pair, or the config file, none of which `todo` has anywhere to freeze it into).

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

A module matches no `kind` pattern in the config. Not freezable - a module either matches a kind or it doesn't; there is no per-module state to suppress here, only a config change.

- because: "a module matching no kind is unchecked, not passing (deptrac's --fail-on-uncovered)"
- next: `add '<module>' to an existing kind's pattern, or give it its own kind in archstrict.config.ts`

## 4. empty-rule-set

A configured rule that structurally cannot match anything: zero modules at all, a `kinds` pattern matching zero modules, a `layers` entry naming a kind nothing declares, or a `deprecated` entry whose actual edge count is exactly 0 (handed off from rule 5, which deliberately does not report that case itself). ArchUnitTS's own "Empty Test Protection": a rule that checks nothing must not look like a pass.

- because: "a rule that checks nothing must not look like a pass (ArchUnitTS's Empty Test Protection)"
- `path`: the config file, not a module

## 5. deprecated-edge-increased / deprecated-edge-decreased

A `deprecated` entry in the config names an edge between two modules and a `count` it must not exceed - tach's own deprecated-dependency idea (warn, don't forbid), with "must not grow" added on top. The actual edge count exceeding the declared `count` is a violation (`rule: "deprecated-edge-increased"`); the actual count falling strictly between 0 and the declared count is a `suggestion` under a different rule id (`rule: "deprecated-edge-decreased"`, informational, never affects the exit code - the edge shrank, which is progress, not a failure). `because` is mandatory in the config; deprecating an edge without a reason is a decision no future reader can judge.

- violation (`deprecated-edge-increased`) next: `reduce <from> -> <to> back to <count> edges, or raise count in archstrict.config.ts and record why the increase was accepted`
- suggestion (`deprecated-edge-decreased`) next: `update count to <actual> for <from> -> <to> in archstrict.config.ts`
- Does not suppress rule 1: a deprecated edge that also bypasses its target's surface is still a rule-1 violation.

## 6. type-leak

A module's surface file re-exports or otherwise exposes an internal declaration - one that lives outside the surface file, inside the project's own checked modules root, and was never itself exported by name from that surface - without the consumer ever having a name for it. A structural leak: recurses through an exported symbol's properties, index signatures, union members, a generic type reference's own type arguments (`Promise<Internal>`, `Map<K, Internal>`, `Array<Internal>`), and a function's return type directly. A generic type parameter (a substitutable variable, not a declaration) and an anonymous type literal are excluded - neither has a name a consumer could fail to import.

- because: "a consumer needs a name for every type it receives from a public surface, not just the type doing the exposing"
- next: `export '<InternalType>' by name from <surface absolute path> (it's declared in <relative path>), or change '<Exported>' to not expose it` - `<surface absolute path>` is the surface file's full absolute path (e.g. `/project/src/m/index.ts`), unlike rule 1's own `<surface>` placeholder above, which is the bare file name
- `todoModule`: the module owning the leaking surface (a leak is a self-violation, not a cross-module edge)

## must-be-empty

A directory a team decided must hold no code at all - archspec's own "empty component" idea (e.g. a project that keeps rich models and no service objects declares `app/services` must stay empty, an anti-pattern guard). Distinct from rule 4 (`empty-rule-set`): that rule flags a rule that structurally cannot match anything; this one flags a real file existing where config says none should. A violation is any file matching config's `mustBeEmpty` glob at all - zero matches is a clean pass, not silence.

- because: whatever `mustBeEmpty`'s own entry gives (mandatory, same as every other root-level rule with a reason to record)
- `path`: the matching file itself; `line`/`column` are always `1`/`1` (no single line is "the" violation - the file's existence is)
- next: `move '<file>' out of '<glob>', or drop this mustBeEmpty entry in archstrict.config.ts if the restriction no longer applies`
- Not freezable: a file that shouldn't exist at all isn't debt to track, it's a file to move or a rule to remove.

## Not a rule of its own: stale-todo, clean-module-has-todo, and stale-cycle-exception

`stale-todo`: a todo entry matches no current violation. Prune it with `archstrict todo`, don't leave it - an unmatched entry hides nothing real.

`clean-module-has-todo`: a module in the config's `strict` list has any todo entries at all, existing or new. Staying clean means no debt, not debt frozen at whatever existed when the module was marked - fix the violation(s), then run `archstrict todo` to prune.

`stale-cycle-exception`: an `ignoredCycles` entry names two modules that aren't part of any real cycle at all (never were, or no longer are). `path` is the config file. Remove the entry - same reasoning as `stale-todo`: an exception that hides nothing real must be visible, not silently kept.
