# archstrict.config.ts

Written as a plain TypeScript value satisfying the generated `Config` type (`archstrict.generated.ts`, itself rewritten by every `archstrict init`). One root file - shape is never scattered per module, the same choice archspec, deptrac, import-linter, dependency-cruiser, eslint-plugin-boundaries, and Nx's `depConstraints` all make.

```ts
import type { Config } from "./archstrict.generated.js";

export default {
  modules: "src/*",
  surface: "index.ts",
  kinds: { flat: "src/*" },
  because: "flat preset: every module under the glob is one kind, checked for its public surface and cycles",
} satisfies Config;
```

Fields:

- **`modules`** (required) - the modules glob, e.g. `"src/*"`. v0 supports exactly one shape: a single fixed prefix directory whose immediate children are modules. Anything deeper (`"src/features/*"`) or a non-`*` glob is out of scope.
- **`surface`** (optional, default `"index.ts"`) - the public-surface file name every module is checked against. Not fixed by the tool: a project names its own. `init` always writes the literal default rather than detecting an existing convention.
- **`kinds`** (required) - kind name -> path pattern. Exactly two pattern shapes are supported: the modules glob itself (matches every module - the `flat` preset's single catch-all kind), or `"<modules-root>/<exact-module-name>"` naming one module. Any other shape is a config error (thrown, not a rule violation) - `archstrict init`'s own generated flat preset only ever uses the first shape.
- **`layers`** (optional) - kind names, in the order layers are declared. Not yet enforced against `kinds` in v0.
- **`deprecated`** (optional) - `{ from, to, count, because }[]`, a `from -> to` module edge whose actual count must never increase. `because` is mandatory: a deprecated edge names a real design tradeoff, and a root-level rule with no stated reason is a decision no future reader can judge.
- **`strict`** (optional) - module names whose todo file may only shrink, never gain a new entry, not even on `todo`'s first run. `check` reports any existing entry in a strict module's todo as its own violation (`clean-module-has-todo`) - marking a module strict never hides a violation, old or new.
- **`because`** (required) - the config's own reason for its shape as a whole (the preset choice, the kind boundaries). Same reasoning as `deprecated`'s own `because`: a decision with no stated reason is one nobody later can judge.

An unsupported `kinds` pattern shape, or a `deprecated` entry naming a module that doesn't exist, is a thrown config error - both are validated up front, independent of which modules exist or which rule's loop happens to reach the offending entry first.
