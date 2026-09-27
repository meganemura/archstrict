// Responsibility: verify the lazy augmentation cache's validation and
// lossless storage independently from the focused type-leak integration.
// Boundary: project scanning and module resolution stay in module-graph.ts.
import { expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUGMENTATION_CACHE_SCHEMA,
  readAugmentationCache,
  writeAugmentationCache,
  type CachedAugmentationEntry,
} from "../src/augmentation-cache.js";

test("augmentation cache entries round-trip exactly", () => {
  const root = mkdtempSync(join(tmpdir(), "archstrict-augmentation-cache-"));
  const path = join(root, "node_modules/.cache/archstrict/augmentations.json");
  try {
    hegel.test((tc) => {
      const candidates = ["src/a.d.ts", "src/excluded.ts", "types/ambient.d.mts"];
      const selected = [...new Set(tc.draw(gen.arrays(gen.sampledFrom(candidates), { maxSize: candidates.length })))];
      const modes = [undefined, 1, 99] as const;
      const files: Record<string, CachedAugmentationEntry> = {};
      for (const candidate of selected) {
        const impliedNodeFormat = tc.draw(gen.sampledFrom(modes));
        const specifiers = tc.draw(gen.arrays(
          gen.tuples(gen.sampledFrom(["./a.js", "../b.js", "external-pkg"]), gen.sampledFrom(modes)),
          { maxSize: 3 },
        )).map(([specifier, mode]) => ({ specifier, mode }));
        files[join(root, candidate)] = {
          mtimeMs: tc.draw(gen.integers({ minValue: 0, maxValue: 10_000 })),
          size: tc.draw(gen.integers({ minValue: 0, maxValue: 10_000 })),
          optionsHash: tc.draw(gen.text({ alphabet: "0123456789abcdef", minSize: 64, maxSize: 64 })),
          ...(impliedNodeFormat === undefined ? {} : { impliedNodeFormat }),
          specifiers,
        };
      }
      writeAugmentationCache(path, "1.2.3", files);
      expect(readAugmentationCache(path, "1.2.3")?.files).toStrictEqual(files);
    }, { testCases: 30 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an augmentation cache with another schema is a silent miss", () => {
  const root = mkdtempSync(join(tmpdir(), "archstrict-augmentation-schema-"));
  const path = join(root, "augmentations.json");
  try {
    writeAugmentationCache(path, "1.2.3", {});
    const value = JSON.parse(readFileSync(path, "utf8"));
    value.schema = AUGMENTATION_CACHE_SCHEMA + 1;
    writeFileSync(path, JSON.stringify(value));
    expect(readAugmentationCache(path, "1.2.3")).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
