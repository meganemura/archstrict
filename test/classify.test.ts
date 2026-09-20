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
import { classifyByGlob, classifyByDirectoryName, classifyFile, AmbiguousClassifyError } from "../src/classify.js";

describe("design fixtures typecheck and load", () => {
  test("prisma-shape, vscode-shape, and nukadoko-shape all satisfy Config", () => {
    expect(prismaShape.scope).toBe("packages/**");
    expect(vscodeShape.classifyByDirectoryName?.tagNamespace).toBe("env");
    expect(nukadokoShape.declaredModules).toHaveLength(4);
  });
});

describe("classifyByGlob", () => {
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
});

describe("classifyFile", () => {
  test("glob and directory-name tags union", () => {
    const tags = classifyFile("packages/2-sql/5-runtime/x.ts", {
      classify: [{ glob: "packages/2-sql/5-runtime/**", tags: ["domain:sql"] }],
      classifyByDirectoryName: { tagNamespace: "env", names: ["5-runtime"] },
    });
    expect([...tags].sort()).toEqual(["domain:sql", "env:5-runtime"]);
  });
});
