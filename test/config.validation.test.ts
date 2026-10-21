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
  cases.push({ edges: { allowDeny: [{ source: "layer:a", targetNamespace: "pkg", deny: ["x"], guard: "true", because: "test" }] },
    message: "config.edges.allowDeny[0].guard must be true or false, not string", remedy: "set config.edges.allowDeny[0].guard to true or false" });
  cases.push({ edges: { point: [{ from: "src/**", to: "lib/**", guard: 1, because: "test" }] },
    message: "config.edges.point[0].guard must be true or false, not number", remedy: "set config.edges.point[0].guard to true or false" });
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

test("an unknown key in any config entry is an error naming the key, the accepted keys, and the edit", async () => {
  const path = "/project/archstrict.config.ts";
  const module = { name: "a", glob: "src/a/**" };
  const valid = { declaredModules: [module], because: "test" };
  const cases: { config: object; context: string; key: string; accepted: string }[] = [
    { config: { ...valid, clasify: [] }, context: "config", key: "clasify",
      accepted: "schemaVersion, surface, deprecated, strict, ignoredCycles, because, scope, exclude, classify, classifyByDirectoryName, declaredModules, mustBeEmpty, edges" },
    { config: { ...valid, classify: [{ glob: "src/**", tag: "layer:a" }] }, context: "config.classify[0]", key: "tag", accepted: "glob, tags" },
    { config: { ...valid, classifyByDirectoryName: { tagNamespace: "env", name: ["node"] } }, context: "config.classifyByDirectoryName", key: "name", accepted: "tagNamespace, names" },
    { config: { ...valid, declaredModules: [{ ...module, surfce: "index.ts" }] }, context: "config.declaredModules[0]", key: "surfce", accepted: "name, glob, surface, friends" },
    { config: { ...valid, declaredModules: [{ ...module, friends: [{ file: "x.ts", form: "src/b/**", because: "test" }] }] },
      context: "config.declaredModules[0].friends[0]", key: "form", accepted: "file, from, because" },
    { config: { ...valid, deprecated: [{ from: "a", to: "a", count: 1, becuase: "test" }] }, context: "config.deprecated[0]", key: "becuase", accepted: "from, to, count, because" },
    { config: { ...valid, mustBeEmpty: [{ glob: "src/old/**", because: "test", note: "x" }] }, context: "config.mustBeEmpty[0]", key: "note", accepted: "glob, because" },
    { config: { ...valid, edges: { allowDeny: [{ source: "layer:a", targetNamespace: "layer", deny: ["b"], because: "test", exceptions: [{ from: "a", too: "b", because: "test" }] }] } },
      context: "config.edges.allowDeny[0].exceptions[0]", key: "too", accepted: "from, to, because" },
    { config: { ...valid, edges: { point: [{ from: { tags: ["layer:a"], exlude: { tags: ["layer:b"] } }, to: "src/**", because: "test" }] } },
      context: "config.edges.point[0].from", key: "exlude", accepted: "tags, exclude" },
    { config: { ...valid, edges: { point: [{ from: { tags: ["layer:a"], exclude: { tag: ["layer:b"] } }, to: "src/**", because: "test" }] } },
      context: "config.edges.point[0].from.exclude", key: "tag", accepted: "tags" },
    { config: { ...valid, edges: { point: [{ from: "src/**", to: { tags: ["layer:b"], exclude: { tags: ["layer:c"] } }, because: "test" }] } },
      context: "config.edges.point[0].to", key: "exclude", accepted: "tags" },
  ];
  for (const { config, context, key, accepted } of cases) {
    await expect(loadConfig(path, `export default ${JSON.stringify(config)};`), context).rejects.toMatchObject({
      name: "ReportError",
      message: `${context} has an unknown field '${key}' - supported fields are ${accepted}`,
      do: `remove '${key}' from ${context} in archstrict.config.ts, then run archstrict check`,
    });
  }
});

test("a point side that is neither a glob nor a tag predicate is an error naming the field and the shape", async () => {
  const path = "/project/archstrict.config.ts";
  const valid = { declaredModules: [{ name: "a", glob: "src/a/**" }], because: "test" };
  const cases: { point: object; message: string; do: string }[] = [
    { point: { from: { tags: ["layer:a"], exclude: ["layer:b"] }, to: "src/**" },
      message: "config.edges.point[0].from.exclude must be a tag predicate { tags: [...] }, not an array",
      do: `set config.edges.point[0].from.exclude to { tags: [...] } (e.g. exclude: { tags: ["engine:tsrs"] }) in archstrict.config.ts, then run archstrict check` },
    { point: { from: { tags: ["layer:a"], exclude: { tags: "layer:b" } }, to: "src/**" },
      message: "config.edges.point[0].from.exclude.tags must be an array of tag strings, not string",
      do: `set config.edges.point[0].from.exclude.tags to an array of tags (e.g. ["engine:tsrs"]) in archstrict.config.ts, then run archstrict check` },
    { point: { from: "src/**", to: { tags: "pkg:x" } },
      message: "config.edges.point[0].to.tags must be an array of tag strings, not string",
      do: `set config.edges.point[0].to.tags to an array of tags (e.g. ["layer:core"]) in archstrict.config.ts, then run archstrict check` },
    { point: { from: ["layer:a"], to: "src/**" },
      message: "config.edges.point[0].from must be a glob string or a tag predicate { tags: [...] }, not an array",
      do: "set config.edges.point[0].from to a glob or { tags: [...] } in archstrict.config.ts, then run archstrict check" },
  ];
  for (const { point, message, do: next } of cases) {
    const config = { ...valid, edges: { point: [{ ...point, because: "test" }] } };
    await expect(loadConfig(path, `export default ${JSON.stringify(config)};`), message).rejects.toMatchObject({
      name: "ReportError", message, do: next,
    });
  }
});
