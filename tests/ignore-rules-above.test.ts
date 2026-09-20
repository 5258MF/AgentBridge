import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findFiles } from "../src/extension/src/find-files.js";
import { searchFiles } from "../src/extension/src/search-files.js";
import { clearIgnoreCache, gitignoreIgnores, ignoreRulesAbove, isAboveWorkspace, type GitignoreRules } from "../src/extension/src/gitignore.js";

function writeScopeFile(root: string, relative: string, content: string): void {
  const target = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function listedFrom(root: string, entries: Array<{ path: string }>): string[] {
  return entries
    .map((entry) => path.relative(root, path.isAbsolute(entry.path) ? entry.path : path.join(root, entry.path)).split(path.sep).join("/"))
    .sort();
}

test("a rule from above the walk root matches by prefixing, not by being out of scope", () => {
  // A file above the walk root names the tree from its own directory down, so every path inside
  // the walk carries the same prefix. Reading such a file and then comparing the unprefixed path
  // is how a scope below the rules ends up listing files that ripgrep hid.
  const rules: GitignoreRules = [{ above: "pkg", patterns: ["probe.txt"] }];
  assert.equal(gitignoreIgnores("probe.txt", rules), true);
  assert.equal(gitignoreIgnores("sub/keep.txt", rules), false);
});

test("ignoreRulesAbove classifies each directory against the root the walk writes its paths against", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-above-")));
  try {
    writeScopeFile(tmp, ".ignore", "secret.txt\n");
    writeScopeFile(tmp, "inner/.gitignore", "inner-only.txt\n");
    writeScopeFile(tmp, "inner/pkg/keep.txt", "x\n");
    // The walk root is tmp/inner/pkg and the workspace root is tmp, so tmp/inner is inside the
    // workspace while tmp's own parent is above it. The same walk visiting the same directories
    // has to produce both shapes.
    const rules = await ignoreRulesAbove(path.join(tmp, "inner", "pkg"), tmp);

    const bases = rules.filter((set) => "base" in set).map((set) => (set as { base: string }).base);
    const aboves = rules.filter((set) => "above" in set).map((set) => (set as { above: string }).above);
    assert.ok(bases.includes("inner"), JSON.stringify(bases));
    assert.ok(bases.includes(""), JSON.stringify(bases));
    // Only a directory above the workspace root is prefixed, and whether one contributes at all
    // depends on whether the machine's temp directory happens to hold an ignore file.
    for (const above of aboves) assert.equal(above, path.basename(tmp), JSON.stringify(aboves));

    // A rule from the workspace root reaches the whole walk; one from tmp/inner reaches only the
    // paths under tmp/inner, so a file of the same name at the workspace root is not covered.
    assert.equal(gitignoreIgnores("inner/pkg/secret.txt", rules), true);
    assert.equal(gitignoreIgnores("inner/pkg/keep.txt", rules), false);
    assert.equal(gitignoreIgnores("inner-only.txt", rules), false, "a rule from inner/ does not reach the root");
    assert.equal(gitignoreIgnores("secret.txt", rules), true, "a bare name from the root reaches every depth");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("find_files hides what an ignore file above the scope root hides", async () => {
  // ripgrep reads the ignore files of every directory on the way up, so a scope below the file
  // holding the rules answers the same as the tree that holds it. The walk read none of them and
  // listed the file ripgrep had hidden.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-parent-ignore-")));
  const scope = path.join(tmp, "pkg");
  try {
    writeScopeFile(tmp, ".gitignore", "parent-rules-probe.txt\n");
    writeScopeFile(tmp, "pkg/parent-rules-probe.txt", "needle\n");
    writeScopeFile(tmp, "pkg/keep.txt", "needle\n");
    const result = await findFiles(
      { patterns: ["**/*.txt"], path: scope },
      { workspaceRoots: [tmp], checkPermission: () => true },
    );
    assert.equal(result.engine, "node", JSON.stringify(result));
    // Paths come back relative to the workspace root, so the scope's own directory is part of them.
    assert.deepEqual(listedFrom(tmp, result.files), ["pkg/keep.txt"], JSON.stringify(result.files));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("search_files skips what an ignore file above the scope root hides", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-parent-search-")));
  const scope = path.join(tmp, "pkg");
  try {
    writeScopeFile(tmp, ".ignore", "parent-rules-probe.txt\n");
    writeScopeFile(tmp, "pkg/parent-rules-probe.txt", "needle\n");
    writeScopeFile(tmp, "pkg/keep.txt", "needle\n");
    const result = await searchFiles(
      { pattern: "needle", path: scope },
      { workspaceRoots: [tmp], checkPermission: () => true },
    );
    assert.equal(result.engine, "node", JSON.stringify(result));
    assert.deepEqual(listedFrom(tmp, result.matches), ["pkg/keep.txt"], JSON.stringify(result.matches));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("an ancestor rule that names a directory is anchored where git anchors it", async () => {
  // A pattern with a slash in it is anchored at the directory holding the file, so
  // tmp/.gitignore naming "pkg/secret.txt" hides exactly that one file. The paths the walk hands
  // to a rule are relative to the workspace root, so the distance collected from above has to be
  // measured against that same root: against the walk root the two agree only when the scope is
  // the workspace root, which is what let a bare filename - matched on its last segment - look
  // like it worked.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-anchored-")));
  const scope = path.join(tmp, "pkg");
  try {
    writeScopeFile(tmp, ".gitignore", "pkg/secret.txt\n");
    writeScopeFile(tmp, "pkg/secret.txt", "needle\n");
    writeScopeFile(tmp, "pkg/keep.txt", "needle\n");

    const found = await findFiles(
      { patterns: ["**/*.txt"], path: scope },
      { workspaceRoots: [tmp], checkPermission: () => true },
    );
    assert.equal(found.engine, "node", JSON.stringify(found));
    assert.deepEqual(listedFrom(tmp, found.files), ["pkg/keep.txt"], JSON.stringify(found.files));

    const hit = await searchFiles(
      { pattern: "needle", path: scope },
      { workspaceRoots: [tmp], checkPermission: () => true },
    );
    assert.equal(hit.engine, "node", JSON.stringify(hit));
    assert.deepEqual(listedFrom(tmp, hit.matches), ["pkg/keep.txt"], JSON.stringify(hit.matches));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("only a parent directory counts as being above the workspace", () => {
  // ".." names the parent and is what a path outside the workspace starts with; a directory
  // called "..cache" is an ordinary name that happens to start the same way. A prefix test
  // read the second as the first, so its rules were anchored by distance from the walk root
  // instead of by path - and then matched nothing, which brought back the files they hid.
  assert.equal(isAboveWorkspace(".."), true);
  assert.equal(isAboveWorkspace("../.."), true);
  assert.equal(isAboveWorkspace(".../x"), false);
  assert.equal(isAboveWorkspace("..cache"), false);
  assert.equal(isAboveWorkspace("..cache/inner"), false);
  assert.equal(isAboveWorkspace(""), false);
  assert.equal(isAboveWorkspace("inner"), false);
});

test("the walk stops climbing at the workspace root", async () => {
  // A directory above the workspace belongs to the machine, not to the tree the caller opened:
  // a repository holding several folders, or a home directory two levels up, would otherwise
  // reach into a scope that never named it.
  const outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-outer-")));
  const root = path.join(outer, "ws");
  try {
    writeScopeFile(outer, ".gitignore", "outside.txt\n");
    writeScopeFile(root, ".gitignore", "inside.txt\n");
    writeScopeFile(root, "pkg/outside.txt", "x\n");
    writeScopeFile(root, "pkg/inside.txt", "x\n");
    writeScopeFile(root, "pkg/keep.txt", "x\n");
    const result = await findFiles(
      { patterns: ["**/*.txt"], path: path.join(root, "pkg") },
      { workspaceRoots: [root], checkPermission: () => true },
    );
    const listed = listedFrom(root, result.files);
    assert.ok(listed.includes("pkg/outside.txt"), `a rule from above the workspace must not reach in: ${listed}`);
    assert.ok(!listed.includes("pkg/inside.txt"), `a rule from the workspace root still applies: ${listed}`);
    assert.ok(listed.includes("pkg/keep.txt"), JSON.stringify(listed));
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test("the ignore files of a directory are read once", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-cache-")));
  try {
    writeScopeFile(tmp, ".gitignore", "first.txt\n");
    const first = await ignoreRulesAbove(path.join(tmp, "pkg"), tmp);
    writeScopeFile(tmp, ".gitignore", "second.txt\n");
    const cached = await ignoreRulesAbove(path.join(tmp, "pkg"), tmp);
    assert.deepEqual(cached, first, "the answer a walk already paid for is kept");
    assert.equal(gitignoreIgnores("first.txt", cached), true);
    assert.equal(gitignoreIgnores("second.txt", cached), false);

    clearIgnoreCache();
    const fresh = await ignoreRulesAbove(path.join(tmp, "pkg"), tmp);
    assert.equal(gitignoreIgnores("second.txt", fresh), true, "clearing the cache reads the file again");
    assert.equal(gitignoreIgnores("first.txt", fresh), false);
  } finally {
    clearIgnoreCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
