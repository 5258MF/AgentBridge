import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findFiles, formatFindFilesForModel } from "../src/extension/src/find-files.js";

function tree(root: string): void {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.txt"), "a\n");
  fs.writeFileSync(path.join(root, "src", "b.txt"), "b\n");
}

function find(root: string, maxResults: number) {
  return findFiles({ patterns: ["**/*.txt"], path: root, max_results: maxResults }, { workspaceRoots: [root], checkPermission: () => true });
}

test("a limit above the range is brought down, and the answer says so", async () => {
  // max_results is declared 1..500 and the SDK enforces neither end, so a caller asking for 900
  // was answered with 500 and had no way to tell that from a directory holding 500 files.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-find-limits-")));
  try {
    tree(root);
    const result = await find(root, 900);
    assert.ok(
      result.adjusted_arguments?.some((note) => note.startsWith("max_results was 900")),
      JSON.stringify(result.adjusted_arguments),
    );
    assert.match(formatFindFilesForModel(result), /^adjusted: .*max_results was 900/m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a limit below the range is clamped, not refused", async () => {
  // search_files clamps both ends since the shared helper; find_files still threw
  // INVALID_ARGUMENT on the low end while clamping the high one, so the same argument, asked of
  // two tools with the same name, answered in two different ways.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-find-limits2-")));
  try {
    tree(root);
    const result = await find(root, 0);
    assert.ok(
      result.adjusted_arguments?.some((note) => note.startsWith("max_results was 0")),
      JSON.stringify(result.adjusted_arguments),
    );
    assert.equal(result.summary.returned_files, 1, "a limit of one returns one file");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a limit in range stands, and is not reported", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-find-limits3-")));
  try {
    tree(root);
    const result = await find(root, 2);
    assert.equal(result.adjusted_arguments?.length ?? 0, 0);
    assert.doesNotMatch(formatFindFilesForModel(result), /^adjusted:/m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a limit that is not a number falls back, and the answer says so", async () => {
  // The schema says integer and the SDK does not enforce it, so "3" reached the tool. It was
  // refused with INVALID_ARGUMENT here while run_command answered the same shape of value with
  // a fallback and a note: two tools, one declared type, two behaviours.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-find-limits4-")));
  try {
    tree(root);
    const result = await findFiles(
      { patterns: ["**/*.txt"], path: root, max_results: "3" as unknown as number },
      { workspaceRoots: [root], checkPermission: () => true },
    );
    assert.ok(
      result.adjusted_arguments?.some((note) => note.includes('max_results was "3"')),
      JSON.stringify(result.adjusted_arguments),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
