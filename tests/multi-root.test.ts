import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileType, vscodeTest, workspace, workspaceFs } from "./helpers/fake-vscode.js";
import { listDirectory } from "../src/extension/src/ide-tool-broker.js";
import { findFiles } from "../src/extension/src/find-files.js";

/**
 * A window with two folders. The file tools were always handed both, but the IDE side asked
 * only the first one, so a path belonging to the second folder was answered as an escape.
 */
function twoFolders(): { first: string; second: string } {
  const first = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-root1-")));
  const second = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-root2-")));
  (workspace as { workspaceFolders: unknown }).workspaceFolders = [
    { uri: { fsPath: first } },
    { uri: { fsPath: second } },
  ];
  return { first, second };
}

function treeOf(directories: Record<string, Array<[string, number]>>): void {
  workspaceFs.readDirectory = async (uri) => {
    const key = Object.keys(directories).find((name) => uri.fsPath.endsWith(name));
    return key ? directories[key]! : [];
  };
}

test("a path that only the second folder has is inside the workspace", async () => {
  // The IDE side asked only workspaceFolders[0], so a path belonging to the second folder was
  // resolved against the first - where nothing of that name exists - and answered as missing
  // or as an escape. "." still means the first folder, which is what it has always meant.
  const { first, second } = twoFolders();
  try {
    fs.mkdirSync(path.join(second, "only2"));
    fs.writeFileSync(path.join(second, "only2", "in-only2.txt"), "x\n");
    treeOf({ only2: [["in-only2.txt", FileType.File]] });

    const listing = await listDirectory({ path: "only2" });
    assert.match(listing, /in-only2\.txt/, listing);
    assert.match(listing, /^path: "only2"$/m, listing);
  } finally {
    workspaceFs.readDirectory = undefined;
    vscodeTest.reset();
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});

test("a scope that is a file in one folder and a directory in the next is the directory", async () => {
  // resolveSafeScope decided on the first candidate it could stat: with "pkg" a file in the
  // first folder and a directory in the second, find_files answered NOT_A_DIRECTORY and never
  // looked at the folder that has the directory the caller meant.
  const { first, second } = twoFolders();
  try {
    fs.writeFileSync(path.join(first, "pkg"), "not a directory\n");
    fs.mkdirSync(path.join(second, "pkg"));
    fs.writeFileSync(path.join(second, "pkg", "inside.txt"), "needle\n");

    const result = await findFiles(
      { patterns: ["**/*.txt"], path: "pkg" },
      { workspaceRoots: [first, second], checkPermission: () => true },
    );
    const listed = result.files
      .map((entry) => path.relative(second, path.isAbsolute(entry.path) ? entry.path : path.join(second, entry.path)).split(path.sep).join("/"))
      .sort();
    assert.deepEqual(listed, ["pkg/inside.txt"], JSON.stringify(result));
  } finally {
    vscodeTest.reset();
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});
