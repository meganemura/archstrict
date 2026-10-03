import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { runRules } from "../src/verbs/check.js";
import { checkMustBeEmpty } from "../src/rules/must-be-empty.js";
import type { Config } from "../src/config.js";
import { createConfigLocator, locateViolation } from "../src/config-pointer.js";

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

  test("each violation's do: names its own file and glob, and its config pointer is the entry that fired", () => {

    const config: Config = {
      configPath: "<test>",
      because: "test config",
      mustBeEmpty: [
        { glob: "src/app/services/**", because: "rich models, no service objects" },
        { glob: "src/app/jobs/**", because: "no background jobs" },
      ],
    };
    const violations = checkMustBeEmpty(["src/app/jobs/sync.ts", "src/app/services/leftover.ts"], config);
    expect(violations).toHaveLength(2);
    const locator = createConfigLocator(config);
    const byPath = new Map(violations.map((v) => [v.path, { do: v.do, config: locateViolation(v, config, locator).config }]));

    expect(byPath.get("src/app/services/leftover.ts")).toMatchObject({
      do: "move 'src/app/services/leftover.ts' out of 'src/app/services/**', or drop this mustBeEmpty entry in archstrict.config.ts if the restriction no longer applies",
      config: { pointer: "mustBeEmpty[0]", value: config.mustBeEmpty![0], role: "fired" },
    });
    expect(byPath.get("src/app/jobs/sync.ts")).toMatchObject({
      do: "move 'src/app/jobs/sync.ts' out of 'src/app/jobs/**', or drop this mustBeEmpty entry in archstrict.config.ts if the restriction no longer applies",
      config: { pointer: "mustBeEmpty[1]", value: config.mustBeEmpty![1], role: "fired" },
    });
  });
});

describe("runRules wiring (check.ts)", () => {
  test("no mustBeEmpty declared: no violations, no crash", () => {
    const declaredModules = ["a", "b", "c"].map((name) => ({ name, glob: `src/${name}/**` }));
    const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules, surface: "public.ts" });
    const config: Config = {
      configPath: "<test>",
      because: "test config",
    };

    expect(runRules(graph, config).violations.some((v) => v.rule === "must-be-empty")).toBe(false);
  });
});
