import test from "node:test";
import assert from "node:assert/strict";
import { boundedHoverText } from "../src/extension/src/lsp-tool.js";

test("a cap below the marker's own length still shortens", () => {
  // slice(-0) is slice(0), so the tail used to be the whole string: a five-character cap
  // handed back all 500 characters and then the marker. No caller asks for a cap that small
  // today - the hover cap is 16000 - and the guard is what makes the answer right for one
  // that does, rather than an answer longer than the text it was asked to shorten.
  const text = "x".repeat(500);
  const result = boundedHoverText(text, 5);
  assert.equal(result.truncated, true);
  assert.ok(result.text.includes("[truncated]"), JSON.stringify(result.text));
  assert.ok(result.text.length < text.length, `${result.text.length} characters`);
});

test("a long answer is cut at both ends and says where", () => {
  const text = "abcdefghij".repeat(100);
  const result = boundedHoverText(text, 100);
  assert.equal(result.truncated, true);
  assert.equal(result.text.length, 100);
  assert.ok(result.text.startsWith("abcdefghij"), JSON.stringify(result.text.slice(0, 20)));
  assert.ok(result.text.endsWith("abcdefghij"), JSON.stringify(result.text.slice(-20)));
  assert.ok(result.text.includes("[truncated]"));
});

test("an answer that fits comes back whole, and unmarked", () => {
  const text = "short";
  assert.deepEqual(boundedHoverText(text, text.length), { text, truncated: false });
});
