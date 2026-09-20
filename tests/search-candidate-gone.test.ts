import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { searchFiles } from "../src/extension/src/search-files.js";

test("a candidate that disappears mid-walk is skipped, not reported as a missing path", async () => {
  // The walk lists candidates and then reads them, and a file can vanish in between: a build
  // cleaning up, an editor writing over it. That used to surface as FILE_NOT_FOUND and "Search
  // path does not exist", which is a different failure entirely - and it abandoned the whole
  // search instead of continuing with the rest of the tree. find_files already skipped it.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-vanished-")));
  try {
    fs.writeFileSync(path.join(tmp, "a.txt"), "needle\n");
    fs.writeFileSync(path.join(tmp, "vanishing.txt"), "needle\n");
    fs.writeFileSync(path.join(tmp, "z.txt"), "needle\n");

    let removed = false;
    // The tool asks about the scope first and about each candidate as it reads them; the scope
    // arrives as an 8.3 path on Windows, so comparing it to tmp is not enough - a candidate is
    // told apart by its name instead. Deleting at the scope question would land before the walk,
    // and the file would simply never be listed.
    const result = await searchFiles(
      { pattern: "needle", path: tmp },
      {
        workspaceRoots: [tmp],
        checkPermission: (candidate) => {
          if (!removed && candidate.toLowerCase().endsWith(".txt")) {
            removed = true;
            fs.rmSync(path.join(tmp, "vanishing.txt"), { force: true });
          }
          return true;
        },
      },
    );

    assert.equal(result.engine, "node", JSON.stringify(result));
    assert.ok(!fs.existsSync(path.join(tmp, "vanishing.txt")), "the hook never removed the file");
    assert.equal(result.matches.length, 2, JSON.stringify(result.matches));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a file that was named as the scope and then disappears is reported as missing", async () => {
  // Same race, the other way round: when the scope is one file it is not one candidate among
  // many, it is the whole search. Skipping it the way a vanished tree entry is skipped answers
  // "no matches", which says the file has no match in it - a caller then reports a file it can
  // no longer see as one that simply does not contain the text. The scope going away is what
  // FILE_NOT_FOUND means everywhere else in this tool, so that is what it says here too.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-scope-gone-")));
  try {
    const target = path.join(tmp, "vanishing.txt");
    fs.writeFileSync(target, "needle\n");

    let removed = false;
    await assert.rejects(
      () =>
        searchFiles(
          { pattern: "needle", path: target },
          {
            workspaceRoots: [tmp],
            checkPermission: (candidate) => {
              if (!removed && candidate.toLowerCase().endsWith("vanishing.txt")) {
                removed = true;
                fs.rmSync(target, { force: true });
              }
              return true;
            },
          },
        ),
      /Search path does not exist/,
    );
    assert.ok(removed, "the hook never removed the file");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
