#!/usr/bin/env node
// Responsibility: reproduce the Prisma oracle comparison (archstrict's
// converted config vs dependency-cruiser's real domain/plane/layer rules)
// through the actual shipped CLI (dist/cli.js check --json), not by
// calling checkAllowDeny/checkOrder/checkPoint directly against a
// buildModuleGraph result - an earlier measurement did that, before
// check/todo could consume declaredModules/edges at all. Copies the clone
// into a disposable scratch directory; never writes into the clone itself.
//
// One declared module covering the whole `packages/**` tree, not one per
// real Prisma package: buildModuleGraph only collects a file's own edges
// when the file resolves to SOME declared module (an undeclared file's
// imports never reach graph.edges at all, only outsideFiles) - so the
// constraint engine needs every real file declared, but rules 1/2/6 only
// care about module identity, not tags, so 123 separate modules would
// flood the report with public-surface-bypass noise unrelated to this
// comparison. One catch-all module (with a surface name nothing can ever
// match) means rule 1 has no cross-module edges to flag (there is only
// one module) and rule 6 walks no files at all - both structurally zero,
// not vacuously passing.
//
// Usage: node scripts/run-prisma-oracle.mjs <path-to-real-prisma-clone>
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { convertPrismaArchitectureConfig } from "./convert-prisma-architecture-config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, "..", "dist", "cli.js");

// dependency-cruiser.config.mjs's own real `exclude.path` list (regex
// fragments matched anywhere in the path), translated to archstrict's
// glob shape by hand - a mismatch here is a real drift to notice, same as
// any other vendored fixture. `**/*.test-d.ts` matters specifically: an
// earlier measurement's 78 false positives all came from test files this
// exact entry excludes.
const EXCLUDE = [
  "**/*.test.ts",
  "**/*.test-d.ts",
  "**/*.spec.ts",
  "**/test/**",
  "**/*.config.*",
  "**/*.d.ts",
  "**/dist/**",
  "**/coverage/**",
  "packages/document/**",
  "*.ts", // this scratch's own root-level archstrict.config.ts
];

function runCheck(scratch) {
  try {
    const stdout = execFileSync("node", [CLI_PATH, "check", "--json"], {
      cwd: scratch,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 128,
    });
    return JSON.parse(stdout);
  } catch (error) {
    return JSON.parse(error.stdout);
  }
}

function report(label, result) {
  const counts = {};
  for (const v of result.violations) counts[v.rule] = (counts[v.rule] ?? 0) + 1;
  console.log(`\n--- ${label} ---`);
  console.log(`modules: ${result.modules}, edges: ${result.edges}, outsideFiles: ${result.outsideFiles}`);
  console.log(`unresolvedSpecifiers: ${result.unresolvedSpecifiers}, unsupportedSyntax: ${result.unsupportedSyntax}`);
  console.log(`violations by rule:`, counts);
  return counts;
}

function writeConfig(scratch, classify, edges, extraPoint) {
  const edgesWithControl = extraPoint === undefined ? edges : { ...edges, point: [...(edges.point ?? []), extraPoint] };
  writeFileSync(
    join(scratch, "archstrict.config.ts"),
    `import type { Config } from "./archstrict.types.js";\n\n` +
      `export default {\n` +
      `  configPath: "<oracle>",\n` +
      `  because: "reproduces the Prisma oracle comparison through the real CLI, not a direct function call",\n` +
      `  declaredModules: [{ name: "packages", glob: "packages/**", surface: "__archstrict_oracle_no_surface__.ts" }],\n` +
      `  exclude: ${JSON.stringify(EXCLUDE)},\n` +
      `  classify: ${JSON.stringify(classify, null, 2)},\n` +
      `  edges: ${JSON.stringify(edgesWithControl, null, 2)},\n` +
      `} satisfies Config;\n`,
  );
}

function main() {
  const clonePath = process.argv[2];
  if (clonePath === undefined || !existsSync(join(clonePath, "architecture.config.json"))) {
    console.error("usage: run-prisma-oracle.mjs <path-to-real-prisma-clone> (must contain architecture.config.json)");
    process.exitCode = 1;
    return;
  }

  const archConfig = JSON.parse(readFileSync(join(clonePath, "architecture.config.json"), "utf8"));
  const { classify, edges } = convertPrismaArchitectureConfig(archConfig);

  const scratch = mkdtempSync(join(tmpdir(), "archstrict-prisma-oracle-"));
  try {
    console.error(`copying ${clonePath} -> ${scratch} (node_modules is large; this takes a while)...`);
    cpSync(clonePath, scratch, {
      recursive: true,
      filter: (src) => !src.split("/").includes(".git"),
    });

    writeConfig(scratch, classify, edges, undefined);
    const baseline = report("baseline (converted config, no control)", runCheck(scratch));

    // Positive control. A cross-*package* edge (e.g. sql importing
    // framework) does NOT work as a control: measured directly, every
    // real workspace-to-workspace specifier in this clone is unresolved
    // without a full `pnpm build` (package.json `exports` point at dist/
    // output that doesn't exist from install alone - a known, previously
    // recorded caveat), so module-graph.ts never creates an edge for one
    // at all; a point rule targeting that direction would trivially read
    // 0 whether or not the engine works. A resolvable npm dependency
    // (`pathe`, a real, unremarkable dependency many packages import) is
    // real, resolves without a build step, and forbidding it must produce
    // many point-rule violations - if it doesn't, the engine isn't
    // actually seeing real edges, and the baseline's 0 above means nothing.
    writeConfig(scratch, classify, edges, {
      from: "packages/**",
      to: { tags: ["pkg:pathe"] },
      because: "positive control only - forbidding a real, common dependency; this oracle run's own sanity check, not a real project rule",
    });
    const control = report("positive control (importing 'pathe' forbidden)", runCheck(scratch));

    console.log(`\nsanity: baseline point-rule count = ${baseline["point-rule"] ?? 0} (expected 0)`);
    console.log(`sanity: control point-rule count = ${control["point-rule"] ?? 0} (expected > 0 - proves real edges are seen)`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main();
