import test from "node:test";
import assert from "node:assert/strict";
import { normalizeExcludeGlobs, normalizeVeryLargeFileBytes } from "../src/extension/src/bridge-server.js";

test("an implicit-read ceiling set below the range is clamped, not obeyed", () => {
  // Zero or a negative value read as "every file is very large", which forced callers to
  // pass a line range even for a one-line file.
  assert.equal(normalizeVeryLargeFileBytes(0), 262_144);
  assert.equal(normalizeVeryLargeFileBytes(-1), 262_144);
});

test("an implicit-read ceiling above the range cannot switch the threshold off", () => {
  assert.equal(normalizeVeryLargeFileBytes(Number.MAX_SAFE_INTEGER), 134_217_728);
});

test("a usable ceiling passes through and unusable ones are ignored", () => {
  assert.equal(normalizeVeryLargeFileBytes(8 * 1024 * 1024), 8 * 1024 * 1024);
  assert.equal(normalizeVeryLargeFileBytes(500_000.6), 500_001);
  for (const value of [undefined, null, "8388608", NaN, Infinity]) {
    assert.equal(normalizeVeryLargeFileBytes(value), undefined, String(value));
  }
});

test("a configured exclude glob ripgrep would refuse is dropped", () => {
  // One malformed glob in settings.json would otherwise fail every later find_files and
  // search_files call, with nothing pointing back at the setting.
  const globs = normalizeExcludeGlobs(["**/*.log", "[", "}", "**/*.{", "a\\", "  ", "**/*.log", 7]);
  assert.deepEqual(globs, ["**/*.log"]);
});

test("a configured exclude glob that is merely unusual is kept", () => {
  // A stray "]" and a nested "[[]" are both literals to globset, so they must survive.
  assert.deepEqual(normalizeExcludeGlobs(["a]b", "[[]", "**/{a,b}/**"]), ["a]b", "[[]", "**/{a,b}/**"]);
});

test("a missing or non-array exclude setting is left to the built-in list", () => {
  assert.equal(normalizeExcludeGlobs(undefined), undefined);
  assert.equal(normalizeExcludeGlobs("**/*.log"), undefined);
  assert.deepEqual(normalizeExcludeGlobs([]), []);
});
