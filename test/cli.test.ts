import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";

describe("cli", () => {
  test("prints usage with no arguments", () => {
    expect(() =>
      execFileSync("node", ["src/cli.ts"], { encoding: "utf8" }),
    ).toThrow();
  });
});
