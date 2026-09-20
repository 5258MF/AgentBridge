import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { searchFiles } from "../src/extension/src/search-files.js";
import { findFiles } from "../src/extension/src/find-files.js";

function workspace(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-search-notes-")));
}

function write(root: string, relative: string, content: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

test("a match whose file is too large for its context says so", async () => {
  // A file the caller named is the whole search, so it is read however large it is - and then
  // it is too large to hold for the lines around the match. That used to happen silently: the
  // match came back with empty before/after and no reason, so a caller could not tell a file
  // that is too large from one that has nothing around it.
  const tmp = workspace();
  try {
    write(tmp, "big.txt", `${"x".repeat(400)}\nneedle\n${"y".repeat(400)}\n`);
    const result = await searchFiles(
      { pattern: "needle", path: path.join(tmp, "big.txt"), context_lines: 1 },
      { workspaceRoots: [tmp], checkPermission: () => true, config: { maxFallbackFileBytes: 100 } },
    );
    assert.ok(result.summary.truncation_reasons.includes("CONTEXT_FILE_TOO_LARGE"), JSON.stringify(result.summary));
    const match = result.matches[0];
    assert.ok(match, "the match itself is still reported");
    assert.deepEqual([match.before.length, match.after.length], [0, 0], "no context is invented for it");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("the caller's exclude is read with the case its own engine was given", async () => {
  // find_files asks ripgrep for --glob-case-insensitive and follows case_sensitive; search_files
  // never sets that switch and reads the exclude case-sensitively. Both are keeping pace with the
  // engine they drive, so the same exclude in a different case reaches them differently - on
  // purpose, and worth a test so it does not drift into an accident.
  const tmp = workspace();
  try {
    // Not a name the built-in excludes already hide, or the answer would be about those.
    write(tmp, path.join("scratch", "x.txt"), "needle\n");

    const searched = await searchFiles(
      { pattern: "needle", path: tmp, exclude: ["SCRATCH"] },
      { workspaceRoots: [tmp], checkPermission: () => true },
    );
    assert.equal(searched.matches.length, 1, "search reads SCRATCH as a different name from scratch");

    const found = await findFiles(
      { patterns: ["**/*.txt"], path: tmp, exclude: ["SCRATCH"] },
      { workspaceRoots: [tmp], checkPermission: () => true },
    );
    assert.equal(found.files.length, 0, "find reads SCRATCH as scratch, the way ripgrep is told to");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
