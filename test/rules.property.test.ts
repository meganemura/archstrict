// Responsibility: compare projected restrictions with rule 7 on generated real imports.
// Boundary: uses graph edges as observations; destination checks read the public projection.
import { test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyFile, compileGlob } from "../src/classify.js";
import { buildModuleGraph, toProjectRelativePosix } from "../src/module-graph.js";
import { checkAllowDeny, checkOrder, checkPoint, matchesPredicate, type FromToPredicate } from "../src/rules/constraints.js";
import { rules, type RulesResult } from "../src/verbs/rules.js";
import type { Config } from "../src/config.js";

const cases = Number(process.env.ARCHSTRICT_PROJECTION_CASES ?? 20);

test("real rule 7 violations are forbidden by the source path's projection", async () => {
  const observed = { "tag-boundary": 0, "tag-order": 0, "point-rule": 0 };
  let completed = 0;
  await hegel.testAsync(async (tc) => {
    // Small complete graphs keep filesystem and TypeScript work bounded while
    // ensuring that each case exercises all three violation assertions.
    const count = tc.draw(gen.integers({ minValue: 2, maxValue: 4 }));
    const offset = tc.draw(gen.integers({ minValue: 0, maxValue: 10000 }));
    const names = Array.from({ length: count }, (_, i) => `m${offset + i}`);
    const sourceIndex = tc.draw(gen.integers({ minValue: 0, maxValue: count - 1 }));
    const targetIndex = (sourceIndex + 1) % count;
    const source = names[sourceIndex]!;
    const target = names[targetIndex]!;
    const useAllow = tc.draw(gen.booleans());
    const tagPoint = tc.draw(gen.booleans());
    const scoped = tc.draw(gen.booleans());
    const reverse = tc.draw(gen.booleans());
    const layers = names.map((_, i) => `l${i}`);
    const sequence = reverse ? [...layers].reverse() : layers;
    const restriction = useAllow
      ? { allow: names.filter((_, i) => i !== targetIndex && tc.draw(gen.booleans())) }
      : { deny: names.filter((_, i) => i === targetIndex || tc.draw(gen.booleans())) };
    const forms = names.map(() => names.map(() => tc.draw(gen.sampledFrom(["value", "type", "dynamic"] as const))));
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-projection-")));
    try {
      const cfg: Config = {
        configPath: join(root, "archstrict.config.ts"),
        declaredModules: names.map((name) => ({ name, glob: `src/${name}/**`, surface: "index.ts" })),
        exclude: ["*.ts"], because: "generated architecture",
        classify: names.map((name, i) => ({ glob: `src/${name}/**`, tags: [`group:${name}`, `layer:l${i}`, "scope:one"] })),
        edges: {
          allowDeny: [{ source: `group:${source}`, targetNamespace: "group", ...restriction, because: "group restriction",
            exceptions: [{ from: `src/${source}/**`, to: "never/**", because: "conditional exception" }] }],
          order: [{ tagNamespace: "layer", ...(scoped ? { within: "scope" } : {}), sequence: { [scoped ? "one" : ""]: sequence }, direction: "downward-only", because: "layer restriction" }],
          point: [{ from: tagPoint ? { tags: [`group:${source}`], exclude: { tags: ["role:exempt"] } } : `src/${source}/**`,
            to: tagPoint ? { tags: [`group:${target}`] } : `src/${target}/**`, because: "point restriction" }],
        },
      };
      for (const [i, name] of names.entries()) {
        mkdirSync(join(root, "src", name), { recursive: true });
        const imports = names.flatMap((other, j) => {
          if (i === j) return [];
          const specifier = `../${other}/index.js`;
          const form = forms[i]![j];
          return [form === "type" ? `import type { Shape as S${j} } from "${specifier}";`
            : form === "dynamic" ? `void import("${specifier}");`
            : `import { value as v${j} } from "${specifier}";`];
        });
        writeFileSync(join(root, "src", name, "index.ts"), imports.join("\n") + "\nexport const value = 1; export type Shape = { value: number };\n");
      }
      writeFileSync(cfg.configPath, `export default ${JSON.stringify(cfg)};`);
      const graph = buildModuleGraph({ projectRoot: root, declaredModules: cfg.declaredModules, exclude: cfg.exclude });
      assert.equal(graph.edges.length, count * (count - 1));
      const violations = [...checkAllowDeny(graph, cfg), ...checkOrder(graph, cfg), ...checkPoint(graph, cfg)];
      const projected = new Map<string, RulesResult>();
      const seen = new Set<string>();
      for (const violation of violations) {
        const edge = graph.edges.find((e) => e.fromFile === violation.path && e.fromPosition.line === violation.line && e.fromPosition.column === violation.column);
        assert.ok(edge);
        let projection = projected.get(violation.path);
        if (projection === undefined) {
          projection = await rules(root, violation.path);
          projected.set(violation.path, projection);
        }
        const targetRel = toProjectRelativePosix(edge.resolvedFile, root);
        const targetTags = classifyFile(targetRel, cfg);
        const sourceTags = classifyFile(toProjectRelativePosix(edge.fromFile, root), cfg);
        if (violation.rule === "tag-boundary") {
          assert.ok(projection.allowDenyConstraints.some((p) => {
            if (!sourceTags.has(p.source) || targetTags.has(p.source)) return false;
            if (p.exceptionsFromP.some((ex) => compileGlob(ex.to).test(targetRel))) return false;
            const values = [...targetTags].filter((tag) => tag.startsWith(`${p.targetNamespace}:`)).map((tag) => tag.slice(p.targetNamespace.length + 1));
            return values.some((value) => p.allow !== undefined ? !p.allow.includes(value) : p.deny?.includes(value));
          }));
        } else if (violation.rule === "tag-order") {
          assert.ok(projection.orderConstraints.some((p) => {
            const targetLayer = [...targetTags].find((tag) => tag.startsWith(`${p.tagNamespace}:`));
            return targetLayer !== undefined && !p.mayDependOn.includes(targetLayer.slice(p.tagNamespace.length + 1));
          }));
        } else {
          assert.ok(projection.pointConstraints.some((p) => {
            const predicate: FromToPredicate = p.forbiddenTo.startsWith("{") ? JSON.parse(p.forbiddenTo) : p.forbiddenTo;
            return matchesPredicate(predicate, targetRel, targetTags);
          }));
        }
        seen.add(violation.rule);
        observed[violation.rule]++;
      }
      assert.deepEqual([...seen].sort(), ["point-rule", "tag-boundary", "tag-order"]);
      completed++;
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, { testCases: cases });
  assert.ok(completed >= cases);
  for (const value of Object.values(observed)) assert.ok(value >= cases);
  console.log(`projection cases: ${completed}; violation assertions: ${JSON.stringify(observed)}`);
}, 180_000);
