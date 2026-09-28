# Reading recommend's output

`archstrict recommend [dir] [--json]` proposes boundaries from the real
import graph: without a config it previews `init`'s own walk in memory (no
file written); with one, it proposes from the declared modules instead.
Read [patterns.md](patterns.md) first for what each detected pattern's own
config looks like, and [config.md](config.md) for `surface`'s exact
semantics.

## `patternProposals`

At most 5 proposals, ranked by evidence - a project with more detectable
shapes than that sees only its strongest-evidenced ones. `detected` on the
top-level result is the count before that cut, so a capped list never reads
as "nothing else was found." Ranking is not `support` alone: a proposal with
almost no real evidence behind it (one importer, one edge) can still reach a
clean `support` of 1, so the rank shrinks `support` toward 0 by how little
evidence backs it - a real, mostly-clean fit backed by hundreds of edges
outranks a trivially clean one backed by a single edge, even though the
trivial one's own `support` field reads higher. `support` itself is
unchanged by this: it always reports the plain fraction, not the rank.
Each proposal carries:

- `pattern` - a stable id: `layered-order`, `app-over-library`, `leaf-kernel`,
  `external-package-confined`, `test-code-isolation`, `public-entry-only`,
  `host-plugin-inversion`, `feature-isolation`.
- `support` - 0 to 1, the fraction of the pattern's own measured evidence
  that agrees with it. A `layered-order` proposal with three modules and
  one reverse edge among otherwise-unanimous real edges reports well below
  1, not a bare pass/fail.
- `evidence` - the real edge counts behind the proposal, in numbers (for
  example "3 of 4 directed edges between them match this order") - complete
  in JSON; a name list past 5 entries truncates to "+N more" in text only.
- `configFragment` - a pasteable `classify`/`edges` (or `declaredModules`)
  snippet, with a `because` drawn from the same evidence. When one group
  covers every module but a small, named few (app over library, a package
  confined to one area, test code kept out of production), `classify` is
  one catch-all `"**"` glob for the default tag plus one entry per named
  module - not one entry per module on the default side.
- `addedViolations` - how many violations of this proposal's own rule id
  the rule pipeline reports today, run in memory against the real graph.
  0 means no real edge violates it yet - not "safe to adopt blindly."
- `do` - [prove-rules.md](prove-rules.md)'s own positive-control workflow,
  or, for `public-entry-only` (which adds no new rule, only narrows an
  existing one), the command to see which `public-surface-bypass`
  violations the proposed surfaces would retire.

Detection reads real edges between declared modules; it never guesses from
a project's framework or its `package.json` dependencies. A pair with no
directional evidence, or a set of modules whose real edges cycle instead of
order, is left out rather than forced into a proposal.

## `surfaceProposals`

One entry per declared module with no public surface file present today and
at least one real external importer - complete in JSON; text shows the top
5 modules and a "+N more" note past that. `candidates` ranks every file
other modules actually import from it, densest first, by distinct importer
count - complete in JSON, truncated to the top 3 per shown module in text.
`proposedSurface` is the smallest ranked prefix covering at least 80% of the
module's own real imports (`coveredImports` of `totalImports`,
`remainingImports` left over), offered as a `surface` value to paste into
that module's `declaredModules` entry. `choices` gives the same alternative
every surface-less module finding does: set the proposed `surface`, add a
barrel file naming a different real entry, or leave the module entirely
private and freeze its bypasses with `archstrict todo` - text prints these
three choices once for the whole section, then one module-specific `do:`
line per shown module (the `surface` edit); `choices` itself stays complete
per module in JSON.

## Reading a proposal before pasting it

1. Confirm the evidence against the tree itself - `evidence`'s own numbers
   should match what a quick read of the real imports shows.
2. Paste `configFragment` into `archstrict.config.ts`, then follow the
   proposal's own `do:` line: [prove-rules.md](prove-rules.md)'s positive
   control for a new `classify`/`edges` rule, or a plain `archstrict check`
   for a `surface` addition.
3. Only after the positive control fires under the expected rule id, treat
   a clean `archstrict check` as real - not before.
