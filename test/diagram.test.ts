import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Config } from "../src/config/config.js";
import { diagram, type DiagramOptions } from "../src/verbs/diagram.js";
import { renderDiagram, renderMarkdown, escapeLabel } from "../src/verbs/diagram-mermaid.js";
import { FIXTURES, REPO, materialize } from "./diagram-project.js";
import { buildDiagramModel, focusModel, type FileRow } from "../src/verbs/diagram-model.js";


function config(rest: Partial<Config>): Config {
  return { configPath: "<test>", because: "", ...rest };
}

function row(rel: string, module: string | undefined, ...tags: string[]): FileRow {
  return { rel, module, tags: new Set(tags) };
}

function draw(cfg: Config, rows: FileRow[], options: Partial<Pick<DiagramOptions, "direction" | "detail">> = {}): string {
  return renderDiagram(buildDiagramModel(cfg, rows), { direction: "TB", detail: "rules", ...options }).text;
}

const lanes = config({
  declaredModules: [
    { name: "core", glob: "src/core/**" },
    { name: "app", glob: "src/app/**" },
  ],
  classify: [
    { glob: "src/core/**", tags: ["layer:core"] },
    { glob: "src/app/**", tags: ["layer:app"] },
  ],
  edges: {
    order: [{ tagNamespace: "layer", sequence: { "": ["core", "app"] }, direction: "downward-only", edgeType: "value", because: "app sits on core" }],
  },
});
const laneRows = [row("src/core/a.ts", "core", "layer:core"), row("src/app/b.ts", "app", "layer:app")];

describe("diagram rendering", () => {
  test("a layer stack puts each module in its layer, highest layer first", () => {
    expect(draw(lanes, laneRows)).toBe(
      [
        "flowchart TB",
        '  subgraph l0["layer: app (value)"]',
        '    m1["<b>app</b><br/><small>src/app/**</small>"]',
        "  end",
        '  subgraph l1["layer: core (value)"]',
        '    m0["<b>core</b><br/><small>src/core/**</small>"]',
        "  end",
        "  l0 ==> l1",
        "  linkStyle 0 stroke:#868e96,stroke-width:3px",
      ].join("\n"),
    );
  });

  test("names, rules, and reasons add detail in that order, and direction changes only the first line", () => {
    const cfg = config({
      because: "one reason",
      declaredModules: [{ name: "a", glob: "src/a/**", surface: "api.ts" }],
      classify: [{ glob: "src/a/**", tags: ["io:pure"] }],
      edges: { allowDeny: [{ source: "io:pure", targetNamespace: "pkg", deny: ["fs"], because: "no files" }] },
    });
    const rows = [row("src/a/x.ts", "a", "io:pure")];
    expect(draw(cfg, rows, { detail: "names", direction: "LR" })).toBe(
      [
        "flowchart LR",
        '  m0["<b>a</b>"]',
        '  s0(["<b>io:pure</b>"]):::selector',
        '  k0{{"pkg: fs"}}:::package',
        "  s0 -.-x|\"cannot use\"| k0",
        "  linkStyle 0 stroke:#e03131,stroke-width:1.5px,stroke-dasharray:5 4",
        "  classDef selector fill:none,stroke-dasharray:4 3",
        "  classDef package fill:none,stroke:#e03131,color:#e03131",
      ].join("\n"),
    );
    expect(draw(cfg, rows, { detail: "rules" })).toContain('m0["<b>a</b><br/><small>src/a/**</small><br/><small>surface: api.ts</small>"]');
    expect(draw(cfg, rows, { detail: "rules" })).toContain('s0(["<b>io:pure</b><br/><small>1 module: a</small>"]):::selector');
    const reasons = draw(cfg, rows, { detail: "reasons" });
    expect(reasons).toContain('s0 -.-x|"cannot use: no files"| k0');
    expect(reasons).toContain('n0["<b>project</b><br/><i>because one reason</i>"]:::note');
  });

  test("an allowlist draws one green arrow per allowed value and a deny draws a red one, with the qualifier on the label", () => {
    const cfg = config({
      declaredModules: [{ name: "a", glob: "src/a/**" }, { name: "b", glob: "src/b/**" }],
      classify: [{ glob: "src/a/**", tags: ["plane:x"] }, { glob: "src/b/**", tags: ["plane:y", "zone:z"] }],
      edges: {
        allowDeny: [
          { source: "plane:x", targetNamespace: "plane", allow: ["y"], edgeType: "value", because: "x uses y" },
          { source: "plane:y", targetNamespace: "zone", deny: ["q"], importForm: "dynamic", edgeType: "type", because: "no q" },
        ],
      },
    });
    const text = draw(cfg, [row("src/a/1.ts", "a", "plane:x"), row("src/b/1.ts", "b", "plane:y", "zone:z")], { detail: "names" });
    expect(text).toContain('s0 -->|"only plane (value)"| s1');
    expect(text).toContain('s1 -.-x|"cannot use (type, dynamic)"| s2');
    expect(text).toContain("linkStyle 0 stroke:#2f9e44,stroke-width:2px");
    expect(text).toContain("linkStyle 1 stroke:#e03131,stroke-width:1.5px,stroke-dasharray:5 4");
  });

  test("a module that holds only some of a selector's files is listed with its file count", () => {
    const cfg = config({
      declaredModules: [{ name: "a", glob: "src/a/**" }, { name: "b", glob: "src/b/**" }],
      edges: { point: [{ from: { tags: ["io:pure"] }, to: { tags: ["pkg:fs"] }, because: "x" }] },
    });
    const rows = [
      row("src/a/1.ts", "a", "io:pure"),
      row("src/a/2.ts", "a", "io:pure"),
      row("src/a/3.ts", "a"),
      row("src/a/4.ts", "a"),
      row("src/a/5.ts", "a"),
      row("src/b/1.ts", "b", "io:pure"),
    ];
    expect(draw(cfg, rows)).toContain('s0(["<b>io:pure</b><br/><small>2 modules: a (2/5 files), b</small>"]):::selector');
  });

  test("a selector beyond ten modules lists the first ten and counts the rest", () => {
    const names = Array.from({ length: 12 }, (_, i) => `m${i}`);
    const cfg = config({
      declaredModules: names.map((name) => ({ name, glob: `src/${name}/**` })),
      edges: { point: [{ from: { tags: ["t:x"] }, to: { tags: ["pkg:fs"] }, because: "x" }] },
    });
    const text = draw(cfg, names.map((name) => row(`src/${name}/a.ts`, name, "t:x")));
    expect(text).toContain("12 modules: m0, m1, m2, m3, m4, m5, m6, m7, m8, m9, +2 more");
  });

  test("a selector no file matches is drawn faded with 0 modules", () => {
    const cfg = config({ edges: { point: [{ from: { tags: ["typo:tag"] }, to: { tags: ["pkg:fs"] }, because: "x" }] } });
    expect(draw(cfg, [])).toContain('s0(["<b>typo:tag</b><br/><small>0 modules</small>"]):::empty');
  });

  test("a module whose files carry several layers, or none, sits outside the stack and says so", () => {
    const cfg = config({
      declaredModules: [{ name: "mix", glob: "src/mix/**" }, { name: "plain", glob: "src/plain/**" }],
      classify: [{ glob: "src/mix/a.ts", tags: ["layer:core"] }, { glob: "src/mix/b.ts", tags: ["layer:app"] }],
      edges: { order: [{ tagNamespace: "layer", sequence: { "": ["core", "app"] }, direction: "downward-only", because: "x" }] },
    });
    const text = draw(cfg, [
      row("src/mix/a.ts", "mix", "layer:core"),
      row("src/mix/b.ts", "mix", "layer:app"),
      row("src/mix/c.ts", "mix"),
      row("src/plain/d.ts", "plain"),
    ]);
    expect(text).toContain('m0["<b>mix</b><br/><small>src/mix/**</small><br/><small>layer: app, core, (none)</small>"]');
    expect(text).toContain('m1["<b>plain</b><br/><small>src/plain/**</small>"]');
    expect(text.split("\n").filter((line) => line.startsWith("    m"))).toEqual([]);
  });

  test("a tag that is a layer value lands on the layer box, and a glob equal to one module's glob lands on that module", () => {
    const cfg = config({
      declaredModules: [{ name: "core", glob: "src/core/**" }, { name: "other", glob: ["src/o/a.ts", "src/o/b.ts"] }],
      classify: [{ glob: "src/core/**", tags: ["layer:core"] }],
      edges: {
        order: [{ tagNamespace: "layer", sequence: { "": ["core"] }, direction: "downward-only", because: "x" }],
        point: [
          { from: { tags: ["layer:core"] }, to: { tags: ["pkg:fs"] }, because: "core has no files" },
          { from: "src/core/**", to: "src/o/a.ts", because: "glob to a glob" },
        ],
      },
    });
    const text = draw(cfg, [row("src/core/a.ts", "core", "layer:core"), row("src/o/a.ts", "other"), row("src/o/b.ts", "other")]);
    expect(text).toContain('k0{{"pkg: fs"}}:::package');
    expect(text).toContain('l0 -.-x|"cannot use"| k0');
    expect(text).toContain('m0 -.-x|"cannot use"| s0');
    expect(text).toContain('s0(["<b>src/o/a.ts</b><br/><small>1 module: other (1/2 files)</small>"]):::selector');
  });

  test("package targets of one source and qualifier collapse into one hexagon, whichever rule kind wrote them", () => {
    const cfg = config({
      edges: {
        allowDeny: [
          { source: "a:x", targetNamespace: "pkg", deny: ["fs", "path"], because: "files" },
          { source: "a:y", targetNamespace: "pkg", deny: ["path", "fs"], because: "files again" },
        ],
        point: [
          { from: { tags: ["a:x"] }, to: { tags: ["pkg:os"] }, edgeType: "value", because: "os" },
          { from: { tags: ["a:x"] }, to: { tags: ["pkg:url"] }, edgeType: "value", because: "url" },
          { from: { tags: ["a:x"] }, to: { tags: ["pkg:zlib"] }, because: "zlib" },
        ],
      },
    });
    const text = draw(cfg, [], { detail: "reasons" });
    expect(text.split("\n").filter((line) => line.startsWith("  k"))).toEqual([
      '  k0{{"pkg: fs, path, zlib"}}:::package',
      '  k1{{"pkg: path, fs"}}:::package',
      '  k2{{"pkg: os, url"}}:::package',
    ]);
    expect(text.split("\n").filter((line) => line.includes("-.-x"))).toEqual([
      '  s0 -.-x|"cannot use: files; zlib"| k0',
      '  s1 -.-x|"cannot use: files again"| k1',
      '  s0 -.-x|"cannot use (value): os; url"| k2',
    ]);
  });

  test("hexagons with equal name lists are one node", () => {
    const cfg = config({
      edges: {
        allowDeny: [
          { source: "a:x", targetNamespace: "pkg", deny: ["fs", "path"], because: "files" },
          { source: "a:y", targetNamespace: "pkg", deny: ["fs", "path"], because: "files" },
        ],
      },
    });
    const text = draw(cfg, []);
    expect(text.split("\n").filter((line) => line.startsWith("  k"))).toEqual(['  k0{{"pkg: fs, path"}}:::package']);
    expect(text).toContain('s0 -.-x|"cannot use"| k0');
    expect(text).toContain('s1 -.-x|"cannot use"| k0');
  });

  test("a package name never reaches an id", () => {
    const cfg = config({ edges: { point: [{ from: { tags: ["a:x"] }, to: { tags: ["pkg:@modelcontextprotocol/sdk"] }, because: "x" }] } });
    const text = draw(cfg, []);
    expect(text).toContain('k0{{"pkg: @modelcontextprotocol/sdk"}}:::package');
    expect(text).not.toMatch(/^\s+[^"\s]*@/m);
  });

  test("an exception, a cycle, a deprecated edge, and a must-be-empty path each get their own look", () => {
    const cfg = config({
      declaredModules: [{ name: "a", glob: "src/a/**" }, { name: "b", glob: "src/b/**" }],
      ignoredCycles: [["a", "b"], ["a", "ghost"]],
      deprecated: [{ from: "a", to: "b", count: 2, because: "shrinking" }],
      mustBeEmpty: [{ glob: "src/utils/**", because: "no utils" }],
      edges: {
        allowDeny: [{ source: "t:x", targetNamespace: "pkg", deny: ["fs"], exceptions: [{ from: "src/a/x.ts", to: "src/b/y.ts", because: "one file" }], because: "x" }],
      },
    });
    const text = draw(cfg, [], { detail: "reasons" });
    expect(text).toContain('e0["<b>must be empty</b><br/><small>src/utils/**</small><br/><i>because no utils</i>"]:::empty');
    expect(text).toContain('s1 -.->|"exempt: one file"| s2');
    expect(text).toContain('m0 <-.->|"known cycle"| m1');
    expect(text).toContain('m0 -.->|"deprecated, at most 2: shrinking"| m1');
    expect(text.split("\n").filter((line) => line.includes("linkStyle"))).toEqual([
      "  linkStyle 0 stroke:#e03131,stroke-width:1.5px,stroke-dasharray:5 4",
      "  linkStyle 1 stroke:#f08c00,stroke-width:1.5px,stroke-dasharray:2 3",
      "  linkStyle 2 stroke:#868e96,stroke-width:1.5px,stroke-dasharray:2 3",
      "  linkStyle 3 stroke:#e8590c,stroke-width:1.5px,stroke-dasharray:5 4",
    ]);
  });

  test("a later order rule and a within rule become notes, not layers", () => {
    const cfg = config({
      edges: {
        order: [
          { tagNamespace: "layer", sequence: { "": ["a", "b"] }, direction: "downward-only", because: "x" },
          { tagNamespace: "tier", within: "layer", sequence: { a: ["lo", "hi"], b: ["in", "out"] }, direction: "downward-only", edgeType: "type", because: "inner" },
        ],
      },
    });
    const text = draw(cfg, []);
    expect(text).toContain('n1["<b>order (type)</b><br/>order tier within layer:a: lo #lt; hi<br/>order tier within layer:b: in #lt; out"]:::note');
  });

  test("link styles list the exact indices of the merged edges", () => {
    const cfg = config({
      edges: {
        order: [{ tagNamespace: "layer", sequence: { "": ["a", "b", "c"] }, direction: "downward-only", because: "x" }],
        point: [
          { from: { tags: ["t:1"] }, to: { tags: ["pkg:a"] }, because: "one" },
          { from: { tags: ["t:1"] }, to: { tags: ["pkg:a"] }, because: "two" },
          { from: { tags: ["t:1"] }, to: { tags: ["t:2"] }, because: "three" },
        ],
      },
    });
    const text = draw(cfg, []);
    expect(text.split("\n").filter((line) => line.includes("linkStyle"))).toEqual([
      "  linkStyle 0,1 stroke:#868e96,stroke-width:3px",
      "  linkStyle 2,3 stroke:#e03131,stroke-width:1.5px,stroke-dasharray:5 4",
    ]);
  });

  describe("rules that the first draft dropped", () => {
    const two = [{ name: "a", glob: "src/a/**" }, { name: "b", glob: "src/b/**" }];
    const twoRows = [row("src/a/1.ts", "a", "layer:ui"), row("src/b/1.ts", "b", "layer:core")];

    test("an empty allow list forbids every value of its namespace", () => {
      const cfg = config({ declaredModules: two, edges: { allowDeny: [{ source: "layer:ui", targetNamespace: "layer", allow: [], because: "ui uses no layer" }] } });
      expect(draw(cfg, twoRows, { detail: "names" })).toBe(
        [
          "flowchart TB",
          '  m0["<b>a</b>"]',
          '  m1["<b>b</b>"]',
          '  s0(["<b>layer:ui</b>"]):::selector',
          '  s1(["<b>layer:*</b>"]):::selector',
          '  s0 -.-x|"cannot use"| s1',
          "  linkStyle 0 stroke:#e03131,stroke-width:1.5px,stroke-dasharray:5 4",
          "  classDef selector fill:none,stroke-dasharray:4 3",
        ].join("\n"),
      );
      expect(draw(cfg, twoRows)).toContain('s1(["<b>layer:*</b><br/><small>2 modules: a, b</small>"]):::selector');
    });

    test("an empty allow list in the pkg namespace forbids every package", () => {
      const cfg = config({ declaredModules: two, edges: { allowDeny: [{ source: "layer:ui", targetNamespace: "pkg", allow: [], because: "no packages" }] } });
      const text = draw(cfg, twoRows, { detail: "names" });
      expect(text).toContain('k0{{"pkg: *"}}:::package');
      expect(text).toContain('s0 -.-x|"cannot use"| k0');
    });

    test("an allow list that names only the source's own tag forbids every other value", () => {
      const cfg = config({ edges: { allowDeny: [{ source: "layer:ui", targetNamespace: "layer", allow: ["ui"], because: "x" }] } });
      expect(draw(cfg, [])).toContain('s0 -.-x|"cannot use"| s1');
    });

    test("a point rule or an exception whose two ends are one node is a self-loop", () => {
      const cfg = config({
        declaredModules: [{ name: "a", glob: "src/a/**" }],
        edges: {
          point: [
            { from: "src/a/**", to: "src/a/**", because: "no internal imports" },
            { from: { tags: ["t:x"] }, to: { tags: ["t:x"] }, because: "x files never import each other" },
          ],
          allowDeny: [{ source: "t:x", targetNamespace: "pkg", deny: ["fs"], exceptions: [{ from: "src/a/x.ts", to: "src/a/x.ts", because: "itself" }], because: "x" }],
        },
      });
      const text = draw(cfg, [row("src/a/x.ts", "a", "t:x")], { detail: "names" });
      expect(text.split("\n").filter((line) => /^ {2}\w+ -\.-/.test(line))).toEqual([
        '  s0 -.-x|"cannot use"| k0',
        '  m0 -.-x|"cannot use"| m0',
        '  s0 -.-x|"cannot use"| s0',
        '  s1 -.->|"exempt"| s1',
      ]);
    });

    test("a glob lands on a module box only when it matches exactly that module's files", () => {
      const cfg = config({
        declaredModules: [{ name: "outer", glob: "src/**" }, { name: "inner", glob: "src/inner/**" }],
        edges: { point: [{ from: "src/**", to: { tags: ["pkg:fs"] }, because: "x" }, { from: "src/inner/**", to: { tags: ["pkg:os"] }, because: "y" }] },
      });
      const text = draw(cfg, [row("src/a.ts", "outer"), row("src/inner/b.ts", "inner")], { detail: "names" });
      expect(text).toContain('s0(["<b>src/**</b>"]):::selector');
      expect(text).toContain('s0 -.-x|"cannot use"| k0');
      expect(text).toContain('m1 -.-x|"cannot use"| k1');
    });

    test("two allow lists from one source in one namespace are two hexagons and a note", () => {
      const rule = (name: string) => ({ source: "layer:ui", targetNamespace: "pkg", allow: [name], because: name });
      const two = config({ edges: { allowDeny: [rule("react"), rule("vue")] } });
      const text = draw(two, []);
      expect(text.split("\n").filter((line) => line.startsWith("  k"))).toEqual(['  k0{{"pkg: react"}}:::package', '  k1{{"pkg: vue"}}:::package']);
      expect(text).toContain('s0 -->|"only pkg"| k0');
      expect(text).toContain('s0 -->|"only pkg"| k1');
      const note = "- Two allow lists from one source in one namespace both apply: a target must be on every list.";
      const doc = (cfg: Config) => renderMarkdown("demo", renderDiagram(buildDiagramModel(cfg, []), { direction: "TB", detail: "rules" }));
      expect(doc(two)).toContain(note);
      expect(doc(config({ edges: { allowDeny: [rule("react")] } }))).not.toContain("Two allow lists");
    });

    test("the layer legend names the direction by the arrows, not by below", () => {
      const legend = renderDiagram(buildDiagramModel(lanes, laneRows), { direction: "BT", detail: "rules" }).legend;
      expect(legend[0]).toEqual({ look: "thick gray arrow between layers", meaning: "a layer may use the layers its gray arrows lead to, never one they come from" });
    });

    test("an unscoped order rule without a \"\" sequence says it never applies", () => {
      const cfg = config({
        edges: {
          order: [
            { tagNamespace: "layer", sequence: { "": ["a", "b"] }, direction: "downward-only", because: "x" },
            { tagNamespace: "tier", sequence: { a: ["lo", "hi"] }, direction: "downward-only", because: "inner" },
            { tagNamespace: "ring", within: "layer", sequence: { a: ["in", "out"] }, direction: "downward-only", because: "scoped" },
          ],
        },
      });
      const text = draw(cfg, []);
      expect(text).toContain('n1["<b>order</b><br/>order tier: never applies (no #quot;#quot; sequence and no within)"]:::note');
      expect(text).toContain('n2["<b>order</b><br/>order ring within layer:a: in #lt; out"]:::note');
    });

    test("predicates with equal text and different tags are different pills", () => {
      const cfg = config({
        edges: {
          point: [
            { from: { tags: ["a:x", "b:y + c:z"] }, to: { tags: ["pkg:fs"] }, because: "one" },
            { from: { tags: ["a:x + b:y", "c:z"] }, to: { tags: ["pkg:fs"] }, because: "two" },
          ],
        },
      });
      expect(buildDiagramModel(cfg, []).selectors.map((s) => s.id)).toEqual(["s0", "s1"]);
    });
  });

  test("a class is defined only when a node uses it", () => {
    expect(draw(lanes, laneRows)).not.toContain("classDef");
  });
});

describe("escaping", () => {
  test("markup, quotes, hashes, backticks, and line breaks in text never reach the Mermaid syntax", () => {
    expect(escapeLabel('</title> & "q" # `x`\nnext')).toBe("#lt;/title#gt; #amp; #quot;q#quot; #35; #96;x#96; next");
  });

  test("a module name and a because with markup render as inert text", () => {
    const cfg = config({
      declaredModules: [{ name: 'a"b<i>', glob: "src/a/**" }],
      edges: { point: [{ from: { tags: ["t:x"] }, to: { tags: ["pkg:fs"] }, because: "no `fs` & <b>bold</b>" }] },
    });
    const text = draw(cfg, [], { detail: "reasons" });
    expect(text).toContain('m0["<b>a#quot;b#lt;i#gt;</b>');
    expect(text).toContain('"cannot use: no #96;fs#96; #amp; #lt;b#gt;bold#lt;/b#gt;"');
    expect(text).not.toContain("`");
  });
});

describe("focus", () => {
  const cfg = config({
    declaredModules: [{ name: "a", glob: "src/a/**" }, { name: "b", glob: "src/b/**" }, { name: "c", glob: "src/c/**" }],
    classify: [{ glob: "src/a/**", tags: ["layer:low", "t:x"] }, { glob: "src/b/**", tags: ["layer:high", "t:y"] }, { glob: "src/c/**", tags: ["layer:low"] }],
    edges: {
      order: [{ tagNamespace: "layer", sequence: { "": ["low", "high"] }, direction: "downward-only", because: "x" }],
      point: [
        { from: { tags: ["t:x"] }, to: { tags: ["pkg:fs"] }, because: "x" },
        { from: { tags: ["t:y"] }, to: { tags: ["pkg:os"] }, because: "y" },
      ],
    },
  });
  const rows = [row("src/a/1.ts", "a", "layer:low", "t:x"), row("src/b/1.ts", "b", "layer:high", "t:y"), row("src/c/1.ts", "c", "layer:low")];

  test("one module keeps its layer stack, its selectors, and their packages, and drops the rest", () => {
    const text = renderDiagram(focusModel(buildDiagramModel(cfg, rows), "a"), { direction: "TB", detail: "names" }).text;
    expect(text).toBe(
      [
        "flowchart TB",
        '  subgraph l0["layer: high"]',
        "  end",
        '  subgraph l1["layer: low"]',
        '    m0["<b>a</b>"]',
        "  end",
        '  s0(["<b>t:x</b>"]):::selector',
        '  k0{{"pkg: fs"}}:::package',
        "  l0 ==> l1",
        '  s0 -.-x|"cannot use"| k0',
        "  linkStyle 0 stroke:#868e96,stroke-width:3px",
        "  linkStyle 1 stroke:#e03131,stroke-width:1.5px,stroke-dasharray:5 4",
        "  classDef selector fill:none,stroke-dasharray:4 3",
        "  classDef package fill:none,stroke:#e03131,color:#e03131",
      ].join("\n"),
    );
  });

  test("an unknown module is an error that lists the declared names", () => {
    expect(() => focusModel(buildDiagramModel(cfg, rows), "z")).toThrow("no declared module named 'z'");
  });
});

describe("markdown", () => {
  test("the fence is one backtick longer than the longest run in the diagram", () => {
    const body = { text: "flowchart TB\n  a[\"``` and ````\"]", legend: [], notes: [] };
    expect(renderMarkdown("demo", body)).toBe(["## demo architecture", "", "`````mermaid", body.text, "`````", ""].join("\n"));
  });

  test("a legend table and the semantic notes follow only for what the diagram draws", () => {
    const cfg = config({ edges: { allowDeny: [{ source: "a:x", targetNamespace: "b", allow: ["y"], because: "x" }] } });
    const doc = renderMarkdown("demo", renderDiagram(buildDiagramModel(cfg, []), { direction: "TB", detail: "rules" }));
    expect(doc).toContain("| Look | Meaning |");
    expect(doc).toContain("| green arrow | files in the source may use only the targets it points to within that tag namespace |");
    expect(doc).toContain("- An allow list also forbids every other value of its tag namespace.");
    expect(doc).not.toContain("known cycle");
  });
});

const defaults: DiagramOptions = { format: "mermaid", direction: "TB", detail: "rules" };

function golden(name: string, actual: string): void {
  const path = join(FIXTURES, `${name}.mmd`);
  if (process.env["UPDATE_GOLDEN"] !== undefined) writeFileSync(path, actual);
  expect(actual, `${name} no longer matches test/fixtures/diagram/${name}.mmd (UPDATE_GOLDEN=1 regenerates)`).toBe(readFileSync(path, "utf8"));
}

describe("golden diagrams", () => {
  for (const name of ["kitchen-sink", "nukadoko"]) {
    test(`${name} matches its golden file`, async () => {
      const dir = materialize(name);
      try {
        golden(name, (await diagram(dir, { ...defaults, detail: "reasons" })).text);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);
  }

  test("this repository matches its golden file", async () => {
    golden("archstrict", (await diagram(REPO, defaults)).text);
  }, 30_000);

  test("every golden file parses with mermaid-cli when MMDC names it", () => {
    const mmdc = process.env["MMDC"];
    if (mmdc === undefined) return;
    const puppeteer = process.env["MMDC_PUPPETEER_CONFIG"];
    const dir = mkdtempSync(join(tmpdir(), "archstrict-diagram-mmdc-"));
    try {
      for (const name of ["kitchen-sink", "nukadoko", "archstrict"]) {
        const args = [...(puppeteer === undefined ? [] : ["-p", puppeteer]), "-q", "-i", join(FIXTURES, `${name}.mmd`), "-o", join(dir, `${name}.svg`)];
        const result = spawnSync(mmdc, args, { encoding: "utf8" });
        expect(result.status, `mmdc rejected ${name}.mmd: ${result.stderr.slice(0, 300)}`).toBe(0);
        expect(existsSync(join(dir, `${name}.svg`))).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
