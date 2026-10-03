// Responsibility: verify that every verb's project walk skips gitignored
// paths the way git itself decides them, and that a declared module can
// still ask for an ignored path.
// Boundary: git is spawned here only as an oracle; the walk never spawns it.
import { expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { isEligibleSourceFile, listAnalyzedFiles, prepareGraph, toProjectRelativePosix } from "../src/module-graph.js";
import { forcedBasesOf, gitignoreStackAbove, isIgnoredBy, isPathGitignored, nextIgnoreState, withGitignoreFile } from "../src/gitignore.js";
import { check } from "../src/verbs/check.js";
import { init } from "../src/verbs/init.js";

async function project(run: (root: string, put: (path: string, content?: string) => void) => void | Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-gitignore-")));
  const put = (path: string, content = "export const value = 1;\n") => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  put("tsconfig.json", JSON.stringify({ compilerOptions: { noLib: true, types: [] } }));
  try { await run(root, put); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

function analyzed(root: string, declaredModules: { name: string; glob: string }[] = []): string[] {
  return listAnalyzedFiles(root, [], declaredModules).map((f) => toProjectRelativePosix(f, root)).sort();
}

test("a gitignored tmp/ holding .ts files produces no uncovered-module, in init and in check", () => project(async (root, put) => {
  put(".gitignore", "tmp/\n");
  put("src/app/index.ts");
  for (let i = 0; i < 5; i++) put(`tmp/corpus/case${i}.ts`);
  const initResult = await init(root);
  expect(initResult.moduleNames).toEqual(["app"]);
  expect(initResult.uncovered).toEqual([]);
  const result = await check(root);
  expect(result.violations.filter((v) => v.rule === "uncovered-module")).toEqual([]);
}));

test("a negated pattern keeps a file the pattern before it ignores", () => project((root, put) => {
  put(".gitignore", "generated/*\n!generated/keep.ts\n");
  put("generated/drop.ts");
  put("generated/keep.ts");
  expect(analyzed(root)).toEqual(["generated/keep.ts"]);
}));

test("a nested .gitignore applies to its own directory only", () => project((root, put) => {
  put("src/a/.gitignore", "scratch.ts\n");
  put("src/a/scratch.ts");
  put("src/a/index.ts");
  put("src/b/scratch.ts");
  expect(analyzed(root)).toEqual(["src/a/index.ts", "src/b/scratch.ts"]);
}));

// A plain name matches at any depth, so only an anchored pattern shows where
// a pattern's path starts. git starts it at the directory that holds the
// pattern's own ignore file; for info/exclude, that is the repository root.
// Every expected path is the answer `git check-ignore` gives for this tree.
test("an anchored pattern is relative to the directory of its own ignore file", () => project((root, put) => {
  put(".git/info/exclude", "/scratch.ts\nout/gen.ts\n");
  put("src/a/.gitignore", "/scratch.ts\ngen/*.ts\n");
  for (const file of [
    "scratch.ts", "src/scratch.ts", "out/gen.ts", "src/out/gen.ts", "src/index.ts",
    "src/a/scratch.ts", "src/a/b/scratch.ts", "src/a/gen/x.ts", "src/a/b/gen/x.ts", "src/a/index.ts",
  ]) put(file);
  expect(analyzed(root)).toEqual([
    "src/a/b/gen/x.ts", "src/a/b/scratch.ts", "src/a/index.ts", "src/index.ts", "src/out/gen.ts", "src/scratch.ts",
  ]);
}));

test("info/exclude and a .gitignore above the project root both apply", () => project((root, put) => {
  put(".git/info/exclude", "local-only/\n");
  put(".gitignore", "packages/web/tmp/\n");
  put("packages/web/src/index.ts");
  put("packages/web/tmp/scratch.ts");
  put("packages/web/local-only/note.ts");
  const web = join(root, "packages/web");
  expect(analyzed(web)).toEqual(["src/index.ts"]);
}));

// A linked worktree's .git is a file that points at its own git directory,
// and the info/exclude that git applies there lives in the main repository's
// git directory. An agent that works in a worktree must see the same file set
// that git sees there.
test("info/exclude of the main repository applies inside a linked worktree", () => project((root, put) => {
  // The global git config must not reach these commands: a signing key or a
  // hook there would run on every commit this test makes.
  const git = (cwd: string, ...args: string[]) => execFileSync("git",
    ["-c", "user.name=archstrict", "-c", "user.email=archstrict@example.invalid", ...args],
    { cwd, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  const main = join(root, "main");
  mkdirSync(main);
  git(main, "init", "-q");
  git(main, "commit", "-q", "--allow-empty", "-m", "init");
  git(main, "worktree", "add", "-q", "../wt");
  put("main/.git/info/exclude", "local-only/\n");
  put("wt/src/index.ts");
  put("wt/local-only/note.ts");
  const worktree = join(root, "wt");
  expect(gitCheckIgnore(worktree, ["local-only/note.ts", "src/index.ts"])).toEqual(["local-only/note.ts"]);
  expect(analyzed(worktree)).toEqual(["src/index.ts"]);
}));

test("a project root inside an ignored directory is still analyzed", () => project((root, put) => {
  put(".git/HEAD", "ref: refs/heads/main\n");
  put(".gitignore", "tmp/\n");
  put("tmp/experiment/src/index.ts");
  expect(analyzed(join(root, "tmp/experiment"))).toEqual(["src/index.ts"]);
}));

test("a declared module whose base is gitignored stays analyzed, and config.exclude still wins", () => project((root, put) => {
  put(".gitignore", "generated/\n");
  put("generated/api/client.ts");
  put("generated/other/x.ts");
  const declaredModules = [{ name: "api", glob: "generated/api/**" }];
  expect(analyzed(root, declaredModules)).toEqual(["generated/api/client.ts"]);
  expect(prepareGraph({ projectRoot: root, declaredModules }).rootNames.map((f) => toProjectRelativePosix(f, root)))
    .toEqual(["generated/api/client.ts"]);
  expect(listAnalyzedFiles(root, ["generated/**"], declaredModules)).toEqual([]);
}));

test("simulate's check for a proposed new file agrees with the walk", () => project((root, put) => {
  put(".gitignore", "tmp/\n*.gen.ts\n!keep.gen.ts\n");
  const eligible = (rel: string) => isEligibleSourceFile(join(root, rel), root, [], [], ["index.ts"]);
  expect(eligible("tmp/new.ts")).toBe(false);
  expect(eligible("src/a.gen.ts")).toBe(false);
  expect(eligible("src/keep.gen.ts")).toBe(true);
  expect(eligible("src/a.ts")).toBe(true);
}));

test("a gitignored path is still resolvable, so a checked-in file can import generated output", () => project((root, put) => {
  put(".gitignore", "src/generated/\n");
  put("src/generated/api.ts");
  const prepared = prepareGraph({ projectRoot: root, declaredModules: [{ name: "src", glob: "src/**" }] });
  expect(prepared.rootNames).toEqual([]);
  expect(prepared.resolvableFiles.map((f) => toProjectRelativePosix(f, root))).toContain("src/generated/api.ts");
}));

// `git check-ignore` exits 1 when it reports nothing; that is an answer too.
function gitCheckIgnore(root: string, files: string[]): string[] {
  try {
    return execFileSync("git", ["-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "--stdin"], {
      cwd: root, input: files.join("\n"), encoding: "utf8",
    }).split("\n").filter(Boolean);
  } catch (error) {
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

// Property: for any small set of patterns and paths, the walk keeps exactly
// the files `git check-ignore` does not report.
test("the walk agrees with git check-ignore", async () => {
  const name = gen.sampledFrom(["a", "b", "tmp", "keep.ts", "x.ts", "y.gen.ts"]);
  const pattern = gen.sampledFrom([
    "tmp/", "/tmp", "tmp", "*.gen.ts", "!keep.ts", "!x.ts", "a/**", "**/b", "a/*.ts", "a/**/x.ts",
    "/a/b/", "b/", "!a/", "*.ts", "!*.gen.ts", "x.ts", "?.ts", "[ab]/x.ts", "\\#x.ts", "# comment", "", "!tmp/keep.ts",
  ]);
  await hegel.testAsync((tc) => project((root, put) => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    const patterns = tc.draw(gen.arrays(pattern, { maxSize: 5 }));
    const nested = tc.draw(gen.arrays(pattern, { maxSize: 3 }));
    const paths = [...new Set(tc.draw(gen.arrays(gen.arrays(name, { minSize: 1, maxSize: 3 }), { minSize: 1, maxSize: 6 }))
      .map((parts) => `${parts.join("/")}.ts`.replace(/\.ts\.ts$/, ".ts")))];
    // A path that is also another path's directory cannot exist as a file.
    const files = paths.filter((p) => !paths.some((q) => q.startsWith(`${p}/`)));
    put(".gitignore", `${patterns.join("\n")}\n`);
    put("a/.gitignore", `${nested.join("\n")}\n`);
    for (const file of files) put(file);
    const ignored = new Set(gitCheckIgnore(root, files));
    expect(analyzed(root)).toEqual(files.filter((f) => !ignored.has(f)).sort());
  }), { testCases: 40 });
});

test("empty ignore files preserve inherited ignore decisions", () => project((root, put) => {
  put(".git/info/exclude", "# local comments\n");
  expect(isIgnoredBy(gitignoreStackAbove(root), "src/index.ts", false)).toBe(false);
  const stack = withGitignoreFile([], "", "*.log\n");
  const nested = withGitignoreFile(stack, "src", "# comments\n\n");
  expect(isIgnoredBy(nested, "src/build.log", false)).toBe(true);
  expect(isIgnoredBy(nested, "src/index.ts", false)).toBe(false);
}));

test("a later patterned exception overrides an earlier literal directory rule", () => {
  const stack = withGitignoreFile([], "", "cache/\n!ca*/\n");
  expect(isIgnoredBy(stack, "cache", true)).toBe(false);
  expect(isIgnoredBy(stack, "cache", false)).toBe(false);
});

test("declared bases force their descendants through ignored parents", () => {
  const stack = withGitignoreFile([], "", "generated/\n*.ts\n");
  const bases = new Set(["generated/api"]);
  expect(nextIgnoreState("ignored", stack, "generated/api", true, bases)).toBe("forced");
  expect(nextIgnoreState("forced", stack, "generated/api/client.ts", false, bases)).toBe("forced");
  expect(nextIgnoreState("kept", [], "src", true, bases)).toBe("kept");
});

test("proposed files use nested ignore rules and distinguish files from directories", () => project((root, put) => {
  put("src/.gitignore", "*.gen.ts\ncache/\n");
  put("src/deep/.gitignore", "!keep.gen.ts\n");
  expect(isPathGitignored(root, "src/deep/drop.gen.ts", new Set())).toBe(true);
  expect(isPathGitignored(root, "src/deep/keep.gen.ts", new Set())).toBe(false);
  expect(isPathGitignored(root, "src/cache", new Set())).toBe(false);
  expect(isPathGitignored(root, "src/cache/new.ts", new Set())).toBe(true);
}));

test("nested exceptions cannot reinclude descendants of an ignored directory", () => project((root, put) => {
  put(".gitignore", "hidden/\n");
  put("hidden/.gitignore", "!new.ts\n");
  expect(isPathGitignored(root, "hidden/new.ts", new Set())).toBe(true);
  expect(isPathGitignored(root, "hidden/new.ts", new Set(["hidden"]))).toBe(false);
}));

test("directory rules preserve literal matches when a later directory name does not match", () => {
  const stack = withGitignoreFile([], "", "cache\nother/\n");
  expect(isIgnoredBy(stack, "cache", true)).toBe(true);
  expect(isIgnoredBy(stack, "other", true)).toBe(true);
  expect(isIgnoredBy(stack, "unlisted", true)).toBe(false);
});

test("declared bases omit the project-wide glob and expose strict parent paths", () => {
  const forced = forcedBasesOf(["", "generated/api/client", "src/app", "src/app"]);
  expect([...forced.bases].sort()).toEqual(["generated/api/client", "src/app"]);
  expect([...forced.ancestors].sort()).toEqual(["generated", "generated/api", "src"]);
});
