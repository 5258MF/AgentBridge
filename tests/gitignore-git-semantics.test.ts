import test from "node:test";
import assert from "node:assert/strict";
import { gitignoreIgnores, parseGitignore, type GitignoreRules } from "../src/extension/src/gitignore.js";

function rules(patterns: string[]): GitignoreRules {
  return [{ base: "", patterns }];
}

test("a pattern whose # is escaped names a file, it is not a comment", () => {
  // git reads `\#report.txt` as a file whose name begins with the character #. The parser
  // dropped the whole line as a comment, so a file git hid was listed.
  // The escape stays in the pattern so the matcher can still tell `\!name` from `!name`.
  assert.deepEqual(parseGitignore("# a comment\n\\#report.txt\n"), ["\\#report.txt"]);
  const parsed = rules(parseGitignore("\\#report.txt\n"));
  assert.equal(gitignoreIgnores("#report.txt", parsed), true);
  assert.equal(gitignoreIgnores("report.txt", parsed), false);
});

test("a pattern whose ! is escaped names a file, it does not re-include", () => {
  assert.deepEqual(parseGitignore("\\!keep.txt\n"), ["\\!keep.txt"]);
  const parsed = rules(parseGitignore("\\!keep.txt\n"));
  assert.equal(gitignoreIgnores("!keep.txt", parsed), true);
  assert.equal(gitignoreIgnores("keep.txt", parsed), false);
});

test("a pattern ending in a slash names a directory, and only a directory", () => {
  // `docs/` hides the directory docs and everything under it. It does not hide a file that
  // happens to be called docs, and the walk used to hide one.
  const dirOnly = rules(["docs/"]);
  assert.equal(gitignoreIgnores("docs/a.txt", dirOnly), true);
  assert.equal(gitignoreIgnores("a/docs/b.txt", dirOnly), true);
  assert.equal(gitignoreIgnores("docs", dirOnly, true), true);
  assert.equal(gitignoreIgnores("a/docs", dirOnly, true), true);
  assert.equal(gitignoreIgnores("docs", dirOnly, false), false);
  assert.equal(gitignoreIgnores("a/docs", dirOnly, false), false);

  // Without the slash the name matches anything called docs, file or directory.
  const bare = rules(["docs"]);
  assert.equal(gitignoreIgnores("docs", bare, false), true);
  assert.equal(gitignoreIgnores("docs/a.txt", bare), true);
});

test("an anchored directory pattern stays anchored", () => {
  const anchored = rules(["src/generated/"]);
  assert.equal(gitignoreIgnores("src/generated/a.ts", anchored), true);
  assert.equal(gitignoreIgnores("other/generated/a.ts", anchored), false);
});

test("a line is read the way git reads it, not the way a trim would leave it", () => {
  // Trimmed the whole line, so a leading space - which git keeps, because it is part of the
  // name - was dropped: ` build` was read as `build` and hid a file nobody named. A # only
  // opens a comment at the very beginning of a line, so ` #foo` is a pattern naming a file
  // whose name starts with a space, and a line of nothing but spaces is blank either way.
  assert.deepEqual(parseGitignore(" build\n"), [" build"]);
  assert.deepEqual(parseGitignore(" #foo\n"), [" #foo"]);
  assert.deepEqual(parseGitignore("#foo\n"), []);
  assert.deepEqual(parseGitignore("   \n"), []);

  const leading = rules(parseGitignore(" build\n"));
  assert.equal(gitignoreIgnores(" build", leading), true, "the file whose name has the space");
  assert.equal(gitignoreIgnores("build", leading), false, "and not the one without it");

  const hash = rules(parseGitignore(" #foo\n"));
  assert.equal(gitignoreIgnores(" #foo", hash), true);
  assert.equal(gitignoreIgnores("#foo", hash), false, "a # after a space is a name, not a comment");
});

test("spaces at the end of a line go, unless the line escaped them", () => {
  // git drops unescaped trailing spaces and keeps escaped ones, so `foo  ` is `foo` while
  // `foo\ ` names a file whose name ends with a space. What decides it is the run of
  // backslashes in front of the space: an escape is one that is not itself escaped.
  assert.deepEqual(parseGitignore("foo  \n"), ["foo"]);
  assert.deepEqual(parseGitignore("foo\\ \n"), ["foo\\ "], "an escaped space is part of the name");
  assert.deepEqual(parseGitignore("foo\\\\ \n"), ["foo\\\\"], "an escaped backslash leaves the space bare");
  assert.deepEqual(parseGitignore("foo\\  \n"), ["foo\\ "], "one of each");

  const plain = rules(parseGitignore("foo  \n"));
  assert.equal(gitignoreIgnores("foo", plain), true);
  assert.equal(gitignoreIgnores("foo  ", plain), false, "the spaces are not part of the name");

  const escaped = rules(parseGitignore("foo\\ \n"));
  assert.equal(gitignoreIgnores("foo ", escaped), true);
  assert.equal(gitignoreIgnores("foo", escaped), false);
});

test("an escaped slash is a character in a name, not an anchor", () => {
  // The escapes were undone in one pass and the leftovers turned into separators in another,
  // so `\\/deep` was unescaped into a leading "/", stripped as an anchor, and then matched at
  // any depth. git reads it as a name beginning with a character no path here begins with:
  // `git check-ignore` answers no for `deep` with `\\/deep` in the file, and yes for it with
  // `/deep` in the file.
  const slash = rules(["\\/deep"]);
  assert.equal(gitignoreIgnores("deep", slash), false, "an escaped slash is not an anchor");
  assert.equal(gitignoreIgnores("a/deep", slash), false);

  const anchored = rules(["/deep"]);
  assert.equal(gitignoreIgnores("deep", anchored), true, "and a real one still is");

  // The escapes that were already read aright still are: an escaped "\#" names a file whose
  // name begins with a #, and an escaped "!" does not re-include.
  assert.equal(gitignoreIgnores("#report.txt", rules(["\\#report.txt"])), true);
  assert.equal(gitignoreIgnores("!keep.txt", rules(["\\!keep.txt"])), true);
});

test("a leading slash anchors a pattern to the directory holding the ignore file", () => {
  // `git check-ignore` answers yes for `deep` and for `deep/f.txt`, and no for `a/deep`, with
  // `/deep` in the file. The slash was taken off the name and then forgotten, so the pattern
  // went on to match at every depth as if it had been written `deep`.
  const anchored = rules(["/deep"]);
  assert.equal(gitignoreIgnores("deep", anchored), true);
  assert.equal(gitignoreIgnores("deep/f.txt", anchored), true, "what is under it goes with it");
  assert.equal(gitignoreIgnores("a/deep", anchored), false);
  assert.equal(gitignoreIgnores("a/b/deep", anchored), false);

  // A separator inside a pattern anchors it too, and a bare name still reaches every depth:
  // the same `git check-ignore` run says yes for `a/b` and `a/b/c.txt`, no for `x/a/b/d.txt`,
  // and yes for both `deep` and `a/deep` when the file says `deep`.
  const inner = rules(["a/b"]);
  assert.equal(gitignoreIgnores("a/b", inner), true);
  assert.equal(gitignoreIgnores("a/b/c.txt", inner), true);
  assert.equal(gitignoreIgnores("x/a/b/d.txt", inner), false);
  assert.equal(gitignoreIgnores("a/b.txt", inner), false);

  const bare = rules(["deep"]);
  assert.equal(gitignoreIgnores("deep", bare), true);
  assert.equal(gitignoreIgnores("a/deep", bare), true);
});
