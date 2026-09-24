import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { IdeToolBroker } from "../src/extension/src/ide-tool-broker.js";
import {
  findContainingRoot,
  resolveExistingInRoots,
  resolveLexicalInRoots,
  workspaceRootPaths,
} from "../src/extension/src/workspace-roots.js";
import { DiagnosticSeverity, languages, Position, Range, workspace } from "./helpers/fake-vscode.js";

function makeTempTree(): { base: string; a: string; b: string; outside: string; cleanup(): void } {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-roots-")));
  const a = path.join(base, "rootA");
  const b = path.join(base, "rootB");
  const outside = path.join(base, "outside");
  for (const dir of [a, b, outside]) fs.mkdirSync(dir, { recursive: true });
  return { base, a, b, outside, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function write(file: string, text = "x"): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const outsideError = () => new Error("OUTSIDE");

/** Directory link that works without admin rights on Windows (junction) and as a symlink elsewhere. */
function tryLinkDir(target: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Single-folder workspaces must behave exactly as before.
// ---------------------------------------------------------------------------

test("single root: lexical resolution always uses the only root, existing or not", () => {
  const tree = makeTempTree();
  try {
    write(path.join(tree.a, "src", "app.ts"));
    const existing = resolveLexicalInRoots([tree.a], "src/app.ts");
    assert.deepEqual(existing, { root: tree.a, absolute: path.join(tree.a, "src", "app.ts"), relative: "src/app.ts" });
    const missing = resolveLexicalInRoots([tree.a], "not/there.ts");
    assert.deepEqual(missing, { root: tree.a, absolute: path.join(tree.a, "not", "there.ts"), relative: "not/there.ts" });
    assert.equal(resolveLexicalInRoots([tree.a], ".")?.relative, ".");
    assert.equal(resolveLexicalInRoots([tree.a], "../outside"), undefined);
    assert.equal(resolveLexicalInRoots([tree.a], tree.a), undefined, "absolute input is rejected unless allowed");
  } finally {
    tree.cleanup();
  }
});

test("single root: existing resolution keeps legacy success, ENOENT and outside outcomes", async () => {
  const tree = makeTempTree();
  try {
    write(path.join(tree.a, "src", "app.ts"));
    const found = await resolveExistingInRoots([tree.a], "src/app.ts", outsideError);
    assert.equal(found.root, tree.a);
    assert.equal(found.absolute, path.join(tree.a, "src", "app.ts"));
    assert.equal(found.lexicalRelative, "src/app.ts");
    assert.equal(found.canonicalRelative, "src/app.ts");

    await assert.rejects(resolveExistingInRoots([tree.a], "missing.ts", outsideError), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    await assert.rejects(resolveExistingInRoots([tree.a], "../outside", outsideError), /OUTSIDE/);
    await assert.rejects(resolveExistingInRoots([tree.a], tree.outside, outsideError), /OUTSIDE/, "absolute input rejected by default");
    await assert.rejects(
      resolveExistingInRoots([tree.a], tree.outside, outsideError, { allowAbsolute: true }),
      /OUTSIDE/,
      "allowed absolute input must still stay inside the workspace",
    );
    const absolute = await resolveExistingInRoots([tree.a], path.join(tree.a, "src"), outsideError, { allowAbsolute: true });
    assert.equal(absolute.canonicalRelative, "src");
  } finally {
    tree.cleanup();
  }
});

test("single root: a link escaping the workspace is still rejected", async (t) => {
  const tree = makeTempTree();
  try {
    write(path.join(tree.outside, "secret.txt"));
    if (!tryLinkDir(tree.outside, path.join(tree.a, "escape"))) {
      t.skip("directory links are not available on this machine");
      return;
    }
    await assert.rejects(resolveExistingInRoots([tree.a], "escape/secret.txt", outsideError), /OUTSIDE/);
    await assert.rejects(resolveExistingInRoots([tree.a], "escape", outsideError), /OUTSIDE/);
  } finally {
    tree.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Multi-root workspaces: folders in order, first existing match wins.
// ---------------------------------------------------------------------------

test("multi root: lexical resolution prefers the first folder containing the entry", () => {
  const tree = makeTempTree();
  try {
    write(path.join(tree.b, "only-b", "file.ts"));
    write(path.join(tree.a, "both.ts"));
    write(path.join(tree.b, "both.ts"));
    assert.equal(resolveLexicalInRoots([tree.a, tree.b], "only-b/file.ts")?.root, tree.b);
    assert.equal(resolveLexicalInRoots([tree.a, tree.b], "both.ts")?.root, tree.a, "first folder wins ties");
    assert.equal(resolveLexicalInRoots([tree.a, tree.b], "nowhere.ts")?.root, tree.a, "missing everywhere falls back to first folder");
    assert.equal(resolveLexicalInRoots([tree.a, tree.b], ".")?.root, tree.a, "default cwd stays on the first folder");
  } finally {
    tree.cleanup();
  }
});

test("multi root: existing resolution searches later folders and keeps first-folder priority", async () => {
  const tree = makeTempTree();
  try {
    write(path.join(tree.b, "pkg", "index.ts"));
    write(path.join(tree.a, "shared.ts"));
    write(path.join(tree.b, "shared.ts"));
    const onlyB = await resolveExistingInRoots([tree.a, tree.b], "pkg/index.ts", outsideError);
    assert.equal(onlyB.root, tree.b);
    assert.equal(onlyB.lexicalRelative, "pkg/index.ts");
    assert.equal((await resolveExistingInRoots([tree.a, tree.b], "shared.ts", outsideError)).root, tree.a);
    await assert.rejects(resolveExistingInRoots([tree.a, tree.b], "nowhere.ts", outsideError), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    const absoluteInB = await resolveExistingInRoots([tree.a, tree.b], path.join(tree.b, "pkg"), outsideError, { allowAbsolute: true });
    assert.equal(absoluteInB.root, tree.b);
    assert.equal(absoluteInB.canonicalRelative, "pkg");
  } finally {
    tree.cleanup();
  }
});

test("multi root: an escaping link in one folder does not block a real entry in another", async (t) => {
  const tree = makeTempTree();
  try {
    write(path.join(tree.outside, "data", "x.txt"));
    write(path.join(tree.b, "data", "x.txt"));
    if (!tryLinkDir(path.join(tree.outside, "data"), path.join(tree.a, "data"))) {
      t.skip("directory links are not available on this machine");
      return;
    }
    const resolved = await resolveExistingInRoots([tree.a, tree.b], "data/x.txt", outsideError);
    assert.equal(resolved.root, tree.b);
    await assert.rejects(resolveExistingInRoots([tree.a], "data/x.txt", outsideError), /OUTSIDE/);
  } finally {
    tree.cleanup();
  }
});

test("findContainingRoot honours folder order for nested roots", () => {
  const outer = path.resolve("/ws/outer");
  const inner = path.resolve("/ws/outer/inner");
  const file = path.resolve("/ws/outer/inner/a.ts");
  assert.equal(findContainingRoot([outer, inner], file), outer);
  assert.equal(findContainingRoot([inner, outer], file), inner);
  assert.equal(findContainingRoot([inner], path.resolve("/ws/outer/b.ts")), undefined);
  assert.equal(findContainingRoot([outer], path.resolve("/ws/outer-sibling/a.ts")), undefined, "prefix is not containment");
});

// ---------------------------------------------------------------------------
// VS Code integration through the fake host.
// ---------------------------------------------------------------------------

test("workspaceRootPaths reads folders in order and fails clearly without a folder", () => {
  const original = workspace.workspaceFolders;
  try {
    workspace.workspaceFolders = [{ uri: { fsPath: "/one" } }, { uri: { fsPath: "/two" } }];
    assert.deepEqual(workspaceRootPaths(), ["/one", "/two"]);
    workspace.workspaceFolders = [];
    assert.throws(() => workspaceRootPaths(), /No workspace folder is open/);
  } finally {
    workspace.workspaceFolders = original;
  }
});

test("get_diagnostics reports files from every workspace folder, relative to their own folder", async () => {
  const tree = makeTempTree();
  const originalFolders = workspace.workspaceFolders;
  const originalGetDiagnostics = languages.getDiagnostics;
  const broker = new IdeToolBroker();
  try {
    write(path.join(tree.a, "a.ts"));
    write(path.join(tree.b, "lib", "b.ts"));
    const diagnostic = (message: string) => ({
      severity: DiagnosticSeverity.Error,
      range: new Range(new Position(0, 0), new Position(0, 1)),
      message,
      source: "ts",
      code: 1,
    });
    (languages as { getDiagnostics: () => unknown }).getDiagnostics = () => [
      [{ scheme: "file", fsPath: path.join(tree.a, "a.ts") }, [diagnostic("in A")]],
      [{ scheme: "file", fsPath: path.join(tree.b, "lib", "b.ts") }, [diagnostic("in B")]],
      [{ scheme: "file", fsPath: path.join(tree.outside, "c.ts") }, [diagnostic("outside")]],
    ];

    workspace.workspaceFolders = [{ uri: { fsPath: tree.a } }];
    const single = await broker.invokeDirect("get_diagnostics", {});
    assert.equal(single.isError, false, single.text);
    assert.match(single.text, /returned: 1/);
    assert.match(single.text, /a\.ts:1:1/);
    assert.doesNotMatch(single.text, /in B|outside/);

    workspace.workspaceFolders = [{ uri: { fsPath: tree.a } }, { uri: { fsPath: tree.b } }];
    const multi = await broker.invokeDirect("get_diagnostics", {});
    assert.equal(multi.isError, false, multi.text);
    assert.match(multi.text, /returned: 2/);
    assert.match(multi.text, /lib\/b\.ts:1:1/);
    assert.doesNotMatch(multi.text, /outside/);

    const scoped = await broker.invokeDirect("get_diagnostics", { path: "lib" });
    assert.equal(scoped.isError, false, scoped.text);
    assert.match(scoped.text, /scope: "lib"/);
    assert.match(scoped.text, /returned: 1/);
    assert.match(scoped.text, /in B/);
  } finally {
    broker.dispose();
    workspace.workspaceFolders = originalFolders;
    (languages as { getDiagnostics: unknown }).getDiagnostics = originalGetDiagnostics;
    tree.cleanup();
  }
});
