// Properties of the two map-shape detectors: a module that holds almost
// every file, and the bypass share on top of that. The thresholds are
// shared by init, recommend, check, and todo, so a drift here would
// change every verb's note at once.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import {
  DOMINANT_MIN_BYPASSES,
  DOMINANT_MIN_FILES,
  childDirectoryAdvice,
  childDirectoryCounts,
  dominantBypassModule,
  dominantByFiles,
  shareAtLeast,
} from "../src/verbs/map-shape.js";

describe("dominantByFiles (property)", () => {
  test("selects the largest module only when it holds at least 4/5 of the files and the minimum count", () => {
    hegel.test((tc) => {
      const count = tc.draw(gen.integers({ minValue: 1, maxValue: 8 }));
      const modules = Array.from({ length: count }, (_, index) => ({
        name: `m${index}`,
        files: tc.draw(gen.integers({ minValue: 0, maxValue: 24 })),
      }));
      const total = modules.reduce((sum, module) => sum + module.files, 0);
      const max = modules.reduce((best, module) => Math.max(best, module.files), 0);
      const winner = modules.filter((module) => module.files === max).map((module) => module.name).sort()[0];
      const result = dominantByFiles(modules);
      if (max >= DOMINANT_MIN_FILES && shareAtLeast(max, total)) {
        assert.equal(result?.name, winner);
        assert.equal(result?.files, max);
        assert.equal(result?.totalFiles, total);
      } else {
        assert.equal(result, undefined);
      }
    });
  });

  test("adding files to the selected module keeps it selected", () => {
    hegel.test((tc) => {
      const modules = [
        { name: "core", files: tc.draw(gen.integers({ minValue: DOMINANT_MIN_FILES, maxValue: 30 })) },
        { name: "edge", files: tc.draw(gen.integers({ minValue: 0, maxValue: 3 })) },
      ];
      const before = dominantByFiles(modules);
      if (before === undefined) return;
      const extra = tc.draw(gen.integers({ minValue: 0, maxValue: 10 }));
      const after = dominantByFiles(modules.map((module) =>
        module.name === before.name ? { ...module, files: module.files + extra } : module));
      assert.equal(after?.name, before.name);
      assert.ok((after?.files ?? 0) >= before.files);
    });
  });
});

describe("dominantBypassModule (property)", () => {
  test("adding bypasses to an already selected module keeps it selected", () => {
    hegel.test((tc) => {
      const modules = [
        { name: "core", files: tc.draw(gen.integers({ minValue: DOMINANT_MIN_FILES, maxValue: 40 })) },
        { name: "app", files: 1 },
      ];
      const other = tc.draw(gen.integers({ minValue: 0, maxValue: 4 }));
      const own = DOMINANT_MIN_BYPASSES + tc.draw(gen.integers({ minValue: 0, maxValue: 12 }));
      // Own bypasses start at the minimum and at least 4/5 of the total,
      // so the module is selected before the extra bypasses land.
      const bypasses = new Map<string, number>([["core", Math.max(own, other * 4)], ["app", other]]);
      const before = dominantBypassModule(modules, bypasses);
      assert.equal(before?.name, "core");
      const extra = tc.draw(gen.integers({ minValue: 0, maxValue: 15 }));
      const after = dominantBypassModule(modules, new Map([["core", bypasses.get("core")! + extra], ["app", other]]));
      assert.equal(after?.name, "core");
      assert.equal(after?.bypasses, before!.bypasses + extra);
    });
  });
});

describe("childDirectoryCounts (property)", () => {
  test("a sibling file is not a child, and a nested file counts in its first directory", () => {
    hegel.test((tc) => {
      const dir = tc.draw(gen.sampledFrom(["src/core", ""]));
      const child = tc.draw(gen.sampledFrom(["api", "db"]));
      const sibling = dir === "" ? "root.ts" : `${dir}/root.ts`;
      const nested = dir === "" ? `${child}/a.ts` : `${dir}/${child}/a.ts`;
      const counts = childDirectoryCounts(dir, [sibling, nested, nested]);
      assert.deepEqual(counts, [{ name: child, files: 2 }]);
      const advice = childDirectoryAdvice("core", dir, counts);
      const glob = dir === "" ? `${child}/**` : `${dir}/${child}/**`;
      assert.equal(advice.includes(glob), true);
      assert.equal(childDirectoryAdvice("core", dir, []), "'core' has no child directory. Group the sibling files that change together");
    });
  });
});
