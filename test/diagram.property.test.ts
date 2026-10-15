// Properties of the diagram over generated projects: escaping, edge integrity, layer and selector
// membership, focus as a subset, file-order independence, and that every rule is drawn.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { Config } from "../src/config.js";
import { escapeLabel, renderDiagram } from "../src/verbs/diagram-mermaid.js";
import { buildDiagramModel, focusModel, type FileRow } from "../src/verbs/diagram-model.js";

const UNESCAPES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "35": "#", "96": "`" };
const ENTITY = /#(amp|lt|gt|quot|35|96);/g;

const LAYERS = ["core", "mid", "top"] as const;
const PACKAGES = ["fs", "path", "@scope/pkg", "os"] as const;
const TAGS = ["io:pure", "io:effect", "kind:x", "layer:core", "layer:mid", "layer:top", "layer:ghost"] as const;
const EDGE_TYPES = ["value", "type", "both"] as const;
const IMPORT_FORMS = ["static", "dynamic", "both"] as const;

const subset = <T>(values: readonly T[], minSize = 1) =>
  gs.arrays(gs.sampledFrom([...values]), { minSize, maxSize: 3 }).map((picked) => [...new Set(picked)]);

type Project = { config: Config; rows: FileRow[] };

const project = gs.composite((tc): Project => {
  const moduleCount = tc.draw(gs.integers({ minValue: 1, maxValue: 5 }));
  const rows: FileRow[] = [];
  // A module nested under m0: the glob `src/m0/**` then matches files that another module owns.
  const nested = tc.draw(gs.booleans());
  if (nested) rows.push({ rel: "src/m0/sub/f0.ts", module: "nested", tags: new Set() });
  for (let m = 0; m < moduleCount; m++) {
    const fileCount = tc.draw(gs.integers({ minValue: 1, maxValue: 3 }));
    for (let f = 0; f < fileCount; f++) {
      const layer = tc.draw(gs.sampledFrom([...LAYERS, undefined]));
      const io = tc.draw(gs.sampledFrom(["io:pure", "io:effect", undefined] as const));
      const tags = [layer === undefined ? undefined : `layer:${layer}`, io].filter((tag): tag is string => tag !== undefined);
      rows.push({ rel: `src/m${m}/f${f}.ts`, module: `m${m}`, tags: new Set(tags) });
    }
  }
  const globs = Array.from({ length: moduleCount }, (_, m) => `src/m${m}/**`);
  const nestedModules = nested ? [{ name: "nested", glob: "src/m0/sub/**" }] : [];
  const predicate = gs.sampledFrom([
    ...TAGS.map((tag) => ({ tags: [tag] })),
    { tags: ["io:pure", "kind:x"] },
    { tags: ["io:pure"], exclude: { tags: ["layer:core"] } },
    ...globs,
    "src/m0/sub/**",
  ]);
  const allowDeny = tc.draw(
    gs.arrays(
      gs.composite((inner) => {
        const targetNamespace = inner.draw(gs.sampledFrom(["pkg", "layer", "io"] as const));
        const allows = inner.draw(gs.booleans());
        const values = inner.draw(subset(targetNamespace === "pkg" ? PACKAGES : targetNamespace === "layer" ? LAYERS : (["pure", "effect"] as const), allows ? 0 : 1));
        const exceptions = inner.draw(gs.arrays(gs.composite((last) => ({ from: last.draw(gs.sampledFrom(globs)), to: last.draw(gs.sampledFrom(globs)), because: "e" })), { maxSize: 2 }));
        return {
          source: inner.draw(gs.sampledFrom([...TAGS])),
          targetNamespace,
          ...(allows ? { allow: values } : { deny: values }),
          ...(exceptions.length > 0 ? { exceptions } : {}),
          edgeType: inner.draw(gs.sampledFrom([...EDGE_TYPES])),
          importForm: inner.draw(gs.sampledFrom([...IMPORT_FORMS])),
          because: inner.draw(gs.text({ maxSize: 8 })),
        };
      }),
      { maxSize: 3 },
    ),
  );
  const point = tc.draw(
    gs.arrays(
      gs.composite((inner) => {
        const from = inner.draw(predicate);
        return {
          from,
          to: inner.draw(gs.booleans()) ? from : inner.draw(gs.sampledFrom([{ tags: ["pkg:fs"] }, { tags: ["pkg:@scope/pkg"] }, { tags: ["io:pure"] }, ...globs])),
          edgeType: inner.draw(gs.sampledFrom([...EDGE_TYPES])),
          because: inner.draw(gs.text({ maxSize: 8 })),
        };
      }),
      { maxSize: 3 },
    ),
  );
  const ordered = tc.draw(gs.booleans());
  return {
    rows,
    config: {
      configPath: "<test>",
      because: tc.draw(gs.text({ maxSize: 8 })),
      declaredModules: [...globs.map((glob, m) => ({ name: `m${m}`, glob })), ...nestedModules],
      ignoredCycles: moduleCount > 1 ? [["m0", "m1"]] : [],
      mustBeEmpty: tc.draw(gs.booleans()) ? [{ glob: "src/none/**", because: "x" }] : [],
      edges: {
        allowDeny,
        point,
        order: ordered ? [{ tagNamespace: "layer", sequence: { "": [...LAYERS] }, direction: "downward-only", because: "x" }] : [],
      },
    } as Config,
  };
});

const OPTIONS = { direction: "TB", detail: "reasons" } as const;

const EDGE_LINE = /^ {2}(\w+) (?:==>|-->|-\.-x|-\.->|<-\.->)(?:\|"[^"]*"\|)? (\w+)$/;

function declaredIds(text: string): string[] {
  return [...text.matchAll(/^ {2,4}(?:subgraph )?(\w+)(?:\[|\(\[|\{\{)/gm)].map((match) => match[1]!);
}

describe("diagram (property)", () => {
  test("label text carries no Mermaid syntax and unescapes to its input", () => {
    hegel.test((tc) => {
      const input = tc.draw(gs.text({ maxSize: 20 }));
      const escaped = escapeLabel(input);
      assert.doesNotMatch(escaped, /[&<>"`\r\n\v\f\u0085\u2028\u2029]/);
      assert.doesNotMatch(escaped.replace(ENTITY, ""), /#/);
      assert.equal(escaped.replace(ENTITY, (_, name: string) => UNESCAPES[name]!), input.replace(/\r\n|[\n\v\f\r\u0085\u2028\u2029]/g, " "));
    });
  });

  test("every module is one node, every edge joins two drawn nodes, and every edge is styled once", () => {
    hegel.test((tc) => {
      const { config, rows } = tc.draw(project);
      const text = renderDiagram(buildDiagramModel(config, rows), OPTIONS).text;
      const ids = declaredIds(text);
      assert.deepEqual([...new Set(ids)], ids, "node ids are unique");
      for (const module of config.declaredModules ?? []) {
        const index = (config.declaredModules ?? []).indexOf(module);
        assert.equal(ids.filter((id) => id === `m${index}`).length, 1, `module ${module.name} is drawn once`);
      }
      const edges = text.split("\n").filter((line) => /^ {2}\w+ (==>|-->|-\.-x|-\.->|<-\.->)/.test(line));
      for (const edge of edges) {
        const match = EDGE_LINE.exec(edge);
        assert.ok(match, `edge line parses: ${edge}`);
        assert.ok(ids.includes(match[1]!) && ids.includes(match[2]!), `edge joins drawn nodes: ${edge}`);
      }
      const styled = [...text.matchAll(/^ {2}linkStyle (\S+) /gm)].flatMap((match) => match[1]!.split(",").map(Number)).sort((a, b) => a - b);
      assert.deepEqual(styled, edges.map((_, index) => index));
    });
  });

  test("every allowDeny rule, exception, and point rule is drawn as some link", () => {
    hegel.test((tc) => {
      const { config, rows } = tc.draw(project);
      const drawn = new Set(buildDiagramModel(config, rows).links.map((link) => link.rule));
      (config.edges?.allowDeny ?? []).forEach((rule, i) => {
        // A deny list of only the source's own tag is exempt by construction and draws nothing.
        const inert = rule.deny !== undefined && rule.deny.every((value) => `${rule.targetNamespace}:${value}` === rule.source);
        if (!inert) assert.ok(drawn.has(`edges.allowDeny[${i}]`), `edges.allowDeny[${i}] is drawn`);
        (rule.exceptions ?? []).forEach((_, k) => assert.ok(drawn.has(`edges.allowDeny[${i}].exceptions[${k}]`), `exception ${i}.${k} is drawn`));
      });
      (config.edges?.point ?? []).forEach((_, j) => assert.ok(drawn.has(`edges.point[${j}]`), `edges.point[${j}] is drawn`));
    });
  });

  test("a module sits in a layer exactly when all its files carry that tag", () => {
    hegel.test((tc) => {
      const { config, rows } = tc.draw(project);
      const model = buildDiagramModel(config, rows);
      for (const module of model.modules) {
        const files = rows.filter((row) => row.module === module.name);
        const expected = model.stack === undefined ? null : LAYERS.find((layer) => files.every((file) => file.tags.has(`layer:${layer}`))) ?? null;
        assert.equal(module.layer, expected, `layer of ${module.name}`);
      }
    });
  });

  test("a selector lists exactly the modules that hold a matching file, with the matching count", () => {
    hegel.test((tc) => {
      const { config, rows } = tc.draw(project);
      const model = buildDiagramModel(config, rows);
      const text = renderDiagram(model, { direction: "TB", detail: "rules" }).text;
      for (const selector of model.selectors.filter((s) => s.kind === "tag")) {
        const expected = model.modules.flatMap((module) => {
          const files = rows.filter((row) => row.module === module.name);
          const hit = files.filter((row) => row.tags.has(selector.text)).length;
          return hit === 0 ? [] : [{ module: module.name, files: hit, of: files.length }];
        });
        assert.deepEqual(selector.members, expected, `members of ${selector.text}`);
        if (expected.length === 0) assert.ok(text.includes(`${selector.id}(["<b>${escapeLabel(selector.text)}</b><br/><small>0 modules</small>"]):::empty`));
      }
    });
  });

  test("a focused render draws only nodes and edges that the full render draws", () => {
    hegel.test((tc) => {
      const { config, rows } = tc.draw(project);
      const model = buildDiagramModel(config, rows);
      // Trimmed: a kept module whose layer stack is dropped is drawn outside a subgraph, so only its indent differs.
      const drawn = (text: string) => new Set(text.split("\n").filter((line) => !/^(flowchart|\s+linkStyle|\s+classDef|\s+end$)/.test(line)).map((line) => line.trim()));
      const full = drawn(renderDiagram(model, OPTIONS).text);
      const name = tc.draw(gs.sampledFrom(model.modules.map((module) => module.name)));
      for (const line of drawn(renderDiagram(focusModel(model, name), OPTIONS).text)) assert.ok(full.has(line), `not in the full render: ${line}`);
    });
  });

  test("the order of the file list does not change the picture", () => {
    hegel.test((tc) => {
      const { config, rows } = tc.draw(project);
      const keys = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 1000 }), { minSize: rows.length, maxSize: rows.length }));
      const shuffled = rows.map((row, i) => ({ row, key: keys[i]! })).sort((a, b) => a.key - b.key).map(({ row }) => row);
      assert.equal(renderDiagram(buildDiagramModel(config, shuffled), OPTIONS).text, renderDiagram(buildDiagramModel(config, rows), OPTIONS).text);
    });
  });
});
