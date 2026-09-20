import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { readImageFile, READ_IMAGE_FILE_SIZE_LIMIT } from "../src/extension/src/read-files.js";

/** The module object the tool reads through, so one call can be answered with a larger file. */
const promises = fsp as unknown as { readFile: (...args: unknown[]) => Promise<Buffer> };

function workspace(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-image-")));
  fs.writeFileSync(path.join(root, "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return root;
}

test("a file that grows between the stat and the read is still refused", async () => {
  // The ceiling was asked of the stat and never of the bytes that came back, so a file that
  // grew in between - an editor writing, a build copying over it - was decoded whole and handed
  // to the model as base64, which is what the ceiling exists to prevent. The size that was read
  // is the size that matters: it is what this call holds in memory.
  const root = workspace();
  const original = promises.readFile;
  promises.readFile = async () => Buffer.alloc(READ_IMAGE_FILE_SIZE_LIMIT + 1);
  try {
    const result = await readImageFile({ path: "a.png" }, { workspaceRoots: [root] });
    assert.equal(result.status, "error");
    assert.equal(result.error?.code, "IMAGE_TOO_LARGE");
    // The size it names is the one that was read, not the one the stat reported: 5 MB and one
    // byte, against a stat that said eight.
    assert.match(result.error?.message ?? "", /Image is 5\.00 MB, which exceeds the 5\.00 MB limit/);
  } finally {
    promises.readFile = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the ceiling is a setting, and one the caller did not set keeps the default", async () => {
  // 5 MB was hard-coded while the text ceiling next to it had been a setting for some time, so
  // a project whose images are all larger than that had no way to read any of them.
  const root = workspace();
  try {
    fs.writeFileSync(path.join(root, "a.png"), Buffer.alloc(64));
    const refused = await readImageFile({ path: "a.png" }, { workspaceRoots: [root], config: { maxBytes: 32 } });
    assert.equal(refused.error?.code, "IMAGE_TOO_LARGE");
    const allowed = await readImageFile({ path: "a.png" }, { workspaceRoots: [root], config: { maxBytes: 64 } });
    assert.equal(allowed.status, "success", allowed.error?.message ?? "");
    const defaulted = await readImageFile({ path: "a.png" }, { workspaceRoots: [root] });
    assert.equal(defaulted.status, "success", defaulted.error?.message ?? "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
