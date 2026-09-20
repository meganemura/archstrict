import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { runRules } from "../src/verbs/check.js";
import { checkMustBeEmpty } from "../src/rules/must-be-empty.js";
import type { Config } from "../src/config.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/public-surface");

describe("checkMustBeEmpty", () => {
  test("a glob with a matching file is a violation naming that file", () => {
    const files = ["src/app/models/user.ts", "src/app/services/leftover.ts"];
    const config = { mustBeEmpty: [{ glob: "src/app/services/**", because: "vanilla_rails: rich models, no service objects" }] };

    const violations = checkMustBeEmpty(files, config);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("must-be-empty");
    expect(violations[0]!.path).toBe("src/app/services/leftover.ts");
    expect(violations[0]!.line).toBe(1);
    expect(violations[0]!.column).toBe(1);
    expect(violations[0]!.evidence).toContain("src/app/services/leftover.ts");
  });

  test("the same glob with zero matching files is a clean pass, not silence", () => {
    const files = ["src/app/models/user.ts"];
    const config = { mustBeEmpty: [{ glob: "src/app/services/**", because: "vanilla_rails: rich models, no service objects" }] };

    expect(checkMustBeEmpty(files, config)).toEqual([]);
  });

  test("no mustBeEmpty entries at all is a clean pass", () => {
    expect(checkMustBeEmpty(["src/anything.ts"], {})).toEqual([]);
  });

  test("multiple matching files under the same entry each get their own violation", () => {
    const files = ["src/app/services/a.ts", "src/app/services/b.ts", "src/app/models/user.ts"];
    const config = { mustBeEmpty: [{ glob: "src/app/services/**", because: "test" }] };

    const violations = checkMustBeEmpty(files, config);
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.path).sort()).toEqual(["src/app/services/a.ts", "src/app/services/b.ts"]);
  });
});

describe("runRules wiring (check.ts)", () => {
  test("a real fixture's own file matching mustBeEmpty surfaces through the full check pipeline", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, modulesGlob: "src/*", surface: "public.ts" });
    // Glob is relative to graph.rootDir, not the project root - this test
    // builds a v0-discovery graph directly (modulesGlob, not
    // declaredModules), where rootDir IS the modules root (here,
    // ".../src"), so "b/**" names module b, not "src/b/**". The CLI cutover
    // resolved the inconsistency this comment used to flag between v0 and
    // declared-mode rootDir: check/todo only ever build a declared-mode
    // graph now (rootDir == the project root always), so a real project's
    // mustBeEmpty globs are consistently project-root-relative. Only this
    // low-level unit test still exercises v0 discovery directly, to prove
    // runRules doesn't hardcode either convention.
    const config: Config = {
      configPath: "<test>",
      because: "test config",
      mustBeEmpty: [{ glob: "b/**", because: "b must stay empty in this test" }],
    };

    const result = runRules(graph, config);
    const mustBeEmptyViolations = result.violations.filter((v) => v.rule === "must-be-empty");
    expect(mustBeEmptyViolations).toHaveLength(1);
    expect(mustBeEmptyViolations[0]!.path).toBe("b/module.ts");
  });

  test("no mustBeEmpty declared: no violations, no crash", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, modulesGlob: "src/*", surface: "public.ts" });
    const config: Config = {
      configPath: "<test>",
      because: "test config",
    };

    expect(runRules(graph, config).violations.some((v) => v.rule === "must-be-empty")).toBe(false);
  });
});
