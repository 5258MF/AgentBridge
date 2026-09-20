import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSeverities } from "../src/extension/src/ide-tool-broker.js";

test("the known severities are kept", () => {
  assert.deepEqual([...normalizeSeverities(["error", "warning"]).known].sort(), ["error", "warning"]);
  assert.deepEqual([...normalizeSeverities(["hint", "information", "hint"]).known], ["hint", "information"]);
  assert.deepEqual(normalizeSeverities(["error"]).ignored, []);
});

test("a name that is not a severity is reported, not swallowed", () => {
  // Each unknown name used to be dropped without a word, so a caller that misspelled one read a
  // filtered answer as a complete one.
  assert.deepEqual(normalizeSeverities(["error", "warn"]).ignored, ['"warn"']);
  assert.deepEqual([...normalizeSeverities(["error", "warn"]).known], ["error"]);
});

test("a filter with nothing usable in it is left unapplied rather than refused", () => {
  // Refusing the call was the old answer, on the grounds that filtering every severity away
  // answers "no diagnostics" for a directory that has some. The caller now gets its diagnostics
  // and a report naming the values that could not be used, which says the same thing without
  // failing the call. A value that is not a name is shown the way every other refused value is
  // shown - quoted, flattened, and cut short - so a long one cannot spend the whole report.
  for (const value of [["errror"], ["warn"], [], ["Error"], [7]]) {
    const filter = normalizeSeverities(value);
    assert.equal(filter.known.size, 0, JSON.stringify(value));
    assert.equal(filter.ignored.length, value.length, JSON.stringify(value));
  }
  assert.deepEqual(normalizeSeverities(["Error"]).ignored, ['"Error"']);
  assert.deepEqual(normalizeSeverities([7]).ignored, ['"7"']);
  assert.deepEqual(normalizeSeverities(["nope\nreally long ".repeat(30)]).ignored.length, 1);
  assert.ok((normalizeSeverities(["nope\nreally long ".repeat(30)]).ignored[0] ?? "").length < 80);
});
