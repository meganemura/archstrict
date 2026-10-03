// Responsibility: verify compiler spelling and absolute/project-relative paths.
// Boundary: separator injection tests Windows behavior without filesystem access.
import { expect, test } from "vitest";
import ts from "typescript";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { toTypeScriptPath, makeAbsolutePosix, makeProjectRelativePosix } from "../src/project-path.js";

const windowsPaths = gen.tuples(
  gen.sampledFrom(["C", "D", "z"]),
  gen.arrays(gen.text({ alphabet: "abcXYZ012_-é", minSize: 1, maxSize: 30 }), { minSize: 1, maxSize: 10 }),
).map(([drive, parts]) => `${drive}:\\${parts.join("\\")}`);

test("Windows conversion is idempotent", () => hegel.test(tc => {
  const path = tc.draw(windowsPaths);
  const once = toTypeScriptPath(path, "\\");
  expect(toTypeScriptPath(once, "\\")).toBe(once);
}));

test("Windows conversion removes every backslash", () => hegel.test(tc => {
  expect(toTypeScriptPath(tc.draw(gen.text()), "\\")).not.toContain("\\");
}));

test("POSIX conversion preserves the input", () => hegel.test(tc => {
  const path = tc.draw(gen.text());
  expect(toTypeScriptPath(path, "/")).toBe(path);
}));

test("Windows conversion agrees with TypeScript", () => hegel.test(tc => {
  const path = tc.draw(windowsPaths);
  // The compiler exports this oracle at runtime but omits its public type.
  const compiler = ts as typeof ts & { normalizePath(path: string): string };
  expect(toTypeScriptPath(path, "\\")).toBe(compiler.normalizePath(path));
}));

test("absolute inputs replace the project root and retain their own anchor", () => {
  const absolute = makeAbsolutePosix("/workspace/project");
  expect(absolute("/other/file.ts")).toBe("/other/file.ts");
  expect(absolute("D:/other/file.ts")).toBe("D:/other/file.ts");
  expect(absolute("//server/share/file.ts")).toBe("//server/share/file.ts");
  expect(absolute("//server/share")).toBe("//server/share/");
});

test("empty root segments do not consume parent traversal", () => {
  expect(makeAbsolutePosix("C:/workspace//project/")("../file.ts")).toBe("C:/workspace/file.ts");
  expect(makeAbsolutePosix("//server/share/workspace//project/")("../file.ts")).toBe("//server/share/workspace/file.ts");
  expect(makeAbsolutePosix("/workspace//project/")("../file.ts")).toBe("/workspace/file.ts");
  expect(makeAbsolutePosix("///workspace/project")("file.ts")).toBe("/workspace/project/file.ts");
});

test("POSIX names that contain drive text retain their parent directories", () => {
  expect(makeAbsolutePosix("/workspace/C:/project")("file.ts")).toBe("/workspace/C:/project/file.ts");
  expect(makeAbsolutePosix("/workspace//server/share")("file.ts")).toBe("/workspace/server/share/file.ts");
  expect(makeAbsolutePosix("/workspace\\project")("file.ts")).toBe("/workspace\\project/file.ts");
});

test("native descendants round trip through project-relative cache paths", () => {
  const segment = gen.text({ alphabet: "abcXYZ012_-", minSize: 1, maxSize: 12 });
  hegel.test((tc) => {
    const directories = tc.draw(gen.arrays(segment, { minSize: 1, maxSize: 5 }));
    const rel = `${directories.join("/")}/file.ts`;
    const absolute = `/workspace/project/${rel}`;
    expect(makeProjectRelativePosix("/workspace/project")(absolute)).toBe(rel);
    expect(makeAbsolutePosix("/workspace/project")(rel)).toBe(absolute);
  });
});

test("dot segments disappear while named POSIX backslashes remain literal", () => {
  expect(makeAbsolutePosix("/workspace/project")("./src/./file.ts")).toBe("/workspace/project/src/file.ts");
  expect(makeAbsolutePosix("/workspace/project")("src\\name/file.ts")).toBe("/workspace/project/src\\name/file.ts");
  expect(makeAbsolutePosix("/workspace/C:/project\\name")("file.ts")).toBe("/workspace/C:/project\\name/file.ts");
});

test("Windows drive and network roots normalize separators in roots and relative inputs", () => {
  expect(makeAbsolutePosix(String.raw`C:\workspace\project`)(String.raw`src\file.ts`)).toBe("C:/workspace/project/src/file.ts");
  expect(makeAbsolutePosix(String.raw`z:\workspace\project`)(String.raw`src\file.ts`)).toBe("z:/workspace/project/src/file.ts");
  expect(makeAbsolutePosix(String.raw`\\server\share\project`)(String.raw`src\file.ts`)).toBe("//server/share/project/src/file.ts");
});
