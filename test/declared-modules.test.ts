import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { checkPublicSurfaceBypass } from "../src/rules/public-surface.js";
import { checkCycles } from "../src/rules/cycles.js";
import { checkTypeLeaks } from "../src/rules/type-leak.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/declared-modules");
const CYCLES_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/cycles");
const TYPE_LEAK_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/type-leak");

const declaredModules = [
  { name: "core", glob: "src/core/**", surface: "index.ts" },
  { name: "consumer", glob: "src/consumer/**", surface: "index.ts" },
];

describe("checkPublicSurfaceBypass against declared modules (not index.ts discovery)", () => {
  test("an undeclared nested barrel (src/core/injector/index.ts) is not treated as a module boundary", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules });
    expect(graph.unresolvedSpecifierCount).toBe(0);

    // src/core/router-like.ts reaches src/core/injector/container.ts
    // directly, bypassing injector's own barrel - but injector was never
    // declared as its own module, so this is intra-module traffic
    // ("core" -> "core"), not a cross-module edge at all.
    const intraModuleEdge = graph.edges.find((e) => e.specifier === "./injector/container.js");
    expect(intraModuleEdge?.fromModule).toBe("core");
    expect(intraModuleEdge?.toModule).toBe("core");

    const violations = checkPublicSurfaceBypass(graph);
    const flaggingTheBarrelBypass = violations.filter((v) => v.path.endsWith("router-like.ts"));
    expect(flaggingTheBarrelBypass).toHaveLength(0);
  });

  test("a genuinely cross-module bypass of the same internal file is still flagged", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules });

    // src/consumer/index.ts reaches the same src/core/injector/container.ts
    // file, but from a DIFFERENT declared module - core's own declared
    // surface (src/core/index.ts) was bypassed, so this must still violate.
    const crossModuleEdge = graph.edges.find(
      (e) => e.specifier === "../core/injector/container.js",
    );
    expect(crossModuleEdge?.fromModule).toBe("consumer");
    expect(crossModuleEdge?.toModule).toBe("core");

    const violations = checkPublicSurfaceBypass(graph);
    const flaggingConsumer = violations.filter((v) => v.path.endsWith("consumer/index.ts"));
    expect(flaggingConsumer).toHaveLength(1);
    expect(flaggingConsumer[0]!.todoModule).toBe("core");
  });

  test("core's own declared surface file is recognized (src/core/index.ts itself)", () => {
    const graph = buildModuleGraph({ projectRoot: FIXTURE, declaredModules });
    const core = graph.modules.get("core");
    expect(core?.surfaceFiles).toHaveLength(1);
    expect(core?.surfaceFiles[0]?.endsWith("src/core/index.ts")).toBe(true);
  });
});

// Rules 2 and 6 are pure predicates over a ModuleGraph - they don't know or
// care whether the graph came from v0 discovery or v1 declaration. The
// same real fixtures those rules' own dedicated tests use, rebuilt via
// declaredModules instead of modulesGlob, must produce identical results.
describe("checkCycles against a declared-module graph", () => {
  test("flags the same a -> b -> c -> a cycle the modulesGlob-built graph does", () => {
    const graph = buildModuleGraph({
      projectRoot: CYCLES_FIXTURE,
      declaredModules: ["a", "b", "c", "d"].map((name) => ({
        name,
        glob: `src/${name}/**`,
        surface: "index.ts",
      })),
    });
    expect(graph.unresolvedSpecifierCount).toBe(0);

    const violations = checkCycles(graph);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.todoModule).toBe("a");
  });
});

describe("config.exclude", () => {
  test("a file matching an exclude glob is invisible entirely - not a member, not a source of edges, not a target", () => {
    // Found necessary by running the constraint engine against a real
    // cloned project: without it, plain test files sit in the same
    // `plane:shared` classify entry as the source they cover, and a test
    // importing straight from an internal module (normal, expected in a
    // test file) reads as a real tag-boundary violation dependency-cruiser
    // itself never sees, because dependency-cruiser's own config excludes
    // test files from analysis entirely.
    const withoutExclude = buildModuleGraph({ projectRoot: FIXTURE, declaredModules });
    const consumerFilesBefore = withoutExclude.modules.get("consumer")!.files.length;
    expect(consumerFilesBefore).toBeGreaterThan(0);

    const withExclude = buildModuleGraph({
      projectRoot: FIXTURE,
      declaredModules,
      exclude: ["src/consumer/**"],
    });
    expect(withExclude.modules.get("consumer")!.files).toHaveLength(0);
    expect(withExclude.edges.some((e) => e.fromFile.includes("/consumer/"))).toBe(false);
    expect(withExclude.edges.some((e) => e.resolvedFile.includes("/consumer/"))).toBe(false);
  });
});

describe("checkTypeLeaks against a declared-module graph", () => {
  test("flags the same 6 leaks the modulesGlob-built graph does", () => {
    const graph = buildModuleGraph({
      projectRoot: TYPE_LEAK_FIXTURE,
      declaredModules: [{ name: "m", glob: "src/m/**", surface: "public.ts" }],
    });
    expect(graph.unresolvedSpecifierCount).toBe(0);

    const violations = checkTypeLeaks(graph);
    expect(violations).toHaveLength(6);
  });
});
