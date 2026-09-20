#!/usr/bin/env node
// Responsibility: reproduce the VS Code oracle comparison (code-layering.ts's
// real environment-layering rule vs archstrict's converted config) through
// the actual shipped CLI (dist/cli.js check --json), not by calling
// checkAllowDeny directly against a buildModuleGraph result the way an
// earlier measurement did. Copies src/ into a disposable scratch directory
// (never writes into the clone itself, never symlinks src/ - a symlinked
// directory's sf.fileName may not match what ts.createProgram realpaths,
// measured directly while building the Prisma oracle script). Unlike the
// Prisma oracle, no node_modules copy is needed: code-layering.ts's own
// rule is pure static analysis over directory names and import
// specifiers, no package resolution required.
//
// One declared module covering the whole `src/vs/**` tree, for the same
// reason the Prisma oracle script uses one: a file only enters graph.edges
// at all once it resolves to some declared module, but rules 1/2/6 only
// care about module identity, not tags, so declaring VS Code's ~180 real
// directories individually would flood the report with public-surface-
// bypass noise unrelated to this comparison.
//
// Usage: node scripts/run-vscode-oracle.mjs <path-to-real-vscode-clone>
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { convertVSCodeLayeringConfig } from "./convert-vscode-layering-config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, "..", "dist", "cli.js");
// Vendored, not read from the clone's own eslint.config.js (a JS object
// literal embedded in a huge config file, not a standalone data file) -
// hand-verified to match the clone's current 'local/code-layering' rule
// options byte-for-byte; re-diff by hand if VS Code's own layering table
// ever changes.
const LAYERING_TABLE_PATH = join(HERE, "..", "test", "fixtures", "vendored", "vscode-code-layering.json");

const EXCLUDE = ["**/test/**", "**/*.test.ts"];

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "esnext",
      module: "nodenext",
      moduleResolution: "nodenext",
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
  },
  null,
  2,
);

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

function writeConfig(scratch, classifyByDirectoryName, edges, controlAllowDeny) {
  const allowDeny = controlAllowDeny === undefined ? edges.allowDeny : [...edges.allowDeny, controlAllowDeny];
  writeFileSync(
    join(scratch, "archstrict.config.ts"),
    `import type { Config } from "./archstrict.types.js";\n\n` +
      `export default {\n` +
      `  configPath: "<oracle>",\n` +
      `  because: "reproduces the VS Code oracle comparison through the real CLI, not a direct function call",\n` +
      `  declaredModules: [{ name: "vs", glob: "src/vs/**", surface: "__archstrict_oracle_no_surface__.ts" }],\n` +
      `  exclude: ${JSON.stringify(EXCLUDE)},\n` +
      `  classifyByDirectoryName: ${JSON.stringify(classifyByDirectoryName, null, 2)},\n` +
      `  edges: { allowDeny: ${JSON.stringify(allowDeny, null, 2)} },\n` +
      `} satisfies Config;\n`,
  );
}

function main() {
  const clonePath = process.argv[2];
  if (clonePath === undefined || !existsSync(join(clonePath, "src", "vs"))) {
    console.error("usage: run-vscode-oracle.mjs <path-to-real-vscode-clone> (must contain src/vs)");
    process.exitCode = 1;
    return;
  }

  const table = JSON.parse(readFileSync(LAYERING_TABLE_PATH, "utf8"));
  const { classifyByDirectoryName, edges } = convertVSCodeLayeringConfig(table);

  const scratch = mkdtempSync(join(tmpdir(), "archstrict-vscode-oracle-"));
  try {
    console.error(`copying ${join(clonePath, "src")} -> ${scratch}/src ...`);
    mkdirSync(join(scratch, "src"));
    cpSync(join(clonePath, "src"), join(scratch, "src"), { recursive: true });
    writeFileSync(join(scratch, "tsconfig.json"), TSCONFIG);

    writeConfig(scratch, classifyByDirectoryName, edges, undefined);
    const baseline = report("baseline (converted config, no control)", runCheck(scratch));

    // Positive control: env:browser importing env:common is real and
    // extremely common (normally allowed) - forbidding it with an
    // allowDeny override (allow: []) must produce many tag-boundary
    // violations. If it doesn't, the engine isn't seeing real edges.
    writeConfig(scratch, classifyByDirectoryName, edges, {
      source: "env:browser",
      targetNamespace: "env",
      allow: [],
      because: "positive control only - browser importing common is real and allowed; this oracle run's own sanity check, not a real project rule",
    });
    const control = report("positive control (env:browser forbidden from everything)", runCheck(scratch));

    console.log(`\nsanity: baseline tag-boundary count = ${baseline["tag-boundary"] ?? 0} (expected 0)`);
    console.log(`sanity: control tag-boundary count = ${control["tag-boundary"] ?? 0} (expected > 0 - proves real edges are seen)`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main();
