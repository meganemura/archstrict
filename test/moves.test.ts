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
import { checkAllowDeny, computeAllowDeny, checkExhaustiveAllow } from "../src/rules/constraints.js";
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
  const graph = buildModuleGraph({ projectRoot: root, declaredModules: config.declaredModules });
  try {
    const result = run(root, config, graph);
    if (result instanceof Promise) return result.finally(() => rmSync(root, { recursive: true, force: true }));
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
  rmSync(root, { recursive: true, force: true });
}

function replaceRule(config: Config, patch: Partial<NonNullable<Config["edges"]>["allowDeny"] extends readonly (infer R)[] | undefined ? R : never>): Config {
  return { ...config, edges: { ...config.edges, allowDeny: [{ ...config.edges!.allowDeny![0]!, ...patch }] } };
}

test("real violations retain their fingerprint and next text after ranked decoration", () => project((_root, config, graph) => {
  const raw = computeAllowDeny(graph, config).violations[0]!;
  const decorated = checkAllowDeny(graph, config)[0]!;
  expect(decorated.moves!.map(move => move.kind)).toEqual(["reroute", "exception", "widen-allow"]);
  expect(fingerprintOf(decorated)).toBe(fingerprintOf(raw));
  const { moves, ...unchanged } = decorated;
  expect(unchanged).toEqual(raw);
  expect(decorated.next).toBe("remove this edge, or add 'forbidden' to 'role:app's allow list in archstrict.config.ts and record why");
  expect(moves![0]).toEqual({ kind: "reroute", verified: false, next: 'consider importing from these public surfaces: ["src/allowed/index.ts"]; confirm the needed symbol is available' });
}));

test("arbitrary moves cannot change a real violation fingerprint", () => project((_root, config, graph) => {
  const violation = computeAllowDeny(graph, config).violations[0]!;
  hegel.test(tc => {
    const moves: Move[] = tc.draw(gen.arrays(gen.record({ kind: gen.sampledFrom(["reroute", "exception", "widen-allow", "widen-deny"] as const), next: gen.text(), verified: gen.booleans() })));
    const decorated = { ...violation, moves };
    expect(fingerprintOf(decorated)).toBe(fingerprintOf(violation));
  });
}));

test("the exact exception proposal exempts its pair without changing a passing edge", () => project((_root, config, graph) => {
  const move = checkAllowDeny(graph, config)[0]!.moves!.find(move => move.kind === "exception")!;
  const entry = { from: "src/app/index.ts", to: "src/forbidden/index.ts", because: "<author must state a real reason>" };
  expect(move).toEqual({ kind: "exception", verified: true, widens: true,
    next: `add ${JSON.stringify(entry)} to exceptions for allowDeny entry 0; this exempts only this one edge pair` });
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
  expect(moves[0]!.next).toContain("src/future/index.ts");
  expect(moves.at(-1)).toMatchObject({ kind: "widen-deny", verified: true, widens: true });
  expect(moves.at(-1)).not.toHaveProperty("creates");
  expect(computeAllowDeny(graph, replaceRule(deny, { deny: [] })).violations).toEqual([]);
}));

test.each([{ allow: [] }, { allow: ["missing"] }])("no reachable surface omits reroute: %j", ({ allow }) => project((_root, config, graph) => {
  expect(checkAllowDeny(graph, replaceRule(config, { allow }))[0]!.moves!.some(move => move.kind === "reroute")).toBe(false);
}));

test("builtins omit the exception move", () => project((root, config) => {
  writeFileSync(join(root, "src/app/index.ts"), 'import "node:fs";');
  const graph = buildModuleGraph({ projectRoot: root, declaredModules: config.declaredModules });
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
  const graph = buildModuleGraph({ projectRoot: root, declaredModules: cfg.declaredModules });
  const violation = checkAllowDeny(graph, cfg).find(v => side === "target" || v.path.includes("a*b"))!;
  expect(violation).toBeDefined();
  expect(violation.moves!.some(move => move.kind === "exception")).toBe(false);
  expect(violation.moves!.some(move => move.kind === "widen-allow")).toBe(true);
}));

test("ambient directory tags select real surfaces", () => project((_root, config, graph) => {
  const cfg = { ...config, classify: undefined, classifyByDirectoryName: { tagNamespace: "role", names: ["app", "allowed", "forbidden", "future"] } };
  expect(checkAllowDeny(graph, cfg)[0]!.moves![0]!.next).toContain("src/allowed/index.ts");
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

test("text moves follow next and leave all previous text intact", () => project(async (root, config) => {
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
  expect(text).toContain(`  next: ${violation.next}\n  moves:`);
}));

test("matching rules retain their own move identity and pre-existing findings are not new", () => project((_root, config, graph) => {
  const cfg: Config = { ...config, edges: { allowDeny: [
    { ...config.edges!.allowDeny![0]!, allow: ["allowed", "forbidden", "future"] },
    { ...config.edges!.allowDeny![0]!, because: "Second rule owns this violation." },
  ] } };
  const violation = checkAllowDeny(graph, cfg)[0]!;
  expect(violation.because).toBe("Second rule owns this violation.");
  const move = violation.moves!.find(move => move.kind === "widen-allow")!;
  expect(move.next).toContain("entry 1");
  expect(move).not.toHaveProperty("creates");
  expect(checkExhaustiveAllow(graph, cfg)).toHaveLength(1);
}));

test("an internal file tag cannot supply a reroute surface", () => project((root, config) => {
  writeFileSync(join(root, "src/allowed/internal.ts"), 'export const internal = 1;');
  const cfg: Config = { ...config, classify: [...config.classify!,
    { glob: "src/allowed/index.ts", tags: ["role:private"] },
    { glob: "src/allowed/internal.ts", tags: ["role:allowed"] },
  ] };
  const graph = buildModuleGraph({ projectRoot: root, declaredModules: cfg.declaredModules });
  expect(checkAllowDeny(graph, cfg)[0]!.moves!.some(move => move.kind === "reroute")).toBe(false);
}));

test("a widening that leaves another forbidden target tag is not verified", () => project((root, config) => {
  writeFileSync(join(root, "src/app/index.ts"), 'import "node:fs";');
  const graph = buildModuleGraph({ projectRoot: root, declaredModules: config.declaredModules });
  const cfg = replaceRule(config, { targetNamespace: "pkg", allow: [] });
  const move = checkAllowDeny(graph, cfg)[0]!.moves!.find(move => move.kind === "widen-allow")!;
  expect(move.verified).toBe(false);
  expect(computeAllowDeny(graph, replaceRule(cfg, { allow: ["fs"] })).violations).toHaveLength(1);
}));
