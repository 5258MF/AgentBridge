import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findFiles, prunableDirectoryNames } from "../src/extension/src/find-files.js";

function workspace(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-find-prune-")));
}

function write(root: string, relative: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "x\n");
}

/**
 * A tree whose generated directory holds more entries than the walk is allowed to look at, so
 * whether that directory is read at all is something the answer can be asked about.
 */
function treeWithGeneratedDirectory(root: string, entries: number): void {
  for (let index = 0; index < entries; index += 1) {
    write(root, path.join("node_modules", `pkg${index}`, "index.js"));
  }
  write(root, path.join("src", "keep.txt"));
}

test("only globs naming a whole subtree can be pruned by name", () => {
  // Pruning by entry name is safe only for `**/name/**`, which excludes every path under such
  // a directory. `build/` and `**/build` name the directory alone, `**/[ab]/**` names two
  // directories one name cannot speak for, and `packages/*/gen/**` depends on a parent the
  // name knows nothing about: pruning those would hide files they let through.
  assert.deepEqual(
    [...prunableDirectoryNames(["**/node_modules/**", "**/dist/**", "**/*.zip", "build/", "**/build", "packages/*/gen/**", "**/[ab]/**", "**/a{b,c}/**"])].sort(),
    ["dist", "node_modules"],
  );
});

test("pruning folds case the way the exclude is matched", () => {
  // The built-ins are read case-insensitively, so "Vendor/" is pruned as "vendor/" is. A
  // caller's own exclude follows case_sensitive, so the same glob keeps its spelling there.
  assert.deepEqual([...prunableDirectoryNames(["**/Vendor/**"])], ["vendor"]);
  assert.deepEqual([...prunableDirectoryNames(["**/Vendor/**"], true)], ["Vendor"]);
});

test("a generated directory is not walked", async () => {
  // find_files matched every entry against `**/node_modules/**`, which a directory called
  // node_modules does not match - only what is under it does - so the directory was read in
  // full and then discarded one entry at a time. On a workspace with dependencies installed
  // that listing was the whole cost of the call. The budget below is what makes the
  // difference visible: entries inside a directory that is never read are never counted.
  const root = workspace();
  try {
    treeWithGeneratedDirectory(root, 40);
    const result = await findFiles(
      { patterns: ["**/*"], path: root },
      { workspaceRoots: [root], checkPermission: () => true, config: { maxFilesScanned: 10 } },
    );
    assert.deepEqual(result.summary.truncation_reasons, [], JSON.stringify(result.summary));
    assert.deepEqual(result.files.map((file) => file.path), ["src/keep.txt"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a directory the caller excluded is not walked either", async () => {
  // exclude names what the agent should not be shown, and it is written `**/generated/**`
  // often enough to be worth not descending into - the same listing as above, thrown away.
  const root = workspace();
  try {
    write(root, path.join("generated", "a.txt"));
    write(root, path.join("generated", "b.txt"));
    write(root, path.join("generated", "c.txt"));
    write(root, path.join("generated", "d.txt"));
    write(root, path.join("src", "keep.txt"));
    const result = await findFiles(
      { patterns: ["**/*"], path: root, exclude: ["**/generated/**"] },
      { workspaceRoots: [root], checkPermission: () => true, config: { maxFilesScanned: 4 } },
    );
    assert.deepEqual(result.summary.truncation_reasons, [], JSON.stringify(result.summary));
    assert.deepEqual(result.files.map((file) => file.path), ["src/keep.txt"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the walk stops at the scan budget and says so", async () => {
  // search_files has bounded its fallback at 20_000 files for a while; find_files had no bound
  // at all, so a call answered by this engine read the whole scope however large it was.
  const root = workspace();
  try {
    for (let index = 0; index < 30; index += 1) write(root, path.join("src", `file${index}.txt`));
    const result = await findFiles(
      { patterns: ["**/*.txt"], path: root },
      { workspaceRoots: [root], checkPermission: () => true, config: { maxFilesScanned: 12 } },
    );
    assert.ok(result.summary.truncation_reasons.includes("MAX_FILES_SCANNED"), JSON.stringify(result.summary));
    assert.ok(result.summary.returned_files > 0, "what was found before the stop is still returned");
    assert.ok(result.summary.returned_files < 30, "the walk stopped rather than reading everything");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the search fallback counts the directories it walks, not only the files", async () => {
  // find_files counts every entry it looks at; the search fallback counted files only, so a
  // tree made of empty directories cost nothing against its budget and the walk had no ceiling
  // but the abort signal.
  const root = workspace();
  try {
    for (let index = 0; index < 30; index += 1) fs.mkdirSync(path.join(root, "empty", `d${index}`), { recursive: true });
    const { searchFiles } = await import("../src/extension/src/search-files.js");
    const result = await searchFiles(
      { pattern: "needle", path: root },
      { workspaceRoots: [root], checkPermission: () => true, config: { maxFallbackFilesScanned: 12 } },
    );
    const reasons = result.summary.truncation_reasons ?? [];
    assert.ok(reasons.includes("MAX_FILES_SCANNED"), JSON.stringify(result.summary));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a walk inside the budget is not reported as bounded", async () => {
  // The ceiling is a bound on the fallback, not a claim about the answer: a scope that fits
  // must not come back flagged, or the caller would narrow a search that was complete.
  const root = workspace();
  try {
    write(root, path.join("src", "a.txt"));
    write(root, path.join("src", "b.txt"));
    const result = await findFiles(
      { patterns: ["**/*.txt"], path: root },
      { workspaceRoots: [root], checkPermission: () => true },
    );
    assert.deepEqual(result.summary.truncation_reasons, [], JSON.stringify(result.summary));
    assert.equal(result.summary.returned_files, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
