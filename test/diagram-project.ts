// Scratch projects for the diagram tests: a fixture's config and file list, with empty files,
// because the diagram reads file names and never their contents.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const REPO = resolve(import.meta.dirname, "..");
export const FIXTURES = join(REPO, "test", "fixtures", "diagram");

export function materialize(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `archstrict-diagram-${name}-`));
  copyFileSync(join(FIXTURES, name, "archstrict.config.ts"), join(dir, "archstrict.config.ts"));
  for (const rel of readFileSync(join(FIXTURES, name, "files.txt"), "utf8").split("\n").filter(Boolean)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), "export {};\n");
  }
  return dir;
}
