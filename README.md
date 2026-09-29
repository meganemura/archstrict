# 🧱 archstrict

[![npm version](https://img.shields.io/npm/v/archstrict?logo=npm)](https://www.npmjs.com/package/archstrict)

archstrict checks TypeScript module boundaries, in the sense of ArchUnit (Java) and archspec (Ruby). You declare each module in config: one directory, or one file when its glob names that file. A module shows the rest of the codebase one public-surface file, and anything that file does not export is private.

tsc and type checkers examine types, and ESLint examines style. archstrict examines the boundary: an import that reaches past that public surface into a module's internals is a violation.

## Install

Every host starts with the npm package in the project:

```sh
npm install -D archstrict
```

Requires Node.js 22 or newer.

This puts a real `archstrict` binary at `node_modules/.bin/archstrict`. The edit hooks and CI run this binary, and the MCP server loads the same installed package.

### What each piece does

- **The CLI** (`npm install -D archstrict`) runs `init`, `check`, `todo`, and the other verbs. It is the only piece that finds violations.
- **The skill** (`skills/archstrict/`) teaches an agent to read a violation report and to change the config. A host loads it from its own skill directory, not from `node_modules/`.
- **The AGENTS.md section** (`archstrict agents`) tells any agent that reads `AGENTS.md` to run `archstrict rules <path>` before it creates a file or adds an import, and `archstrict check` after it edits. It is a few lines of project instructions, not the skill.
- **The edit hooks** (Claude Code only) run around each edit. The PreToolUse hook previews the change, and the PostToolUse hook runs `archstrict check <file>` and returns any violation into the agent's context. See [hook.md](skills/archstrict/references/hook.md).
- **The MCP server** (Claude Code plugin) gives the agent `check`, `rules`, `search`, and `simulate` as tools.
- **CI** runs `archstrict check` on every change, whichever host made it.

### Claude Code

Load a clone of this repository as a Claude Code plugin. The plugin carries the skill, the two edit hooks, and the MCP server. `--plugin-dir` loads it for one session, so pass it each time you start Claude Code:

```sh
git clone https://github.com/meganemura/archstrict.git
claude --plugin-dir ./archstrict
```

The hooks run the project's own `node_modules/.bin/archstrict`, so the npm install above is still required. Load the plugin from a git clone: npm drops the symlinks that the plugin root needs (`.claude-plugin/plugin.json`, `hooks/`, `mcp/`), so `node_modules/archstrict/` does not load as a plugin. The package still carries the plugin's files under `node_modules/archstrict/.agents/`.

### Other agents (Cursor, Codex, cloud agents)

The edit hooks are Claude Code only. For any other agent, use three pieces:

1. Install the skill from the public repository with the GitHub CLI. Replace `cursor` with your agent's value from `gh skill install --help`:

   ```sh
   gh skill install meganemura/archstrict archstrict --agent cursor
   ```

   The default scope is the project: Cursor, Codex, and several other agents share `.agents/skills/archstrict/`. Add `--scope user` to install it in your home directory instead.

2. Add the AGENTS.md section:

   ```sh
   npx archstrict agents
   ```

3. Run `archstrict check` in CI. With no edit hook, CI is where a violation from an agent session is caught:

   ```yaml
   - run: npm ci
   - run: npx archstrict check
   ```

## Quick start

```sh
npm install -D archstrict
npx archstrict init
npx archstrict check
```

`init` writes `archstrict.config.ts` when that file is absent, and writes `archstrict.types.ts`, the module-name union. On a fresh project it declares one module per top-level directory that holds TypeScript source (`.ts`, `.tsx`, `.mts`, `.cts`), and one module per loose top-level source file, both inside the opened container and at the project root. The container is `src/` when that directory holds source, and the project root when `src/` is absent or holds none. A later run leaves a hand-edited config in place and only regenerates `archstrict.types.ts` from `declaredModules`.

`check` analyzes the project and prints each violation with a rule id, `path:line:col`, the evidence, a `because` reason, and a `do:` command.

A config is one TypeScript value. `init` writes the real `declaredModules` from the tree it walked; the entries below are examples of a directory module and a single-file module. The `exclude` list below is the base that `init` always writes. `init` also adds an entry for each noise directory and colocated test-file pattern it finds on disk.

```ts
import type { Config } from "./archstrict.types.js";

export default {
  schemaVersion: 1,
  surface: ["index.ts", "index.tsx", "index.mts", "index.cts"],
  exclude: ["archstrict.config.ts", "archstrict.types.ts", ".*/**", "**/.*/**"],
  declaredModules: [
    { name: "app", glob: "src/app/**" },
    { name: "shared", glob: "src/shared/**" },
    { name: "cli.ts", glob: "src/cli.ts", surface: "cli.ts" },
  ],
  because: "app and shared are directory modules; cli.ts is one loose file, public as itself",
} satisfies Config;
```

`surface` names the public-surface file of a directory module. A single-file module names that file as its own `surface`, as `cli.ts` does above. `because` is required. A file that matches no `declaredModules` glob and no `exclude` pattern is an `uncovered-module` violation.

Rules, commands, and the full config: [AGENTS.md](AGENTS.md), [skills/archstrict/SKILL.md](skills/archstrict/SKILL.md), and [skills/archstrict/references/config.md](skills/archstrict/references/config.md).

## Installing from a local checkout

The `npm install` above installs the published package. Contributors and agents working from a checkout of this repository use one of the modes below.

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

   `npm pack` packs the checkout's working tree, not its git history, so it needs `dist/` already built. Confirmed by running it: the tarball contains `dist/`, `skills/`, `llms.txt`, `.agents/`, `README.md`, `README.ja.md`, `CHANGELOG.md`, `docs/`, `AGENTS.md`, `LICENSE`, and `package.json` - the same set `npm link` and the `file:` mode expose, plus the packaging itself.

---

[Japanese](README.ja.md)
