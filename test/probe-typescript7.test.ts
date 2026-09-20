import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(new URL("../scripts/probe-typescript7.mjs", import.meta.url));

// This project's own test environment has no typescript 7 installed (only
// the pinned 6.0.3 dependency) - exactly the environment npm test always
// runs in, and exactly the case this test can verify without a second,
// conflicting typescript install of its own. The CI job that actually
// installs typescript 7.0.2 first (.github/workflows/ci.yml) is what
// exercises the real, live measurement; this test guards the always-safe
// fallback every other run of this script hits.
describe("scripts/probe-typescript7.mjs", () => {
  test("never fails, and reports both surfaces as not attempted when typescript 7 isn't installed", () => {
    const stdout = execFileSync("node", [SCRIPT_PATH], { encoding: "utf8" });
    const summary = JSON.parse(stdout);

    expect(summary["unstable/ast"].attempted).toBe(false);
    expect(summary["unstable/ast"].reason).toContain("import failed");
    expect(summary["unstable/sync"].attempted).toBe(false);
    expect(summary["unstable/sync"].reason).toContain("import failed");
  });
});
