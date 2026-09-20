import test from "node:test";
import assert from "node:assert/strict";
import { boundedInteger, boundedNotes, describeValue } from "../src/extension/src/bounded-integer.js";

test("a value above the range is brought down, and says so", () => {
  const bound = boundedInteger(6, 2, 0, 5, "context_lines");
  assert.equal(bound.value, 5);
  assert.equal(bound.note, "context_lines was 6: above 5, so 5 was used");
});

test("a value below the range is brought up, and says so", () => {
  // The old search_files threw here while clamping the top, so the same argument had two
  // different failure modes depending on which end it missed.
  const bound = boundedInteger(-1, 2, 0, 5, "context_lines");
  assert.equal(bound.value, 0);
  assert.equal(bound.note, "context_lines was -1: below 0, so 0 was used");
});

test("a value that is not an integer falls back, and says so", () => {
  // The quietest case of all: a caller asking for a five minute timeout got two, and nothing
  // in the answer mentioned a timeout.
  assert.equal(boundedInteger(300000.5, 120_000, 1_000, 120_000, "timeout_ms").value, 120_000);
  assert.equal(boundedInteger("300000", 120_000, 1_000, 120_000, "timeout_ms").value, 120_000);
  assert.match(
    boundedInteger("300000", 120_000, 1_000, 120_000, "timeout_ms").note ?? "",
    /not an integer in 1000\.\.120000, so 120000 was used/,
  );
});

test("a value that was never given is not reported as adjusted", () => {
  const bound = boundedInteger(undefined, 200, 1, 500, "max_entries");
  assert.equal(bound.value, 200);
  assert.equal(bound.note, null);
});

test("a value in range stands, and is not reported", () => {
  const bound = boundedInteger(3, 2, 0, 5, "context_lines");
  assert.equal(bound.value, 3);
  assert.equal(bound.note, null);
});

test("several bounds make one line, and none make no line", () => {
  const bounds = [
    boundedInteger(6, 2, 0, 5, "context_lines"),
    boundedInteger(3, 2, 0, 5, "context_lines"),
  ];
  assert.equal(boundedNotes(bounds), "adjusted: context_lines was 6: above 5, so 5 was used.");
  assert.equal(boundedNotes([boundedInteger(3, 2, 0, 5, "context_lines")]), null);
});

test("a value it cannot print is still reported, and stays on one line", () => {
  // JSON.stringify was the obvious way to show a value and the wrong one: it throws on a
  // BigInt and on a cycle, so a caller sending either turned a note about a bad number into an
  // error about reporting one. A long or multi-line value would also have taken the whole
  // answer for itself.
  assert.equal(boundedInteger(10n, 2, 0, 5, "max_results").value, 2);
  assert.match(boundedInteger(10n, 2, 0, 5, "max_results").note ?? "", /^max_results was "10": not an integer/);

  const cyclic: Record<string, unknown> = { name: "loop" };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => boundedInteger(cyclic, 2, 0, 5, "max_results"));
  assert.match(boundedInteger(cyclic, 2, 0, 5, "max_results").note ?? "", /\[object Object\]/);

  const note = boundedInteger("a\nb  c", 2, 0, 5, "max_results").note ?? "";
  assert.equal(note.includes("\n"), false, "a note has to stay on one line");
  assert.match(note, /"a b c"/);

  const long = boundedInteger("x".repeat(200), 2, 0, 5, "max_results").note ?? "";
  assert.ok(long.length <= 120, `a long value must be cut short: ${long.length}`);
  assert.match(long, /\.\.\."/);
});

test("a severity it cannot print is reported the same way", () => {
  const value = { toString(): string { throw new Error("nope"); } };
  assert.equal(describeValue(value), "a value that cannot be shown");
  assert.equal(describeValue("plain"), '"plain"');
});
