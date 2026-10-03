// Responsibility: specify how the check verb's argument list maps to its
// options - the switches, the --rule/--module filters, and the focus file -
// and which argument lists are usage errors.
// Boundary: whether a named rule or module exists depends on the loaded
// project and is checked by check() itself; that the printed do: commands
// parse is covered with the bounded check text.
import { describe, expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { parseCheckArgv, type CheckArgv } from "../src/check-options.js";
import { ReportError } from "../src/report-error.js";

type Token =
  | { kind: "json" | "prove" | "frozen" }
  | { kind: "rule" | "module"; value: string };

const value = gen.fromRegex("[a-z][a-z0-9-]{0,8}");
const token: gen.Generator<Token> = gen.oneOf<Token>(
  gen.sampledFrom(["json", "prove", "frozen"] as const).map((kind) => ({ kind })),
  gen.tuples(gen.sampledFrom(["rule", "module"] as const), value).map(([kind, v]) => ({ kind, value: v })),
);

function argvOf(item: Token): string[] {
  return "value" in item ? [`--${item.kind}`, item.value] : [`--${item.kind}`];
}

function model(tokens: readonly Token[], focusFile: string | undefined): CheckArgv {
  const values = (kind: "rule" | "module") =>
    tokens.flatMap((item) => (item.kind === kind && "value" in item ? [item.value] : []));
  return {
    asJson: tokens.some((item) => item.kind === "json"),
    prove: tokens.some((item) => item.kind === "prove"),
    frozen: tokens.some((item) => item.kind === "frozen"),
    focusFile,
    rules: values("rule"),
    modules: values("module"),
  };
}

describe("parseCheckArgv", () => {
  test("no arguments check the whole project as text, with every switch off and no filters", () => {
    expect(parseCheckArgv([])).toEqual({
      asJson: false,
      prove: false,
      frozen: false,
      focusFile: undefined,
      rules: [],
      modules: [],
    });
  });

  test("each switch turns on only itself", () => {
    expect(parseCheckArgv(["--json"])).toMatchObject({ asJson: true, prove: false, frozen: false });
    expect(parseCheckArgv(["--prove"])).toMatchObject({ asJson: false, prove: true, frozen: false });
    expect(parseCheckArgv(["--frozen"])).toMatchObject({ asJson: false, prove: false, frozen: true });
  });

  test("a file argument scopes the report to that file and turns on no switch", () => {
    expect(parseCheckArgv(["src/app/main.ts"])).toEqual({
      asJson: false,
      prove: false,
      frozen: false,
      focusFile: "src/app/main.ts",
      rules: [],
      modules: [],
    });
  });

  test("any order of switches, filters, and one file parses to the same options as a model reading", () => {
    hegel.test((tc) => {
      const tokens = tc.draw(gen.arrays(token, { maxSize: 8 }));
      const file = tc.draw(gen.optional(gen.fromRegex("src/[a-z]{1,6}\\.ts")));
      const at = tc.draw(gen.integers({ minValue: 0, maxValue: tokens.length }));
      const parts = tokens.map(argvOf);
      if (file !== null) parts.splice(at, 0, [file]);

      expect(parseCheckArgv(parts.flat())).toEqual(model(tokens, file ?? undefined));
    });
  });
});

function usageError(argv: readonly string[]): ReportError {
  let thrown: unknown;
  try {
    parseCheckArgv(argv);
  } catch (error) {
    thrown = error;
  }
  expect(thrown, JSON.stringify(argv)).toBeInstanceOf(ReportError);
  const error = thrown as ReportError;
  expect(error.do).toContain("archstrict check");
  return error;
}

const KNOWN_OPTIONS = new Set(["--json", "--prove", "--frozen", "--rule", "--module"]);
const unknownOption = gen.fromRegex("--?[a-z][a-z-]{0,7}").filter((arg) => !KNOWN_OPTIONS.has(arg));

describe("parseCheckArgv usage errors", () => {
  test("a --rule or --module with no value, or with an option where the value belongs, is an error naming that filter", () => {
    const cases: Array<[string[], string]> = [
      [["--rule"], "--rule"],
      [["--json", "--module"], "--module"],
      [["--rule", "--json"], "--rule"],
      [["--module", "--frozen", "src/a.ts"], "--module"],
      [["--module", "x", "--rule", "--module", "y"], "--rule"],
    ];
    for (const [argv, filter] of cases) {
      expect(usageError(argv).message, JSON.stringify(argv)).toContain(filter);
    }
  });

  test("an unknown option anywhere among valid arguments is an error naming it, never a focus file", () => {
    hegel.test((tc) => {
      const tokens = tc.draw(gen.arrays(token, { maxSize: 4 }));
      const unknown = tc.draw(unknownOption);
      const at = tc.draw(gen.integers({ minValue: 0, maxValue: tokens.length }));
      const parts = tokens.map(argvOf);
      parts.splice(at, 0, [unknown]);

      expect(usageError(parts.flat()).message).toContain(unknown);
    });
  });

  test("a second file argument is an error, since the report scopes to at most one file", () => {
    for (const argv of [
      ["src/a.ts", "src/b.ts"],
      ["src/a.ts", "--json", "--rule", "public-surface-bypass", "src/b.ts"],
    ]) {
      expect(usageError(argv).message, JSON.stringify(argv)).toMatch(/file/);
    }
  });
});
