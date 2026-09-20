# archstrict.config.ts

Written as a plain TypeScript value satisfying the generated `Config` type (`archstrict.generated.ts`, itself rewritten by every `archstrict init`). One root file - shape is never scattered per module, the same choice archspec, deptrac, import-linter, dependency-cruiser, eslint-plugin-boundaries, and Nx's `depConstraints` all make.

```ts
import type { Config } from "./archstrict.generated.js";

export default {
  surface: "index.ts",
  exclude: ["*.ts"],
  classify: [{ glob: "src/**", tags: ["kind:flat"] }],
  declaredModules: [
    { name: "app", glob: "src/app/**", surface: "index.ts" },
    { name: "shared", glob: "src/shared/**", surface: "index.ts" },
  ],
  because: "flat preset: every module under the glob is one kind, checked for its public surface and cycles",
} satisfies Config;
```

`declaredModules` is the only source of module boundaries - `check`/`todo` never discover modules from directory structure at runtime; only `archstrict init`'s own one-time walk does, to suggest what to declare. A file matching no `declaredModules` entry is `outsideFiles` (metric) and an `uncovered-module` violation (rule 3) unless it's `exclude`d.

Fields:

- **`scope`** (optional) - typed on `Config`, but not yet read by any rule or verb; declaring it has no effect on what `classify`, `declaredModules`, or the constraint engine see. Wiring it in (an analysis boundary narrower than the whole project) is real, not-yet-done work, not a decision that was made and reversed.
- **`exclude`** (optional) - glob patterns kept out of analysis entirely: not a module member, not an edge source, not an edge target, not counted as `outsideFiles` either. `init` always writes `["*.ts"]` (this project's own root-level `archstrict.config.ts`/`archstrict.generated.ts`) - a real project's own loose files (outside every module directory) need their own `exclude` entry, or their own `declaredModules` entry, since `init` can't decide that on a project's behalf.
- **`surface`** (optional, default `"index.ts"`) - the public-surface file name every module is checked against. Not fixed by the tool: a project names its own. A `declaredModules` entry's own `surface` can override this per module, and can itself be a glob (a module's public surface can be more than one file).
- **`declaredModules`** (required) - `{ name, glob, surface }[]`, the source of truth for module boundaries. Replaces v0's index.ts-presence discovery (measured wrong: a barrel `index.ts` is not evidence of an enforced boundary, in NestJS's or Drizzle's own real code).
- **`classify`** (optional) - `{ glob, tags }[]`, glob -> tags, most-specific-glob-wins (longest literal prefix, then fewest wildcards; a tie between two equally-specific entries naming different tags for the same file is a config error). Independent of `declaredModules` - tags classify any file in scope, whether or not it belongs to a declared module.
- **`classifyByDirectoryName`** (optional) - `{ tagNamespace, names }`, ambient tagging by directory-name segment (VS Code's `code-layering.ts` convention): the nearest path segment matching one of `names`, walking from the file outward, becomes `${tagNamespace}:${name}`. Independent of `classify` - a file can carry tags from both mechanisms at once; their results union.
- **`edges`** (optional) - the constraint engine (rule 7: `tag-boundary`/`tag-order`/`point-rule`), each shape generalizing rules 1/2's fixed module vocabulary to tags. See [rules.md](rules.md#7-tag-boundary--tag-order--point-rule-the-constraint-engine) for the full shape of `allowDeny`, `order`, and `point`, and what each one's violation looks like.
- **`deprecated`** (optional) - `{ from, to, count, because }[]`, a `from -> to` module edge whose actual count must never increase. `because` is mandatory: a deprecated edge names a real design tradeoff, and a root-level rule with no stated reason is a decision no future reader can judge.
- **`strict`** (optional) - module names whose todo file may only shrink, never gain a new entry, not even on `todo`'s first run. `check` reports any existing entry in a strict module's todo as its own violation (`clean-module-has-todo`) - marking a module strict never hides a violation, old or new.
- **`ignoredCycles`** (optional) - `readonly [string, string][]`, e.g. `[["a", "b"]]`. Names any two modules of a known cycle, in either order; exempts the whole strongly-connected component they belong to from rule 2 (`cycle`), not just that one edge. A pair matching no real cycle at all is itself flagged (`stale-cycle-exception`) - remove it rather than leave it.
- **`mustBeEmpty`** (optional) - `{ glob, because }[]`. A directory a project decided must hold no code at all (archspec's own "empty component" idea). A violation is any file matching the glob - zero matches is a clean pass, not silence. The glob is project-root-relative. See [rules.md](rules.md#must-be-empty).
- **`because`** (required) - the config's own reason for its shape as a whole (the preset choice, the module boundaries). Same reasoning as `deprecated`'s own `because`: a decision with no stated reason is one nobody later can judge.

A `classify` glob matching zero real files, or zero `declaredModules` entries at all, is a reported violation (rule 4, `empty-rule-set`), not a thrown error - `check` still runs and reports everything else it can. A `deprecated` entry naming a module that doesn't exist is a thrown config error, validated up front before any rule runs. An `order` rule's `sequence` missing a layer value classify actually assigns within a scope it does cover is also a thrown config error, but checked lazily instead - only once `checkOrder` walks an edge that actually carries the missing value, not before any rule runs.
