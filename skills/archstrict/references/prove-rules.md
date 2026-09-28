# Prove that a new rule can report a violation

Run a positive control after you add or change a rule in `archstrict.config.ts`.
A clean result only has meaning after the rule reports the violation that it claims to prevent.

For each changed rule:

1. Choose one proposed file that must violate only the behavior you want to prove.
2. Send the complete proposed file content to `archstrict simulate --json`.
3. Find an `added` entry with the expected rule id.
4. Confirm that its `config.pointer` identifies the config entry you changed.
5. Fix the config rule when either assertion fails. Do not weaken the positive control.

The examples below use modules named `app`, `domain`, `ui`, and `core`.
Their surfaces are `index.ts`.
The config classifies files with `role:app`, `role:domain`, and the `layer:core`, `layer:domain`, and `layer:ui` values.

## allowDeny

This proposal must fire the `tag-boundary` rule whose source is `role:app` and whose deny list contains `domain`:

```sh
printf '%s\n' '{"changes":[{"path":"src/app/allow-deny-proof.ts","content":"import { value } from \"../domain/index.js\"; export const proof = value;\n"}]}' | archstrict simulate --json
```

Confirm that `added` contains `rule: "tag-boundary"` and a fired `config.pointer` of `edges.allowDeny[0].deny[0]`.

## order

This proposal makes the earlier `core` layer depend on the later `ui` layer:

```sh
printf '%s\n' '{"changes":[{"path":"src/core/order-proof.ts","content":"import { value } from \"../ui/index.js\"; export const proof = value;\n"}]}' | archstrict simulate --json
```

Confirm that `added` contains `rule: "tag-order"` and `config.pointer: "edges.order[0].sequence"`.

## point

This proposal creates the exact forbidden `src/app/**` to `src/core/internal.ts` edge:

```sh
printf '%s\n' '{"changes":[{"path":"src/app/point-proof.ts","content":"import { hidden } from \"../core/internal.js\"; export const proof = hidden;\n"}]}' | archstrict simulate --json
```

Confirm that `added` contains `rule: "point-rule"` and `config.pointer: "edges.point[0]"`.

## declaredModules surface

This proposal reaches past the `domain` module's configured `index.ts` surface:

```sh
printf '%s\n' '{"changes":[{"path":"src/app/surface-proof.ts","content":"import { hidden } from \"../domain/internal.js\"; export const proof = hidden;\n"}]}' | archstrict simulate --json
```

Confirm that `added` contains `rule: "public-surface-bypass"` and `config.pointer: "declaredModules[1]"`.

Delete no files after these commands: simulation keeps every proposal in memory.
