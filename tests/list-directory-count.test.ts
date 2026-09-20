import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileType, vscodeTest, workspace, workspaceFs } from "./helpers/fake-vscode.js";
import { listDirectory } from "../src/extension/src/ide-tool-broker.js";

/**
 * A directory tree the fake filesystem answers with. Names are handed back in the order the
 * host would list them, with the type bits a provider reports.
 */
function treeOf(directories: Record<string, Array<[string, number]>>) {
  workspaceFs.readDirectory = async (uri) => {
    const key = Object.keys(directories).find((name) => uri.fsPath.endsWith(name));
    return key ? directories[key]! : [];
  };
}

test("a listing that had to stop says how much it saw", async () => {
  // "truncated: true" said the answer was short and not by how much, which is the whole
  // difference between a directory holding one more entry and one holding four hundred: a
  // caller deciding whether to ask again, or to narrow the scope, had nothing to decide with.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-list-")));
  try {
    vscodeTest.reset();
    (workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: root } }];
    const many = Array.from({ length: 12 }, (_, index) => [`f${index}.txt`, FileType.File] as [string, number]);
    treeOf({ [path.basename(root)]: many });

    const short = await listDirectory({ max_entries: 5 });
    assert.match(short, /^returned_entries: 5$/m, short);
    assert.match(short, /^entries_seen: 12$/m, short);
    assert.match(short, /^truncated: true$/m, short);

    const whole = await listDirectory({ max_entries: 50 });
    assert.match(whole, /^returned_entries: 12$/m, whole);
    assert.match(whole, /^entries_seen: 12$/m, whole);
    assert.match(whole, /^truncated: false$/m, whole);
    assert.doesNotMatch(whole, /NOTE: the listing stopped/, "a complete listing has nothing to explain");
  } finally {
    workspaceFs.readDirectory = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
