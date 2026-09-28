# Re-architecture workflow

Use this workflow after adoption has made `archstrict check` clean by freezing known debt.

1. Run `archstrict hotspots`. Start with a high-score module or a boundary hotspot pair. The score is commits times fan-in. A pair is a boundary hotspot when it has a current module edge and at least one directional co-change share is 50% or more.
2. Read the candidate's frozen debt and active violations by rule. Follow the imports behind those counts. Name one move: extract a shared contract into a module with one surface, route importers through a narrow surface, invert a dependency behind an interface owned by the stable side, merge code that changes together, or split code that changes for unrelated reasons.
3. State the expected numeric effect before editing. Name the score, fan-in, debt count, or pair share that should decrease.
4. Run `archstrict simulate` with the planned source and config changes. Check the result for a new cycle or violation before writing files.
5. Make the move in small steps. After each step, run the project's tests and `archstrict check`. Run `archstrict todo` to prune fixed entries. A later todo run must not add entries. Record the verified reason in the config rule's `because` field.
6. Run `archstrict hotspots` again. Compare the candidate's score, fan-in, debt, and pair shares with the expected effect.

## Worked example

A CLI module has 30 commits and fan-in 6, so its score is 180. Library modules import its output contracts. Its todo owns 20 `public-surface-bypass` entries, and the CLI and command-support modules co-change in 8 of the CLI's 10 relevant commits and 8 of command-support's 12 commits.

Extract the output contracts and shared command helpers into a new module with one public surface. Before editing, simulate the moved files, new surface, and changed imports. The expected result is fan-in 3 for the CLI, a score of 90 at the same commit count, and 16 fewer frozen entries. Apply the move in small steps and run the tests, check, and todo after each step. In one trial, frozen debt changed from 444 to 428 and CLI fan-in changed from 6 to 3. The final hotspots run confirms whether the dependency and co-change evidence moved with the code.
