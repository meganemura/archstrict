// Responsibility: specify which characters separate directory names when
// classifyByDirectoryName walks a path, on a POSIX platform and on Windows.
// The platform separator is replaced per test, so the file passes the same
// way on any host.
// Boundary: which directory name wins and how globs match are specified in
// classify.test.ts; this file only varies the path separator.
import { afterEach, describe, expect, test, vi } from "vitest";

type PathModule = typeof import("node:path");

async function classifyByDirectoryNameOn(separator: "/" | "\\") {
  vi.resetModules();
  vi.doMock("node:path", async (importOriginal) => ({ ...(await importOriginal<PathModule>()), sep: separator }));
  const { classifyByDirectoryName } = await import("../src/classify.js");
  return classifyByDirectoryName;
}

afterEach(() => {
  vi.doUnmock("node:path");
  vi.resetModules();
});

const config = { tagNamespace: "env", names: ["browser"] };

describe("classifyByDirectoryName path separators", () => {
  // Windows treats either character as a separator, so a native Windows
  // path must reach the directory names inside it.
  test("on Windows, a backslash and a forward slash both separate directory names", async () => {
    const classify = await classifyByDirectoryNameOn("\\");
    expect(classify("src\\browser\\thing.ts", config)).toEqual(["env:browser"]);
    expect(classify("src/browser/thing.ts", config)).toEqual(["env:browser"]);
    expect(classify("src\\browser/thing.ts", config)).toEqual(["env:browser"]);
  });

  // A POSIX file name may contain a backslash, so "a\browser" is one
  // directory named that way, not a "browser" directory nested in "a".
  test("on POSIX, a backslash belongs to the directory name and does not separate it", async () => {
    const classify = await classifyByDirectoryNameOn("/");
    expect(classify("src/a\\browser/thing.ts", config)).toEqual([]);
    expect(classify("src/browser/thing.ts", config)).toEqual(["env:browser"]);
  });
});
