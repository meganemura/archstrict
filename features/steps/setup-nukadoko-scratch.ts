import { defineStep, z } from "nukadoko";
import { cpSync, existsSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BUILTIN_MODULE_NAMES = new Set(builtinModules);

// The package name a bare specifier's own top-level directory would be
// under node_modules - "@scope/pkg/subpath" -> "@scope/pkg", "pkg/subpath"
// -> "pkg". Independent of archstrict's own module-graph.ts (the same
// two-line rule, not a shared import), matching this step's own stated
// purpose: check archstrict's report against a count taken directly off
// the filesystem, not against the same code twice.
function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!;
}

// Every bare (non-relative) import/export-from specifier under `srcDir`,
// naming neither a node builtin nor a package this environment actually has
// installed - nukadoko's own real source names its optional peer
// dependencies (@modelcontextprotocol/client and playwright), which
// archstrict does not install, so this is a real, expected count for a
// fresh install, not archstrict failing to resolve something it should.
function countUnresolvableSpecifiers(srcDir: string, nodeModulesDir: string): number {
  // Only a real import/export statement, not `from "..."` inside a comment
  // or a prose string (this codebase is heavily commented, and a naive
  // content-wide regex matched things like `// ...from "no browser"`). The
  // statement starts a line with `import` or `export` and may span lines
  // up to its `from`: nukadoko's own src/context/browser-evidence.ts lists
  // its imported names one per line, so a per-line match missed its
  // `} from "playwright"` line.
  const BARE_SPECIFIER = /^[ \t]*(?:import|export)\b[^;"'`]*?\bfrom\s+["']([^."'][^"']*)["']/gm;
  let count = 0;
  function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith(".ts")) continue;
      for (const match of readFileSync(full, "utf8").matchAll(BARE_SPECIFIER)) {
        const specifier = match[1]!;
        const bare = specifier.replace(/^node:/, "");
        if (BUILTIN_MODULE_NAMES.has(bare)) continue;
        const pkg = packageNameOf(specifier);
        if (!existsSync(join(nodeModulesDir, pkg))) count++;
      }
    }
  }
  walk(srcDir);
  return count;
}

// nukadoko ships its own TypeScript source alongside dist/ - copying from
// node_modules/nukadoko/src (not a live sibling checkout) means this scenario
// runs on any machine that ran npm install, needs no environment variable
// naming a checkout, and never writes anywhere near a real nukadoko working
// tree. It also happens to match the project's own measured shape (24
// module dirs, 182 files) exactly, so no separate fixture had to be built by
// hand.
const NUKADOKO_SRC = fileURLToPath(new URL("../../node_modules/nukadoko/src", import.meta.url));
const ARCHSTRICT_NODE_MODULES = fileURLToPath(new URL("../../node_modules", import.meta.url));

// A symlinked node_modules lets nukadoko's own bare-specifier imports
// (@cucumber/*, zod, allure-js-commons, ...) resolve inside the scratch copy
// without a second npm install. moduleDirs, rootFileCount,
// modulesWithoutIndexTs, and expectedUnresolvedSpecifiers are computed here,
// independently of anything archstrict itself reports, so later Then steps
// compare check's output against a count this step took directly off the
// filesystem rather than trusting the same tool twice.
export default defineStep({
  description:
    "Copies nukadoko's own published src/ into a scratch project - a snapshot with no public-surface convention, entirely disposable, and never written back to.",
  pattern: "the nukadoko package's own published src exists as a scratch copy",
  args: z.object({}),
  returns: z.object({
    root: z.string().describe("the scratch project's root directory"),
    moduleDirs: z.array(z.string()).describe("the module directory names copied from nukadoko's src/, sorted"),
    rootFileCount: z
      .number()
      .describe("how many .ts files sit directly under src/, outside every module directory"),
    modulesWithoutIndexTs: z
      .number()
      .describe(
        "how many module directories have no index.ts of their own - a handful of nukadoko's own module directories (matching/, compat/, mcp/) happen to have one as a barrel file, unrelated to archstrict's convention, and archstrict's default surface name is index.ts, so those coincidentally already have a public surface",
      ),
    expectedUnresolvedSpecifiers: z
      .number()
      .describe(
        "bare specifiers naming neither a node builtin nor a package this environment has installed - nukadoko's own real source names its optional peer dependencies (@modelcontextprotocol/client, playwright), which are not part of archstrict's own install, so this is legitimately nonzero",
      ),
  }),
  run({ scratch }) {
    const root = scratch.dir("archstrict-nukadoko-dogfood");
    cpSync(NUKADOKO_SRC, join(root, "src"), { recursive: true });
    symlinkSync(ARCHSTRICT_NODE_MODULES, join(root, "node_modules"));
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify(
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
      ),
    );

    const srcDir = join(root, "src");
    const entries = readdirSync(srcDir);
    const moduleDirs = entries.filter((name) => statSync(join(srcDir, name)).isDirectory()).sort();
    const rootFileCount = entries.filter((name) => name.endsWith(".ts") && statSync(join(srcDir, name)).isFile()).length;
    const modulesWithoutIndexTs = moduleDirs.filter((name) => !existsSync(join(srcDir, name, "index.ts"))).length;
    const expectedUnresolvedSpecifiers = countUnresolvableSpecifiers(srcDir, ARCHSTRICT_NODE_MODULES);

    return { root, moduleDirs, rootFileCount, modulesWithoutIndexTs, expectedUnresolvedSpecifiers };
  },
});
