# A survey of existing boundary-checking configurations, and why archstrict does not ship a preset

This records a survey of existing boundary-checking configurations in
public repositories, done to answer one question: does archstrict need a
`--preset` flag? The answer is no. The survey's own findings became
[skills/archstrict/references/patterns.md](../skills/archstrict/references/patterns.md)
instead - a reference an agent reads before proposing a config, not code
that runs automatically.

## Method

The survey searched public code for existing boundary-checking
configuration files and read every one it kept. About 1,090 distinct
repositories came back across several targeted search queries; each got a
star count. A repository qualified to keep reading its config at 300 stars
from a general search query, or 100 stars from a query that already
selects for a real, chosen tag vocabulary (so the bar could be lower there
and still surface more than a handful). A tool's own source, its
documentation, its fixtures, and its tutorials were dropped, along with
one malformed config. Every kept configuration file was fetched and read
in full: 113 configuration files, of which 72 carried a real, project-
specific rule.

**What was counted.** A rule counts once per repository, by which shape it
expresses (a layer order, a runtime-environment split, a feature isolation
rule, and so on - fourteen shapes emerged, twelve of them expected going
in, two found only once the configs were actually read). A single
repository can count toward more than one shape; most real configurations
mix two to four of them.

**Two biases, both worth stating plainly.**

- **Most configuration files carry no project decision at all.** Across
  the sample: a config-generating tool's own tag family, read in the
  general query, was carrying its own scaffold's no-op rule (a wildcard
  matching everything, added by the generator and never edited) in three
  out of every four repositories that had one at all. A dependency-graph
  tool's own default preset, applied by its own init command and left
  untouched, accounted for a similar share of that tool's own configs. The
  mere presence of a boundary tool in a repository is weak evidence of a
  chosen pattern; the counts below come only from configs that carried a
  real, hand-written rule.
- **Search results are ordered by relevance, not by stars, and only the
  first page is visible.** The counts below are frequencies within this
  sample, not frequencies in the population of all public repositories.
  Read a count as "common", "uncommon", or "rare" - not as a percentage.
- **A third, smaller bias:** several of the richest, most clearly
  commented configurations in the sample were recent, with self-
  describing rule names and dated comments, and plausibly written with an
  agent's help. They still show a real, chosen boundary - a comment
  explaining a rule is evidence of intent regardless of who wrote the
  comment.

## Pattern counts

| Pattern | Repositories | Evidence strength |
|---|---|---|
| Layered order (downward only) | 34 | strong |
| Runtime/platform environments | 23 | strong |
| Feature isolation with a shared kernel | 20 | strong |
| Public-entry-only (no deep imports) | 17 | strong |
| Leaf / pure kernel | 16 | strong (not anticipated before the survey) |
| External package confined to one area | 13 | medium (not anticipated before the survey) |
| Test code not imported by production code | 9 project-chosen, 10 more inherited from a tool's own default preset | medium; mostly inherited, not chosen |
| Domain/scope isolation | 9, plus one studied, unsurveyed real config (Prisma) | medium, seen only in one tag-based monorepo tool's own convention |
| Two tag axes combined | 7, plus the same studied config (three axes) | medium, seen only in that same tool family |
| App vs lib | 5 | thin as its own explicit rule; often implicit instead |
| Hexagonal / clean architecture | 5, one more partial | thin; every repository using it had well under 3,000 stars |
| Barrel-inverse (must not import own barrel) | 5 | thin but consistent in what it says |
| Type-only exception | 5 | thin; a modifier on another pattern, not a pattern of its own |
| Host/plugin inversion | 5 | thin |

## What each pattern's vocabulary and rule shape typically look like

Public-entry-only is the strongest single piece of evidence for
archstrict's own core model - a module as one directory, shown to the rest
of the codebase through one named surface file. The entry file name varies
across the sample (`index.ts` most often, then `public.ts`, `facade.ts`,
`contracts.ts`, one file per subpath export, or the package name itself
through a build alias) - which is exactly why archstrict's own `surface`
field is configurable per project and per module, rather than fixed to
`index.ts`.

A layered order is almost always one entry per layer, naming every layer
at or below itself as allowed - expressed either as an allow list (a
monorepo tool's own tag convention) or as a deny list naming everything
above (a dependency-graph tool, a path-restriction rule). A runtime-
environment split almost always exempts one directory (`common`,
`shared`) that every environment may use, and that itself may use
nothing else. Feature isolation is almost always two rules together: a
feature may not import a sibling feature, and the shared kernel may not
import any feature - composition happens one level up, in a router or an
app shell. A leaf/pure kernel is simpler than a full layer order and is
often the only rule a small project has at all: one directory that
imports nothing outside itself. An external-package-confined rule targets
an npm package or a node built-in by name, not an internal directory - the
same shape as an internal boundary, aimed outward instead of inward.

Domain isolation and its two-axis combination were both seen only inside
one tag-based monorepo tool's own tagging convention in this sample (and
in one further, separately studied real configuration, Prisma's own
`architecture.config.json`, which combines a domain axis, a layer axis
scoped per domain, and a third "plane" axis). Evidence for this shape
outside that one tool family is thin. Hexagonal/clean architecture,
barrel-inverse, the type-only exception, host/plugin inversion, and app-
vs-lib-as-an-explicit-rule are each real but thin: five or fewer
repositories each, and (for hexagonal specifically) every one under 3,000
stars. A proposal built on one of these five should say plainly that the
evidence for it is thin.

## The decision: a reference for agents, not a preset

archstrict does not ship a `--preset` flag, and `init`/`recommend` never
apply one of these patterns automatically. Instead, this survey's own
findings became a skill reference
([skills/archstrict/references/patterns.md](../skills/archstrict/references/patterns.md)):
recognition cues (directory names, file names, import evidence) and a
tested, real archstrict config for each pattern, meant for an agent to
read before proposing a config to a project - never applied without a
human or an agent looking at the project's own tree first.

The reason is what archstrict itself is: a general tag-and-constraint
engine over `classify`/`classifyByDirectoryName` and `edges`
(`allowDeny`/`order`/`point`), not a tool with a fixed vocabulary of
layers or domains built in. A preset fixes a vocabulary - `type:app`,
`scope:shared`, `domain:core`, whatever a preset author chose - and a
project whose own real shape does not match that vocabulary either
distorts its own directory names to fit the preset, or abandons the
preset's own rules while keeping its scaffold (exactly the "scaffold, no
project decision" case this survey measured so often). A pattern an agent
proposes from a project's own observed layout, in the project's own
vocabulary, keeps the engine general while still giving every project the
benefit of a name for the shape it already has.
