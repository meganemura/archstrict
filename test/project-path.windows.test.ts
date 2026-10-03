// Responsibility: verify graph path spelling with the Windows path adapter.
// Boundary: this adapter check does not access a Windows filesystem.
import { expect, test, vi } from "vitest";

vi.mock("node:path", async (importOriginal) => {
  const path = await importOriginal<typeof import("node:path")>();
  return { ...path, sep: "\\", relative: path.win32.relative };
});

import { makeProjectRelativePosix } from "../src/project-path.js";

test("Windows graph paths use POSIX separators for descendants and sibling paths", () => {
  const relative = makeProjectRelativePosix("C:\\workspace\\project");
  expect(relative("C:\\workspace\\project\\src\\a.ts")).toBe("src/a.ts");
  expect(relative("C:\\workspace\\other\\file.ts")).toBe("../other/file.ts");
  expect(relative("C:\\workspace\\project")).toBe("");
  expect(relative("C:\\workspace\\project\\src\\a.ts")).toBe("src/a.ts");
});
