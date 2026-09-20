import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFiles } from "../src/extension/src/read-files.js";

function workspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-read-files-"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text, "utf8");
  return root;
}

async function read(root: string, request: Record<string, unknown>) {
  return readFiles({ files: [request] } as never, { workspaceRoots: [root] });
}

test("a range past the end of the file is reported, not returned empty", async () => {
  const root = workspace({ "a.txt": "one\ntwo\nthree\n" });
  try {
    const result = await read(root, { path: "a.txt", start_line: 40, end_line: 50 });
    const file = result.files[0]!;
    assert.equal(file.status, "error");
    assert.equal(file.status === "error" && file.error.code, "INVALID_LINE_RANGE");
    assert.match(file.status === "error" ? file.error.message : "", /past the end of the file/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a range that starts inside the file still reads", async () => {
  const root = workspace({ "a.txt": "one\ntwo\nthree\n" });
  try {
    const result = await read(root, { path: "a.txt", start_line: 2, end_line: 3 });
    const file = result.files[0]!;
    assert.equal(file.status, "success");
    assert.equal(file.status === "success" && file.content, "2: two\n3: three");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an empty file still reads as empty", async () => {
  // No line is past the end of a file that has none, so this keeps working as before.
  const root = workspace({ "empty.txt": "" });
  try {
    const result = await read(root, { path: "empty.txt", start_line: 1 });
    assert.equal(result.files[0]!.status, "success");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a start line past the end of an empty file is reported too", async () => {
  // The check exempted every empty file, so start_line: 2 on one came back as success with
  // the 2 echoed back - a caller reading its own number back has no way to notice it asked
  // for a line that cannot exist. start_line: 1 is how a caller asks for an empty file and
  // still succeeds; anything beyond that has nothing to point at.
  const root = workspace({ "empty.txt": "" });
  try {
    const result = await read(root, { path: "empty.txt", start_line: 2 });
    const file = result.files[0]!;
    assert.equal(file.status, "error");
    assert.equal(file.status === "error" && file.error.code, "INVALID_LINE_RANGE");
    assert.match(file.status === "error" ? file.error.message : "", /past the end of the file/);

    const atOne = await read(root, { path: "empty.txt", start_line: 1 });
    assert.equal(atOne.files[0]!.status, "success", "an empty file asked for by name still reads");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
