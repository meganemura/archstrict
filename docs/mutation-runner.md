# Mutation runner

`npm run mutation` is the entry point.

`stryker.config.json` mutates `src/**/*.ts` and leaves out `src/cli.ts` and `src/mcp-server.ts`. Those two files are process entry points. `test/cli.test.ts` runs the built `dist/cli.js`. The config sets `coverageAnalysis` to `perTest`.

A bounded run passes the mutate option through the npm script:

```sh
npm run mutation -- --mutate src/<file>.ts
```

The sandbox copy and the increment form in `src/rules/constraints.ts` are in [maintenance.md](maintenance.md).
