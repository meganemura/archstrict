// Responsibility: verify root .gitignore patterns against literal outcomes
// and properties of the pattern language.
// Boundary: one ignore file at the project root. Layer precedence, nested
// files, and the project walk belong to gitignore.test.ts, which compares
// the whole walk with git.
import { describe, expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gen from "@hegeldev/hegel/generators";
import { isIgnoredBy, withGitignoreFile } from "../src/gitignore.js";

function ignores(lines: string, path: string): boolean {
  return isIgnoredBy(withGitignoreFile([], "", `${lines}\n`), path, false);
}

function ignoresDir(lines: string, path: string): boolean {
  return isIgnoredBy(withGitignoreFile([], "", `${lines}\n`), path, true);
}

describe("gitignore lines", () => {
  // An editor on Windows saves .gitignore with CRLF endings, and git reads
  // that file the same as one with LF endings.
  test("a CRLF line ending is not part of the pattern", () => {
    const crlf = "Thumbs.db\r\n/out.ts\r\n*.log\r\n!keep.log\r";
    expect(ignores(crlf, "Thumbs.db")).toBe(true);
    expect(ignores(crlf, "out.ts")).toBe(true);
    expect(ignores(crlf, "a/out.ts")).toBe(false);
    expect(ignores(crlf, "a.log")).toBe(true);
    expect(ignores(crlf, "keep.log")).toBe(false);
    expect(ignores(crlf, "other.ts")).toBe(false);
  });

  test("a line that starts with # is a comment, and a # anywhere else is part of the name", () => {
    expect(ignores("#x.ts", "#x.ts")).toBe(false);
    expect(ignores("x#", "x#")).toBe(true);
    expect(ignores("a#b.ts", "a#b.ts")).toBe(true);
  });

  // An editor can leave invisible spaces at the end of a line. A name that
  // really ends in a space must still be expressible, by escaping it.
  test("trailing spaces are not part of the pattern unless the last one is escaped", () => {
    expect(ignores("x.ts  ", "x.ts")).toBe(true);
    expect(ignores("x.ts  ", "x.ts  ")).toBe(false);
    expect(ignores(String.raw`x\ `, "x ")).toBe(true);
    expect(ignores(String.raw`x\ `, "x")).toBe(false);
    expect(ignores(String.raw`x\  `, "x ")).toBe(true);
    expect(ignores(String.raw`x\  `, "x  ")).toBe(false);
    // Only the end of the line is trimmed: a leading space is part of the name.
    expect(ignores(" x.ts", " x.ts")).toBe(true);
    expect(ignores(" x.ts", "x.ts")).toBe(false);
  });
});

describe("gitignore slashes", () => {
  test("a leading slash anchors the pattern to the ignore file's own directory", () => {
    expect(ignores("/x.ts", "x.ts")).toBe(true);
    expect(ignores("/x.ts", "a/x.ts")).toBe(false);
  });

  test("a trailing slash makes the pattern ignore a directory of that name and never a file", () => {
    expect(ignoresDir("tmp/", "tmp")).toBe(true);
    expect(ignoresDir("tmp/", "d/tmp")).toBe(true);
    expect(ignores("tmp/", "tmp")).toBe(false);
    expect(ignoresDir("out/tmp/", "out/tmp")).toBe(true);
    expect(ignores("out/tmp/", "out/tmp")).toBe(false);
  });
});

describe("gitignore escapes", () => {
  test("a backslash makes the next character match only itself", () => {
    expect(ignores(String.raw`\*.ts`, "*.ts")).toBe(true);
    expect(ignores(String.raw`\*.ts`, "a.ts")).toBe(false);
    expect(ignores(String.raw`\?.ts`, "?.ts")).toBe(true);
    expect(ignores(String.raw`\?.ts`, "a.ts")).toBe(false);
    expect(ignores(String.raw`\[ab].ts`, "[ab].ts")).toBe(true);
    expect(ignores(String.raw`\[ab].ts`, "a.ts")).toBe(false);
    // An escaped "#" or "!" at the start is a name, not a comment or a negation.
    expect(ignores(String.raw`\#x.ts`, "#x.ts")).toBe(true);
    expect(ignores(String.raw`\!x.ts`, "!x.ts")).toBe(true);
    expect(ignores(String.raw`\!x.ts`, "x.ts")).toBe(false);
  });

  test("escaping every character of a name gives a pattern that matches that name and no other", () => {
    const char = gen.sampledFrom(["a", "b", "*", "?", "[", "]", "!", "#", ".", "\\", " "]);
    const name = gen.arrays(char, { minSize: 1, maxSize: 5 });
    hegel.test((tc) => {
      const own = tc.draw(name).join("");
      const other = tc.draw(name).join("");
      const pattern = [...own].map((c) => `\\${c}`).join("");
      expect(ignores(pattern, own)).toBe(true);
      expect(ignores(pattern, other)).toBe(other === own);
    });
  });
});

describe("gitignore bracket expressions", () => {
  test("a bracket expression matches one character from the set between its brackets", () => {
    expect(ignores("[ab].ts", "a.ts")).toBe(true);
    expect(ignores("[ab].ts", "b.ts")).toBe(true);
    expect(ignores("[ab].ts", "c.ts")).toBe(false);
    // The rest of the segment is not part of the set.
    expect(ignores("x[ab].ts", "xa.ts")).toBe(true);
    expect(ignores("x[ab].ts", "xx.ts")).toBe(false);
    expect(ignores("x[ab].ts", "xt.ts")).toBe(false);
    // A "]" right after the opening bracket is a member, not the close.
    expect(ignores("x[]a].ts", "x].ts")).toBe(true);
    expect(ignores("x[]a].ts", "xa.ts")).toBe(true);
    expect(ignores("x[]a].ts", "xb.ts")).toBe(false);
  });

  test("a leading ! or ^ in a bracket expression matches one character outside the set", () => {
    for (const pattern of ["[!ab].ts", "[^ab].ts"]) {
      expect(ignores(pattern, "c.ts")).toBe(true);
      expect(ignores(pattern, "a.ts")).toBe(false);
      expect(ignores(pattern, "b.ts")).toBe(false);
      // The leading marker only negates the set; it is never a member, so a
      // name holding either marker character is still outside the set.
      expect(ignores(pattern, "!.ts")).toBe(true);
      expect(ignores(pattern, "^.ts")).toBe(true);
    }
    // Anywhere else in the set, ! and ^ are ordinary members.
    expect(ignores("[a!]x", "!x")).toBe(true);
    expect(ignores("[a^]x", "^x")).toBe(true);
    expect(ignores("[a^]x", "bx")).toBe(false);
  });

  test("a bracket expression agrees with set membership, negated or not", () => {
    const member = gen.sampledFrom(["a", "b", "c", ".", "*", "?"]);
    const around = gen.fromRegex("[abc]{0,2}");
    hegel.test((tc) => {
      const set = tc.draw(gen.arrays(member, { minSize: 1, maxSize: 3 })).join("");
      const negated = tc.draw(gen.booleans());
      const before = tc.draw(around);
      const after = tc.draw(around);
      const char = tc.draw(member);
      const pattern = `${before}[${negated ? "!" : ""}${set}]${after}`;
      expect(ignores(pattern, `${before}${char}${after}`)).toBe(set.includes(char) !== negated);
    });
  });

  // git matches nothing with a bracket that never closes. Whatever the
  // pattern still matches, it must not reach a name that lacks the bracket.
  test("a pattern with an unclosed bracket ignores no name without that bracket", () => {
    expect(ignores("x[ab.ts", "xab.ts")).toBe(false);
    expect(ignores("x[ab.ts", "xa.ts")).toBe(false);
    expect(ignores("x[ab.ts", "x.ts")).toBe(false);
  });
});

describe("gitignore stars", () => {
  test("a run of stars inside a segment matches like one star", () => {
    expect(ignores("a**.ts", "a.ts")).toBe(true);
    expect(ignores("a**.ts", "abc.ts")).toBe(true);
    expect(ignores("a**.ts", "x/abc.ts")).toBe(true);
    expect(ignores("a**.ts", "a.js")).toBe(false);
    expect(ignores("a***b", "ab")).toBe(true);
    expect(ignores("a***b", "axyb")).toBe(true);
    expect(ignores("a***b", "ax")).toBe(false);
  });

  // A lone `*` is the usual way to ignore everything in a directory. It must
  // reach every name, not only a file that is literally named "*".
  test("a pattern of wildcards alone matches every name the wildcards fit", () => {
    expect(ignores("*", "x.ts")).toBe(true);
    expect(ignores("*", "a/b.ts")).toBe(true);
    expect(ignores("?", "x")).toBe(true);
    expect(ignores("?", "a/b")).toBe(true);
    expect(ignores("?", "xy")).toBe(false);
  });

  test("a whole ** segment matches zero or more directories", () => {
    const dirs = gen.arrays(gen.sampledFrom(["a", "b", "c"]), { maxSize: 3 });
    hegel.test((tc) => {
      const between = tc.draw(dirs).map((dir) => `${dir}/`).join("");
      expect(ignores("**/x.ts", `${between}x.ts`)).toBe(true);
      expect(ignores("a/**/x.ts", `a/${between}x.ts`)).toBe(true);
      expect(ignores("a/**", `a/${between}x.ts`)).toBe(true);
      // The segments around ** still have to match.
      expect(ignores("**/x.ts", `${between}y.ts`)).toBe(false);
      expect(ignores("a/**/x.ts", `b/${between}x.ts`)).toBe(false);
      expect(ignores("a/**", `b/${between}x.ts`)).toBe(false);
    }, { testCases: 20 });
  });
});

describe("gitignore plain names", () => {
  test("a plain-name pattern ignores that name under any parent directory", () => {
    expect(ignores("Thumbs.db", "Thumbs.db")).toBe(true);
    expect(ignores("Thumbs.db", "a/b/Thumbs.db")).toBe(true);
    expect(ignores("Thumbs.db", "Thumbs.dbx")).toBe(false);
    // git matches the name whatever the directory names hold, a line break included.
    expect(ignores("Thumbs.db", "odd\nname/Thumbs.db")).toBe(true);
  });
});

test("a double-star directory segment can match zero directories", () => {
  expect(ignores("a/**/x.ts", "a/x.ts")).toBe(true);
});

test("an unrelated directory rule preserves a plain-name directory match", () => {
  expect(ignoresDir("cache\nother/", "cache")).toBe(true);
});
