// Config validators report faulty fields and preserve valid config values.
// The loader supplies runtime values through the supported config boundary.
import { expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.js";
import { check, loadConfig } from "../src/verbs/check.js";

test("edge shape errors identify the faulty value and give the matching edit", async () => {
  const path = "/project/archstrict.config.ts";
  const valid = { declaredModules: [], because: "test" };
  const cases: { edges: unknown; message: string; remedy: string }[] = [
    { edges: null, message: "config.edges must be an object", remedy: "set config.edges to an object with allowDeny, order, and point" },
    { edges: "invalid", message: "config.edges must be an object", remedy: "set config.edges to an object with allowDeny, order, and point" },
    { edges: { typo: [] }, message: "config.edges has an unknown field 'typo' - supported fields are allowDeny, order, point", remedy: "remove 'typo' from config.edges" },
  ];
  for (const kind of ["allowDeny", "order", "point"]) {
    cases.push({ edges: { [kind]: {} }, message: `config.edges.${kind} must be an array of entries, not object`, remedy: `set config.edges.${kind} to an array of entries` });
    for (const entry of [null, "invalid", 4, [], true]) {
      cases.push({ edges: { [kind]: [entry] }, message: `config.edges.${kind}[0] must be an object`, remedy: `make config.edges.${kind}[0] an object` });
    }
    cases.push({ edges: { [kind]: [{ typo: "invalid" }] }, message: `config.edges.${kind}[0] has an unknown field 'typo'`, remedy: `remove 'typo' from config.edges.${kind}[0]` });
  }
  cases.push({ edges: { order: [{ tagNamespace: "layer", sequence: [], direction: "downward-only", because: "test" }] },
    message: "an edges.order entry's sequence must be an object", remedy: "set that sequence to an object keyed by the within scope" });
  for (const { edges, message, remedy } of cases) {
    await expect(loadConfig(path, `export default ${JSON.stringify({ ...valid, edges })};`)).rejects.toMatchObject({
      name: "ReportError", message: expect.stringContaining(message),
      do: `${remedy} in archstrict.config.ts, then run archstrict check`,
    });
  }
  const edges = { order: [{ tagNamespace: "layer", direction: "downward-only", because: "test" }] };
  expect(await loadConfig(path, `export default ${JSON.stringify({ ...valid, edges })};`)).toEqual({ ...valid, edges, configPath: path });
});

test("glob arrays report the exact offending member after supported members", async () => {
  await hegel.testAsync(async tc => {
    const character = tc.draw(gen.sampledFrom(["{", "}", "(", ")", "[", "]", "?", "!"]));
    const preceding = tc.draw(gen.integers({ minValue: 0, maxValue: 4 }));
    const field = tc.draw(gen.sampledFrom(["glob", "surface"]));
    const values = [...Array.from({ length: preceding }, (_, index) => `src/app/valid${index}.ts`), `src/app/bad${character}.ts`];
    const module = field === "glob"
      ? { name: "app", glob: values }
      : { name: "app", glob: "src/app/**", surface: values };
    const raw = { declaredModules: [module], because: "test" };
    const path = "/project/archstrict.config.ts";
    const key = `declaredModules[0].${field}[${preceding}]`;
    await expect(loadConfig(path, `export default ${JSON.stringify(raw)};`, "archstrict map")).rejects.toMatchObject({
      name: "ReportError", message: expect.stringContaining(`field '${key}' has an unsupported glob 'src/app/bad${character}.ts'`),
      do: `rewrite '${key}' in ${path} using only * and **, or split it into one entry per directory, in archstrict.config.ts, then run archstrict map`,
    });
    const supported = { declaredModules: [{ name: "app", glob: ["src/app/a.ts", "src/app/b.ts"], surface: ["index.ts", "types.ts"] }], because: "test" };
    expect(await loadConfig(path, `export default ${JSON.stringify(supported)};`)).toEqual({ ...supported, configPath: path });
  }, { testCases: 50 });
});

test("glob validation skips null optional entries and still checks later string globs", async () => {
  const path = "/project/archstrict.config.ts";
  const cases = [
    { classify: [null, { glob: "src/bad?.ts", tags: ["layer:app"] }], field: "classify[1].glob" },
    { mustBeEmpty: [null, { glob: "src/bad?.ts", because: "empty" }], field: "mustBeEmpty[1].glob" },
    { declaredModules: [{ name: "app", glob: "src/app/**", friends: [null, { file: "bad?.ts", from: "src/**", because: "friend" }] }], field: "declaredModules[0].friends[1].file" },
  ];
  for (const { field, ...fields } of cases) {
    const raw = { declaredModules: [], because: "test", ...fields };
    await expect(loadConfig(path, `export default ${JSON.stringify(raw)};`)).rejects.toMatchObject({
      name: "ReportError", message: expect.stringContaining(`field '${field}' has an unsupported glob`),
    });
  }
});

test("deprecated module errors name the missing module and its declaration remedy", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archstrict-config-validation-")));
  try {
    const configPath = join(root, "archstrict.config.ts");
    writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"noLib":true,"types":[]}}');
    writeFileSync(configPath, 'export default { declaredModules: [], because: "test", deprecated: [{ from: "removed", to: "other", count: 0, because: "retire" }] };');
    await expect(check(root)).rejects.toMatchObject({
      name: "ReportError",
      message: "deprecated entry 'removed -> other' names module 'removed', which does not exist",
      do: `declare 'removed' in ${configPath}, or remove that deprecated entry, then run archstrict check`,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("glob validation skips absent exception entries while naming later exception fields", async () => {
  for (const field of ["from", "to"]) {
    const exception = field === "from"
      ? { from: "src/bad?.ts", to: "src/**", because: "friend" }
      : { from: "src/**", to: "src/bad?.ts", because: "friend" };
    const raw = { declaredModules: [], because: "test", edges: { allowDeny: [{
      source: "layer:a", targetNamespace: "layer", allow: ["b"], because: "layers", exceptions: [null, exception],
    }] } };
    await expect(loadConfig("/project/archstrict.config.ts", `export default ${JSON.stringify(raw)};`)).rejects.toMatchObject({
      name: "ReportError", message: expect.stringContaining(`field 'edges.allowDeny[0].exceptions[1].${field}' has an unsupported glob`),
    });
  }
});

test("the loader preserves optional edge filters and an order scope for every rule kind", async () => {
  const edges = {
    allowDeny: [{ source: "layer:app", targetNamespace: "layer", allow: ["ui"],
      edgeType: "value", importForm: "static", because: "layers" }],
    order: [{ tagNamespace: "layer", within: "domain", sequence: { billing: ["app", "ui"] },
      direction: "downward-only", edgeType: "value", importForm: "static", because: "order" }],
    point: [{ from: "src/app/**", to: "src/ui/**", edgeType: "value", importForm: "static", because: "point" }],
  } satisfies NonNullable<Config["edges"]>;
  const config = await loadConfig("/project/archstrict.config.ts", `export default ${JSON.stringify({
    declaredModules: [], because: "test", edges,
  })};`);
  expect(config.edges).toEqual(edges);
});
