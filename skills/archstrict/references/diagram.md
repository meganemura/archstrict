# Draw the config with `archstrict diagram`

Run `archstrict diagram [--format mermaid|markdown] [--direction TB|BT|LR|RL] [--detail names|rules|reasons] [--focus <module>] [--json]` from the project root.
It prints a Mermaid flowchart of `archstrict.config.ts` on stdout and writes no file.
Redirect the output to keep it: `archstrict diagram --format markdown > docs/architecture.md`.
The command reads the config and the names of the analyzed files, the walk `check` starts from.
It builds no import graph, so it does not show which imports exist, only what the config forbids or allows.

## What is drawn

| In `archstrict.config.ts` | In the diagram |
| --- | --- |
| `declaredModules[]` | One box per module, named in bold. At `--detail rules` and `reasons` it also lists the glob, a `surface:` line only when the surface differs from the project default (`surface: none` for `[]`), and one `friend:` line per friend. |
| the first `edges.order` rule without `within` | One box per sequence value, highest (last) first, holding the modules whose files all carry that tag. Thick gray arrows chain each layer to the next one below. A module whose files carry several values, or some none, sits outside the boxes with a line such as `layer: kernel, sql, (none)`. |
| a later `order` rule, or one with `within` | A note that lists its sequence, lowest first. |
| a tag, a glob, or a tag predicate that a rule names | A dashed pill with its text and the modules that hold a matching file: `4 modules: a, b (2/5 files)`. Past 10 modules it lists 10 and counts the rest. A pill that matches no file reads `0 modules` and is faded, which is how a mistyped tag shows. A tag that is a layer value uses the layer box. A glob equal to one module's glob uses that module's box. |
| `pkg:<name>` targets and `allowDeny` entries in the `pkg` namespace | A red hexagon. Packages of one link kind, source, and qualifier share a hexagon, and hexagons with equal name lists are one node. |
| `allowDeny` `deny` and `point` | A red dashed arrow ending in a cross, labelled `cannot use`. |
| `allowDeny` `allow` | A green arrow to each allowed value, labelled `only <namespace>`. |
| `allowDeny` `exceptions` | An amber dotted arrow between the two globs, labelled `exempt`. |
| `ignoredCycles` | A dotted gray arrow with two heads, labelled `known cycle`. |
| `deprecated` | A dashed orange arrow, labelled `deprecated, at most N`. |
| `mustBeEmpty` | A faded dashed box with the glob and `must be empty`. |
| `because` | Only at `--detail reasons`: appended to arrow labels as `: <because>`, set as an italic line in notes, and the project `because` becomes a note. |

An `edgeType` or `importForm` other than `both` always shows on the label, as `(value)`, `(type)`, `(static)`, `(dynamic)`, or a pair such as `(value, static)`.
A layer rule's qualifier goes in each layer title instead.
`exclude`, `strict`, `schemaVersion`, and the `surface` default are not drawn.
A `deprecated` or `ignoredCycles` entry that names an undeclared module is left out; `check` reports it.

## How to read it

An arrow joins sets of files, not modules.
Tags belong to files, and one module glob can hold files of several layers, so a module-to-module arrow would claim a ban the config never wrote.
A pill or layer box names the modules it covers, and `(n/m files)` marks a module where only n of its m files match.

Three facts the arrows cannot carry, printed under the legend of `--format markdown`:

- An allow list also forbids every other value of its tag namespace.
- An `allowDeny` rule judges only a target that has a tag in its namespace.
- A target that also carries the source tag is exempt from an `allowDeny` rule.

A layer may use any layer below it and never one above, not only the adjacent one.
The diagram depends on the file tree as well as the config, so a new file can change a member list.

## Options

- `--format markdown` prints `## <project directory> architecture`, a fenced `mermaid` block, a legend table of the arrow and node kinds that appear, and the facts above.
- `--direction` is the Mermaid flow direction. The default is `TB`, which draws the highest layer on top.
- `--detail names` keeps names, layers, selector text, and arrows without reasons. `rules` is the default. `reasons` adds every `because`.
- `--focus <module>` keeps that module, every selector that holds one of its files, the links that touch the module or one of those selectors, and the other end of each link. The layer stack stays whole, with the other modules dropped, when the module or a kept link touches it. An unknown name fails with a `do:` line that lists the declared modules.
- `--json` prints `configPath`, `format`, `direction`, `detail`, `focus`, `text` (the document), `modules` (`name`, `node`, `layer`, `tags`), `layers`, `selectors` (`node`, `kind`, `text`, `members`), `packages`, `links` (`kind`, `from`, `to` as node ids, `rule` as a config pointer such as `edges.point[3]`, `qualifier`, `because`, and `packages` for a hexagon), and `legend`. An agent can ask which modules a selector covers without parsing Mermaid.

A config or usage failure exits 1 and prints a `do:` line, as every verb does.
