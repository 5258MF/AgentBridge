import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FILE_TOOL_DEFINITIONS,
  FILE_TOOL_NAMES,
  invokeFileTool,
  isFileToolName,
} from "../src/extension/src/file-tool-registry.js";

// A real directory, because the parsers run before anything is read and a test that got as
// far as the filesystem would be testing the wrong thing.
const CONTEXT = { workspaceRoots: [process.cwd()] };

async function rejects(name: string, args: unknown, expected: RegExp): Promise<void> {
  await assert.rejects(
    () => invokeFileTool(name, args, CONTEXT),
    (error: unknown) => {
      assert.match((error as Error).message, expected);
      return true;
    },
  );
}

test("the file tools are the ones the registry claims to serve", () => {
  assert.deepEqual([...FILE_TOOL_NAMES].sort(), ["apply_patch", "find_files", "read_files", "read_image_file", "search_files"]);
  for (const name of FILE_TOOL_NAMES) assert.equal(isFileToolName(name), true);
  assert.equal(isFileToolName("apply_patches"), false);
  assert.equal(isFileToolName("run_command"), false);
});

test("every file tool refuses arguments it did not ask for", () => {
  // A caller that misspells a field must be told, not silently answered with the field
  // dropped - "patchh" would otherwise be read as a patch that does nothing.
  for (const tool of FILE_TOOL_DEFINITIONS) {
    const schema = tool.inputSchema as Record<string, unknown>;
    assert.equal(schema.type, "object", tool.name);
    assert.equal(schema.additionalProperties, false, tool.name);
    assert.ok(tool.description.length > 0, tool.name);
  }
});

test("an unknown tool is refused by name", async () => {
  await rejects("write_file", {}, /Unknown file tool/);
});

test("an apply_patch call without a patch is refused", async () => {
  await rejects("apply_patch", {}, /patch must be a non-empty string/);
  await rejects("apply_patch", { patch: 42 }, /patch must be a non-empty string/);
  await rejects("apply_patch", "not an object", /expected an object/);
});

test("an expected version that is not a sha256 is refused", async () => {
  await rejects(
    "apply_patch",
    { patch: "*** Begin Patch\n*** End Patch", expected_versions: { "a.txt": "deadbeef" } },
    /sha256:\.\.\. strings/,
  );
  await rejects(
    "apply_patch",
    { patch: "*** Begin Patch\n*** End Patch", expected_versions: ["a.txt"] },
    /must be an object mapping paths/,
  );
});

test("a read_files call has to name at least one file", async () => {
  await rejects("read_files", { files: [] }, /files must not be empty/);
  await rejects("read_files", { paths: ["a.txt"] }, /files array/);
  await rejects("read_files", { files: [{ path: "" }] }, /files\[0\]\.path must be a non-empty string/);
  await rejects("read_files", { files: [{ path: "a.txt", start_line: 0 }] }, /files\[0\]\.start_line/);
});

test("a find_files call has to name at least one pattern", async () => {
  await rejects("find_files", { patterns: [] }, /patterns must be a non-empty array/);
  await rejects("find_files", { patterns: ["*.ts", ""] }, /patterns must be a non-empty array/);
  await rejects("find_files", { patterns: ["*.ts"], no_ignore: "yes" }, /no_ignore must be a boolean/);
  await rejects("find_files", { patterns: ["*.ts"], sort: "name" }, /sort must be/);
});

test("a search_files call refuses an ill-formed glob", async () => {
  // find_files has always checked these. search_files left them to ripgrep, which only
  // settles the question when a ripgrep is available: the fallback reads the same pattern as
  // a literal, so "src/[" was an error under one engine and a different search under the other.
  await rejects("search_files", { pattern: "x", include: ["src/["] }, /Glob patterns must be/);
  await rejects("search_files", { pattern: "x", exclude: ["**/{a,b"] }, /Glob patterns must be/);
});

test("a search_files call has to carry a pattern", async () => {
  await rejects("search_files", { pattern: "" }, /pattern must be a non-empty string/);
  await rejects("search_files", { pattern: "x", include: ["*.ts", ""] }, /include must be an array of non-empty strings/);
});

test("a read_image_file call has to name a file", async () => {
  await rejects("read_image_file", { path: "" }, /path must be a non-empty string/);
  await rejects("read_image_file", {}, /path must be a non-empty string/);
});

test("a read_image_file call that failed says so in the result, not only in the text", async () => {
  // The tool answers one file, so a failure is the call failing - there is no other file in
  // the answer that succeeded. It was reported as a normal result with "ERROR ..." inside the
  // text, which a caller that trusts the isError flag reads as an image it did not get.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-image-error-")));
  try {
    const result = await invokeFileTool("read_image_file", { path: "missing.png" }, { workspaceRoots: [root] });
    assert.equal(result.isError, true, result.text);
    assert.match(result.text, /FILE_NOT_FOUND/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
