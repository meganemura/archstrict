# archstrict

[![npm version](https://img.shields.io/npm/v/archstrict?logo=npm)](https://www.npmjs.com/package/archstrict)

arch is architecture, not tsc, not eslint, not a type checker: module boundary checking.
Not archetype.

TypeScript module boundary checking, in the sense of ArchUnit (Java) and archspec (Ruby): a module is one directory declared explicitly in config, it shows the rest of the codebase one public-surface file, and everything else inside it is private.

See [AGENTS.md](AGENTS.md) for the shape, the rules, and the commands, and [skills/archstrict/SKILL.md](skills/archstrict/SKILL.md) for the workflow.

## Install

This package is not published yet. The npm registry name `archstrict` holds a `0.0.0` placeholder (`"description": "Reserved."`) with no code in it - `npm install archstrict` gets that placeholder, not the tool. Do not use it.

Every mode below puts a real `archstrict` binary at `node_modules/.bin/archstrict` in the target project - the exact path the PostToolUse hook (see [hook.md](skills/archstrict/references/hook.md)) checks for before running `check` on your behalf after an edit. Each mode also carries the agent skill (`skills/archstrict/SKILL.md` and `skills/archstrict/references/`), `llms.txt`, and `.agents/` (the plugin manifest, PostToolUse hook, and MCP server) into `node_modules/archstrict/`. npm omits the checkout's symlinks (`.claude-plugin/plugin.json`, `hooks/`, `mcp/`), so the installed hook is `node_modules/archstrict/.agents/hooks/post-tool-use.mjs` and the installed MCP server is `node_modules/archstrict/.agents/mcp/server.mjs`. A git checkout still loads as a Claude Code plugin through those symlinks.

1. **`npm link`, from a local checkout on the same machine.**

   ```sh
   # in this checkout
   npm run build   # if dist/ is missing or stale
   npm link

   # in the project you want to check
   npm link archstrict
   ```

   `npm unlink archstrict` in the target project removes it again.

2. **A `file:` dependency on a local checkout**, when you want the dependency recorded in the target's own `package.json` instead of a global link:

   ```json
   "archstrict": "file:../archstrict"
   ```

   `npm install` turns this into a symlink to the checkout, the same way `npm link` does, and runs no build step. Run `npm run build` in the checkout before running `npm install` in the target project - a symlinked `file:` dependency does not run the checkout's lifecycle scripts, so its `prepare` script never builds it. If you already installed before building, rerun `npm install` in the target project afterward, so it links the binary now that `dist/` exists.

3. **A git dependency** (`"archstrict": "github:<owner>/archstrict#<ref>"`), for a machine that cannot reach this checkout but can read the repository over git. `dist/` is not committed; npm installs the package's devDependencies and runs its `prepare` script (`npm run build`) after cloning, which builds `dist/`. Two conditions apply:
   - The installing machine must be able to read the repository. An agent whose access covers only the repository it runs in gets a 404 here; use mode 4 instead.
   - Lifecycle scripts must be enabled. With `ignore-scripts=true` in the npm config, `prepare` never runs and the install has no `dist/`, so `node_modules/.bin/archstrict` points at a missing file. Pass `--ignore-scripts=false` for this install, or use mode 4.

4. **A tarball from `npm pack`**, copied to the target machine - the mode that works where the target has no access to this repository at all (for example, an agent whose access covers only the repository it runs in):

   ```sh
   # in this checkout
   npm run build
   npm pack   # writes archstrict-<version>.tgz

   # copy the tarball to the target machine, then in the target project
   npm install ./archstrict-<version>.tgz
   ```

   `npm pack` packs the checkout's working tree, not its git history, so it needs `dist/` already built. Confirmed by running it: the tarball contains `dist/`, `skills/`, `llms.txt`, `.agents/`, `README.md`, `LICENSE`, and `package.json` - the same set `npm link` and the `file:` mode expose, plus the packaging itself.
