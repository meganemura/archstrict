# Plan a file with `archstrict rules`

Run `archstrict rules <path> [--json]` from the project root before creating a file or adding imports.
The path can refer to an existing file or a file that does not exist yet.
Relative paths resolve from the current directory. Paths outside the project root produce an error.

The command loads `archstrict.config.ts` and builds the project graph, as `check` does.
Existing files use the graph's actual module membership and surface files.
Proposed files use the configured module and surface globs.
The query does not create the proposed file.

The result reports:

- `path`: the absolute path, with existing directory symlinks resolved.
- `exists` and `excluded`: whether the path exists and matches a configured exclude glob.
- `module`, `tags`, and `isSurfaceFile`: module membership, sorted classification tags, and public surface status.
- `importableFrom`: other modules' existing public surface files, ordered by module name.
- `friendAccess`: friend entries whose `from` glob matches the queried importer path, including their reasons.
  Each `file` is the graph's project-relative file glob.
- `mustBeEmptyViolation` and `uncoveredViolation`: the same violation objects used by `check`, when applicable.

Excluded paths retain descriptive information, but it does not apply to architecture checks.
Their violation fields are unset, and text output starts with an out-of-scope notice.
JSON omits fields whose values are undefined, including `module` when membership is unresolved.

`importableFrom` lists public entry points; the following projections describe restrictions on imports from the queried path:

- `allowDenyConstraints` includes entries whose source tag matches the path.
  It copies allow and deny lists, reports edge filters, and sets `sameGroupExempt: true`.
  A target with the same source tag is exempt from that rule.
  `exceptionsFromP` lists matching importer exceptions; each target must still match its `to` glob for the exception to apply.
- `orderConstraints` reports the path's own layer and the sequence for its scope.
  `rules` and `check` select the same layer and scope when a path has multiple tags in one namespace.
  `mayDependOn` contains the sequence prefix through that layer, inclusive, following downward-only order.
  Missing layer tags, missing scope tags, and undeclared scope sequences omit the rule.
  A layer missing from a declared sequence produces the same configuration error as check, before an import exists.
- `pointConstraints` lists matching source predicates, their identifiers, and `forbiddenTo` predicates.
  Glob predicates remain strings; tag predicates use JSON serialization, as point-rule reports do.

Each projection includes `edgeType`, `importForm`, and `because`; omitted filters appear as `both`.
Text output gives each constraint kind its own section and prints `(none)` for an empty projection.
Excluded paths still show descriptive projections under the out-of-scope notice.
A matching order rule can report an unlisted layer even for a proposed or excluded path.
These projections use source information; target tags, exception targets, and actual import forms still determine whether a particular edge violates a rule.
Run `archstrict check` after editing to evaluate actual imports.

For example:

```sh
archstrict rules src/feature/new-thing.ts
archstrict rules src/feature/new-thing.ts --json
```

Text output uses `key: value` lines and includes each violation's original `evidence`, `because`, structured `config` location, and `do` fields.
The must-be-empty violation uses a project-relative path, as `check` does; the uncovered violation uses an absolute path.
A successful query exits with code 0, including when it reports a potential violation.
Argument, configuration, and outside-root errors exit with code 1; `--json` errors use `{ "error": "<message>" }`.
