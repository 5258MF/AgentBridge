import test from "node:test";
import assert from "node:assert/strict";
import { createCanonicalUnifiedDiff } from "../src/extension/src/canonical-diff.js";

const MARKER = "\\ No newline at end of file";

/**
 * Apply a unified diff back onto the text it was made from. The marker attaches to the line
 * above it and to the side that line belongs to: after a "-" it describes the old file only
 * and must not change what is produced.
 */
function apply(oldText: string, unified: string): string | undefined {
  const lines = unified.split("\n");
  const at = lines.findIndex((line) => line.startsWith("@@"));
  if (at < 0) return oldText;
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/.exec(lines[at]!);
  if (!header) return undefined;
  const oldLines = oldText.length === 0 ? [] : oldText.replace(/\n$/, "").split("\n");
  let cursor = Number(header[1]) - 1;
  let endsWithoutNewline = false;
  let previousWasNewSide = false;
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line === MARKER) {
      if (previousWasNewSide) endsWithoutNewline = true;
      continue;
    }
    const marker = line[0];
    const text = line.slice(1);
    if (marker === " ") {
      if (oldLines[cursor] !== text) return undefined;
      out.push(text);
      cursor += 1;
    } else if (marker === "-") {
      if (oldLines[cursor] !== text) return undefined;
      cursor += 1;
    } else if (marker === "+") {
      out.push(text);
    }
    previousWasNewSide = marker === "+" || marker === " ";
  }
  out.push(...oldLines.slice(cursor));
  if (out.length === 0) return "";
  return out.join("\n") + (endsWithoutNewline ? "" : "\n");
}

function diff(oldText: string, newText: string): string {
  return createCanonicalUnifiedDiff([{
    action: "update",
    old_path: "x",
    new_path: "x",
    old_bytes: Buffer.from(oldText, "utf8"),
    new_bytes: Buffer.from(newText, "utf8"),
  }]);
}

test("gaining only a final newline is reported", () => {
  const out = diff("a", "a\n");
  assert.ok(out.includes("@@"), out);
  assert.ok(out.includes("-a"), out);
  assert.ok(out.includes("\\ No newline at end of file"), out);
  assert.ok(out.includes("+a"), out);
});

test("losing only a final newline is reported", () => {
  const out = diff("a\n", "a");
  assert.ok(out.includes("@@"), out);
  assert.ok(out.includes("+a"), out);
  assert.ok(out.includes("\\ No newline at end of file"), out);
});

test("an empty file becoming a single newline is reported", () => {
  const out = diff("", "\n");
  assert.ok(out.includes("@@"), out);
  assert.ok(out.includes("+"), out);
});

test("an identical file produces no hunk", () => {
  assert.equal(diff("a\n", "a\n").includes("@@"), false);
});

test("a diff can be applied back to produce exactly the new file", () => {
  // Enumerated rather than hand-picked: the interesting cases are the ones where a line is
  // repeated, because that is when a line's identity in the output stops being obvious.
  const bodies: string[] = [""];
  for (let length = 1; length <= 4; length += 1) {
    const next: string[] = [];
    for (const body of bodies) {
      for (const letter of ["a", "b"]) next.push(body + letter + "\n");
    }
    bodies.push(...next);
  }
  const candidates = new Set<string>();
  for (const body of bodies) {
    candidates.add(body);
    candidates.add(body.slice(0, -1));
  }
  let checked = 0;
  for (const oldText of candidates) {
    for (const newText of candidates) {
      if (oldText === newText) continue;
      checked += 1;
      assert.equal(apply(oldText, diff(oldText, newText)), newText, `${JSON.stringify(oldText)} -> ${JSON.stringify(newText)}`);
    }
  }
  assert.ok(checked > 1000, String(checked));
});

test("an ordinary edit keeps its markers", () => {
  const out = diff("a", "b");
  assert.ok(out.includes("-a"), out);
  assert.ok(out.includes("+b"), out);
  assert.equal(out.split("\\ No newline at end of file").length - 1, 2, out);
});

test("a marker is never followed by a line of the side it finished", () => {
  // The marker declares a side over, so git places it after that side's last line and lets
  // only the other side's additions follow. A removal written behind one is a shape git never
  // produces: "a\nb\n" -> "a" used to come out as -a / +a / marker / -b, which only this
  // parser could read back. Checked over every combination of short files, with and without
  // a final newline, because the placement depends on which side ends without one.
  const bodies: string[] = [];
  for (const oldText of ["a", "a\n", "a\nb", "a\nb\n", "a\nb\nc", "a\nb\nc\n"]) {
    for (const newText of ["a", "a\n", "b", "b\n", "a\nb", "a\nb\n", "a\nb\nc", "a\nb\nc\n", "a\nB\n", "a\nb\nc\nd"]) {
      if (oldText === newText) continue;
      const out = diff(oldText, newText);
      bodies.push(out);
      let ended = false;
      const hunk = out.split("\n").slice(out.split("\n").findIndex((line) => line.startsWith("@@")) + 1).filter(Boolean);
      for (const line of hunk) {
        if (line === MARKER) {
          ended = true;
          continue;
        }
        if (!ended) continue;
        assert.ok(
          line.startsWith("+"),
          `a line follows the marker although the side it ends is over:\n${out}`,
        );
      }
    }
  }
  assert.ok(bodies.length > 50, String(bodies.length));
});

test("losing the final newline of a file is written the way git writes it", () => {
  // Checked against git: -a / -b / +a / marker. The removal the change already made used to
  // be emitted after the marker, which had declared the new side finished.
  const out = diff("a\nb\n", "a");
  const body = out.slice(out.indexOf("@@"));
  assert.equal(
    body,
    ["@@ -1,2 +1 @@", "-a", "-b", "+a", MARKER].join("\n"),
    out,
  );
});

test("a one-line range carries no count, the way git writes it", () => {
  // git prints "@@ -1 +1 @@" for a hunk that covers one line on a side, and keeps the count
  // only when it is not one. Both sides of a one-line change are affected, and a hunk that
  // touches one side only keeps the count on the other.
  const one = diff("a\n", "b\n");
  assert.equal(one.slice(one.indexOf("@@")), ["@@ -1 +1 @@", "-a", "+b"].join("\n"), one);

  const added = diff("a\n", "a\nb\n");
  assert.equal(added.slice(added.indexOf("@@")), ["@@ -1 +1,2 @@", " a", "+b"].join("\n"), added);
});

test("a trailing-newline change is reported alongside an edit elsewhere", () => {
  // The rewrite used to require every edit to be equal, so a content change anywhere in the
  // file hid the trailing-newline change: the last line stayed equal, no marker was emitted
  // for it, and the diff understated what happened.
  const out = diff("a\nb\nc\n", "a2\nb\nc");
  assert.ok(out.includes("-a"), out);
  assert.ok(out.includes("+a2"), out);
  assert.ok(out.includes("\\ No newline at end of file"), out);
});
