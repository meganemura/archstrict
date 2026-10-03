// Responsibility: verify config assessments with fake Provers and local CLI runs.
// Boundary: tests never contact the assessment service or supply credentials.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { Config } from "../src/config.js";
import { checkConfigMeaning, realProver, ProverFailure, type Prover } from "../src/rules/config-meaning.js";
import { check, formatText, hasBlockingViolations } from "../src/verbs/check.js";

beforeEach(() => vi.stubEnv("TYPESAFE_API_KEY", undefined));
afterEach(() => vi.unstubAllEnvs());
const config: Config = {
  configPath: "/project/archstrict.config.ts", because: "test architecture", declaredModules: [],
  edges: {
    allowDeny: [{ source: "role:app", targetNamespace: "role", allow: ["app", "infra"], because: "Keep infrastructure separate." }],
    order: [{ tagNamespace: "layer", within: "domain", sequence: { shop: ["data", "app"] }, direction: "downward-only", because: "Keep the dependency direction." }],
    point: [{ from: { tags: ["role:app"] }, to: "src/infra/**", because: "Do not access infrastructure directly." }],
  },
};
function answer(choice: "consistent" | "contradicts", confidence: number) {
  return { type: "choice" as const, choice, confidence,
    probabilities: { consistent: choice === "consistent" ? confidence : 1 - confidence,
      contradicts: choice === "contradicts" ? confidence : 1 - confidence } };
}
const answers = { "allowDeny-0": answer("contradicts", 0.83), "order-0": answer("consistent", 0.49), "point-0": answer("contradicts", 0.7) };

test("one batch preserves each complete rule and its reason", async () => {
  const prover = vi.fn<Prover>(async () => ({ answers }));
  const result = await checkConfigMeaning(config, true, prover);
  expect(prover).toHaveBeenCalledTimes(1);
  const request = prover.mock.calls[0]![0];
  expect(Object.keys(request.questions)).toEqual(Object.keys(answers));
  expect(request.state).toContain("TypeScript");
  for (const kind of ["allowDeny", "order", "point"] as const) {
    const entry = config.edges![kind]![0]!;
    const question = request.questions[`${kind}-0`]!;
    expect(question.type).toBe("choice");
    expect(question.criteria).toEqual({ consistent: "the shape agrees with what the because text claims",
      contradicts: "the shape actually permits something the because text says must never happen" });
    expect(question.instructions).toContain(JSON.stringify({ kind, ...entry }));
    expect(question.instructions).toContain(entry.because);
  }
  expect(result).toHaveLength(2);
  expect(result.map(v => "confidence" in v ? v.confidence : undefined)).toEqual([0.83, 0.7]);
  expect(result.map(v => v.because)).toEqual([config.edges!.allowDeny![0]!.because, config.edges!.point![0]!.because]);
  for (const v of result) {
    expect(v).toMatchObject({ rule: "config-meaning", tier: "calibrated", path: config.configPath, line: 1, column: 1 });
    expect(v).not.toHaveProperty("todoModule");
    expect(v).not.toHaveProperty("skipped");
  }
  expect(result[0]!.do).toContain("role:app");
  expect(result[1]!.evidence).toContain("src/infra/**");
});

test("missing credentials produce one explicit skip", async () => {
  const result = await checkConfigMeaning(config, true);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ skipped: true, tier: "calibrated", because: "a rule that checks nothing must not look like a pass" });
  expect(result[0]!.evidence).toContain("TYPESAFE_API_KEY is not set");
  expect(result[0]!.do).toContain("--prove");
  expect(result[0]).not.toHaveProperty("confidence");
});

test("no opt-in and no entries both avoid the Prover", async () => {
  const prover = vi.fn<Prover>();
  expect(await checkConfigMeaning(config, false, prover)).toEqual([]);
  expect(await checkConfigMeaning({ ...config, edges: {} }, true, prover)).toEqual([]);
  expect(await checkConfigMeaning({ ...config, edges: undefined }, true)).toEqual([]);
  expect(prover).not.toHaveBeenCalled();
});

test.each([
  [new Error("private error details"), "network error"],
  [Object.assign(new Error("private error details"), { name: "AbortError" }), "timeout"],
  [Object.assign(new Error("private error details"), { name: "TimeoutError" }), "timeout"],
  [new ProverFailure("http-status"), "HTTP status"],
  [new ProverFailure("invalid-json"), "invalid JSON"],

  ["private error details", "network error"],
  [null, "network error"],
  [undefined, "network error"],
])("request failure becomes one safe skip: %s", async (error, expected) => {
  const result = await checkConfigMeaning(config, true, async () => { throw error; });
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ skipped: true, tier: "calibrated" });
  expect(result[0]).not.toHaveProperty("confidence");
  expect(result[0]!.evidence).toContain(expected);

  expect(result[0]!.do).toContain("archstrict check --prove");
  expect(JSON.stringify(result)).not.toContain("private error details");
});

const invalidAnswers: unknown[] = [{}, { "allowDeny-0": answer("contradicts", 0.9) },
  ...[NaN, Infinity, 1.1, -0.1, "0.8", undefined].map(confidence => ({ ...answers, "order-0": { ...answer("consistent", 0.8), confidence } })),
  ...[null, {}, { ...answer("consistent", 0.8), type: "score" }, { ...answer("consistent", 0.8), choice: "unknown" },
    { ...answer("consistent", 0.8), probabilities: null },
    { ...answer("consistent", 0.8), probabilities: { consistent: 0.8 } },
    { ...answer("consistent", 0.8), probabilities: { consistent: NaN, contradicts: 0.2 } },
    { ...answer("consistent", 0.8), probabilities: { consistent: 0.8, contradicts: 2 } },
  ].map(value => ({ ...answers, "order-0": value }))];
test.each(invalidAnswers)(
  "incomplete or invalid answers discard partial findings", async (invalid) => {
    const result = await checkConfigMeaning(config, true, async () => ({ answers: invalid }) as Awaited<ReturnType<Prover>>);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ skipped: true });
    expect(result[0]).not.toHaveProperty("confidence");
    expect(result[0]).not.toHaveProperty("undecided");
  });

test("low confidence contradictions are undecided assessments, not failures", async () => {
  const confidence = 0.7 - Number.EPSILON;
  const result = await checkConfigMeaning(config, true, async () => ({ answers: {
    ...answers, "allowDeny-0": answer("consistent", 1), "point-0": answer("contradicts", confidence),
  } }));
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ undecided: true, tier: "calibrated", because: config.edges!.point![0]!.because });
  expect(result[0]).not.toHaveProperty("confidence");
  expect(result[0]).not.toHaveProperty("skipped");
  expect(result[0]).not.toHaveProperty("todoModule");
  expect(result[0]!.evidence).toContain(String(confidence));
  expect(result[0]!.evidence).toContain(JSON.stringify(answer("contradicts", confidence).probabilities));
  expect(result[0]!.do).toContain("human review");
});

test("choices preserve confidence and partition contradictions at the inclusive threshold", async () => {
  await hegel.testAsync(async tc => {
    const values = tc.draw(gen.arrays(gen.tuples(gen.booleans(), gen.floats({ minValue: 0, maxValue: 1 }))));
    const entries = values.map((_, i) => ({ source: `role:${i}`, targetNamespace: "role", deny: ["infra"], because: `Boundary ${i}` }));
    const result = await checkConfigMeaning({ ...config, edges: { allowDeny: entries } }, true,
      async () => ({ answers: Object.fromEntries(values.map(([contradicts, confidence], i) =>
        [`allowDeny-${i}`, answer(contradicts ? "contradicts" : "consistent", confidence)])) }));
    expect(result.map(v => v.because)).toEqual(values.flatMap(([contradicts], i) => contradicts ? [`Boundary ${i}`] : []));
    expect(result.filter(v => !v.undecided).map(v => v.confidence)).toEqual(
      values.filter(([contradicts, confidence]) => contradicts && confidence >= 0.7).map(([, confidence]) => confidence));
    expect(result.filter(v => v.undecided)).toHaveLength(values.filter(([contradicts, confidence]) => contradicts && confidence < 0.7).length);
  });
});

const projectEdges: Config["edges"] = {
  allowDeny: [{ source: "role:app", targetNamespace: "pkg", allow: ["fs", "node"], because: "Restrict external imports." }],
};
async function project(fn: (root: string) => Promise<void>, edges: Config["edges"] = projectEdges) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-meaning-")));
  mkdirSync(join(root, "src/app"), { recursive: true });
  mkdirSync(join(root, "src/other"), { recursive: true });
  writeFileSync(join(root, "src/other/index.ts"), 'import "node:path";');
  writeFileSync(join(root, "src/app/index.ts"), 'import "node:fs"; export const value = 1;');
  writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"noLib":true,"types":[]}}');
  writeFileSync(join(root, "archstrict.config.ts"), `export default ${JSON.stringify({
    declaredModules: [{ name: "app", glob: "src/app/**" }, { name: "other", glob: "src/other/**" }], exclude: ["*.ts"], strict: ["app"],
    classify: [{ glob: "src/app/**", tags: ["role:app"] }], because: "test architecture", edges,
  })};`);
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test.each([1, 0.6])("check keeps assessments advisory in strict modules and applies the existing file filter: %s", async confidence => project(async root => {
  const prover: Prover = async () => ({ answers: { "allowDeny-0": answer("contradicts", confidence) } });
  const result = await check(root, undefined, { prove: true, prover });
  expect(result.violations).toHaveLength(1);
  expect(result.violations[0]!.rule).toBe("config-meaning");

  expect(result.violations[0]!.config).toMatchObject({ pointer: "edges.allowDeny[0]", role: "fired" });
  expect(hasBlockingViolations(result)).toBe(false);
  expect(result.todo).toBe(0);
  expect(formatText(result)).toContain("tier: calibrated");
  expect(formatText(result)).toContain(confidence === 1 ? "confidence: 1" : "undecided: true");
  expect(formatText(result)).not.toContain("undefined");
  expect((await check(root, join(root, "src/app/index.ts"), { prove: true, prover })).violations).toEqual([]);
  expect((await check(root, join(root, "archstrict.config.ts"), { prove: true, prover })).violations).toHaveLength(1);
  expect((await check(root)).violations).toEqual([]);
  const blocking = { ...result, violations: [...result.violations, { rule: "empty-rule-set" as const,
    path: root, line: 1, column: 1, evidence: "no edges", because: "test", do: "fix the rule",
    config: result.violations[0]!.config }] };
  expect(hasBlockingViolations(blocking)).toBe(true);
}));

test("check locates a skip at the edges section it left unchecked", async () => project(async root => {
  const prover: Prover = async () => { throw new ProverFailure("http-status"); };
  const result = await check(root, undefined, { prove: true, prover });
  expect(result.violations).toHaveLength(1);
  expect(result.violations[0]).toMatchObject({ rule: "config-meaning", skipped: true,
    config: { path: join(root, "archstrict.config.ts"), pointer: "edges", role: "governs",
      value: { allowDeny: [{ source: "role:app", targetNamespace: "pkg", allow: ["fs", "node"], because: "Restrict external imports." }] } } });
}));

test("check points each contradiction at the edge rule it assessed", async () => {
  const order = { tagNamespace: "layer", sequence: { core: ["data", "app"] }, direction: "downward-only" as const,
    because: "Keep the dependency direction." };
  const edges = {
    allowDeny: [{ source: "role:app", targetNamespace: "pkg", allow: ["fs", "node"], because: "Restrict external imports." }],
    order: [{ ...order, within: "domain" }, { ...order, within: "plane" }],
    point: [{ from: { tags: ["role:app"] }, to: "src/other/**", because: "Do not reach other code directly." }],
  };
  const prover: Prover = async request => ({ answers: Object.fromEntries(Object.keys(request.questions)
    .map(id => [id, answer("contradicts", 0.9)])) });
  await project(async root => {
    const findings = (await check(root, undefined, { prove: true, prover })).violations.filter(v => v.rule === "config-meaning");
    expect(findings).toHaveLength(4);
    expect(findings.map(v => v.config)).toEqual(expect.arrayContaining([
      ["edges.allowDeny[0]", edges.allowDeny[0]], ["edges.order[0]", edges.order[0]],
      ["edges.order[1]", edges.order[1]], ["edges.point[0]", edges.point[0]],
    ].map(([pointer, value]) => expect.objectContaining({ path: join(root, "archstrict.config.ts"), pointer, value, role: "fired" }))));
    const orderFindings = findings.filter(v => v.because === order.because);
    expect(orderFindings).toHaveLength(2);
    expect(orderFindings[0]!.evidence).not.toBe(orderFindings[1]!.evidence);
    expect(orderFindings[0]!.do).not.toBe(orderFindings[1]!.do);
  }, edges);
});

test("the built CLI accepts --prove in JSON and text and never blocks on a skip", async () => project(async root => {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  for (const args of [["--prove", "--json"], ["--prove"], ["src/app/index.ts", "--prove", "--json"], ["--json"]]) {
    const result = spawnSync(process.execPath, [cli, "check", ...args], { cwd: root, env, encoding: "utf8" });
    expect(result.status).toBe(0);
    if (!args.includes("--json")) expect(result.stdout).toContain("TYPESAFE_API_KEY is not set");
    else {
      const violations = JSON.parse(result.stdout).violations;
      expect(violations).toHaveLength(args[0] === "--prove" ? 1 : 0);
      if (violations.length) expect(violations[0].skipped).toBe(true);
    }
  }
}));

test.each([
  ["null answers", { answers: null }],
  ["absent answers", {}],
  ["text answers", { answers: "text" }],
  ["numeric answers", { answers: 1 }],
  ["array answers", { answers: [] }],
  ["null response", null],
  ["text response", "text"],
])("an invalid answers container produces the exact skip: %s", async (_name, response) => {
  const prover = vi.fn<Prover>().mockResolvedValue(response as unknown as Awaited<ReturnType<Prover>>);
  expect(await checkConfigMeaning(config, true, prover)).toEqual([{
    rule: "config-meaning", path: config.configPath, line: 1, column: 1,
    tier: "calibrated", skipped: true,
    evidence: "the Jev API request failed: invalid answers",
    because: "a rule that checks nothing must not look like a pass",
    do: "retry archstrict check --prove after checking the service response",
  }]);
});

test.each([
  ["a missing answer", { "allowDeny-0": answer("contradicts", 0.9), "point-0": answer("contradicts", 0.9) },
    "the Jev API request failed: missing an expected answer"],
  ["a malformed answer", { ...answers, "order-0": null }, "the Jev API request failed: invalid choice answer"],
])("%s produces the exact skip", async (_name, response, evidence) => {
  const prover = vi.fn<Prover>().mockResolvedValue({ answers: response } as unknown as Awaited<ReturnType<Prover>>);
  expect(await checkConfigMeaning(config, true, prover)).toEqual([{
    rule: "config-meaning", path: config.configPath, line: 1, column: 1,
    tier: "calibrated", skipped: true, evidence,
    because: "a rule that checks nothing must not look like a pass",
    do: "retry archstrict check --prove after checking the service response",
  }]);
});

describe("realProver HTTP contract", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const request: Parameters<Prover>[0] = {
    state: "Assess the rule.",
    questions: { rule: { type: "choice", instructions: "Check the reason.",
      criteria: { consistent: "agrees", contradicts: "disagrees" } } },
  };
  beforeEach(() => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-only-dummy-key");
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  test("sends the real request shape and returns the parsed answers", async () => {
    const response = { answers: { rule: answer("consistent", 0.9) } };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(response)));
    expect(await realProver(request)).toEqual(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(options!.method).toBe("POST");
    expect(options!.headers).toEqual({ Authorization: "Bearer test-only-dummy-key", "Content-Type": "application/json" });
    expect(JSON.parse(options!.body as string)).toEqual({ ...request, model: "jev-latest" });
    expect(options!.signal).toBeInstanceOf(AbortSignal);
  });

  test("rejects a non-2xx response with http-status", async () => {
    fetchMock.mockResolvedValue(new Response("unavailable", { status: 503 }));
    await expect(realProver(request)).rejects.toMatchObject({ constructor: ProverFailure, kind: "http-status" });
  });

  test("rejects an invalid JSON body with invalid-json", async () => {
    fetchMock.mockResolvedValue(new Response("not JSON"));
    await expect(realProver(request)).rejects.toMatchObject({ constructor: ProverFailure, kind: "invalid-json" });
  });

  test.each(["AbortError", "TimeoutError"])("preserves a fetch %s error by identity", async name => {
    const error = Object.assign(new Error("request interrupted"), { name });
    fetchMock.mockRejectedValue(error);
    await expect(realProver(request)).rejects.toBe(error);
  });

  test.each(["AbortError", "TimeoutError"])("preserves a response-body %s error by identity", async name => {
    const error = Object.assign(new Error("response interrupted"), { name });
    const response = new Response();
    vi.spyOn(response, "json").mockRejectedValue(error);
    fetchMock.mockResolvedValue(response);
    await expect(realProver(request)).rejects.toBe(error);
  });
});
