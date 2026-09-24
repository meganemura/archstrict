import { describe, expect, test } from "vitest";
import { fingerprintOf, readTodo, todoPath, writeTodo } from "../src/todo-store.js";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { existsSync, mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { buildModuleGraph } from "../src/module-graph.js";
import { runRules, applyTodo } from "../src/verbs/check.js";

describe("todoPath", () => {
  // A file-shaped module root must never produce `<file>/archstrict.todo.json`:
  // that path is what makes `todo` throw ENOTDIR. A directory root keeps the
  // in-directory file so existing modules do not move their todo.
  test("a file root stores the todo beside the file; a directory root stores it inside", () => {
    hegel.test(tc => {
      const name = tc.draw(gen.fromRegex("[a-z]{1,12}"));
      const asFile = tc.draw(gen.booleans());
      const root = mkdtempSync(join(tmpdir(), "archstrict-todo-path-"));
      try {
        const moduleRoot = join(root, asFile ? `${name}.ts` : name);
        if (asFile) writeFileSync(moduleRoot, "export const x = 1;\n");
        else mkdirSync(moduleRoot);

        const path = todoPath(moduleRoot);
        const entry = { fingerprint: "abc123abc123", rule: "public-surface-bypass", path: moduleRoot, evidence: "e" };
        writeTodo(moduleRoot, [entry]);
        expect(readTodo(moduleRoot)).toEqual([entry]);
        expect(existsSync(path)).toBe(true);
        if (asFile) {
          expect(path).toBe(join(root, `${name}.ts.archstrict.todo.json`));
          expect(path.startsWith(moduleRoot + sep)).toBe(false);
          expect(existsSync(join(moduleRoot, "archstrict.todo.json"))).toBe(false);
        } else {
          expect(path).toBe(join(moduleRoot, "archstrict.todo.json"));
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, { testCases: 20 });
  });
});

describe("fingerprintOf", () => {
  test("a cycle violation's fingerprint excludes path, so it survives which file's edge happened to be reported", () => {
    // A cycle's `path` names one arbitrary edge's file, not the cycle
    // itself - renaming that file (or the cycle picking a different edge
    // to report on a later run) must not un-freeze an already-frozen
    // cycle.
    const before = fingerprintOf({ rule: "cycle", path: "/src/a/module.ts", evidence: "a -> b -> c -> a" });
    const after = fingerprintOf({ rule: "cycle", path: "/src/a/renamed.ts", evidence: "a -> b -> c -> a" });
    expect(after).toBe(before);
  });

  test("a non-cycle violation's fingerprint does include path", () => {
    const a = fingerprintOf({ rule: "public-surface-bypass", path: "/src/app/a.ts", evidence: "x" });
    const b = fingerprintOf({ rule: "public-surface-bypass", path: "/src/app/b.ts", evidence: "x" });
    expect(a).not.toBe(b);
  });

  test("a type-leak violation's fingerprint excludes the mutable 'referenced by' suffix, so one more caller of an already-known leak doesn't reopen it", () => {
    const before = fingerprintOf({
      rule: "type-leak",
      path: "/src/m/index.ts",
      evidence: "'Internal', declared in 'src/m/hidden.ts', is never exported by name from module 'm' - referenced by 'A'",
    });
    const after = fingerprintOf({
      rule: "type-leak",
      path: "/src/m/index.ts",
      evidence: "'Internal', declared in 'src/m/hidden.ts', is never exported by name from module 'm' - referenced by 'A', 'B'",
    });
    expect(after).toBe(before);
  });

  test("a type-leak violation's fingerprint still distinguishes a genuinely different internal type", () => {
    const a = fingerprintOf({
      rule: "type-leak",
      path: "/src/m/index.ts",
      evidence: "'Internal', declared in 'src/m/hidden.ts', is never exported by name from module 'm' - referenced by 'A'",
    });
    const b = fingerprintOf({
      rule: "type-leak",
      path: "/src/m/index.ts",
      evidence: "'OtherInternal', declared in 'src/m/hidden.ts', is never exported by name from module 'm' - referenced by 'A'",
    });
    expect(a).not.toBe(b);
  });
});


test("a real legacy cycle stays frozen across diagnostic changes and file renames", () => {
  hegel.test(tc => {
    const renamed = `renamed${tc.draw(gen.fromRegex("[a-z]{1,12}"))}.ts`;
    const root = mkdtempSync(join(tmpdir(), "archstrict-cycle-todo-"));
    try {
      for (const name of ["a", "b"]) mkdirSync(join(root, "src", name), { recursive: true });
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { noLib: true, types: [] } }));
      writeFileSync(join(root, "src/a/work.ts"), 'import "../b/service.js";');
      writeFileSync(join(root, "src/b/service.ts"), 'import "../a/work.js";');
      const config = { configPath: join(root, "archstrict.config.ts"), because: "Keep modules independent.",
        declaredModules: ["a", "b"].map(name => ({ name, glob: `src/${name}/**`, surface: "*.ts" })) };
      const evaluate = () => {
        const graph = buildModuleGraph({ projectRoot: root, declaredModules: config.declaredModules });
        return { graph, result: runRules(graph, config) };
      };
      const before = evaluate();
      expect(before.result.violations).toHaveLength(1);
      const cycle = before.result.violations[0]!;
      const legacy = { rule: "cycle", path: cycle.path, evidence: "a -> b -> a" };
      const fingerprint = fingerprintOf(legacy);
      expect(fingerprintOf(cycle)).toBe(fingerprint);
      writeTodo(before.graph.modules.get("a")!.dir, [{ ...legacy, fingerprint }]);
      const frozen = applyTodo(before.graph, config, before.result);
      expect(frozen.todo).toBe(1);
      expect(frozen.violations).toEqual([]);

      renameSync(join(root, "src/a/work.ts"), join(root, "src/a", renamed));
      writeFileSync(join(root, "src/b/service.ts"), `import "../a/${renamed.replace(/\.ts$/, ".js")}";`);
      const after = evaluate();
      expect(after.result.violations).toHaveLength(1);
      const renamedCycle = after.result.violations[0]!;
      expect(renamedCycle.do).toContain(`src/a/${renamed}`);
      expect(renamedCycle.do).not.toBe(cycle.do);
      expect(fingerprintOf(renamedCycle)).toBe(fingerprint);
      const stillFrozen = applyTodo(after.graph, config, after.result);
      expect(stillFrozen.todo).toBe(1);
      expect(stillFrozen.violations).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, { testCases: 25 });
});
