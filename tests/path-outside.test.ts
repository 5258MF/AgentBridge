import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyPatch } from "../src/extension/src/apply-patch.js";
import { findFiles } from "../src/extension/src/find-files.js";
import { readFiles, readImageFile } from "../src/extension/src/read-files.js";
import { searchFiles } from "../src/extension/src/search-files.js";

/** Run a tool and return everything it produced (result or thrown error) as text. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify(await run());
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return `${typeof code === "string" ? code : ""} ${error instanceof Error ? error.message : String(error)}`;
  }
}

function makeTree(): { base: string; root: string; outside: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-outside-"));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, "inside.txt"), "inside\n");
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
  fs.mkdirSync(path.join(outside, "dir"));
  return { base, root, outside };
}

test("outside paths report PATH_OUTSIDE_WORKSPACE whether or not they exist", async () => {
  const { base, root, outside } = makeTree();
  try {
    const workspaceRoots = [root];
    const probes: Array<[string, string]> = [
      ["existing absolute", path.join(outside, "secret.txt")],
      ["missing absolute", path.join(outside, "missing.txt")],
      ["existing relative", "../outside/secret.txt"],
      ["missing relative", "../outside/missing.txt"],
      ["missing directory", path.join(outside, "no-such-dir", "x.txt")],
    ];
    for (const [label, probe] of probes) {
      const results: Record<string, string> = {
        read_files: await outcome(() => readFiles({ files: [{ path: probe }] }, { workspaceRoots })),
        read_image_file: await outcome(() => readImageFile({ path: probe.replace(/\.txt$/, ".png") }, { workspaceRoots })),
        search_files: await outcome(() => searchFiles({ pattern: "secret", path: probe }, { workspaceRoots })),
        find_files: await outcome(() => findFiles({ patterns: ["*"], path: path.dirname(probe) }, { workspaceRoots })),
        apply_patch_update: await outcome(() => applyPatch({ patch: `*** Begin Patch\n*** Update File: ${probe}\n@@\n-secret\n+x\n*** End Patch` }, { workspaceRoots })),
        apply_patch_add: await outcome(() => applyPatch({ patch: `*** Begin Patch\n*** Add File: ${probe}.new\n+x\n*** End Patch` }, { workspaceRoots })),
      };
      for (const [tool, text] of Object.entries(results)) {
        assert.match(text, /PATH_OUTSIDE_WORKSPACE/, `${tool} / ${label}: ${text.slice(0, 300)}`);
        assert.doesNotMatch(text, /FILE_NOT_FOUND|NOT_A_FILE|NOT_A_DIRECTORY|PERMISSION_DENIED/, `${tool} / ${label}: ${text.slice(0, 300)}`);
      }
    }
    assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "secret\n");
    assert.equal(fs.readdirSync(outside).sort().join(","), "dir,secret.txt");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("missing paths inside the workspace still report FILE_NOT_FOUND, and inside paths still work", async () => {
  const { base, root } = makeTree();
  try {
    const workspaceRoots = [root];
    assert.match(await outcome(() => readFiles({ files: [{ path: "missing.txt" }] }, { workspaceRoots })), /FILE_NOT_FOUND/);
    assert.match(await outcome(() => readFiles({ files: [{ path: path.join(root, "missing.txt") }] }, { workspaceRoots })), /FILE_NOT_FOUND/);
    assert.match(await outcome(() => searchFiles({ pattern: "x", path: "missing-dir" }, { workspaceRoots })), /FILE_NOT_FOUND/);
    assert.match(await outcome(() => readFiles({ files: [{ path: "inside.txt" }] }, { workspaceRoots })), /"status":"success"/);
    assert.match(await outcome(() => readFiles({ files: [{ path: path.join(root, "inside.txt") }] }, { workspaceRoots })), /"status":"success"/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
