// Responsibility: verify managed instructions without damaging surrounding bytes or symlinks.
// Boundary: uses disposable directories and the built CLI; never edits repository instructions.
import { describe, expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { lstatSync, readFileSync, readlinkSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { agents, ARCHSTRICT_INSTRUCTIONS_BLOCK, ARCHSTRICT_SECTION_START, ARCHSTRICT_SECTION_END } from "../src/verbs/agents.js";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");
const expectedBlock = `<!-- ARCHSTRICT_START -->
## archstrict

In projects with an \`archstrict.config.ts\` (module-boundary/architecture linting), run \`archstrict rules <path>\` BEFORE creating a file or adding an import - it reports the module, tags, and constraints that would govern that path, even before it exists. Run \`archstrict check\` after editing to confirm.

If there is no \`archstrict.config.ts\`, skip archstrict entirely - it may not be installed here.
<!-- ARCHSTRICT_END -->`;

function withProject(fn: (root: string, shared: string) => void): void {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-agents-")));
  const root = join(temp, "project");
  const shared = join(temp, "shared");
  mkdirSync(root);
  mkdirSync(shared);
  try { fn(root, shared); } finally { rmSync(temp, { recursive: true, force: true }); }
}

function runCli(root: string, args: string[] = []) {
  return spawnSync(process.execPath, [cli, "agents", ...args], { cwd: root, encoding: "utf8" });
}

describe("agents", () => {
  test("creates, replaces idempotently, and removes a block-only file", () => withProject((root) => {
    const path = join(root, "AGENTS.md");
    expect(agents(root)).toEqual({ state: "created", path });
    expect(readFileSync(path, "utf8")).toBe(expectedBlock + "\n");
    const first = readFileSync(path);
    expect(agents(root).state).toBe("replaced");
    expect(readFileSync(path)).toEqual(first);
    expect(agents(root, true)).toEqual({ state: "removed", path });
    expect(readFileSync(path, "utf8")).toBe("");
  }));

  test("remove leaves absent and unmarked files untouched", () => withProject((root) => {
    const path = join(root, "AGENTS.md");
    expect(agents(root, true)).toEqual({ state: "already-absent", path });
    expect(existsSync(path)).toBe(false);
    writeFileSync(path, "# Other instructions\r\n");
    const stat = lstatSync(path);
    expect(agents(root, true)).toEqual({ state: "no-markers", path });
    expect(readFileSync(path, "utf8")).toBe("# Other instructions\r\n");
    expect(lstatSync(path).mtimeMs).toBe(stat.mtimeMs);
  }));

  test("fixed instructions are independent of config content", () => withProject((root) => {
    expect(ARCHSTRICT_INSTRUCTIONS_BLOCK).toBe(expectedBlock);
    for (const word of ["declaredModules", "classify", "edges"]) expect(expectedBlock).not.toContain(word);
    writeFileSync(join(root, "archstrict.config.ts"), "export default { declaredModules: [], classify: [], edges: {} };\n");
    agents(root);
    const before = readFileSync(join(root, "AGENTS.md"));
    writeFileSync(join(root, "archstrict.config.ts"), "This is deliberately not valid TypeScript.");
    agents(root);
    expect(readFileSync(join(root, "AGENTS.md"))).toEqual(before);
  }));

  test("CLI preserves an external target link and the target's existing content", () => withProject((root, shared) => {
    const path = join(root, "AGENTS.md");
    const target = join(shared, "instructions.md");
    writeFileSync(target, "# Shared instructions\n");
    symlinkSync(target, path);
    const link = readlinkSync(path);
    const inode = lstatSync(path).ino;
    const result = runCli(root, ["--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ state: "appended", path: target });
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(lstatSync(path).ino).toBe(inode);
    expect(readlinkSync(path)).toBe(link);
    expect(readFileSync(target, "utf8")).toBe("# Shared instructions\n\n\n" + expectedBlock + "\n");
    writeFileSync(target, "# Shared instructions\n\n\n" + ARCHSTRICT_SECTION_START + "\nstale\n" + ARCHSTRICT_SECTION_END + "\n");
    const replaced = runCli(root, ["--json"]);
    expect(replaced.status).toBe(0);
    expect(JSON.parse(replaced.stdout)).toEqual({ state: "replaced", path: target });
    expect(lstatSync(path).ino).toBe(inode);
    expect(readlinkSync(path)).toBe(link);
    expect(readFileSync(target, "utf8")).toBe("# Shared instructions\n\n\n" + expectedBlock + "\n");
    expect(runCli(root, ["--remove", "--json"]).status).toBe(0);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("# Shared instructions\n");
  }));

  test("relative link chains and dangling targets retain every link", () => withProject((root, shared) => {
    const path = join(root, "AGENTS.md");
    const middle = join(shared, "link.md");
    const target = join(shared, "new", "instructions.md");
    symlinkSync("../shared/link.md", path);
    symlinkSync("new/instructions.md", middle);
    expect(agents(root, true)).toEqual({ state: "already-absent", path: target });
    expect(existsSync(target)).toBe(false);
    expect(agents(root)).toEqual({ state: "created", path: target });
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(lstatSync(middle).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path)).toBe("../shared/link.md");
    expect(readlinkSync(middle)).toBe("new/instructions.md");
    expect(readFileSync(target, "utf8")).toBe(expectedBlock + "\n");
  }));

  test("link cycles report an error without replacing links", () => withProject((root) => {
    const path = join(root, "AGENTS.md");
    symlinkSync("other.md", path);
    symlinkSync("AGENTS.md", join(root, "other.md"));
    expect(() => agents(root)).toThrow(/agents: symlink cycle detected/);
    const result = runCli(root, ["--json"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain("symlink cycle detected");
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path)).toBe("other.md");
  }));

  test.each([
    ARCHSTRICT_SECTION_START + " incomplete",
    ARCHSTRICT_SECTION_END + ARCHSTRICT_SECTION_START,
    expectedBlock + expectedBlock,
  ])("ambiguous markers preserve the file", (contents) => withProject((root) => {
    const path = join(root, "AGENTS.md");
    writeFileSync(path, contents);
    expect(() => agents(root)).toThrow(/markers/);
    expect(() => agents(root, true)).toThrow(/markers/);
    expect(readFileSync(path, "utf8")).toBe(contents);
  }));

  test("CLI text distinguishes successful states", () => withProject((root) => {
    const path = join(root, "AGENTS.md");
    const created = runCli(root);
    expect(created.status).toBe(0);
    expect(created.stdout).toBe(`created instructions in ${path}\n`);
    expect(runCli(root).stdout).toBe(`replaced instructions in ${path}\n`);
    expect(runCli(root, ["--remove"]).stdout).toBe(`removed instructions from ${path}\n`);
    expect(runCli(root, ["--remove"]).stdout).toBe(`no markers in ${path}; left unchanged\n`);
    rmSync(path);
    expect(runCli(root, ["--remove"]).stdout).toBe(`instructions absent at ${path}; left unchanged\n`);
    writeFileSync(path, "Other content");
    expect(runCli(root).stdout).toBe(`appended instructions to ${path}\n`);
  }));

  test.each(["\n", "\r\n"])("removal preserves neighboring sections with %j separators", (newline) => withProject((root) => {
    const path = join(root, "AGENTS.md");
    const separator = newline + newline;
    writeFileSync(path, "Before" + separator + expectedBlock + separator + "After");
    agents(root, true);
    expect(readFileSync(path, "utf8")).toBe("Before" + separator + "After");
    writeFileSync(path, expectedBlock + separator + "After");
    agents(root, true);
    expect(readFileSync(path, "utf8")).toBe("After");
  }));

  test("replacement preserves arbitrary surrounding bytes and is idempotent", () => {
    hegel.test((tc) => withProject((root) => {
      const prefix = Buffer.from(tc.draw(gen.binary()));
      const suffix = Buffer.from(tc.draw(gen.binary()));
      for (const marker of [ARCHSTRICT_SECTION_START, ARCHSTRICT_SECTION_END]) {
        tc.assume(!prefix.includes(marker) && !suffix.includes(marker));
      }
      const original = Buffer.concat([prefix, Buffer.from(ARCHSTRICT_SECTION_START + "\nold\n" + ARCHSTRICT_SECTION_END), suffix]);
      const path = join(root, "AGENTS.md");
      writeFileSync(path, original);
      expect(agents(root).state).toBe("replaced");
      const expected = Buffer.concat([prefix, Buffer.from(expectedBlock), suffix]);
      expect(readFileSync(path)).toEqual(expected);
      agents(root);
      expect(readFileSync(path)).toEqual(expected);
    }));
  });

  test("appending then removing restores arbitrary unmarked bytes", () => {
    hegel.test((tc) => withProject((root) => {
      const original = Buffer.from(tc.draw(gen.binary()));
      tc.assume(!original.includes(ARCHSTRICT_SECTION_START) && !original.includes(ARCHSTRICT_SECTION_END));
      const path = join(root, "AGENTS.md");
      writeFileSync(path, original);
      expect(agents(root).state).toBe("appended");
      expect(agents(root, true).state).toBe("removed");
      expect(readFileSync(path)).toEqual(original);
    }));
  });
});
