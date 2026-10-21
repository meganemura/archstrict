# Edge engine (`ARCHSTRICT_ENGINE`)

archstrict reads every analyzed file to list its imports, then resolves each import to a file. That step is the edge walk. It has two engines:

- `typescript` (the default): typescript 6.0.3, which archstrict depends on.
- `tsrs` (opt-in): [tsrs](https://www.npmjs.com/package/tsrs), a native port of the TypeScript 7 compiler.

Set the environment variable to choose:

```sh
ARCHSTRICT_ENGINE=tsrs npx archstrict check
```

Every verb, the MCP server, and both edit hooks read the variable. The hooks and the MCP server run with the environment of the process that starts them, so set it there too. Unset or empty selects `typescript`. Any other value stops the verb with a `do:` line, and with `--json` the output is `{ "error": "<message>", "do": "<command>" }`.

## Install

tsrs is not a dependency of archstrict. Install the one version archstrict was checked against:

```sh
npm install --save-dev --save-exact tsrs@0.14.1-ts7.1.0-dev.20260929
```

Another installed tsrs version is refused. tsrs ships native binaries for linux x64 and arm64 (glibc and musl) and darwin arm64 only. On Windows and on Intel macOS it cannot start; archstrict then stops with a message that names the platform. It never falls back to the default engine without telling you.

## What tsrs covers

- Parsing each analyzed file and listing its import, export, dynamic `import()`, and `import("...")` type specifiers.
- Resolving each specifier, including `simulate`'s in-memory change set.

The edges, and so `public-surface-bypass`, cycles, `edges` constraints, deprecated edges, and the unresolved-specifier counts, come from tsrs. On archstrict, nukadoko, and solarsql the two engines gave the same edges.

## What stays on typescript 6.0.3

- Rule 6 (`type-leak`) and its type closure, `search`, `fix`, and everything else that needs a Program, the type checker, or a compiler host. tsrs answers each checker call through a separate process, which measured 6 to 13 times slower for rule 6.
- Each file's ESM or CommonJS format (from the nearest `package.json`) and the resolution mode of each import, so both engines resolve under the same mode.
- Reading `tsconfig.json`, including each file's nearest one and its `extends` chain. tsrs resolves under the options typescript 6.0.3 read.

## What tsrs refuses

tsrs follows TypeScript 7 module resolution, which removed `baseUrl` lookups and the `node10` and `classic` strategies. Under those options tsrs resolves fewer imports and reports no error. archstrict stops instead when a tsconfig sets `baseUrl`, `moduleResolution: "node10"` or `"classic"`, or a `module` of `none`, `amd`, `umd`, or `system` with no `moduleResolution`. Unset `ARCHSTRICT_ENGINE` for that project.

## Cache

The edge cache in `node_modules/.cache/archstrict` records the engine. A run on the other engine rebuilds the cache instead of reading its entries, so switching back and forth costs one full walk per switch.
