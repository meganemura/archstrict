# Preview changes with `archstrict simulate`

Run `archstrict simulate [--json] [--whole-project]` from the project root.
The command reads a JSON object from stdin:

```ts
{
  changes: { path: string; content: string | null }[];
}
```

Each path identifies a file to create, replace, or delete.
Relative paths resolve from the project root.
A string supplies the full proposed file content, not a patch.
Use `null` to delete a file in the simulation.
By default, the command reports only violations whose `path` is one of the changed files.
It uses the same focused type-leak analysis as `check <file>` when a changed file is a module surface.
Use `--whole-project` when a proposal can create a violation on an unchanged file, such as a new target that makes an existing import resolvable.
Whole-project mode also suits CI and multi-file refactors that need the complete delta.
It compares the proposal with the project on disk and leaves the files unchanged.

For example:

```sh
printf '%s\n' '{"changes":[{"path":"src/app/index.ts","content":"export const value = 1;\n"}]}' | archstrict simulate --json
```

## Results

With `--json`, the result has this shape:

```ts
{
  mode: "scoped" | "whole-project";
  added: Violation[];
  resolved: Violation[];
  unchangedCount: number;
}
```

Each violation includes `rule`, `path`, `line`, `column`, `evidence`, `because`, `config`, and `do`.
`config` is one `{ path, pointer, value, line, column, role }` object, or an array when the violation needs more than one config location.
The comparison uses the same fingerprints as todo tracking:

- `added`: violations whose fingerprints occur after the proposal but not before it.
- `resolved`: violations whose fingerprints occur before the proposal but not after it.
- `unchangedCount`: the number of baseline violations whose fingerprints also occur after the proposal.

Unchanged violations contribute to the count; the result does not list their values.
A changed fingerprint can produce one resolved violation and one added violation for the same underlying problem.

`mode` states whether the default changed-file scope or `--whole-project` ran.

Without `--json`, the first two lines give a summary such as:

```text
mode: scoped
added: 0; resolved: 0; unchanged: 1
```

The text then lists added and resolved violations when present.
The command exits with code 1 when `added` is nonempty, and 0 otherwise.
Input or config errors also exit with code 1; `--json` reports them as `{ "error": "<message>" }`.

## Proposed config

Include `archstrict.config.ts` in the same `changes` array to preview a config change.
Set its `content` to the full proposed config source.
You can combine this entry with source changes or submit it alone.
The baseline uses the config on disk; the proposed check uses the supplied config.
No separate flag or field is required.

```sh
printf '%s\n' '{"changes":[{"path":"archstrict.config.ts","content":"export default { declaredModules: [{ name: \"app\", glob: \"src/app/**\" }, { name: \"lib\", glob: \"src/lib/**\", surface: [\"index.ts\", \"private.ts\"] }], exclude: [\"*.ts\"], because: \"Publish the library value as a supported entry point.\" };"}]}' | archstrict simulate --json
```

The example proposes a second public entry point for `lib`.
A config entry with `content: null` fails with `cannot delete archstrict.config.ts`.

## Todo freeze

Both checks apply the existing archstrict.todo.json before the fingerprint comparison.
A violation suppressed by a matching todo entry is absent from the baseline violation list.
If the proposal fixes that violation, it does not appear in `resolved`.
Instead, a frozen entry that no longer matches can produce an added `stale-todo` violation.
Simulation leaves archstrict.todo.json unchanged.

## MCP

The MCP `simulate` tool accepts the same `changes` array in its arguments and uses scoped mode.
After the MCP connection is initialized, send a JSON-RPC `tools/call` request:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "simulate",
    "arguments": {
      "changes": [
        { "path": "src/app/index.ts", "content": "export const value = 1;\n" }
      ]
    }
  }
}
```

Config proposals use the same entry shape through MCP.
