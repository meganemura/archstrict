// Responsibility: verify path identities against the compiler's spelling.
// Boundary: separator injection tests Windows behavior without filesystem access.
import { expect, test } from "vitest";
import ts from "typescript";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { toTypeScriptPath } from "../src/project-path.js";

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
