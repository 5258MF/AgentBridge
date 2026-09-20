import test from "node:test";
import assert from "node:assert/strict";
import { FileType, vscodeTest } from "./helpers/fake-vscode.js";
import { fileTypeKind } from "../src/extension/src/ide-tool-broker.js";

test("an entry that is two things at once is named for what a reader asked about", () => {
  // FileType is a set of bits, not one value out of an enumeration: a link is reported as
  // SymbolicLink combined with whatever it points at. Comparing the whole number against one
  // member therefore matched neither a symlink to a file (65) nor one to a directory (66),
  // and both were listed as [OTHER] - an entry the tool declined to describe at all. The
  // link bit is what a listing is meant to answer, so it is read first.
  vscodeTest.reset();
  assert.equal(fileTypeKind(FileType.File), "file");
  assert.equal(fileTypeKind(FileType.Directory), "dir");
  assert.equal(fileTypeKind(FileType.SymbolicLink), "symlink");
  assert.equal(fileTypeKind(FileType.SymbolicLink | FileType.File), "symlink");
  assert.equal(fileTypeKind(FileType.SymbolicLink | FileType.Directory), "symlink");
  assert.equal(fileTypeKind(FileType.Unknown), "unknown");
});
