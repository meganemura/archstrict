// Responsibility: verify move proposals against real project graphs and stable violation identities.
// Boundary: config copies remain local; tests never apply proposed edits to a user's project.
import { expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModuleGraph, type ModuleGraph } from "../src/module-graph.js";
import type { Config } from "../src/config.js";
import { checkAllowDeny, computeAllowDeny, checkExhaustiveAllow, type ConstraintViolation } from "../src/rules/constraints.js";
import { fingerprintOf } from "../src/todo-store.js";
import { check, formatText } from "../src/verbs/check.js";
import type { Move } from "../src/rules/moves.js";

function project(run: (root: string, config: Config, graph: ModuleGraph) => void | Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-moves-")));
  const names = ["app", "allowed", "forbidden", "future", "other"];
  for (const name of names) {
    mkdirSync(join(root, "src", name), { recursive: true });
    writeFileSync(join(root, "src", name, "index.ts"), 'export const value = 1;');
  }
  writeFileSync(join(root, "src/app/index.ts"), 'import "../forbidden/index.js"; import "../allowed/index.js";');
  writeFileSync(join(root, "src/other/index.ts"), 'import "../future/index.js";');
  writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"noLib":true,"types":[]}}');
  const config: Config = { configPath: join(root, "archstrict.config.ts"), because: "test",
    declaredModules: names.map(name => ({ name, glob: `src/${name}/**` })),
    classify: names.filter(name => name !== "other").map(name => ({ glob: `src/${name}/**`, tags: [`role:${name}`] })),
    edges: { allowDeny: [{ source: "role:app", targetNamespace: "role", allow: ["allowed"], because: "App uses the allowed surface." }] } };
  const graph = buildModuleGraph({ projectRoot: root, declaredModules: config.declaredModules! });
  try {
    const result = run(root, config, graph);
    if (result instanceof Promise) return result.finally(() => rmSync(root, { recursive: true, force: true }));
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
  rmSync(root, { recursive: true, force: true });
}

function replaceRule(config: Config, patch: Partial<NonNullable<Config["edges"]>["allowDeny"] extends readonly (infer R)[] | undefined ? R : never>): Config {
  return { ...config, edges: { ...config.edges, allowDeny: [{ ...config.edges!.allowDeny![0]!, ...patch }] } };
}

test("real violations retain their fingerprint and do text after ranked decoration", () => project((_root, config, graph) => {
  const raw = computeAllowDeny(graph, config).violations[0]!;
  const decorated = checkAllowDeny(graph, config)[0]!;
  expect(decorated.moves!.map(move => move.kind)).toEqual(["reroute", "exception", "widen-allow"]);
  expect(fingerprintOf(decorated)).toBe(fingerprintOf(raw));
  const { moves, ...unchanged } = decorated;
  expect(unchanged).toEqual(raw);
  expect(decorated.do).toBe("remove this edge, or add 'forbidden' to 'role:app's allow list in archstrict.config.ts and record why");
  expect(moves![0]).toEqual({ kind: "reroute", verified: false, do: 'consider importing from these public surfaces: ["src/allowed/index.ts"]; confirm the needed symbol is available' });
}));

test("arbitrary moves cannot change a real violation fingerprint", () => project((_root, config, graph) => {
  const violation = computeAllowDeny(graph, config).violations[0]!;
  hegel.test(tc => {
    const moves: Move[] = tc.draw(gen.arrays(gen.record({ kind: gen.sampledFrom(["reroute", "exception", "widen-allow", "widen-deny"] as const), do: gen.text(), verified: gen.booleans() })));
    const decorated = { ...violation, moves };
    expect(fingerprintOf(decorated)).toBe(fingerprintOf(violation));
  });
}));

test("the exact exception proposal exempts its pair without changing a passing edge", () => project((_root, config, graph) => {
  const move = checkAllowDeny(graph, config)[0]!.moves!.find(move => move.kind === "exception")!;
  const entry = { from: "src/app/index.ts", to: "src/forbidden/index.ts", because: "<author must state a real reason>" };
  expect(move).toEqual({ kind: "exception", verified: true, widens: true,
    do: `add ${JSON.stringify(entry)} to exceptions for allowDeny entry 0; this exempts only this one edge pair` });
  expect(checkAllowDeny(graph, replaceRule(config, { exceptions: [entry] }))).toEqual([]);
  expect(computeAllowDeny(graph, config).violations).toHaveLength(1);
}));

test("widening re-runs the real checks without mutating config", () => project((_root, config, graph) => {
  const before = JSON.stringify(config);
  const move = checkAllowDeny(graph, config)[0]!.moves!.find(move => move.kind === "widen-allow")!;
  expect(move).toMatchObject({ widens: true, verified: true });
  expect(move).not.toHaveProperty("creates");
  const hypothetical = replaceRule(config, { allow: ["allowed", "forbidden"] });
  expect(computeAllowDeny(graph, hypothetical).violations).toEqual([]);
  expect(checkExhaustiveAllow(graph, hypothetical)).toEqual([]);
  expect(JSON.stringify(config)).toBe(before);
}));

test("an exhaustive widening remains present and names its new finding", () => project((_root, config, graph) => {
  const near = replaceRule(config, { allow: ["allowed", "future"] });
  const move = checkAllowDeny(graph, near)[0]!.moves!.find(move => move.kind === "widen-allow")!;
  expect(move).toMatchObject({ widens: true, creates: ["exhaustive-allow-list"] });
  const hypothetical = replaceRule(near, { allow: ["allowed", "future", "forbidden"] });
  expect(computeAllowDeny(graph, hypothetical).violations).toEqual([]);
  expect(checkExhaustiveAllow(graph, hypothetical)).toHaveLength(1);
}));

test("deny widening removes the value and uses whole-graph reroute candidates", () => project((_root, config, graph) => {
  const deny = replaceRule(config, { allow: undefined, deny: ["forbidden"] });
  const moves = checkAllowDeny(graph, deny)[0]!.moves!;
  expect(moves[0]!.do).toContain("src/future/index.ts");
  expect(moves.at(-1)).toMatchObject({ kind: "widen-deny", verified: true, widens: true });
  expect(moves.at(-1)).not.toHaveProperty("creates");
  expect(computeAllowDeny(graph, replaceRule(deny, { deny: [] })).violations).toEqual([]);
}));

// The do text is the edit an agent applies to the config. It must name the list that the
// move's kind changes, because adding to allow and removing from deny are opposite edits.
test.each([
  { kind: "widen-allow", lists: {}, do: 'add "forbidden" to allow for allowDeny entry 0' },
  { kind: "widen-deny", lists: { allow: undefined, deny: ["forbidden"] }, do: 'remove "forbidden" from deny for allowDeny entry 0' },
])("a $kind move names its list, the value, and the entry to edit", ({ kind, lists, do: text }) => project((_root, config, graph) => {
  const move = checkAllowDeny(graph, replaceRule(config, lists))[0]!.moves!.find(move => move.kind.startsWith("widen-"))!;
  expect(move).toMatchObject({ kind, do: text });
}));

// Real projects tag one module in several namespaces, so a tag outside the rule's namespace
// must not make the denied module look like a legal target. The source's own module is no
// alternative either: proposing it would send the violating file back to itself.
test("deny-list reroutes propose only surfaces with an admitted value in the rule's namespace, never the denied target or the source's own module", () => project((root, config) => {
  writeFileSync(join(root, "src/other/index.ts"), 'import "../future/index.js"; import "../app/index.js";');
  const cfg = replaceRule({ ...config, classify: config.classify!.map(entry =>
    entry.glob === "src/forbidden/**" ? { ...entry, tags: ["role:forbidden", "layer:core"] } : entry) },
  { allow: undefined, deny: ["forbidden"] });
  const graph = buildModuleGraph({ projectRoot: root, declaredModules: cfg.declaredModules! });
  const reroute = checkAllowDeny(graph, cfg)[0]!.moves!.find(move => move.kind === "reroute")!;
  const surfaces = JSON.parse(/(\[.*\])/.exec(reroute.do)![1]!);
  expect(surfaces).toEqual(["src/allowed/index.ts", "src/future/index.ts"]);
}));

// Authors order declaredModules by meaning, not by path. The proposal must read the same for
// any declaration order, so two runs over equivalent configs can be compared line by line.
test("reroute surfaces are listed in path order whatever order the config declares modules in", () => project((root, config) => {
  const cfg = replaceRule({ ...config, declaredModules: [...config.declaredModules!].reverse() }, { allow: ["allowed", "future"] });
  const graph = buildModuleGraph({ projectRoot: root, declaredModules: cfg.declaredModules! });
  const reroute = checkAllowDeny(graph, cfg)[0]!.moves!.find(move => move.kind === "reroute")!;
  expect(JSON.parse(/(\[.*\])/.exec(reroute.do)![1]!)).toEqual(["src/allowed/index.ts", "src/future/index.ts"]);
}));

test.each([{ allow: [] }, { allow: ["missing"] }])("no reachable surface omits reroute: %j", ({ allow }) => project((_root, config, graph) => {
  expect(checkAllowDeny(graph, replaceRule(config, { allow }))[0]!.moves!.some(move => move.kind === "reroute")).toBe(false);
}));

test("builtins omit the exception move", () => project((root, config) => {
  writeFileSync(join(root, "src/app/index.ts"), 'import "node:fs";');
  const graph = buildModuleGraph({ projectRoot: root, declaredModules: config.declaredModules! });
  const cfg = replaceRule(config, { targetNamespace: "pkg", allow: ["node"] });
  const moves = checkAllowDeny(graph, cfg)[0]!.moves!;
  expect(moves.some(move => move.kind === "exception")).toBe(false);
  expect(moves.some(move => move.kind === "widen-allow")).toBe(true);
}));

test.each(["source", "target"])("a literal star in the real %s path omits exception", side => project((root, config) => {
  const name = side === "source" ? "a*b" : "d*b";
  mkdirSync(join(root, "src", name));
  writeFileSync(join(root, "src", name, "index.ts"), side === "source" ? 'import "../forbidden/index.js";' : 'export const value = 1;');
  if (side === "target") writeFileSync(join(root, "src/app/index.ts"), `import "../${name}/index.js";`);
  const cfg = { ...config, declaredModules: [...config.declaredModules!, { name, glob: `src/${name}/**` }],
    classify: [...config.classify!, { glob: `src/${name}/**`, tags: [side === "source" ? "role:app" : "role:forbidden"] }] };
  const graph = buildModuleGraph({ projectRoot: root, declaredModules: cfg.declaredModules! });
  const violation = checkAllowDeny(graph, cfg).find(v => side === "target" || v.path.includes("a*b"))!;
  expect(violation).toBeDefined();
  expect(violation.moves!.some(move => move.kind === "exception")).toBe(false);
  expect(violation.moves!.some(move => move.kind === "widen-allow")).toBe(true);
}));

test("ambient directory tags select real surfaces", () => project((_root, config, graph) => {
  const cfg = { ...config, classify: undefined, classifyByDirectoryName: { tagNamespace: "role", names: ["app", "allowed", "forbidden", "future"] } };
  expect(checkAllowDeny(graph, cfg)[0]!.moves![0]!.do).toContain("src/allowed/index.ts");
}));

test("widening never adds a newly denied real edge", () => project((_root, config, graph) => {
  hegel.test(tc => {
    const allow = tc.draw(gen.arrays(gen.sampledFrom(["allowed", "forbidden", "future"]), { unique: true }));
    const value = tc.draw(gen.sampledFrom(["allowed", "forbidden", "future"]));
    const key = (v: { path: string; line: number; column: number }) => `${v.path}:${v.line}:${v.column}`;
    const before = new Set(computeAllowDeny(graph, replaceRule(config, { allow })).violations.map(key));
    const after = computeAllowDeny(graph, replaceRule(config, { allow: [...allow, value] })).violations;
    expect(after.filter(v => !before.has(key(v)))).toEqual([]);
  });
}));

test("text moves follow do and leave all previous text intact", () => project(async (root, config) => {
  writeFileSync(config.configPath, `export default ${JSON.stringify(config)};`);
  const result = await check(root);
  const without = { ...result, violations: result.violations.map(v => {
    if (v.rule !== "tag-boundary") return v;
    const { moves, ...raw } = v;
    return raw;
  }) };
  const text = formatText(result);
  expect(text).toContain("\n  moves:\n    reroute:");
  expect(text.split("\n").filter(line => line !== "  moves:" && !/^    (reroute|exception|widen-allow|widen-deny):/.test(line)).join("\n")).toBe(formatText(without));
  const violation = result.violations.find(v => v.rule === "tag-boundary")!;
  expect(text).toContain(`  do: ${violation.do}\n  moves:`);
}));

test("matching rules retain their own move identity and pre-existing findings are not new", () => project((_root, config, graph) => {
  const cfg: Config = { ...config, edges: { allowDeny: [
    { ...config.edges!.allowDeny![0]!, allow: ["allowed", "forbidden", "future"] },
    { ...config.edges!.allowDeny![0]!, because: "Second rule owns this violation." },
  ] } };
  const violation = checkAllowDeny(graph, cfg)[0]!;
  expect(violation.because).toBe("Second rule owns this violation.");
  const move = violation.moves!.find(move => move.kind === "widen-allow")!;
  expect(move.do).toContain("entry 1");
  expect(move).not.toHaveProperty("creates");
  expect(checkExhaustiveAllow(graph, cfg)).toHaveLength(1);
}));

// An exhaustive finding belongs to one entry. Another entry that is exhaustive already says
// nothing about the entry this widening changes, so the new finding must still be named.
test("a widening that makes its own entry exhaustive names that finding even when another entry already is", () => project((_root, config, graph) => {
  const cfg: Config = { ...config, edges: { allowDeny: [
    { ...config.edges!.allowDeny![0]!, allow: ["allowed", "forbidden", "future"] },
    { ...config.edges!.allowDeny![0]!, allow: ["allowed", "future"], because: "Second rule owns this violation." },
  ] } };
  expect(checkExhaustiveAllow(graph, cfg)).toHaveLength(1);
  const violation = checkAllowDeny(graph, cfg)[0]!;
  expect(violation.because).toBe("Second rule owns this violation.");
  expect(violation.moves!.find(move => move.kind === "widen-allow")).toMatchObject({ verified: true, creates: ["exhaustive-allow-list"] });
}));

// One edge can violate entries in two namespaces at once. Widening one entry leaves the other
// entry's violations as they were, so naming them in creates would report a consequence the
// change does not have.
test("a widening never lists a violation that another entry already reports as one it creates", () => project((_root, config, graph) => {
  const cfg: Config = { ...config,
    classify: config.classify!.map(entry => entry.glob === "src/allowed/**" ? { ...entry, tags: ["role:allowed", "layer:core"] } : entry),
    edges: { allowDeny: [
      config.edges!.allowDeny![0]!,
      { source: "role:app", targetNamespace: "layer", deny: ["core"], because: "App stays off the core layer." },
    ] } };
  const widenings = checkAllowDeny(graph, cfg).map(violation => violation.moves!.find(move => move.kind.startsWith("widen-"))!);
  expect(widenings.map(move => move.kind)).toEqual(["widen-allow", "widen-deny"]);
  for (const move of widenings) {
    expect(move.verified).toBe(true);
    expect(move).not.toHaveProperty("creates");
  }
}));

// A finding is one edge judged by one entry, and each finding carries its own moves. Another
// finding that outlives this widening gets its own widening, so it must not mark this one
// unverified: that would tell the reader the edit fails to clear the finding it was made for.
test.each([
  { remaining: "another edge still breaks the same entry", shared: (v: ConstraintViolation) => v.because,
    setup: (root: string, config: Config) => {
      writeFileSync(join(root, "src/app/index.ts"), 'import "../forbidden/index.js"; import "../allowed/index.js"; import "../future/index.js";');
      return config;
    } },
  { remaining: "the same edge still breaks another entry", shared: (v: ConstraintViolation) => `${v.path}:${v.line}:${v.column}`,
    setup: (_root: string, config: Config): Config => ({ ...config,
      classify: config.classify!.map(entry => entry.glob === "src/forbidden/**" ? { ...entry, tags: ["role:forbidden", "layer:core"] } : entry),
      edges: { allowDeny: [
        config.edges!.allowDeny![0]!,
        { source: "role:app", targetNamespace: "layer", deny: ["core"], because: "App stays off the core layer." },
      ] } }) },
])("a widening that clears its own finding is verified while $remaining", ({ shared, setup }) => project((root, config) => {
  const cfg = setup(root, config);
  const graph = buildModuleGraph({ projectRoot: root, declaredModules: cfg.declaredModules! });
  const violations = checkAllowDeny(graph, cfg);
  expect(violations).toHaveLength(2);
  expect(new Set(violations.map(shared)).size).toBe(1);
  for (const violation of violations) {
    expect(violation.moves!.find(move => move.kind.startsWith("widen-"))).toMatchObject({ verified: true });
  }
}));

test("an internal file tag cannot supply a reroute surface", () => project((root, config) => {
  writeFileSync(join(root, "src/allowed/internal.ts"), 'export const internal = 1;');
  const cfg: Config = { ...config, classify: [...config.classify!,
    { glob: "src/allowed/index.ts", tags: ["role:private"] },
    { glob: "src/allowed/internal.ts", tags: ["role:allowed"] },
  ] };
  const graph = buildModuleGraph({ projectRoot: root, declaredModules: cfg.declaredModules! });
  expect(checkAllowDeny(graph, cfg)[0]!.moves!.some(move => move.kind === "reroute")).toBe(false);
}));

// A builtin import carries both pkg:<name> and the pkg:node umbrella tag. Admitting one of them
// leaves the other forbidden, in either list mode.
test.each([
  { mode: "allow", lists: { allow: [] }, admitFs: { allow: ["fs"] } },
  { mode: "deny", lists: { allow: undefined, deny: ["node", "fs"] }, admitFs: { deny: ["node"] } },
])("a widening that leaves another forbidden target tag is not verified: $mode list", ({ lists, admitFs }) => project((root, config) => {
  writeFileSync(join(root, "src/app/index.ts"), 'import "node:fs";');
  const graph = buildModuleGraph({ projectRoot: root, declaredModules: config.declaredModules! });
  const cfg = replaceRule(config, { targetNamespace: "pkg", ...lists });
  const move = checkAllowDeny(graph, cfg)[0]!.moves!.find(move => move.kind.startsWith("widen-"))!;
  expect(move.verified).toBe(false);
  expect(move).not.toHaveProperty("creates");
  expect(computeAllowDeny(graph, replaceRule(cfg, admitFs)).violations).toHaveLength(1);
}));
