// Responsibility: verify config assessments with fake Provers and local CLI runs.
// Boundary: tests never contact the scoring service or supply credentials.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { Config } from "../src/config.js";
import { checkConfigMeaning, ProverFailure, type Prover } from "../src/rules/config-meaning.js";
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
const answers = { "allowDeny-0": { score: 0.83 }, "order-0": { score: 0.49 }, "point-0": { score: 0.5 } };

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
    expect(question.type).toBe("score");
    expect(question.criteria).toHaveLength(3);
    expect(question.instructions).toContain(JSON.stringify({ kind, ...entry }));
    expect(question.instructions).toContain(entry.because);
  }
  expect(result).toHaveLength(2);
  expect(result.map(v => "confidence" in v ? v.confidence : undefined)).toEqual([0.83, 0.5]);
  expect(result.map(v => v.because)).toEqual([config.edges!.allowDeny![0]!.because, config.edges!.point![0]!.because]);
  for (const v of result) {
    expect(v).toMatchObject({ rule: "config-meaning", tier: "calibrated", path: config.configPath, line: 1, column: 1 });
    expect(v).not.toHaveProperty("todoModule");
    expect(v).not.toHaveProperty("skipped");
  }
  expect(result[0]!.next).toContain("role:app");
  expect(result[1]!.evidence).toContain("src/infra/**");
});

test("missing credentials produce one explicit skip", async () => {
  const result = await checkConfigMeaning(config, true);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ skipped: true, tier: "calibrated", because: "a rule that checks nothing must not look like a pass" });
  expect(result[0]!.evidence).toContain("TYPESAFE_API_KEY is not set");
  expect(result[0]!.next).toContain("--prove");
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
])("request failure becomes one safe skip: %s", async (error, expected) => {
  const result = await checkConfigMeaning(config, true, async () => { throw error; });
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ skipped: true, tier: "calibrated" });
  expect(result[0]).not.toHaveProperty("confidence");
  expect(result[0]!.evidence).toContain(expected);
  expect(JSON.stringify(result)).not.toContain("private error details");
});

const invalidAnswers: Record<string, { score: number }>[] = [{}, { "allowDeny-0": { score: 0.9 } }, { ...answers, "order-0": { score: NaN } },
  { ...answers, "order-0": { score: 1.1 } }, { ...answers, "order-0": { score: -0.1 } }];
test.each(invalidAnswers)(
  "incomplete or invalid answers discard partial findings", async (invalid) => {
    const result = await checkConfigMeaning(config, true, async () => ({ answers: invalid }));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ skipped: true });
    expect(result[0]).not.toHaveProperty("confidence");
  });

test("scores preserve their values and obey the inclusive threshold", async () => {
  await hegel.testAsync(async tc => {
    const values = tc.draw(gen.arrays(gen.integers({ minValue: 0, maxValue: 100 }), { minSize: 1 }));
    const entries = values.map((_, i) => ({ source: `role:${i}`, targetNamespace: "role", deny: ["infra"], because: `Boundary ${i}` }));
    const result = await checkConfigMeaning({ ...config, edges: { allowDeny: entries } }, true,
      async () => ({ answers: Object.fromEntries(values.map((n, i) => [`allowDeny-${i}`, { score: n / 100 }])) }));
    expect(result.map(v => "confidence" in v ? v.confidence : undefined)).toEqual(values.filter(n => n >= 50).map(n => n / 100));
  });
});

async function project(fn: (root: string) => Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-meaning-")));
  mkdirSync(join(root, "src/app"), { recursive: true });
  writeFileSync(join(root, "src/app/index.ts"), 'import "node:fs"; export const value = 1;');
  writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"noLib":true,"types":[]}}');
  writeFileSync(join(root, "archstrict.config.ts"), `export default ${JSON.stringify({
    declaredModules: [{ name: "app", glob: "src/app/**" }], exclude: ["*.ts"], strict: ["app"],
    classify: [{ glob: "src/app/**", tags: ["role:app"] }], because: "test architecture",
    edges: { allowDeny: [{ source: "role:app", targetNamespace: "pkg", allow: ["fs", "node"], because: "Restrict external imports." }] },
  })};`);
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("check keeps assessments advisory in strict modules and applies the existing file filter", async () => project(async root => {
  const prover: Prover = async () => ({ answers: { "allowDeny-0": { score: 1 } } });
  const result = await check(root, undefined, { prove: true, prover });
  expect(result.violations).toHaveLength(1);
  expect(result.violations[0]!.rule).toBe("config-meaning");
  expect(hasBlockingViolations(result)).toBe(false);
  expect(result.todo).toBe(0);
  expect(formatText(result)).toContain("tier: calibrated");
  expect(formatText(result)).toContain("confidence: 1");
  expect((await check(root, join(root, "src/app/index.ts"), { prove: true, prover })).violations).toEqual([]);
  expect((await check(root, join(root, "archstrict.config.ts"), { prove: true, prover })).violations).toHaveLength(1);
  expect((await check(root)).violations).toEqual([]);
  const blocking = { ...result, violations: [...result.violations, { rule: "empty-rule-set" as const,
    path: root, line: 1, column: 1, evidence: "no edges", because: "test", next: "fix the rule" }] };
  expect(hasBlockingViolations(blocking)).toBe(true);
}));

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
