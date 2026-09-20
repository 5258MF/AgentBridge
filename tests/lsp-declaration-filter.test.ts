import test from "node:test";
import assert from "node:assert/strict";
import { containsPosition, sameUri } from "../src/extension/src/lsp-tool.js";

const uri = (text: string, fsPath: string, scheme = "file"): any => ({ toString: () => text, scheme, fsPath });

type Row = Parameters<typeof containsPosition>[0];

const row = (uri: string, sl: number, sc: number, el: number, ec: number): Row =>
  ({
    uri: { toString: () => uri },
    range: { start: { line: sl, character: sc }, end: { line: el, character: ec } },
  }) as unknown as Row;

test("a declaration spanning a signature contains the name inside it", () => {
  // "function foo()" occupies columns 0..15 on line 3; the reference sits at column 9.
  const declaration = row("file:///a.ts", 3, 0, 3, 15);
  assert.equal(containsPosition(declaration, 3, 9), true);
});

test("a position outside the declaration is not contained", () => {
  const declaration = row("file:///a.ts", 3, 0, 3, 15);
  assert.equal(containsPosition(declaration, 3, 16), false);
  assert.equal(containsPosition(declaration, 2, 9), false);
  assert.equal(containsPosition(declaration, 4, 0), false);
});

test("a point range contains its own position", () => {
  const exact = row("file:///a.ts", 7, 4, 7, 4);
  assert.equal(containsPosition(exact, 7, 4), true);
  assert.equal(containsPosition(exact, 7, 5), false);
});

test("the same file is recognized however its drive letter is cased", () => {
  // One provider lower-cases the drive letter and another does not, and the declaration
  // filter compared the strings, so the two never matched and the declaration survived.
  const lower = uri("file:///c:/proj/a.ts", "c:\\proj\\a.ts");
  const upper = uri("file:///C:/proj/a.ts", "C:\\proj\\a.ts");
  assert.equal(sameUri(lower, upper), process.platform === "win32");
  assert.equal(sameUri(lower, lower), true);
});

test("different files are never the same file", () => {
  assert.equal(sameUri(uri("file:///c:/proj/a.ts", "c:\\proj\\a.ts"), uri("file:///c:/proj/b.ts", "c:\\proj\\b.ts")), false);
  assert.equal(sameUri(uri("file:///c:/proj/a.ts", "c:\\proj\\a.ts"), uri("untitled:Untitled-1", "c:\\proj\\a.ts", "untitled")), false);
});

test("a declaration's name range excludes references inside its body", () => {
  // The target range of a function covers its whole body, so testing against it treats every
  // reference within — a recursive call included — as the declaration. The selection range is
  // the declared name alone, which is what a reference to it looks like.
  const wholeFunction = row("file:///a.ts", 0, 0, 6, 1);
  const declaredName = row("file:///a.ts", 0, 9, 0, 12);
  const recursiveCall = { line: 3, character: 2 };

  assert.equal(containsPosition(wholeFunction, recursiveCall.line, recursiveCall.character), true);
  assert.equal(containsPosition(declaredName, recursiveCall.line, recursiveCall.character), false);
  assert.equal(containsPosition(declaredName, 0, 9), true);
});
