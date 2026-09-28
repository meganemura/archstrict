// Responsibility: keep the rule positive-control commands executable.
// Boundary: this test reads the published reference and runs its JSON change sets through the built CLI.
import { expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const reference = join(repoRoot, "skills", "archstrict", "references", "prove-rules.md");
const cli = join(repoRoot, "dist", "cli.js");

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

test("each documented positive control fires its rule at the changed config entry", () => {
  const root = mkdtempSync(join(tmpdir(), "archstrict-prove-rules-"));
  try {
    put(root, "tsconfig.json", JSON.stringify({ compilerOptions: { noLib: true, types: [], module: "nodenext", target: "esnext" } }));
    put(root, "package.json", '{"type":"module"}');
    put(root, "archstrict.config.ts", `export default ${JSON.stringify({
      declaredModules: ["app", "domain", "ui", "core"].map(name => ({ name, glob: `src/${name}/**`, surface: "index.ts" })),
      exclude: ["*.ts"],
      classify: [
        { glob: "src/app/**", tags: ["role:app"] },
        { glob: "src/domain/**", tags: ["role:domain", "layer:domain"] },
        { glob: "src/ui/**", tags: ["layer:ui"] },
        { glob: "src/core/**", tags: ["layer:core"] },
      ],
      edges: {
        allowDeny: [{ source: "role:app", targetNamespace: "role", deny: ["domain"], because: "Keep app independent from domain." }],
        order: [{ tagNamespace: "layer", sequence: { "": ["core", "domain", "ui"] }, direction: "downward-only", because: "Keep layers ordered." }],
        point: [{ from: "src/app/**", to: "src/core/internal.ts", because: "Keep core internals private." }],
      },
      because: "Declare the fixture modules.",
    })};`);
    for (const name of ["app", "domain", "ui", "core"]) put(root, `src/${name}/index.ts`, "export const value = 1;\n");
    put(root, "src/domain/internal.ts", "export const hidden = 1;\n");
    put(root, "src/core/internal.ts", "export const hidden = 1;\n");

    const source = readFileSync(reference, "utf8");
    const bodies = [...source.matchAll(/printf '%s\\n' '(\{"changes"[^']+\})' \| archstrict simulate --json/g)].map(match => match[1]!);
    expect(bodies).toHaveLength(4);
    const expected = [
      ["tag-boundary", "edges.allowDeny[0].deny[0]", "fired"],
      ["tag-order", "edges.order[0].sequence", "fired"],
      ["point-rule", "edges.point[0]", "fired"],
      ["public-surface-bypass", "declaredModules[1]", "governs"],
    ];
    bodies.forEach((body, index) => {
      const output = spawnSync(process.execPath, [cli, "simulate", "--json"], { cwd: root, encoding: "utf8", input: body });
      expect(output.status).toBe(1);
      const result = JSON.parse(output.stdout);
      const violation = result.added.find((value: { rule: string }) => value.rule === expected[index]![0]);
      const pointers = Array.isArray(violation?.config) ? violation.config : [violation?.config];
      expect(pointers.some((pointer: { pointer?: string; role?: string }) =>
        pointer?.pointer === expected[index]![1] && pointer.role === expected[index]![2])).toBe(true);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
