import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyPatch, formatApplyPatchForModel } from "../src/extension/src/apply-patch.js";

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-replace-"));
}

function version(file: string): string {
  return `sha256:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
}

function replacePatch(file: string, lines: string[]): string {
  return ["*** Begin Patch", `*** Delete File: ${file}`, `*** Add File: ${file}`, ...lines.map((line) => `+${line}`), "*** End Patch"].join("\n");
}

async function errorOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail("expected the patch to fail");
}

test("Delete File + Add File replaces the whole file in place", async () => {
  const root = makeRoot();
  try {
    const file = path.join(root, "app.txt");
    fs.writeFileSync(file, "\uFEFFold 1\r\nold 2\r\nold 3\r\n");
    const result = await applyPatch({ patch: replacePatch("app.txt", ["new a", "new b"]) }, { workspaceRoots: [root] });
    assert.equal(fs.readFileSync(file, "utf8"), "\uFEFFnew a\r\nnew b\r\n", "line endings and BOM are kept");
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0]!.action, "update");
    assert.equal(result.files[0]!.replaced, true);
    assert.equal(result.files[0]!.additions, 2);
    assert.match(formatApplyPatchForModel(result), /replaced: true/);
    assert.match(result.diff, /-old 1/);
    assert.match(result.diff, /\+new b/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("replacement honors expected_versions", async () => {
  const root = makeRoot();
  try {
    const file = path.join(root, "a.txt");
    fs.writeFileSync(file, "one\n");
    const stale = await errorOf(() => applyPatch(
      { patch: replacePatch("a.txt", ["two"]), expected_versions: { "a.txt": "sha256:0000" } },
      { workspaceRoots: [root] },
    ));
    assert.match(stale, /^STALE_FILE/);
    assert.equal(fs.readFileSync(file, "utf8"), "one\n");

    await applyPatch({ patch: replacePatch("a.txt", ["two"]), expected_versions: { "a.txt": version(file) } }, { workspaceRoots: [root] });
    assert.equal(fs.readFileSync(file, "utf8"), "two\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("replacement with no lines empties the file", async () => {
  const root = makeRoot();
  try {
    fs.writeFileSync(path.join(root, "e.txt"), "content\n");
    await applyPatch({ patch: replacePatch("e.txt", []) }, { workspaceRoots: [root] });
    assert.equal(fs.readFileSync(path.join(root, "e.txt"), "utf8"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Add File on an existing file still fails and explains how to replace it", async () => {
  const root = makeRoot();
  try {
    fs.writeFileSync(path.join(root, "x.txt"), "keep\n");
    const message = await errorOf(() => applyPatch({ patch: "*** Begin Patch\n*** Add File: x.txt\n+new\n*** End Patch" }, { workspaceRoots: [root] }));
    assert.match(message, /^FILE_ALREADY_EXISTS/);
    assert.match(message, /\*\*\* Delete File: x\.txt' immediately before '\*\*\* Add File: x\.txt'/);
    assert.equal(fs.readFileSync(path.join(root, "x.txt"), "utf8"), "keep\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("other repeated paths are still rejected, and a missing file cannot be replaced", async () => {
  const root = makeRoot();
  try {
    fs.writeFileSync(path.join(root, "y.txt"), "y\n");
    const reversed = await errorOf(() => applyPatch(
      { patch: "*** Begin Patch\n*** Add File: z.txt\n+z\n*** Delete File: z.txt\n*** End Patch" },
      { workspaceRoots: [root] },
    ));
    assert.match(reversed, /^INVALID_PATCH: Patch touches z\.txt more than once/);
    const updateThenAdd = await errorOf(() => applyPatch(
      { patch: "*** Begin Patch\n*** Update File: y.txt\n@@\n-y\n+w\n*** Add File: y.txt\n+q\n*** End Patch" },
      { workspaceRoots: [root] },
    ));
    assert.match(updateThenAdd, /^INVALID_PATCH/);
    assert.equal(fs.readFileSync(path.join(root, "y.txt"), "utf8"), "y\n");

    const missing = await errorOf(() => applyPatch({ patch: replacePatch("missing.txt", ["m"]) }, { workspaceRoots: [root] }));
    assert.match(missing, /^FILE_NOT_FOUND/);
    assert.equal(fs.existsSync(path.join(root, "missing.txt")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a replacement is rolled back together with a failing patch", async () => {
  const root = makeRoot();
  try {
    fs.writeFileSync(path.join(root, "r.txt"), "original\n");
    fs.writeFileSync(path.join(root, "s.txt"), "s\n");
    const patch = [
      "*** Begin Patch",
      "*** Delete File: r.txt",
      "*** Add File: r.txt",
      "+replaced",
      "*** Update File: s.txt",
      "@@",
      "-not in file",
      "+t",
      "*** End Patch",
    ].join("\n");
    const message = await errorOf(() => applyPatch({ patch }, { workspaceRoots: [root] }));
    assert.match(message, /^PATCH_CONTEXT_NOT_FOUND/);
    assert.equal(fs.readFileSync(path.join(root, "r.txt"), "utf8"), "original\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
