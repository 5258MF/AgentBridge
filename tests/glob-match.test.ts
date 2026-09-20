import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { isSupportedGlob, matchesAnyGlob, matchesGlob } from "../src/extension/src/glob.js";

const EXCLUDES = ["**/node_modules/**", "**/.git/**", "**/dist/**"];

test("segment globs match the paths ripgrep would exclude", () => {
  assert.equal(matchesGlob("node_modules/x/y.js", "**/node_modules/**"), true);
  assert.equal(matchesGlob("a/b/node_modules/x.js", "**/node_modules/**"), true);
  assert.equal(matchesGlob("src/node_moduels.js", "**/node_modules/**"), false);
  assert.equal(matchesGlob(".git/config", "**/.git/**"), true);
});

test("a trailing ** needs at least one segment after the directory", () => {
  // The reading path.matchesGlob gives it: "tests/**" covers everything under tests/ but
  // is not another way of writing "tests".
  assert.equal(matchesGlob("tests/a/b.ts", "tests/**"), true);
  assert.equal(matchesGlob("tests", "tests/**"), false);
  assert.equal(matchesGlob("tests.ts", "tests/**"), false);
});

test("a ** in the middle spans any number of directories, including none", () => {
  assert.equal(matchesGlob("a/b.ts", "a/**/b.ts"), true);
  assert.equal(matchesGlob("a/x/y/b.ts", "a/**/b.ts"), true);
  assert.equal(matchesGlob("a/x/b.ts", "a/**/b.ts"), true);
  assert.equal(matchesGlob("a/b/c.ts", "a/**/b.ts"), false);
});

test("wildcards stay inside one path segment", () => {
  assert.equal(matchesGlob("src/a.ts", "**/*.ts"), true);
  assert.equal(matchesGlob("src/deep/a.ts", "**/*.ts"), true);
  assert.equal(matchesGlob("src/a.tsx", "**/*.ts"), false);
  assert.equal(matchesGlob("src/a.ts", "src/?.ts"), true);
  assert.equal(matchesGlob("src/ab.ts", "src/?.ts"), false);
});

test("character classes and alternation are honoured", () => {
  assert.equal(matchesGlob("a1.ts", "a[0-9].ts"), true);
  assert.equal(matchesGlob("a9.ts", "a[0-9].ts"), true);
  assert.equal(matchesGlob("ab.ts", "a[0-9].ts"), false);
  assert.equal(matchesGlob("ax.ts", "a[!0-9].ts"), true);
  assert.equal(matchesGlob("a1.ts", "a[!0-9].ts"), false);
  assert.equal(matchesGlob("a.ts", "*.{ts,js}"), true);
  assert.equal(matchesGlob("a.js", "*.{ts,js}"), true);
  assert.equal(matchesGlob("a.css", "*.{ts,js}"), false);
});

test("a character class inside a brace alternation is not split at its comma", () => {
  // Measured against the bundled ripgrep: `rg --iglob '{[a,b]}' --files` in a directory
  // holding a, b, c and "," answers a, b and "," - the class is one branch, naming a, b or
  // the comma. Scanning the braces as bare characters cut it into "[a" and "b]", neither of
  // which matches anything, so a default find_files - which compiles the pattern to match
  // without regard to case - hid a different set of files than ripgrep did.
  const pattern = ["{[a,b]}"];
  assert.equal(matchesAnyGlob("a", pattern, false), true);
  assert.equal(matchesAnyGlob("b", pattern, false), true);
  assert.equal(matchesAnyGlob(",", pattern, false), true);
  assert.equal(matchesAnyGlob("c", pattern, false), false);

  // Still an alternation when the class sits beside one, and a comma of its own is a comma.
  assert.equal(matchesAnyGlob("a.ts", ["{[ab],x}.ts"], false), true);
  assert.equal(matchesAnyGlob("x.ts", ["{[ab],x}.ts"], false), true);
  assert.equal(matchesAnyGlob("c.ts", ["{[ab],x}.ts"], false), false);
  assert.equal(matchesAnyGlob("a,b", ["{a\\,b}"], false), true);
  assert.equal(matchesAnyGlob("ab", ["{a\\,b}"], false), false);
});

test("a literal dot is a dot, not any character", () => {
  assert.equal(matchesGlob("a.ts", "a.ts"), true);
  assert.equal(matchesGlob("aXts", "a.ts"), false);
});

test("an unpaired brace or class never matches instead of throwing", () => {
  // These are rejected by isSupportedGlob before they reach a tool, but a matcher that
  // throws on them would take the whole walk with it.
  assert.equal(matchesGlob("a.ts", "*.{ts"), false);
  assert.equal(matchesGlob("a.ts", "a[.ts"), false);
});

test("the built-in excludes hide the paths they are meant to hide", () => {
  for (const value of ["node_modules/x/y.js", ".git/objects/ab", "dist/extension.js"]) {
    const matched = EXCLUDES.some((pattern) => matchesGlob(value, pattern));
    assert.equal(matched, true, value);
  }
  for (const value of ["src/extension.ts", "tests/run-tests.mjs"]) {
    const matched = EXCLUDES.some((pattern) => matchesGlob(value, pattern));
    assert.equal(matched, false, value);
  }
});

test("a pattern without a slash names an entry by its own name", () => {
  // ripgrep and .gitignore both read "docs" as "anything called docs, at any depth", so it is
  // the directory that has to match — matched against the full path alone it excluded nothing,
  // and the fallback engines walked into docs/ and kept every file underneath.
  assert.equal(matchesAnyGlob("docs", ["docs"], true), true);
  assert.equal(matchesAnyGlob("src/docs", ["docs"], true), true);
  assert.equal(matchesAnyGlob("a/b/docs", ["docs"], true), true);
  assert.equal(matchesAnyGlob("src/docs.md", ["docs"], true), false);
  assert.equal(matchesAnyGlob("src/a.md", ["docs"], true), false);
  // An empty pattern list must not read as "matches everything".
  assert.equal(matchesAnyGlob("src/docs", [], true), false);
});

test("case-insensitive matching compares both sides in the same case", () => {
  // The helper lower-cases the value and the pattern together; dropping either side makes a
  // pattern written in another case match nothing.
  assert.equal(matchesAnyGlob("src/Docs", ["docs"], false), true);
  assert.equal(matchesAnyGlob("src/Docs", ["DOCS"], false), true);
  assert.equal(matchesAnyGlob("src/Docs", ["docs"], true), false);
});

test("case-insensitive matching does not rewrite the pattern", () => {
  // It used to lower-case the pattern as well as the value, and a pattern is not text: `[A-z]`
  // is a range that reaches `[`, `\\`, `]`, `^` and `_`, and lower-casing it turns it into
  // `[a-z]`, which reaches none of them. ripgrep, asked with --iglob, answers `[` for `[A-z]`
  // and `a` for `[A-Z]`, so one exclude hid different files in the two engines. The pattern is
  // compiled instead of rewritten now; every case below was checked against `rg --iglob`.
  assert.equal(matchesAnyGlob("[", ["[A-z]"], false), true, "the range reaches the bracket itself");
  assert.equal(matchesAnyGlob("a", ["[A-Z]"], false), true);
  assert.equal(matchesAnyGlob("A", ["[a-z]"], false), true);
  assert.equal(matchesAnyGlob("[", ["[!a-z]"], false), true);
  assert.equal(matchesAnyGlob("z", ["[!a-y]"], false), true);

  // A letter outside a class is still matched without regard to case, which is what the
  // lower-casing was there for: a directory called Vendor is the vendor that is never shown.
  assert.equal(matchesAnyGlob("X.TXT", ["*.txt"], false), true);
  assert.equal(matchesAnyGlob("vendor/pkg/a.js", ["**/VENDOR/**"], false), true);
  assert.equal(matchesAnyGlob("a.ts", ["*.{TS,JS}"], false), true, "alternation is still alternation");
  assert.equal(matchesAnyGlob("a.css", ["*.{TS,JS}"], false), false);

  // And the same patterns still mean the same things they did.
  assert.equal(matchesAnyGlob("a/b", ["a/**/b"], false), true);
  assert.equal(matchesAnyGlob("a/x/y/b", ["a/**/b"], false), true);
  assert.equal(matchesAnyGlob("a/b/c", ["a/**/b"], false), false);
  assert.equal(matchesAnyGlob("src/a.ts", ["src/?.ts"], false), true);
  assert.equal(matchesAnyGlob("a.ts", ["*.{ts"], false), false, "a pattern that cannot be compiled matches nothing");
});

test("a compiled pattern is reused, and does not keep its answer", () => {
  // The compiled forms are cached because a walk asks about the same few patterns once per
  // file, and a cache that cached the answer instead of the pattern would answer every file
  // with the first one's result.
  assert.equal(matchesAnyGlob("src/A.TS", ["**/*.ts"], false), true);
  assert.equal(matchesAnyGlob("README.md", ["**/*.ts"], false), false);
  assert.equal(matchesAnyGlob("deep/dir/A.TS", ["**/*.ts"], false), true);
});

test("isSupportedGlob rejects what ripgrep would refuse to parse", () => {
  assert.equal(isSupportedGlob("**/*.ts"), true);
  assert.equal(isSupportedGlob(""), false);
  assert.equal(isSupportedGlob("a[bc"), false);
  assert.equal(isSupportedGlob("a\\"), false);
  assert.equal(isSupportedGlob("}a{"), false);
});

test("the wrapper adds nothing of its own to the host's answer", () => {
  // The semantics are Node's. This pins that the module is a pass-through and stays one: a
  // hand-written matcher would drift from path.matchesGlob on exactly the patterns below.
  const values = ["node_modules/x.js", "src/a.ts", "tests", "a/b/c.ts", "dist/x.js", "top.js"];
  for (const pattern of [...EXCLUDES, "**/*.ts", "tests/**", "a/**/c.ts", "*.{ts,js}", "*.js"]) {
    for (const value of values) {
      const expected: boolean = path.matchesGlob(value, pattern);
      assert.equal(matchesGlob(value, pattern), expected, `${value} vs ${pattern}`);
    }
  }
});

test("a compiled pattern gives the answer the host gives, case apart", () => {
  // The compiler is hand-written, so it can drift from the host the way the matcher it replaced
  // did, and it drifted three ways. A "]" written first in a class was dropped instead of kept,
  // so "[]a]" lost the one character it names. A "**" that does not own a segment of its own -
  // "a**b", "**b", "a**" - was compiled as "any characters, / included", where the host reads it
  // as the two single stars it looks like and answers "ab" and "axb" but not "a/b". And a "**"
  // at the end made the directory it stands behind optional, so "a/**" reached "a" itself.
  // Every pair below is put to both, which is the only way a hand-written compiler is ever
  // going to be believed: an exclude that one engine reads and the other does not is a file the
  // user asked never to see, reported by whichever engine walks past it.
  //
  // "^" looks like a fourth drift and is not one. A glob negates with "!" alone, but the host
  // reads "[^ab]" as "[!ab]" and ripgrep asked with --iglob reads it the same way, and this
  // compiler exists to give the host's answer rather than the standard's. It is pinned here so
  // that "correcting" it later is a failing test instead of a quiet disagreement.
  const patterns = [
    "[]a]", "[^ab]", "[!ab]", "[a^]", "[]]", "[^]a]", "[!]a]", "[[]", "[a-z]", "[!a]",
    "a**b", "**b", "a**", "**", "a/**/b", "**/b", "a/**", "***", "a/*", "*/b", "a*b",
    "**/*.ts", "**/node_modules/**", "*.{ts,js}", "a[0-9].ts", "src/?.ts", "a.ts",
    "{a,b}", "a{b,c}d", "*", "?", "**/", "a/**/", "**/**", "a/**/**/b", "*/**", "**/*",
    "*/", "a/**/*", "**/a/**",
  ];
  const values = [
    "a", "]", "b", "c", "^", "ab", "axb", "a/b", "a/x/b", "a/x/y/b", "x/b", "x/y/b",
    "src/a.ts", "src/a.tsx", "a1.ts", "a9.ts", "ax.ts", "a.ts", "a.js", "a.css",
    "node_modules/x/y.js", "a/node_modules/x.js", "a.tsx.js", "dist/x.js",
  ];
  let checked = 0;
  for (const pattern of patterns) {
    for (const value of values) {
      // The basename is asked about on both sides as well - a pattern without a slash names an
      // entry by its own name - so that what differs, if anything differs, is the compiler.
      const base = value.slice(value.lastIndexOf("/") + 1);
      const expected = matchesGlob(value, pattern) || matchesGlob(base, pattern);
      assert.equal(matchesAnyGlob(value, [pattern], false), expected, `${value} vs ${pattern}`);
      checked += 1;
    }
  }
  assert.equal(checked, patterns.length * values.length);
});

test("a ] written first in a class is one of the characters the class names", () => {
  assert.equal(matchesAnyGlob("]", ["[]a]"], false), true, "the host answers ] for []a]");
  assert.equal(matchesAnyGlob("a", ["[]a]"], false), true);
  assert.equal(matchesAnyGlob("b", ["[]a]"], false), false);
  assert.equal(matchesAnyGlob("]", ["[^]a]"], false), false, "a negated class excludes it too");
  assert.equal(matchesAnyGlob("b", ["[^]a]"], false), true);
});

test("a ** that does not own a segment of its own is the two single stars it looks like", () => {
  assert.equal(matchesAnyGlob("ab", ["a**b"], false), true);
  assert.equal(matchesAnyGlob("axb", ["a**b"], false), true);
  assert.equal(matchesAnyGlob("a/b", ["a**b"], false), false, "a single star never crosses a /");
  assert.equal(matchesAnyGlob("ab", ["a**"], false), true);
  assert.equal(matchesAnyGlob("a/b", ["a**"], false), false);
  assert.equal(matchesAnyGlob("xb", ["**/b"], false), false, "a leading **/ still needs the /");
  assert.equal(matchesAnyGlob("x/b", ["**/b"], false), true);
  // And a trailing globstar keeps the directory it stands behind: "a/**" is not another way of
  // writing "a", which is what compiling it as ".*" made it.
  assert.equal(matchesAnyGlob("a/b", ["a/**"], false), true);
  assert.equal(matchesAnyGlob("a/b/c", ["a/**"], false), true);
  assert.equal(matchesAnyGlob("a", ["a/**"], false), false);
});
