// Responsibility: draw archstrict.config.ts as a Mermaid flowchart from the config and file names.
// Boundary: no import graph, no TypeScript program, no writes. Meaning is diagram-model.ts and
// Mermaid syntax is diagram-mermaid.ts.
import { basename, resolve } from "node:path";
import { classifyFile } from "../classify.js";
import { DEFAULT_SURFACE, listAnalyzedFiles, moduleForDeclaredFile, toProjectRelativePosix } from "../module-graph.js";
import { loadConfig } from "./check.js";
import { buildDiagramModel, describeQualifier, focusModel, type FileRow, type LinkKind } from "./diagram-model.js";
import { renderDiagram, renderMarkdown, type DiagramDetail, type DiagramDirection } from "./diagram-mermaid.js";

export type { DiagramDetail, DiagramDirection } from "./diagram-mermaid.js";
export type { LinkKind } from "./diagram-model.js";
export type DiagramFormat = "mermaid" | "markdown";

export type DiagramOptions = {
  format: DiagramFormat;
  direction: DiagramDirection;
  detail: DiagramDetail;
  focus?: string;
};

export type DiagramResult = {
  configPath: string;
  format: DiagramFormat;
  direction: DiagramDirection;
  detail: DiagramDetail;
  focus: string | null;
  text: string;
  modules: { name: string; node: string; layer: string | null; tags: string[] }[];
  layers: { node: string; tag: string }[];
  selectors: { node: string; kind: "tag" | "glob" | "predicate"; text: string; members: { module: string; files: number; of: number }[] }[];
  packages: { node: string; names: string[] }[];
  links: {
    kind: LinkKind;
    from: string;
    to: string;
    rule: string;
    qualifier: string | null;
    because: string | null;
    packages: string[] | null;
  }[];
  legend: { look: string; meaning: string }[];
};

export async function diagram(projectRoot: string, options: DiagramOptions): Promise<DiagramResult> {
  const configPath = resolve(projectRoot, "archstrict.config.ts");
  const config = await loadConfig(configPath, undefined, "archstrict check", "archstrict diagram");
  const declared = config.declaredModules ?? [];
  const files = listAnalyzedFiles(projectRoot, config.exclude ?? [], declared, config.surface ?? DEFAULT_SURFACE);
  const rows: FileRow[] = files.map((file) => {
    const rel = toProjectRelativePosix(file, projectRoot);
    return { rel, module: moduleForDeclaredFile(file, projectRoot, declared), tags: classifyFile(rel, config) };
  });

  const full = buildDiagramModel(config, rows);
  const model = options.focus === undefined ? full : focusModel(full, options.focus);
  const rendered = renderDiagram(model, options);
  const text = options.format === "markdown" ? renderMarkdown(basename(resolve(projectRoot)), rendered) : `${rendered.text}\n`;

  return {
    configPath,
    format: options.format,
    direction: options.direction,
    detail: options.detail,
    focus: options.focus ?? null,
    text,
    modules: model.modules.map((module) => ({ name: module.name, node: module.id, layer: module.layer, tags: [...module.tags] })),
    layers: (model.stack?.layers ?? []).map((layer) => ({ node: layer.id, tag: `${model.stack!.namespace}:${layer.value}` })),
    selectors: model.selectors.map((selector) => ({
      node: selector.id,
      kind: selector.kind,
      text: selector.text,
      members: selector.members.map((member) => ({ module: member.module, files: member.files, of: member.of })),
    })),
    packages: model.packageSets.map((set) => ({ node: set.id, names: [...set.names] })),
    links: model.links.map((link) => ({
      kind: link.kind,
      from: link.from,
      to: link.to,
      rule: link.rule,
      qualifier: describeQualifier(link.qualifier),
      because: link.because === "" ? null : link.because,
      packages: link.packages === null ? null : [...link.packages],
    })),
    legend: rendered.legend.map((row) => ({ look: row.look, meaning: row.meaning })),
  };
}

export function formatDiagramText(result: DiagramResult): string {
  return result.text;
}
