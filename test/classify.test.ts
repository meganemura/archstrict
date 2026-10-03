// Importing all three design fixtures here forces tsc to check them even
// though test/fixtures/ itself is excluded from the project's tsconfig
// (its source trees intentionally contain code that must NOT typecheck as
// part of this project) - an explicit relative import from an included
// file still pulls the target into the program. If a fixture's shape ever
// drifts from Config, this import breaks before any behavioral test does.
import { describe, expect, test } from "vitest";
import prismaShape from "./fixtures/prisma-shape/archstrict.config.js";
import vscodeShape from "./fixtures/vscode-shape/archstrict.config.js";
import nukadokoShape from "./fixtures/nukadoko-shape/archstrict.config.js";
import { classifyByGlob, classifyByDirectoryName, classifyFile, compileGlob, AmbiguousClassifyError } from "../src/classify.js";

describe("design fixtures typecheck and load", () => {
  test("prisma-shape, vscode-shape, and nukadoko-shape all satisfy Config", () => {
    expect(prismaShape.scope).toBe("packages/**");
    expect(vscodeShape.classifyByDirectoryName?.tagNamespace).toBe("env");
    expect(nukadokoShape.declaredModules).toHaveLength(4);
  });
});

describe("classifyByGlob", () => {
  test("a trailing double wildcard matches paths across directory segments", () => {
    expect(compileGlob("src/**").test("src/a/x.ts")).toBe(true);
  });

  test("a longer literal prefix wins when both matching globs have the same wildcard count", () => {
    const broad = { glob: "src/**", tags: ["broad"] };
    const nested = { glob: "src/nested/**", tags: ["nested"] };
    expect(classifyByGlob("src/nested/x.ts", [broad, nested])).toEqual(["nested"]);
    expect(classifyByGlob("src/nested/x.ts", [nested, broad])).toEqual(["nested"]);
  });

  test("an exact path wins over a wildcard with the same literal prefix", () => {
    const exact = { glob: "a", tags: ["exact"] };
    const broad = { glob: "a*", tags: ["broad"] };
    expect(classifyByGlob("a", [exact, broad])).toEqual(["exact"]);
    expect(classifyByGlob("a", [broad, exact])).toEqual(["exact"]);
  });
  test("the more specific entry wins regardless of declaration order", () => {
    const broad = { glob: "packages/1-core/**", tags: ["broad"] };
    const specific = { glob: "packages/1-core/exports/control.ts", tags: ["specific"] };

    expect(classifyByGlob("packages/1-core/exports/control.ts", [broad, specific])).toEqual(["specific"]);
    expect(classifyByGlob("packages/1-core/exports/control.ts", [specific, broad])).toEqual(["specific"]);
  });

  test("a file matching no entry is undefined, not an empty array", () => {
    expect(classifyByGlob("elsewhere/file.ts", [{ glob: "packages/**", tags: ["x"] }])).toBeUndefined();
  });

  test("a mid-pattern ** matches zero segments as well as one or more", () => {
    const entries = [{ glob: "a/**/b.ts", tags: ["x"] }];
    expect(classifyByGlob("a/b.ts", entries)).toEqual(["x"]);
    expect(classifyByGlob("a/x/b.ts", entries)).toEqual(["x"]);
    expect(classifyByGlob("a/x/y/b.ts", entries)).toEqual(["x"]);
  });

  test("two equally-specific entries disagreeing about the same file throw", () => {
    // Same literal-prefix length (16: "packages/shared/") and same
    // wildcard count (1) on both, and both match "packages/shared/x.ts" -
    // a genuine tie, with different tags, which precedence cannot resolve.
    const tie1 = { glob: "packages/shared/*", tags: ["one"] };
    const tie2 = { glob: "packages/shared/*.ts", tags: ["two"] };
    expect(() => classifyByGlob("packages/shared/x.ts", [tie1, tie2])).toThrow(AmbiguousClassifyError);
  });

  test("the tie error names the file and both globs, in its message and in its do: command", () => {
    const tie1 = { glob: "packages/shared/*", tags: ["one"] };
    const tie2 = { glob: "packages/shared/*.ts", tags: ["two"] };
    for (const entries of [[tie1, tie2], [tie2, tie1]]) {
      let thrown: unknown;
      try {
        classifyByGlob("packages/shared/x.ts", entries);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AmbiguousClassifyError);
      const error = thrown as AmbiguousClassifyError;
      for (const part of ["packages/shared/x.ts", tie1.glob, tie2.glob]) expect(error.message).toContain(`'${part}'`);
      for (const glob of [tie1.glob, tie2.glob]) expect(error.do).toContain(`'${glob}'`);
    }
  });

  test("two equally-specific entries whose tag lists differ only partly still throw, in either order", () => {
    const pairs: Array<[string[], string[]]> = [
      [["layer:a"], ["layer:a", "env:node"]],
      [["layer:a", "env:node"], ["layer:a", "env:browser"]],
    ];
    for (const [tags1, tags2] of pairs) {
      const tie1 = { glob: "packages/shared/*", tags: tags1 };
      const tie2 = { glob: "packages/shared/*.ts", tags: tags2 };
      for (const entries of [[tie1, tie2], [tie2, tie1]]) {
        expect(() => classifyByGlob("packages/shared/x.ts", entries), JSON.stringify(entries)).toThrow(AmbiguousClassifyError);
      }
    }
  });

  test("the same entry repeated, or two entries that happen to agree, is not ambiguous", () => {
    const a = { glob: "packages/shared/*", tags: ["one"] };
    const b = { glob: "packages/shared/*.ts", tags: ["one"] };
    expect(classifyByGlob("packages/shared/x.ts", [a, b])).toEqual(["one"]);
  });
});

describe("classifyByDirectoryName", () => {
  test("the nearest matching segment, walking from the file outward, wins", () => {
    const config = { tagNamespace: "env", names: ["common", "node"] };
    expect(classifyByDirectoryName("src/vs/platform/node/common/thing.ts", config)).toEqual(["env:common"]);
    expect(classifyByDirectoryName("src/vs/platform/node/thing.ts", config)).toEqual(["env:node"]);
    expect(classifyByDirectoryName("src/vs/platform/thing.ts", config)).toEqual([]);
  });

  test("a matching directory at the project root tags the file", () => {
    expect(classifyByDirectoryName("browser/thing.ts", { tagNamespace: "env", names: ["browser"] })).toEqual(["env:browser"]);
  });
});

describe("classifyFile", () => {
  test("glob and directory-name tags union", () => {
    const tags = classifyFile("packages/2-sql/5-runtime/x.ts", {
      classify: [{ glob: "packages/2-sql/5-runtime/**", tags: ["domain:sql"] }],
      classifyByDirectoryName: { tagNamespace: "env", names: ["5-runtime"] },
    });
    expect([...tags].sort()).toEqual(["domain:sql", "env:5-runtime"]);
  });

  test("without classifyByDirectoryName, a file carries only its classify tags", () => {
    expect([...classifyFile("packages/core/x.ts", { classify: [{ glob: "packages/core/**", tags: ["domain:core"] }] })]).toEqual(["domain:core"]);
    expect(classifyFile("packages/core/x.ts", {}).size).toBe(0);
  });
});
