// Detects whether a repository declares import-boundary rules in a root
// config file. It reads every root-level config file by content instead of
// matching known file names, so it is not tied to any one tool; its answer is
// a lead for a human to read, not a verdict (a rule restricting a single
// third-party package matches too).
//
// usage as a script: node survey/declared.mjs <repoDir>   (prints JSON)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_FILE = /^\.?[\w.-]*\.(json|jsonc|js|cjs|mjs|ts|cts|mts|ya?ml|toml)$|^\.[\w-]+rc$/;
// Rule names and keys that restrict imports between paths or tags.
const RESTRICTION = /restricted-?imports|restricted-?paths|module-?boundaries|depConstraints|forbidden\s*:/i;
// A file whose name itself says it holds boundary or layering rules.
const DEDICATED = /boundar|architecture|layer|depend[a-z-]*rc|depend[a-z-]*\.config/i;
const SKIP = /^(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig[\w.-]*\.json|renovate\.json|lerna\.json|turbo\.json|vercel\.json|netlify\.toml|codecov\.ya?ml)$/;

export function detectDeclared(root) {
  const found = [];
  let names = [];
  try { names = readdirSync(root); } catch { return found; }
  for (const name of names.sort()) {
    if (!CONFIG_FILE.test(name) || SKIP.test(name)) continue;
    const file = join(root, name);
    let text;
    try { if (!statSync(file).isFile() || statSync(file).size > 512_000) continue; text = readFileSync(file, "utf8"); } catch { continue; }
    if (DEDICATED.test(name) && RESTRICTION.test(text)) found.push("dedicated boundary config file at the repository root");
    else if (RESTRICTION.test(text)) found.push("import-restriction rules in a root config file");
  }
  // File names are left out on purpose: the report names no tool, and a
  // config file name usually names one.
  return [...new Set(found)];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(detectDeclared(process.argv[2])));
