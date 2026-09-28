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

## A second sample: the 200 most-starred TypeScript repositories

The first survey found repositories through code search for the vocabulary of
dedicated boundary tools, so it can only measure frequency among repositories
that already adopted one. A second survey, done on 2026-09-25, instead
sampled by popularity: the 200 most-starred public TypeScript repositories on
GitHub, independent of which tool (if any) each one uses. Four of the 200
already appeared in the first survey's own table (all four enforce a
boundary); the other 196 were checked by fetching each repository's full file
tree and reading every file that looked like a boundary-tool config, a
general lint config, or a hand-written checker script by name (files under
`scripts/`, `tools/`, or a lint-configuration directory whose name mentions a
boundary, a layer, a restriction, or an architecture check), plus the root
package manifest and build config.

**What counted.** A repository counts as enforcing a boundary when at least
one rule names two areas of the project and forbids or allows an edge
between them, or confines an external package or capability to one named
area - the same bar as the first survey. A cycle-detection-only rule, a
package-hygiene rule with a named single replacement everywhere, a
deprecation-only rule, or a build system's own per-target dependency
declarations with no layer table do not count on their own.

**Headline.** 52 of the 200 repositories (26%) enforce a boundary this way;
47 (24%) after setting aside five repositories whose only rule is a
load-path rule (see the new LOAD pattern below). About three quarters do
not.

Enforcement rises sharply with codebase size, counted by `.ts`/`.tsx` file
count (excluding generated declaration files):

| TypeScript files | Enforces a boundary |
|---|---|
| under 100 | 0 of 18 |
| 100 to 999 | 6 of 82 |
| 1,000 to 4,999 | 24 of 67 |
| 5,000 or more | 18 of 29 |

The median enforcing repository has about 3,000 TypeScript files; the median
non-enforcing repository has about 400. Several very large, popular
repositories in the sample enforce nothing found by this method at all -
star count and popularity do not predict enforcement; size does.

**The tool mix inverts.** In the first survey, dedicated tag-and-constraint
tools (a monorepo tool's own tag graph, a dependency-graph analysis tool, a
path-restriction rule, a boundary-specific linter plugin) carried almost
every rule. In this sample, those same tools carry only about an eighth of
the 48 enforcing repositories combined; a general-purpose linter's built-in
"forbid importing this path" rule carries about three fifths, and a checker
the project wrote for itself - its own script, its own rule table, its own
message text - carries most of the rest. One repository's own hand-written
checker reimplements a monorepo tool's tag-constraint idea from scratch,
including a hard-coded tag map and an allow-list per tag, without adopting
the tool itself.

**Per-pattern counts, both samples side by side.** Sample 1's denominator
below is 82 repositories, from the first survey's own repository-level
table. The method section above instead counts 72 configuration files with
a project-chosen rule, from a per-tool pass over the same
search results; the two numbers come from two different passes over the
same underlying search, and the per-pattern counts below use the
repository-level table's own 82. Sample 2's denominator is 48
repositories. A repository can count toward more than one pattern in
either sample.

| Pattern | Sample 1 (of 82) | Sample 2 (of 48) |
|---|---|---|
| Public-entry-only | 17 | **22** |
| Layered order | **34** | 10 |
| Runtime/platform environments | 23 | 13 |
| Feature isolation with a shared kernel | 20 | 2 |
| Leaf / pure kernel | 16 | 7 |
| External package confined to one area | 13 | 14 |
| Type-only exception | 5 | 10 |
| Test code kept out of production | 9 | 4 |
| Scope/domain isolation | 9 | 2 |
| Barrel-inverse | 5 | 3 |
| App vs lib | 5 | 2 |
| Hexagonal / clean | 5 | 2 |
| Two tag axes combined | 7 | 1 |
| Host/plugin inversion | 5 | 4 |
| Load-path isolation | no category in sample 1 | 8 |
| Edition split | no category in sample 1 | 2 |
| Composition root | no category in sample 1 | 2 |
| Friend list | no category in sample 1 | 1 |
| Entry-graph budget | no category in sample 1 | 1 |

**What the difference means.** The two samples measure different
populations, not the same population twice. Sample 1's method can only find
a repository that already picked a dedicated boundary tool and used its own
vocabulary: a tag, an element type, a zone. That selection over-represents
configurations built on a scaffold meant to make a layer ladder or a
feature-isolation rule cheap to write - those are exactly the shapes a
dedicated tool's own vocabulary makes easy to write. Sample 2, ordered by
popularity alone, shows what large, established codebases enforce
regardless of tooling choice. That turns out to be, overwhelmingly, a
generic "forbid this import path" rule or a hand-written script, aimed at
one entry point or one runtime split rather than a whole layer stack. Read
the layered-order and feature-isolation counts in the first survey as
evidence about repositories that adopted a layering tool. They are not
evidence that layering is the most common shape among popular TypeScript
codebases in general.

Sample 2 also surfaces a reason for a rule that sample 1's own method could
not have found under its own name: cost. Several repositories forbid a
statically-imported heavy or side-effecting module purely to keep it off an
eager load path (bundle size, startup time), not for an architectural
reason at all. The first survey's own search terms had no way to single
this reason out from an ordinary external-package rule.

**An independent baseline mechanism.** Three unrelated large repositories in
the second sample each built their own mechanism, separately, for a rule
that fails only when the count of known violations grows past a committed
baseline, or a grow-only list of accepted exceptions that may only get
longer, never shorter by editing it directly. None of the three call it by
the same name, and nothing suggests one copied another. This is an
observation about a real, independently-arrived-at idea for managing
existing boundary debt over time, not a documented convention any tool
ships - and it is the same shape, arrived at from a different direction, as
archstrict's own todo file: a frozen list that can only shrink.

**Tags from sources other than a directory name (observations, not counted
patterns).** Two repositories in the second sample derive a file's tag from
something other than its path: one reads a runtime tag off a fixed filename
suffix (a file whose name ends a certain way is browser-only, another
ending marks it Node-only, another marks a web-worker file) - archstrict
already expresses this today, since a `classify` glob can match a literal
suffix directly. The other reads a tag from a field in a package's own
manifest, independent of any path at all; archstrict does not read package
manifests for tags today, so this is noted as an observation, not a
supported mechanism.

**Limits.** This sample counts declared rules only, not the real import
graph: it says nothing about how often a rule actually fires, whether the
codebase's real edges already comply, or whether a project keeps its
boundary by convention with no rule enforcing it at all (invisible to this
method either way). A rule living under an unexpected file name, inside a
CI configuration file, or inside a shared configuration package more than a
few directories deep could be missed; the "no rule found" count is a lower
bound, not a proof of absence. Per-package export maps and TypeScript
project references were not read as a source of boundary evidence in this
sample. As with the first survey, a count here is a frequency within this
sample, not a share of all public TypeScript code.

## What real import graphs keep

Both samples above read declared configuration files, not the code itself. A
third pass, done on 2026-09-25, instead measured the real import graph of the
50 most-starred public TypeScript repositories (star order; 5 skipped for not
qualifying as a real codebase, one not measured because analysis ran out of
memory), independent of whether each one declares any rule at all. Two of the
50 already appear by name elsewhere in this document (VS Code, in the sample
below) - every other repository is described only by size and shape, per this
project's own policy on naming other codebases.

**Method.** Each repository was cloned once, shallow (`--depth 1`); nothing
from it was installed, built, or run. To make a workspace's own internal
packages resolvable without running an install, `node_modules/<name>` was
symlinked to each package directory a repository's own manifest named;
third-party packages stayed unresolved throughout. A monorepo got one module
per workspace package; every other repository used archstrict's own init-walk
(one module per directory holding `.ts` under `src/` or the project root). A
production graph drops every edge whose importing file is test code, since a
test file importing a sibling package as a fixture is not the same claim as
production code doing it; cycles and layering are measured on this production,
value-import graph, with type-only imports counted as a separate, second
question rather than folded into the same count.

**Counts, with the declaring subset.**

| Pattern | Kept in the graph (of 50) | Of those, declares a rule |
|---|---|---|
| Layered order | 14 | 2 |
| Runtime/platform environments | 12 | 2 |
| Feature isolation with a shared kernel | 11 | 3 |
| Public entry only | 2 | 1 |
| Leaf / pure kernel | 14 | 3 |
| External package confined to one area | 43 | 9 |
| App vs lib | 5 | 0 |
| Test code kept out of production | 30 | 4 |
| Host/plugin inversion | 10 | 2 |

About 9 of the 50 declare any internal boundary rule at all, read by hand from
each repository's own root configuration files.

**The key contrast.** Public-entry-only was the single most-declared pattern
in the star-ordered sample of declared configs (22 of 48 repositories that
declare anything). In the real graph, it holds for only 2 of these 50
repositories - a config declaring it is enforcing something the graph does
not keep on its own as a byproduct of ordinary code organization. External-
package confinement (43 of 50) and test separation (30 of 50) are the
opposite case: the most common shapes the graph already keeps, whether or not
any config exists to say so.

**Shapes not on the pattern list above.**

- **Test code folds a clean layering into one cycle.** In 15 of the 50
  repositories, more modules sit inside a value-import cycle once test files
  count than in the production graph alone - a 329-module repository went
  from 0 modules in cycles to 46; an 84-module repository went from 0 to 2;
  VS Code went from 4 to 6 of its 10 modules. A test file importing a sibling
  package as a fixture is the usual cause; judging layering on the production
  graph, not the whole-file graph, avoids counting that as a real reverse
  dependency.
- **One stray import turns an ordered pair into a mutual cycle.** 17 of the
  50 repositories have a two-module cycle in production code, and it is
  usually lopsided rather than balanced: VS Code's own two largest modules
  pair 951 edges one way against 1 the other; a small repository's
  configuration file and its library pairing showed 1 edge against 48; a
  12-module repository showed two directories pairing 1 edge against 9. One
  direction is the intended dependency; the handful of reverse edges read as
  the exceptions worth removing, not evidence the pair has no order at all.
- **Type-only imports add back edges a value-only reading misses.** In 8 of
  the 50 repositories, counting type-only imports puts more modules inside a
  cycle than counting value imports alone: an 85-module repository went from
  4 modules in cycles to 73; a 9-module repository went from 0 to 3; a
  31-module repository went from 10 to 12.
- **Nearly disconnected workspaces.** 14 of the 50 repositories with at least
  5 modules have at most one real production dependency for every two
  modules: a 10-module repository had 3 dependency pairs; a 12-module
  repository had 5; a 5-module repository had none at all.
- **One large cycle instead of a layer order.** 9 of the 50 repositories have
  a single production value cycle covering at least 30% of their modules (a
  19-module repository with 12 of them in one cycle; a 9-module repository
  with 3; a 21-module repository with 8); at this granularity these
  repositories show no layered order to propose at all.

**Limits.** One commit per repository, from a shallow clone with no history -
nothing here says whether a kept shape is a real, ongoing decision or a
snapshot of one moment. Only `.ts` files were parsed at the time of this
measurement; a repository where `.tsx` outnumbers `.ts` has a graph that
omits most of its UI code. Third-party imports were never resolved, so
external-package confinement reads the specifier text a file wrote, and an
unresolved path alias could be miscounted as a package. Granularity is a
choice archstrict's own init-walk makes, and a different granularity would
draw different module boundaries and could shift which patterns are visible
at all. Every threshold above is this survey's own choice, not a bar drawn by
any measured project; the per-repository numbers this survey produced allow
a different threshold to be applied later. Intent is always inferred from
structure, never confirmed by asking anyone who wrote the code.

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
