// Responsibility: install or remove the fixed archstrict instructions in AGENTS.md.
// Boundary: preserves surrounding bytes and follows links; never reads project configuration.
import { lstatSync, existsSync, realpathSync, readlinkSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, statSync, chmodSync } from "node:fs";
import { dirname, isAbsolute, resolve, join } from "node:path";
import { randomUUID } from "node:crypto";

export const ARCHSTRICT_SECTION_START = "<!-- ARCHSTRICT_START -->";
export const ARCHSTRICT_SECTION_END = "<!-- ARCHSTRICT_END -->";

export const ARCHSTRICT_INSTRUCTIONS_BLOCK = `${ARCHSTRICT_SECTION_START}
## archstrict

In projects with an \`archstrict.config.ts\` (module-boundary/architecture linting), run \`archstrict rules <path>\` BEFORE creating a file or adding an import - it reports the module, tags, and constraints that would govern that path, even before it exists. Run \`archstrict check\` after editing to confirm.

The full rule reference (every rule's evidence/because/next shape, the config schema, the pre-edit query) is at \`node_modules/archstrict/skills/archstrict/SKILL.md\` when installed via npm - read it before configuring \`archstrict.config.ts\`, or when a violation's \`next:\` text alone isn't enough.

If there is no \`archstrict.config.ts\`, skip archstrict entirely - it may not be installed here.
${ARCHSTRICT_SECTION_END}`;

export type AgentsResult = {
  state: "created" | "appended" | "replaced" | "removed" | "already-absent" | "no-markers";
  path: string;
};

function resolveWriteTarget(path: string): string {
  let current = path;
  const seen = new Set<string>();
  for (;;) {
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return current; // A missing target can be created at this path.
    }
    if (!stat.isSymbolicLink()) {
      return existsSync(current) ? realpathSync(current) : current;
    }
    if (seen.has(current)) {
      throw new Error(`agents: symlink cycle detected at '${current}'`);
    }
    seen.add(current);
    const target = readlinkSync(current);
    current = isAbsolute(target) ? target : resolve(dirname(current), target);
  }
}

function sectionRange(contents: Buffer): { start: number; end: number } | undefined {
  const start = contents.indexOf(ARCHSTRICT_SECTION_START);
  const endMarker = contents.indexOf(ARCHSTRICT_SECTION_END);
  if (start === -1 && endMarker === -1) return undefined;
  // Ambiguous markers cannot define a safe replacement boundary.
  if (start === -1 || endMarker < start ||
      contents.indexOf(ARCHSTRICT_SECTION_START, start + 1) !== -1 ||
      contents.indexOf(ARCHSTRICT_SECTION_END, endMarker + 1) !== -1) {
    throw new Error("agents: incomplete or duplicate ARCHSTRICT markers; file left unchanged");
  }
  return { start, end: endMarker + Buffer.byteLength(ARCHSTRICT_SECTION_END) };
}

function removeSection(contents: Buffer, start: number, end: number): Buffer {
  // Consume one separator, not the surrounding document's whitespace.
  if (start >= 4 && contents.subarray(start - 4, start).equals(Buffer.from("\r\n\r\n"))) start -= 4;
  else if (start >= 2 && contents.subarray(start - 2, start).equals(Buffer.from("\n\n"))) start -= 2;
  if (start === 0 && contents.subarray(end, end + 4).equals(Buffer.from("\r\n\r\n"))) end += 4;
  else if (start === 0 && contents.subarray(end, end + 2).equals(Buffer.from("\n\n"))) end += 2;
  else if (contents.subarray(end).equals(Buffer.from("\n"))) end++;
  else if (contents.subarray(end).equals(Buffer.from("\r\n"))) end += 2;
  return Buffer.concat([contents.subarray(0, start), contents.subarray(end)]);
}

function writeTarget(path: string, contents: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.archstrict-agents-${randomUUID()}.tmp`);
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : undefined;
  try {
    writeFileSync(temporary, contents, { flag: "wx", mode });
    if (mode !== undefined) chmodSync(temporary, mode);
    // Renaming over the resolved target keeps AGENTS.md and intermediate links intact.
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function agents(projectRoot: string, remove = false): AgentsResult {
  const path = resolveWriteTarget(resolve(projectRoot, "AGENTS.md"));
  if (!existsSync(path)) {
    if (remove) return { state: "already-absent", path };
    writeTarget(path, Buffer.from(ARCHSTRICT_INSTRUCTIONS_BLOCK + "\n"));
    return { state: "created", path };
  }
  const original = readFileSync(path);
  const section = sectionRange(original);
  if (remove) {
    if (section === undefined) return { state: "no-markers", path };
    writeTarget(path, removeSection(original, section.start, section.end));
    return { state: "removed", path };
  }
  const block = Buffer.from(ARCHSTRICT_INSTRUCTIONS_BLOCK);
  const updated = section === undefined
    ? Buffer.concat([original, Buffer.from(original.length > 0 ? "\n\n" : ""), block, Buffer.from("\n")])
    : Buffer.concat([original.subarray(0, section.start), block, original.subarray(section.end)]);
  if (!updated.equals(original)) writeTarget(path, updated);
  return { state: section === undefined ? "appended" : "replaced", path };
}

export function formatAgentsText(result: AgentsResult): string {
  switch (result.state) {
    case "created": return `created instructions in ${result.path}\n`;
    case "appended": return `appended instructions to ${result.path}\n`;
    case "replaced": return `replaced instructions in ${result.path}\n`;
    case "removed": return `removed instructions from ${result.path}\n`;
    case "already-absent": return `instructions absent at ${result.path}; left unchanged\n`;
    case "no-markers": return `no markers in ${result.path}; left unchanged\n`;
  }
}
