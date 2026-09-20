import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { findFiles } from "../src/extension/src/find-files.js";
import { searchFiles } from "../src/extension/src/search-files.js";
import { childProcessTest } from "./helpers/fake-child-process.js";

const SCOPE = path.join(process.cwd(), "tests", "helpers");

/**
 * Wait for the engine to spawn its first ripgrep.
 *
 * The cancellation has to arrive while the child is running, which is the only moment the
 * "close" and the abort can race - so the test cannot abort before the spawn has happened.
 */
async function waitForChild(): Promise<any> {
  for (let attempt = 0; attempt < 5_000; attempt += 1) {
    if (childProcessTest.spawned.length > 0) return childProcessTest.spawned[0]!;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("no ripgrep was spawned");
}

test("a search cancelled while ripgrep is running is reported as a cancellation", async () => {
  // A cancelled search used to answer the "close" event instead of the abort: the child ends
  // with no exit code and a signal, which is neither 0 nor 1 and not a truncation kill, so
  // the call came back as an I/O error reading "ripgrep exited with code null".
  childProcessTest.reset();
  const controller = new AbortController();
  const promise = searchFiles(
    { pattern: "needle", path: SCOPE },
    { workspaceRoots: [SCOPE], config: { ripgrepPath: "bundled-ripgrep" }, signal: controller.signal },
  );

  const child = await waitForChild();
  controller.abort();
  // A child killed by a signal reports no exit code, only the signal that ended it.
  child.emitExit(null, "SIGTERM");

  await assert.rejects(promise, (error: Error) => {
    assert.equal(error.message, "Search was cancelled.", error.message);
    return true;
  });
  assert.equal(childProcessTest.spawned.length, 1, "a cancellation must not be retried on another binary");
});

test("a listing cancelled while ripgrep is running is reported as a cancellation", async () => {
  childProcessTest.reset();
  const controller = new AbortController();
  const promise = findFiles(
    { patterns: ["*.ts"], path: SCOPE },
    { workspaceRoots: [SCOPE], config: { ripgrepPath: "bundled-ripgrep" }, signal: controller.signal },
  );

  const child = await waitForChild();
  controller.abort();
  child.emitExit(null, "SIGTERM");

  await assert.rejects(promise, (error: Error) => {
    assert.equal(error.message, "File discovery was cancelled.", error.message);
    return true;
  });
  assert.equal(childProcessTest.spawned.length, 1, "a cancellation must not be retried on another binary");
});

test("a ripgrep killed by a signal the caller did not send is still an I/O error", async () => {
  // The cancellation reading must not swallow a ripgrep that died on its own: only an aborted
  // caller turns a signal-killed child into a cancellation.
  childProcessTest.reset();
  const promise = searchFiles(
    { pattern: "needle", path: SCOPE },
    { workspaceRoots: [SCOPE], config: { ripgrepPath: "bundled-ripgrep" }, signal: new AbortController().signal },
  );

  const child = await waitForChild();
  child.emitExit(null, "SIGKILL");

  await assert.rejects(promise, (error: Error) => {
    assert.match(error.message, /ripgrep exited/, error.message);
    return true;
  });
});
