import test from "node:test";
import assert from "node:assert/strict";
import { bridgeWorkspaceSegments } from "../src/extension/src/extension.js";

test("a path that climbs above the workspace root is rejected", () => {
  // The old check only knew ".." when a separator followed it, so a bare ".." resolved to
  // the workspace's parent directory.
  for (const value of ["..", "./..", "../", "../a", "a/../../b", "..\\..", " .. "]) {
    assert.throws(() => bridgeWorkspaceSegments(value), /Invalid Bridge workspace path/, value);
  }
});

test("a relative path resolves to its segments", () => {
  assert.deepEqual(bridgeWorkspaceSegments("src/extension/a.ts"), ["src", "extension", "a.ts"]);
  assert.deepEqual(bridgeWorkspaceSegments("./a.txt"), ["a.txt"]);
  assert.deepEqual(bridgeWorkspaceSegments("a\\b\\c.txt"), ["a", "b", "c.txt"]);
  assert.deepEqual(bridgeWorkspaceSegments("."), []);
});

test("an absolute path is rejected instead of being reinterpreted as relative", () => {
  // Dropping the leading separator would silently open <root>/etc/passwd for a caller that
  // asked for /etc/passwd, so the request has to fail instead.
  for (const value of ["/etc/passwd", "/", "//server/share", "C:\\x\\y.txt", "C:/x.txt"]) {
    assert.throws(() => bridgeWorkspaceSegments(value), /Invalid Bridge workspace path/, value);
  }
});

test("a parent reference that stays inside the root is still allowed", () => {
  // ".." is only an escape when it has nothing left to climb out of.
  assert.deepEqual(bridgeWorkspaceSegments("a/../b"), ["b"]);
  assert.deepEqual(bridgeWorkspaceSegments("a/b/../c"), ["a", "c"]);
});
