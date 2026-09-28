# Re-architecture workflow

Use this workflow once adoption has made `archstrict check` clean, with every existing violation frozen by `archstrict todo`. It goes from "archstrict is adopted" to "here is the one move to make and its expected effect", with the evidence to prove the move worked.

## Steps

1. **Adopt and freeze.** `archstrict init`, then `archstrict check`, then `archstrict todo`. Prove any new `classify`/`edges` rule can fire, following [prove-rules.md](prove-rules.md), before freezing. A clean `check` with a frozen todo is the baseline every later step measures against.
2. **Run `archstrict hotspots [--since <ref>] [--json]`.** Each module carries a score (commits times fan-in), fan-in, fan-out, frozen debt by rule, and active violations by rule. Each pair carries a co-change count and both directional shares. A pair is a boundary hotspot when it crosses a current module edge and at least one directional share is 50% or more.
3. **Pick a candidate.** Start from the highest-score module, or the boundary-hotspot pair with the largest co-change share. A module with high score and heavy fan-in is changed often by code that depends on it. A boundary-hotspot pair is two modules that keep changing together across an edge that is supposed to keep them independent.
4. **Read the candidate's frozen debt.** `archstrict hotspots --json` reports `frozenDebtByRule` and `activeViolationsByRule` per module; `archstrict check --frozen --module <name>` lists each entry's rule, path, and evidence, marked `frozen: true`, through the same rule id and `do:` a live violation carries - no need to open `archstrict.todo.json` by hand. Read the imports behind the count: which files import the candidate, and through which rule (a surface bypass, an order violation, a cycle).
5. **Name the move, and state its expected numeric effect before editing.** Common moves:
   - Extract a shared contract into its own module with one surface, when other modules import it only for that contract.
   - Give a module a surface and route importers through it, step by step. A frozen bypass is keyed by its importing file, specifier, and target file, not by the evidence text, so adding the surface leaves every unmigrated importer's frozen entry matched. Migrate importers in as many steps as the change needs: each migrated import now targets the surface, and `todo` prunes its entry.
   - Invert a dependency behind an interface the stable side owns: pass the data or callback the unstable side needs as a parameter, instead of importing it.
   - Merge modules that always change together.
   - Split a module whose files change for unrelated reasons.
   Name the score, fan-in, debt count, or pair share the move should change, and the expected new value, before touching a file.
6. **Simulate the move before editing.** Build the change set (moved and edited files, any surface file, any config edit) and run `archstrict simulate --json` (or `--whole-project` when the move can affect a file it does not touch directly). Read `added` for a new cycle or violation the move would create. A move that looks safe from imports alone can still expose a cycle that was hidden behind the file being moved.
7. **Make the move in small steps.** After each step: the project's tests, `archstrict check` clean, `archstrict todo` (it must prune, and it must never add). Record the verified reason in the config's `because` field.
8. **Re-run `archstrict hotspots`.** Confirm the candidate's score, fan-in, debt, and pair shares moved the way step 5 predicted.

## Worked example

A CLI module has 119 commits and fan-in 6, for a score of 714. Three library modules import a shared output-writer and error-formatter from it, for output contracts unrelated to command parsing. Those edges own 7 order violations and 9 surface bypasses in the CLI's frozen debt. The CLI also co-changes with one of those library modules in 47 of its 119 commits, a 39.5%/79.7% directional share and a boundary-hotspot pair.

The move: extract the output-writer and error-formatter into a new module with one surface. Expected effect: the CLI's fan-in drops from 6 to 3, and roughly 16 frozen entries prune, since the extracted contract stops being CLI-owned and its former importers now depend on the new module's surface instead.

Simulating the move first shows no new cycle. The move applies in one step: create the new module and its surface, move the two files, update every importer to use the new surface, add the module to `declaredModules`, and record the measured importer count and rule counts in its `because`. Tests pass, `check` stays clean, and `todo` prunes with nothing added.

Measured result: frozen debt went from 444 to 428, and the CLI's fan-in went from 6 to 3. A later `archstrict hotspots` run shows the extracted module's own fan-in at 4 and fan-out at 0, confirming the dependency moved with the code instead of merely being renamed.

## Pitfalls

- **A move can expose a hidden cycle.** One planned move was moving a single file out of a hot module and behind a new surface. The file's own imports looked ordinary: type-only dependencies on two modules, and one value import from a third. Simulating the full change set reported a new cycle fingerprint the move would create: one of the file's own dependencies already imported services back from a module the move would newly route through. `archstrict simulate` found that fingerprint before any file changed, so step 6 caught it ahead of step 7. The move waited for a fix to the exposed cycle.
- **Breaking a cycle can require injecting a dependency first.** In a separate case, two modules depended on each other in both directions: one called a lookup function owned by the other, and the other separately imported a cleanup function the first module owned. The fix moved zero files. The function on the calling side took the data it needed as a parameter from its own caller, which already had that data on hand. The cleanup function moved to the module that already owned the resource it cleaned up. That change alone turned four frozen entries stale; `archstrict todo` pruned all four and added none, taking frozen debt from 428 to 424, before the originally planned move even started.
