import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeTempScript, setIdeToolWarningSink } from "../src/extension/src/ide-tool-broker.js";

/**
 * The directory a temp script is written into is made by this code and taken away by this code.
 *
 * Both paths are exercised without a shell: the script is a file the platform can refuse to
 * delete, which is what a still-held file on Windows does for a moment after the shell exits,
 * and what the retry in removeTempScript exists for.
 */

function makeScriptDirectory(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-run-")));
  return root;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the directory a temp script was written into is taken away with it", async () => {
  const directory = makeScriptDirectory();
  const scriptPath = path.join(directory, "script.ps1");
  fs.writeFileSync(scriptPath, "Write-Output 'x'\n");
  removeTempScript(scriptPath);
  for (let waited = 0; waited < 2_000 && fs.existsSync(directory); waited += 50) await wait(50);
  assert.equal(fs.existsSync(directory), false, "the directory mkdtemp made must not be left behind");
});

test("the directory is still taken away when the script itself cannot be deleted", async () => {
  // Windows holds the file for a moment after the shell exits, which is what the single retry
  // is for - and when the retry fails as well, the code used to return without removing the
  // directory, so a file nobody could delete kept a directory nobody needed until the machine
  // was restarted. A directory is used here as a script no platform will unlink: it fails with
  // EPERM on Windows and EISDIR everywhere else, and neither is the ENOENT that means "gone".
  const directory = makeScriptDirectory();
  const scriptPath = path.join(directory, "script.ps1");
  fs.mkdirSync(scriptPath);

  const warnings: string[] = [];
  setIdeToolWarningSink((message) => warnings.push(message));
  try {
    removeTempScript(scriptPath);
    for (let waited = 0; waited < 2_000 && fs.existsSync(directory); waited += 50) await wait(50);
  } finally {
    setIdeToolWarningSink(undefined);
  }

  assert.equal(fs.existsSync(directory), false, "a file that cannot be deleted must not keep its directory");
  assert.equal(warnings.length > 0, true, "the failure is still reported rather than swallowed");
  assert.match(warnings[0]!, /could not remove temp script/);
});

test("a directory this code did not make is left alone", async () => {
  // The prefix is what says the directory belongs to this function, so a path from an older
  // build, or a caller's own temp directory, is not something it removes.
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "someone-elses-")));
  const scriptPath = path.join(directory, "script.ps1");
  fs.writeFileSync(scriptPath, "x\n");
  removeTempScript(scriptPath);
  await wait(400);
  assert.equal(fs.existsSync(directory), true, "only a directory mkdtemp made for a run is removed");
  assert.equal(fs.existsSync(scriptPath), false, "the script itself is still deleted");
  fs.rmSync(directory, { recursive: true, force: true });
});
