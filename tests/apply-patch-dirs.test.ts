import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyPatch, formatApplyPatchForModel } from "../src/extension/src/apply-patch.js";

function makeTree(): { base: string; root: string; outside: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-dirs-"));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  return { base, root, outside };
}

function add(file: string, line = "hello"): string {
  return `*** Begin Patch\n*** Add File: ${file}\n+${line}\n*** End Patch`;
}

async function errorOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail("expected the patch to fail");
}

test("Add File creates missing parent directories and reports them", async () => {
  const { base, root } = makeTree();
  try {
    const result = await applyPatch({ patch: add("src/new/deep/file.txt") }, { workspaceRoots: [root] });
    assert.equal(fs.readFileSync(path.join(root, "src", "new", "deep", "file.txt"), "utf8"), "hello\n");
    assert.deepEqual(result.created_directories, ["src", "src/new", "src/new/deep"]);
    assert.match(formatApplyPatchForModel(result), /created_directories: \["src","src\/new","src\/new\/deep"\]/);

    const again = await applyPatch({ patch: add("src/new/other.txt") }, { workspaceRoots: [root] });
    assert.equal(again.created_directories, undefined, "existing directories are not reported");
    assert.doesNotMatch(formatApplyPatchForModel(again), /created_directories/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("Move to creates missing parent directories", async () => {
  const { base, root } = makeTree();
  try {
    fs.writeFileSync(path.join(root, "a.txt"), "one\n");
    const patch = "*** Begin Patch\n*** Update File: a.txt\n*** Move to: moved/here/a.txt\n@@\n-one\n+two\n*** End Patch";
    const result = await applyPatch({ patch }, { workspaceRoots: [root] });
    assert.deepEqual(result.created_directories, ["moved", "moved/here"]);
    assert.equal(fs.readFileSync(path.join(root, "moved", "here", "a.txt"), "utf8"), "two\n");
    assert.equal(fs.existsSync(path.join(root, "a.txt")), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a patch that fails preflight creates no directories", async () => {
  const { base, root } = makeTree();
  try {
    fs.writeFileSync(path.join(root, "b.txt"), "keep\n");
    const patch = "*** Begin Patch\n*** Add File: fresh/x.txt\n+x\n*** Update File: b.txt\n@@\n-missing context\n+y\n*** End Patch";
    const message = await errorOf(() => applyPatch({ patch }, { workspaceRoots: [root] }));
    assert.match(message, /^PATCH_CONTEXT_NOT_FOUND/);
    assert.equal(fs.existsSync(path.join(root, "fresh")), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("new directories are never created outside the workspace", async () => {
  const { base, root, outside } = makeTree();
  try {
    const relative = await errorOf(() => applyPatch({ patch: add("../outside/newdir/x.txt") }, { workspaceRoots: [root] }));
    assert.match(relative, /^PATH_OUTSIDE_WORKSPACE/);
    const absolute = await errorOf(() => applyPatch({ patch: add(path.join(outside, "abs", "x.txt")) }, { workspaceRoots: [root] }));
    assert.match(absolute, /^PATH_OUTSIDE_WORKSPACE/);

    // A link inside the workspace pointing outside must not be followed.
    fs.symlinkSync(outside, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    const viaLink = await errorOf(() => applyPatch({ patch: add("link/sub/x.txt") }, { workspaceRoots: [root] }));
    assert.match(viaLink, /^PATH_OUTSIDE_WORKSPACE/);
    assert.deepEqual(fs.readdirSync(outside), [], "nothing may be created outside");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a file in place of a parent directory reports NOT_A_DIRECTORY", async () => {
  const { base, root } = makeTree();
  try {
    fs.writeFileSync(path.join(root, "notes.txt"), "text\n");
    const message = await errorOf(() => applyPatch({ patch: add("notes.txt/sub/x.txt") }, { workspaceRoots: [root] }));
    assert.match(message, /^NOT_A_DIRECTORY: Cannot create notes\.txt\/sub\/x\.txt: notes\.txt is a file/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("multi-root: a root where the parent exists is preferred, otherwise the first root", async () => {
  const { base, root } = makeTree();
  const second = path.join(base, "second");
  fs.mkdirSync(path.join(second, "only-here"), { recursive: true });
  try {
    await applyPatch({ patch: add("only-here/x.txt") }, { workspaceRoots: [root, second] });
    assert.equal(fs.existsSync(path.join(second, "only-here", "x.txt")), true);
    assert.equal(fs.existsSync(path.join(root, "only-here")), false);

    await applyPatch({ patch: add("nowhere/y.txt") }, { workspaceRoots: [root, second] });
    assert.equal(fs.existsSync(path.join(root, "nowhere", "y.txt")), true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
