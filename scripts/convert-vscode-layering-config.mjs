#!/usr/bin/env node
// Responsibility: convert VS Code's real code-layering.ts table (a layer
// name -> the other layer names it may access - vendored as a fixture,
// not fetched over the network) into v1's classifyByDirectoryName +
// edges.allowDeny shape. Not general-purpose beyond this one real shape.
//
// Mapping: classifyByDirectoryName's `names` is the table's own key set
// (the ambient tagging convention code-layering.ts itself implements: the
// nearest matching directory-name segment becomes the tag). One allowDeny
// entry per layer, `allow` from its own allowed-list. Same-layer access
// needs no entry of its own - checkAllowDeny's own composition rule
// already exempts a target sharing the source's own tag (code-layering.ts
// only makes this explicit by `.add(parts[i])`; this project's engine
// gets it for free from the same-group rule every allowDeny entry shares).
export function convertVSCodeLayeringConfig(layeringTable) {
  const names = Object.keys(layeringTable);
  const classifyByDirectoryName = { tagNamespace: "env", names };

  const allowDeny = names.map((layer) => ({
    source: `env:${layer}`,
    targetNamespace: "env",
    allow: layeringTable[layer],
    because: `${layer} may only reach: ${layeringTable[layer].join(", ") || "(nothing outside its own layer)"}`,
  }));

  return { classifyByDirectoryName, edges: { allowDeny } };
}

async function main() {
  const [, , inputPath, outputPath] = process.argv;
  if (inputPath === undefined) {
    console.error("usage: convert-vscode-layering-config.mjs <code-layering-table.json> [output.ts]");
    process.exitCode = 1;
    return;
  }
  const { readFileSync, writeFileSync } = await import("node:fs");
  const table = JSON.parse(readFileSync(inputPath, "utf8"));
  const { classifyByDirectoryName, edges } = convertVSCodeLayeringConfig(table);
  const contents = `import type { Config } from "./archstrict.generated.js";

export default {
  configPath: "<generated>",
  modules: "src/vs/*",
  kinds: { flat: "src/vs/*" },
  because: "converted from code-layering.ts's own table",
  scope: "src/vs/**",
  classifyByDirectoryName: ${JSON.stringify(classifyByDirectoryName, null, 2)},
  edges: ${JSON.stringify(edges, null, 2)},
} satisfies Config;
`;
  if (outputPath === undefined) {
    process.stdout.write(contents);
  } else {
    writeFileSync(outputPath, contents);
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main();
}
