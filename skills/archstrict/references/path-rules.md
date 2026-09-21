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

`importableFrom` lists public entry points; edge constraints can still forbid an import.
This command does not project `allowDeny`, `order`, or `point` constraints.
Run `archstrict check` after editing to evaluate actual imports.

For example:

```sh
archstrict rules src/feature/new-thing.ts
archstrict rules src/feature/new-thing.ts --json
```

Text output uses `key: value` lines and includes each violation's original evidence, reason, and next action.
The must-be-empty violation uses a project-relative path, as `check` does; the uncovered violation uses an absolute path.
A successful query exits with code 0, including when it reports a potential violation.
Argument, configuration, and outside-root errors exit with code 1; `--json` errors use `{ "error": "<message>" }`.
