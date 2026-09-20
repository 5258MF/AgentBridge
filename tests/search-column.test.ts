import test from "node:test";
import assert from "node:assert/strict";
import { byteOffsetToColumn } from "../src/extension/src/search-files.js";

test("an ASCII line maps bytes to columns one to one", () => {
  assert.equal(byteOffsetToColumn("const x = 1;", 0), 1);
  assert.equal(byteOffsetToColumn("const x = 1;", 6), 7);
});

test("a multi-byte character does not inflate the column", () => {
  // "中文abc": each CJK character is 3 bytes but one column, so a byte offset of 6 is the
  // fourth character, not the seventh.
  // Byte layout: 中(3) 文(3) a(1) b(1) c(1) — so "a" starts at byte 6 and "b" at byte 7.
  assert.equal(byteOffsetToColumn("中文abc", 0), 1);
  assert.equal(byteOffsetToColumn("中文abc", 6), 3);
  assert.equal(byteOffsetToColumn("中文abc", 7), 4);
});

test("a surrogate pair counts as the units it occupies, not as one", () => {
  // Columns follow VS Code and LSP, which count UTF-16 code units: an emoji outside the BMP
  // advances the column by two. Iterating code points and counting each as one would put "b"
  // at column 3 instead of 4 and every later match on the line would be off by one.
  // Byte layout: a(1) 😀(4) b(1).
  assert.equal(byteOffsetToColumn("a😀b", 0), 1);
  assert.equal(byteOffsetToColumn("a😀b", 1), 2);
  assert.equal(byteOffsetToColumn("a😀b", 5), 4);
  // A flag is two regional indicators, so eight bytes and four units.
  assert.equal(byteOffsetToColumn("x🇨🇳y", 1), 2);
  assert.equal(byteOffsetToColumn("x🇨🇳y", 9), 6);
});

test("a missing or invalid offset falls back to the first column", () => {
  assert.equal(byteOffsetToColumn("abc", undefined), 1);
  assert.equal(byteOffsetToColumn("abc", "x"), 1);
  assert.equal(byteOffsetToColumn("abc", -3), 1);
});
