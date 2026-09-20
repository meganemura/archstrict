#!/usr/bin/env node
// Responsibility: convert Prisma 8's real architecture.config.json shape
// (packages: [{glob, domain, layer, plane}], rules, crossDomainRules,
// planeRules, crossDomainExceptions, layerOrder - vendored as a fixture,
// not fetched over the network) into v1's classify + edges shape. Not
// general-purpose beyond this one real shape - a second config with a
// different structure needs its own converter, not a flag on this one.
//
// Mapping:
// - `packages` -> one classify entry per glob, tags domain:/layer:/plane:.
// - `crossDomainRules` -> one allowDeny entry per domain, targetNamespace
//   "domain", `allow` from mayImportFrom (dependency-cruiser's own
//   createCrossDomainRules only ever reads mayImportFrom, never a forbid
//   form for this axis).
// - `planeRules` -> one allowDeny entry per plane, targetNamespace
//   "plane", `deny` from `forbid` (dependency-cruiser's own
//   createPlaneRules reads only `.forbid`, never `.allow` - Prisma's own
//   config carries both redundantly, but only one drives real
//   enforcement).
// - `layerOrder` -> one order rule, tagNamespace "layer", within "domain",
//   its `sequence` the layerOrder object verbatim (already keyed by
//   domain, exactly this project's own `within`-scoped shape).
export function convertPrismaArchitectureConfig(archConfig) {
  const classify = archConfig.packages.map((pkg) => ({
    glob: pkg.glob,
    tags: [`domain:${pkg.domain}`, `layer:${pkg.layer}`, `plane:${pkg.plane}`],
  }));

  const allowDeny = [];
  for (const [domain, rule] of Object.entries(archConfig.crossDomainRules ?? {})) {
    allowDeny.push({
      source: `domain:${domain}`,
      targetNamespace: "domain",
      allow: rule.mayImportFrom,
      because: rule.reason,
    });
  }
  for (const [plane, rule] of Object.entries(archConfig.planeRules ?? {})) {
    if (rule.forbid === undefined || rule.forbid.length === 0) continue;
    allowDeny.push({
      source: `plane:${plane}`,
      targetNamespace: "plane",
      deny: rule.forbid,
      exceptions: (rule.exceptions ?? []).map((ex) => ({
        from: ex.from,
        to: ex.to,
        because: ex.because ?? "declared plane exception",
      })),
      because: `the ${plane} plane must not depend on: ${rule.forbid.join(", ")}`,
    });
  }

  const order =
    archConfig.layerOrder === undefined
      ? []
      : [
          {
            tagNamespace: "layer",
            within: "domain",
            sequence: archConfig.layerOrder,
            direction: "downward-only",
            because: "dependencies flow toward core; lateral within a layer is allowed",
          },
        ];

  return { classify, edges: { allowDeny, order } };
}

async function main() {
  const [, , inputPath, outputPath] = process.argv;
  if (inputPath === undefined) {
    console.error("usage: convert-prisma-architecture-config.mjs <architecture.config.json> [output.ts]");
    process.exitCode = 1;
    return;
  }
  const { readFileSync, writeFileSync } = await import("node:fs");
  const archConfig = JSON.parse(readFileSync(inputPath, "utf8"));
  const { classify, edges } = convertPrismaArchitectureConfig(archConfig);
  const contents = `import type { Config } from "./archstrict.generated.js";

export default {
  configPath: "<generated>",
  because: "converted from architecture.config.json",
  scope: "packages/**",
  classify: ${JSON.stringify(classify, null, 2)},
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
