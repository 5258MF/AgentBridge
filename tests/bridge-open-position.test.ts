import test from "node:test";
import assert from "node:assert/strict";
import { bridgeOpenPosition } from "../src/extension/src/extension.js";

test("a position that is not a line is answered with the first one", () => {
  // The check was "a number greater than zero", so 2.5 was truncated by the Position
  // constructor to 2, -1 became a line before the first one, and Infinity named a line no
  // document has - each without a word. A position is counted from one, so anything else is
  // brought into range the way every other number the bridge receives is.
  assert.deepEqual(bridgeOpenPosition({ line: 12, column: 4 }), { line: 12, column: 4 });
  assert.deepEqual(bridgeOpenPosition({}), { line: 1, column: 1 });
  assert.deepEqual(bridgeOpenPosition({ line: 2.5 }), { line: 1, column: 1 });
  assert.deepEqual(bridgeOpenPosition({ line: -3 }), { line: 1, column: 1 });
  assert.deepEqual(bridgeOpenPosition({ line: Number.POSITIVE_INFINITY }), { line: 1, column: 1 });
  assert.deepEqual(bridgeOpenPosition({ line: Number.NaN }), { line: 1, column: 1 });
  assert.deepEqual(bridgeOpenPosition({ line: "7" as unknown as number }), { line: 1, column: 1 });
  assert.deepEqual(bridgeOpenPosition({ line: 3, column: -1 }), { line: 3, column: 1 });
  assert.deepEqual(bridgeOpenPosition({ column: 0 }), { line: 1, column: 1 });
});
