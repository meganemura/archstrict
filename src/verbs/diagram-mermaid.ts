// Responsibility: turn a diagram model into Mermaid flowchart text, a legend, and the markdown
// document around them. All Mermaid syntax lives here: ids, escaping, arrows, linkStyle, classDef.
// Boundary: no config and no archstrict semantics beyond what the model already decided. A link
// kind is one row of LINKS, so a new rule shape adds a kind in the model and a row here, not a
// branch in the renderer.
import { describeQualifier, type DiagramModel, type Link, type LinkKind, type Membership, type Note, type Qualifier, type SelectorNode } from "./diagram-model.js";

export type DiagramDirection = "TB" | "BT" | "LR" | "RL";
export type DiagramDetail = "names" | "rules" | "reasons";
export type RenderOptions = { readonly direction: DiagramDirection; readonly detail: DiagramDetail };

export type LegendRow = { readonly look: string; readonly meaning: string };
export type Rendered = { readonly text: string; readonly legend: readonly LegendRow[]; readonly notes: readonly string[] };

type LinkRow = {
  readonly arrow: string;
  readonly label: (link: Link) => string | null;
  readonly style: string;
  /** Whether a non-default edgeType/importForm goes on the label. */
  readonly qualified: boolean;
  /** Whether `--detail reasons` appends the rule's because to the label. */
  readonly reasons: boolean;
  readonly look: string;
  readonly meaning: string;
};

// The Record type makes a link kind without a row a compile error. The order of the rows is the
// order of the legend.
const LINKS: Record<LinkKind, LinkRow> = {
  layer: {
    arrow: "==>",
    label: () => null,
    style: "stroke:#868e96,stroke-width:3px",
    qualified: false,
    reasons: false,
    look: "thick gray arrow between layers",
    meaning: "a layer may use any layer below it, never one above",
  },
  allow: {
    arrow: "-->",
    label: (link) => `only ${link.subject}`,
    style: "stroke:#2f9e44,stroke-width:2px",
    qualified: true,
    reasons: true,
    look: "green arrow",
    meaning: "files in the source may use only the targets it points to within that tag namespace",
  },
  forbid: {
    arrow: "-.-x",
    label: () => "cannot use",
    style: "stroke:#e03131,stroke-width:1.5px,stroke-dasharray:5 4",
    qualified: true,
    reasons: true,
    look: "dashed red arrow ending in a cross",
    meaning: "files in the source must not import files or packages in the target",
  },
  exempt: {
    arrow: "-.->",
    label: () => "exempt",
    style: "stroke:#f08c00,stroke-width:1.5px,stroke-dasharray:2 3",
    qualified: false,
    reasons: true,
    look: "dotted amber arrow",
    meaning: "an allowDeny exception: that import is not judged by the rule",
  },
  cycle: {
    arrow: "<-.->",
    label: () => "known cycle",
    style: "stroke:#868e96,stroke-width:1.5px,stroke-dasharray:2 3",
    qualified: false,
    reasons: false,
    look: "dotted gray arrow with two heads",
    meaning: "a cycle between these modules that ignoredCycles exempts",
  },
  deprecated: {
    arrow: "-.->",
    label: (link) => `deprecated, at most ${link.subject}`,
    style: "stroke:#e8590c,stroke-width:1.5px,stroke-dasharray:5 4",
    qualified: false,
    reasons: true,
    look: "dashed orange arrow",
    meaning: "a module edge whose count must not grow",
  },
};

type NodeClass = "selector" | "empty" | "package" | "note";

const CLASS_DEFS: Record<NodeClass, string> = {
  selector: "fill:none,stroke-dasharray:4 3",
  empty: "stroke-dasharray:4 3,opacity:0.6",
  package: "fill:none,stroke:#e03131,color:#e03131",
  note: "fill:none,stroke-dasharray:2 2",
};

type NodeKind = "layer" | "selector" | "package" | "empty" | "note";

const NODES: Record<NodeKind, LegendRow> = {
  layer: {
    look: "labelled box around modules",
    meaning: "a layer of the order rule; a module sits in it when every one of its files carries that tag",
  },
  selector: {
    look: "dashed pill",
    meaning: "a set of files named by a tag, a glob, or a tag predicate; the list names the modules that hold them, and (n/m files) marks a module where only n of m files match",
  },
  package: { look: "red hexagon", meaning: "packages, by the name the rule uses; pkg:node is every Node builtin" },
  empty: { look: "faded dashed box", meaning: "a path that must hold no source file, or a selector that matches no file" },
  note: { look: "dashed note", meaning: "a rule the picture cannot draw as an arrow, or a reason" },
};

const MEMBER_LIMIT = 10;

const LINE_BREAK = /\r\n|[\n\v\f\r\u0085\u2028\u2029]/g;

const ESCAPES: Record<string, string> = { "&": "amp", "<": "lt", ">": "gt", '"': "quot", "#": "35", "`": "96" };

/**
 * Text inside ["..."] and edge labels: & < > " # ` become #amp; #lt; #gt; #quot; #35; #96;, and a
 * line break becomes a space. Backticks matter because a leading one turns a label into a
 * Mermaid markdown string.
 */
export function escapeLabel(text: string): string {
  return text
    .replace(LINE_BREAK, " ")
    .replace(/[&<>"#`]/g, (char) => `#${ESCAPES[char]!};`);
}

function suffixOf(qualifier: Qualifier): string {
  const described = describeQualifier(qualifier);
  return described === null ? "" : ` (${described})`;
}

function memberLine(members: readonly Membership[]): string {
  if (members.length === 0) return "0 modules";
  const shown = members.slice(0, MEMBER_LIMIT).map((m) => (m.files < m.of ? `${m.module} (${m.files}/${m.of} files)` : m.module));
  if (members.length > MEMBER_LIMIT) shown.push(`+${members.length - MEMBER_LIMIT} more`);
  return `${members.length} module${members.length === 1 ? "" : "s"}: ${shown.join(", ")}`;
}

function italicBecause(because: string): string {
  return `<i>because ${escapeLabel(because)}</i>`;
}

type Edge = { from: string; to: string; kind: LinkKind; label: string | null };

// Links with equal (from, to, kind, label, qualifier) are one arrow; their reasons join with "; ".
function mergeLinks(links: readonly Link[], detail: DiagramDetail): Edge[] {
  const groups = new Map<string, { link: Link; reasons: string[] }>();
  for (const link of links) {
    const row = LINKS[link.kind];
    const head = `${row.label(link) ?? ""}${row.qualified ? suffixOf(link.qualifier) : ""}`.trim();
    const key = [link.from, link.to, link.kind, head].join("\0");
    const group = groups.get(key) ?? { link, reasons: [] };
    if (row.reasons && link.because !== "" && !group.reasons.includes(link.because)) group.reasons.push(link.because);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, { link, reasons }]) => {
    const head = key.split("\0")[3]!;
    const because = detail === "reasons" && reasons.length > 0 ? reasons.join("; ") : "";
    const label = [head, because].filter((part) => part !== "").join(": ");
    return { from: link.from, to: link.to, kind: link.kind, label: label === "" ? null : label };
  });
}

function moduleLabel(module: DiagramModel["modules"][number], detail: DiagramDetail): string {
  const parts = [`<b>${escapeLabel(module.name)}</b>`];
  if (detail !== "names") {
    parts.push(...module.globs.map((glob) => `<small>${escapeLabel(glob)}</small>`));
    if (module.surface !== null) parts.push(`<small>surface: ${escapeLabel(module.surface.length === 0 ? "none" : module.surface.join(", "))}</small>`);
    parts.push(...module.friends.map((friend) => `<small>friend: ${escapeLabel(`${friend.from} -> ${friend.file}`)}</small>`));
    if (module.layer === null && module.stackValues.length > 0) {
      const values = [...module.stackValues, ...(module.stackGaps ? ["(none)"] : [])];
      parts.push(`<small>${escapeLabel(`layer: ${values.join(", ")}`)}</small>`);
    }
  }
  return parts.join("<br/>");
}

function selectorLine(selector: SelectorNode, detail: DiagramDetail): { line: string; klass: NodeClass } {
  const klass: NodeClass = selector.members.length === 0 ? "empty" : "selector";
  const members = detail === "names" ? "" : `<br/><small>${escapeLabel(memberLine(selector.members))}</small>`;
  return { line: `  ${selector.id}(["<b>${escapeLabel(selector.text)}</b>${members}"]):::${klass}`, klass };
}

function noteLabel(note: Note, detail: DiagramDetail): string | null {
  const suffix = suffixOf(note.qualifier);
  const reason = detail === "reasons" ? [italicBecause(note.because)] : [];
  if (note.kind === "project") return detail === "reasons" ? ["<b>project</b>", ...reason].join("<br/>") : null;
  if (note.kind === "stack") return detail === "reasons" ? [`<b>layer order${escapeLabel(suffix)}</b>`, ...reason].join("<br/>") : null;
  if (detail === "names") return null;
  return [`<b>order${escapeLabel(suffix)}</b>`, ...note.lines.map(escapeLabel), ...reason].join("<br/>");
}

// A fact the arrows cannot carry. It prints only when the diagram holds a rule it qualifies.
const SEMANTIC_NOTES: readonly { readonly applies: (links: readonly Link[]) => boolean; readonly text: string }[] = [
  { applies: (links) => links.some((link) => link.kind === "allow"), text: "An allow list also forbids every other value of its tag namespace." },
  {
    applies: (links) => links.some((link) => (link.kind === "allow" || link.kind === "forbid") && link.rule.startsWith("edges.allowDeny")),
    text: "An allowDeny rule judges only a target that carries a tag in its namespace, and a target that also carries the source tag is exempt.",
  },
  { applies: (links) => links.some((link) => link.kind !== "layer"), text: "Arrows join sets of files, not modules. A module appears in a list when it holds at least one matching file." },
];

export function renderDiagram(model: DiagramModel, options: RenderOptions): Rendered {
  const { detail } = options;
  const edges = mergeLinks(model.links, detail);
  const classes = new Set<NodeClass>();
  const nodeKinds = new Set<NodeKind>();
  const lines: string[] = [`flowchart ${options.direction}`];

  const moduleLine = (module: DiagramModel["modules"][number], indent: string): string =>
    `${indent}${module.id}["${moduleLabel(module, detail)}"]`;

  if (model.stack !== undefined) {
    nodeKinds.add("layer");
    const suffix = suffixOf(model.stack.qualifier);
    for (const layer of model.stack.layers) {
      lines.push(`  subgraph ${layer.id}["${escapeLabel(`${model.stack.namespace}: ${layer.value}${suffix}`)}"]`);
      for (const module of model.modules) if (module.layer === layer.value) lines.push(moduleLine(module, "    "));
      lines.push("  end");
    }
  }
  for (const module of model.modules) {
    if (model.stack === undefined || module.layer === null) lines.push(moduleLine(module, "  "));
  }
  for (const box of model.mustBeEmpty) {
    classes.add("empty");
    nodeKinds.add("empty");
    const reason = detail === "reasons" ? `<br/>${italicBecause(box.because)}` : "";
    lines.push(`  ${box.id}["<b>must be empty</b><br/><small>${escapeLabel(box.glob)}</small>${reason}"]:::empty`);
  }
  for (const selector of model.selectors) {
    const { line, klass } = selectorLine(selector, detail);
    classes.add(klass);
    nodeKinds.add(klass);
    lines.push(line);
  }
  for (const set of model.packageSets) {
    classes.add("package");
    nodeKinds.add("package");
    lines.push(`  ${set.id}{{"${escapeLabel(`pkg: ${set.names.join(", ")}`)}"}}:::package`);
  }
  for (const note of model.notes) {
    const label = noteLabel(note, detail);
    if (label === null) continue;
    classes.add("note");
    nodeKinds.add("note");
    lines.push(`  ${note.id}["${label}"]:::note`);
  }

  for (const edge of edges) {
    const label = edge.label === null ? "" : `|"${escapeLabel(edge.label)}"|`;
    lines.push(`  ${edge.from} ${LINKS[edge.kind].arrow}${label} ${edge.to}`);
  }
  const indicesByStyle = new Map<string, number[]>();
  edges.forEach((edge, index) => {
    const style = LINKS[edge.kind].style;
    indicesByStyle.set(style, [...(indicesByStyle.get(style) ?? []), index]);
  });
  for (const [style, indices] of indicesByStyle) lines.push(`  linkStyle ${indices.join(",")} ${style}`);
  for (const name of Object.keys(CLASS_DEFS) as NodeClass[]) if (classes.has(name)) lines.push(`  classDef ${name} ${CLASS_DEFS[name]}`);

  const presentKinds = new Set(edges.map((edge) => edge.kind));
  const legend: LegendRow[] = [
    ...(Object.keys(LINKS) as LinkKind[]).filter((kind) => presentKinds.has(kind)).map((kind) => ({ look: LINKS[kind].look, meaning: LINKS[kind].meaning })),
    ...(Object.keys(NODES) as NodeKind[]).filter((kind) => nodeKinds.has(kind)).map((kind) => NODES[kind]),
  ];
  const links = model.links.filter((link) => edges.some((edge) => edge.from === link.from && edge.to === link.to && edge.kind === link.kind));
  const notes = SEMANTIC_NOTES.filter((note) => note.applies(links)).map((note) => note.text);
  return { text: lines.join("\n"), legend, notes };
}

export function renderMarkdown(title: string, rendered: Rendered): string {
  const longestRun = Math.max(0, ...(rendered.text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const lines = [`## ${title.replace(LINE_BREAK, " ")} architecture`, "", `${fence}mermaid`, rendered.text, fence];
  if (rendered.legend.length > 0) {
    lines.push("", "| Look | Meaning |", "| --- | --- |", ...rendered.legend.map((row) => `| ${row.look} | ${row.meaning} |`));
  }
  if (rendered.notes.length > 0) lines.push("", ...rendered.notes.map((note) => `- ${note}`));
  return `${lines.join("\n")}\n`;
}
