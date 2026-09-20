import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatSearchFilesForModel, searchFiles } from "../src/extension/src/search-files.js";

function write(root: string, relative: string, contents: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

test("a search says when a limit was brought into range", async () => {
  // The schema promises context_lines at most 5 and the tool used to answer 5 to a request for
  // 6 without a word about it, so a caller could not tell a shortened context from a bug.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-adjusted-")));
  try {
    write(tmp, "a.txt", "needle one\nneedle two\n");
    const result = await searchFiles(
      { pattern: "needle", path: tmp, context_lines: 6 },
      { workspaceRoots: [tmp], checkPermission: () => true },
    );
    assert.ok(
      result.adjusted_arguments?.some((note) => note.startsWith("context_lines was 6")),
      JSON.stringify(result.adjusted_arguments),
    );
    assert.match(formatSearchFilesForModel(result), /^adjusted: .*context_lines was 6/m);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a limit below the range is clamped rather than refused", async () => {
  // context_lines: -1 used to fail the whole search with INVALID_ARGUMENT while context_lines: 6
  // was quietly accepted as 5. Both ends answer the same way now.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-adjusted2-")));
  try {
    write(tmp, "a.txt", "needle\n");
    const result = await searchFiles(
      { pattern: "needle", path: tmp, context_lines: -1 },
      { workspaceRoots: [tmp], checkPermission: () => true },
    );
    assert.ok(
      result.adjusted_arguments?.some((note) => note.startsWith("context_lines was -1")),
      JSON.stringify(result.adjusted_arguments),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a limit that is not a number falls back, and the answer says so", async () => {
  // The schema says integer and the SDK does not enforce it, so "3" reached the tool and was
  // refused with INVALID_ARGUMENT, while run_command answered the same shape of value with a
  // fallback and a note. The file tools were the only ones that disagreed.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-adjusted3-")));
  try {
    write(tmp, "a.txt", "needle\n");
    const result = await searchFiles(
      { pattern: "needle", path: tmp, context_lines: "3" as unknown as number },
      { workspaceRoots: [tmp], checkPermission: () => true },
    );
    assert.ok(
      result.adjusted_arguments?.some((note) => note.includes('context_lines was "3"')),
      JSON.stringify(result.adjusted_arguments),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
