import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findFiles } from "../src/extension/src/find-files.js";
import { searchFiles } from "../src/extension/src/search-files.js";
import { childProcessTest } from "./helpers/fake-child-process.js";

// Small on purpose: a candidate that cannot serve the search falls through to the Node
// engine, which really walks and reads the scope.
const SCOPE = path.join(process.cwd(), "tests", "helpers");

/**
 * Answer every ripgrep the engine spawns until the call settles.
 *
 * The engine spawns a candidate and waits for it before trying the next, so a test can only
 * hand a child its output once the engine has asked for it - and it keeps asking, through the
 * configured path, RIPGREP_PATH, the bundled binary and finally a bare "rg", until one of
 * them serves the call. `answer` is applied to each child in the order it is spawned.
 */
async function driveRipgreps<T>(
  start: () => Promise<T>,
  answer: (child: any, index: number) => void,
): Promise<{ result: T; commands: string[] }> {
  const promise = start();
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });

  const commands: string[] = [];
  for (let attempt = 0; attempt < 5_000 && !settled; attempt += 1) {
    if (childProcessTest.spawned.length > commands.length) {
      const child = childProcessTest.spawned[commands.length]!;
      commands.push(child.command);
      answer(child, commands.length);
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return { result: await promise, commands };
}

function rejectsTheFlags(child: any): void {
  child.emitStderr("rg: unrecognized flag --max-count\n");
  child.emitExit(2);
}

function failsToSearch(child: any): void {
  child.emitStderr(`rg: ${SCOPE}: IO error for operation on ${SCOPE}: Not a directory (os error 20)\n`);
  child.emitExit(2);
}

async function withRipgrepOnPath<T>(body: () => Promise<T>): Promise<T> {
  const saved = process.env.RIPGREP_PATH;
  process.env.RIPGREP_PATH = "ripgrep-on-path";
  try {
    return await body();
  } finally {
    if (saved === undefined) delete process.env.RIPGREP_PATH;
    else process.env.RIPGREP_PATH = saved;
  }
}

test("a find ripgrep that rejects the flags is followed by the next candidate", async () => {
  childProcessTest.reset();
  await withRipgrepOnPath(async () => {
    const { result, commands } = await driveRipgreps(
      () => findFiles(
        { patterns: ["*.ts"], path: SCOPE },
        { workspaceRoots: [SCOPE], config: { ripgrepPath: "bundled-ripgrep" } },
      ),
      (child, index) => {
        if (index > 2) throw new Error(`a working ripgrep must stop the search, but candidate ${index} was spawned.`);
        if (index === 1) {
          rejectsTheFlags(child);
          return;
        }
        child.emitStdout("fake-vscode.ts\npanel-harness.ts\n");
        child.emitExit(0);
      },
    );
    assert.deepEqual(commands, ["bundled-ripgrep", "ripgrep-on-path"]);
    assert.equal(result.engine, "ripgrep", JSON.stringify(result));
    assert.equal(result.files.length, 2, JSON.stringify(result));
  });
});

test("a search ripgrep that rejects the flags is followed by the next candidate", async () => {
  childProcessTest.reset();
  await withRipgrepOnPath(async () => {
    const { result, commands } = await driveRipgreps(
      () => searchFiles(
        { pattern: "needle", path: SCOPE },
        { workspaceRoots: [SCOPE], config: { ripgrepPath: "bundled-ripgrep" } },
      ),
      (child, index) => {
        if (index > 2) throw new Error(`a working ripgrep must stop the search, but candidate ${index} was spawned.`);
        if (index === 1) {
          rejectsTheFlags(child);
          return;
        }
        child.emitStdout(
          `${JSON.stringify({ type: "match", data: { path: { text: "fake-vscode.ts" }, lines: { text: "needle\n" }, line_number: 3, submatches: [{ start: 0 }] } })}\n`,
        );
        child.emitExit(0);
      },
    );
    assert.deepEqual(commands, ["bundled-ripgrep", "ripgrep-on-path"]);
    assert.equal(result.engine, "ripgrep", JSON.stringify(result));
    assert.equal(result.matches.length, 1, JSON.stringify(result));
  });
});

test("candidates that all reject the flags fall through to the Node engine", async () => {
  childProcessTest.reset();
  await withRipgrepOnPath(async () => {
    const { result, commands } = await driveRipgreps(
      () => searchFiles(
        { pattern: "needle", path: SCOPE },
        { workspaceRoots: [SCOPE], config: { ripgrepPath: "bundled-ripgrep" } },
      ),
      (child) => rejectsTheFlags(child),
    );
    // Every candidate was tried before giving up on ripgrep at all.
    assert.ok(commands.length > 2, commands.join(", "));
    // The Node engine still answers the call; it is slower, not wrong.
    assert.equal(result.engine, "node", JSON.stringify(result));
  });
});

/**
 * A scope holding one directory per built-in exclude, spelled with a capital letter.
 *
 * "Node_modules" and "Vendor" are the same kind of noise "node_modules" and "vendor" are, and
 * on a case-sensitive filesystem they can sit beside the real thing.
 */
function casedExcludeScope(): { root: string; cleanup: () => void } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-find-case-")));
  for (const name of ["Node_modules/a.js", "Vendor/b.js", "src/c.js"]) {
    const target = path.join(root, ...name.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "needle\n");
  }
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function listedFrom(root: string, files: Array<{ path: string }>): string[] {
  return files
    .map((file) => path.relative(root, path.isAbsolute(file.path) ? file.path : path.join(root, file.path)).split(path.sep).join("/"))
    .sort();
}

test("the Node engine hides a differently-cased built-in exclude, the way ripgrep does", async () => {
  // ripgrep is handed --glob-case-insensitive whenever case_sensitive is false and applies it
  // to the built-in excludes along with every other glob, so "Vendor/" is hidden. The Node
  // engine matched those same globs case-sensitively, so the one call answered two ways and
  // which answer came back depended only on whether a ripgrep happened to be installed.
  const { root, cleanup } = casedExcludeScope();
  try {
    const result = await findFiles(
      { patterns: ["**/*.js"], path: root },
      { workspaceRoots: [root], checkPermission: () => true },
    );
    assert.equal(result.engine, "node", JSON.stringify(result));
    assert.deepEqual(listedFrom(root, result.files), ["src/c.js"], JSON.stringify(result.files));
  } finally {
    cleanup();
  }
});

test("case_sensitive does not lift the built-in excludes", async () => {
  // The built-ins are noise reduction and are matched case-insensitively whatever the caller
  // asks for, in both engines: ripgrep gets them as --iglob, which is per-glob and independent
  // of the whole-command --glob-case-insensitive switch. Only the caller's own patterns and
  // exclude follow case_sensitive, so "Node_modules" stays hidden here.
  const { root, cleanup } = casedExcludeScope();
  try {
    const result = await findFiles(
      { patterns: ["**/*.js"], path: root, case_sensitive: true },
      { workspaceRoots: [root], checkPermission: () => true },
    );
    assert.deepEqual(listedFrom(root, result.files), ["src/c.js"], JSON.stringify(result.files));
  } finally {
    cleanup();
  }
});

test("case_sensitive still governs the caller's own pattern", async () => {
  // The point of the previous test: it is the built-ins that stopped following case_sensitive,
  // not case_sensitive that stopped working. A pattern of this caller's own still does.
  const { root, cleanup } = casedExcludeScope();
  try {
    const insensitive = await findFiles(
      { patterns: ["**/SRC/*.js"], path: root },
      { workspaceRoots: [root], checkPermission: () => true },
    );
    assert.deepEqual(listedFrom(root, insensitive.files), ["src/c.js"], JSON.stringify(insensitive.files));

    const sensitive = await findFiles(
      { patterns: ["**/SRC/*.js"], path: root, case_sensitive: true },
      { workspaceRoots: [root], checkPermission: () => true },
    );
    assert.deepEqual(listedFrom(root, sensitive.files), [], JSON.stringify(sensitive.files));
  } finally {
    cleanup();
  }
});

test("the built-in excludes reach ripgrep as case-insensitive globs of their own", async () => {
  // --iglob rather than --glob, so they do not depend on --glob-case-insensitive being set -
  // which is why find_files and search_files now agree despite only one of them ever setting
  // that switch.
  childProcessTest.reset();
  await withRipgrepOnPath(async () => {
    const seen: string[][] = [];
    for (const caseSensitive of [undefined, true]) {
      // Each run spawns its own child, and the harness reads every child spawned so far, so
      // the second run would otherwise be handed the first run's again.
      childProcessTest.reset();
      const { result } = await driveRipgreps(
        () => findFiles(
          { patterns: ["*.js"], path: SCOPE, ...(caseSensitive === undefined ? {} : { case_sensitive: true }) },
          { workspaceRoots: [SCOPE], config: { ripgrepPath: "bundled-ripgrep" } },
        ),
        (child) => {
          seen.push([...child.args]);
          child.emitStdout("");
          child.emitExit(0);
        },
      );
      assert.equal(result.engine, "ripgrep", JSON.stringify(result));
    }
    const [loose, strict] = seen;
    assert.ok(loose!.includes("--glob-case-insensitive"), loose!.join(" "));
    assert.ok(!strict!.includes("--glob-case-insensitive"), strict!.join(" "));
    for (const args of seen) {
      const at = args.indexOf("!**/node_modules/**");
      assert.ok(at > 0, args.join(" "));
      assert.equal(args[at - 1], "--iglob", args.join(" "));
    }
  });
});

test("search_files hides the same differently-cased directories find_files does", async () => {
  // The reason for --iglob: search_files never sets --glob-case-insensitive, because its
  // case_sensitive governs the text being searched rather than the paths. Tying the built-ins
  // to that switch left "Vendor/" visible to search and hidden from find, so the two tools
  // disagreed about what is in the workspace.
  const { root, cleanup } = casedExcludeScope();
  try {
    const result = await searchFiles(
      { pattern: "needle", path: root },
      { workspaceRoots: [root], checkPermission: () => true },
    );
    assert.equal(result.engine, "node", JSON.stringify(result));
    assert.deepEqual(listedFrom(root, result.matches), ["src/c.js"], JSON.stringify(result.matches));
  } finally {
    cleanup();
  }
});

test("search_files reaches ripgrep the same way, without the whole-command switch", async () => {
  // Same --iglob, and no --glob-case-insensitive in either mode: the caller's case_sensitive is
  // spent on --case-sensitive/--ignore-case/--smart-case instead.
  childProcessTest.reset();
  await withRipgrepOnPath(async () => {
    const { result } = await driveRipgreps(
      () => searchFiles(
        { pattern: "needle", path: SCOPE },
        { workspaceRoots: [SCOPE], config: { ripgrepPath: "bundled-ripgrep" } },
      ),
      (child) => {
        child.emitStdout("");
        child.emitExit(0);
      },
    );
    assert.equal(result.engine, "ripgrep", JSON.stringify(result));
    const args = childProcessTest.spawned[0]!.args;
    assert.ok(!args.includes("--glob-case-insensitive"), args.join(" "));
    const at = args.indexOf("!**/node_modules/**");
    assert.ok(at > 0, args.join(" "));
    assert.equal(args[at - 1], "--iglob", args.join(" "));
  });
});

test("a search ripgrep cannot perform still surfaces instead of being retried away", async () => {
  childProcessTest.reset();
  await withRipgrepOnPath(async () => {
    await assert.rejects(
      driveRipgreps(
        () => searchFiles(
          { pattern: "needle", path: SCOPE },
          { workspaceRoots: [SCOPE], config: { ripgrepPath: "bundled-ripgrep" } },
        ),
        (child) => failsToSearch(child),
      ),
      (error: Error) => error.message.includes("IO error"),
    );
    assert.equal(childProcessTest.spawned.length, 1, "a real search error must not be retried on another binary");
  });
});

test("a find ripgrep cannot perform still surfaces instead of being retried away", async () => {
  childProcessTest.reset();
  await withRipgrepOnPath(async () => {
    await assert.rejects(
      driveRipgreps(
        () => findFiles(
          { patterns: ["*.ts"], path: SCOPE },
          { workspaceRoots: [SCOPE], config: { ripgrepPath: "bundled-ripgrep" } },
        ),
        (child) => failsToSearch(child),
      ),
      (error: Error) => error.message.includes("IO error"),
    );
    assert.equal(childProcessTest.spawned.length, 1, "a real walk error must not be retried on another binary");
  });
});

function writeScopeFile(root: string, relative: string, content: string): void {
  const target = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

/**
 * A scope whose only .gitignore sits below the root.
 *
 * `sub/.gitignore` ignores `nested/`, and `other/nested/` is a decoy with the same name one
 * level over: a pattern pulled out of the directory that owns it would hide both.
 */
function nestedGitignoreScope(): { root: string; cleanup: () => void } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-nested-ignore-")));
  writeScopeFile(root, "src/keep.js", "needle\n");
  writeScopeFile(root, "sub/.gitignore", "nested/\n");
  writeScopeFile(root, "sub/other.js", "needle\n");
  writeScopeFile(root, "sub/nested/deep.js", "needle\n");
  writeScopeFile(root, "other/nested/decoy.js", "needle\n");
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("the Node engine honours a .gitignore below the scope root, the way ripgrep does", async () => {
  // Only the root's .gitignore used to be read, so every nested one was invisible to the
  // fallback: a directory ripgrep walked straight past was walked into here, and one call
  // listed different files depending on which engine happened to answer it.
  const { root, cleanup } = nestedGitignoreScope();
  try {
    const result = await findFiles(
      { patterns: ["**/*.js"], path: root },
      { workspaceRoots: [root], checkPermission: () => true },
    );
    assert.equal(result.engine, "node", JSON.stringify(result));
    assert.deepEqual(
      listedFrom(root, result.files),
      ["other/nested/decoy.js", "src/keep.js", "sub/other.js"],
      JSON.stringify(result.files),
    );
  } finally {
    cleanup();
  }
});

test("search_files honours the same nested .gitignore", async () => {
  // Same walk, same gap. The decoy is the point: `nested/` belongs to `sub`, so a sibling
  // directory of that name one level over has to survive.
  const { root, cleanup } = nestedGitignoreScope();
  try {
    const result = await searchFiles(
      { pattern: "needle", path: root },
      { workspaceRoots: [root], checkPermission: () => true },
    );
    assert.equal(result.engine, "node", JSON.stringify(result));
    assert.deepEqual(
      listedFrom(root, result.matches),
      ["other/nested/decoy.js", "src/keep.js", "sub/other.js"],
      JSON.stringify(result.matches),
    );
  } finally {
    cleanup();
  }
});

test("a nested .gitignore can re-include what the root excluded", async () => {
  // Deeper rules are applied last, so `sub/.gitignore` gets the final say about its own files
  // even though the root has already excluded the whole extension.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-reinclude-")));
  try {
    writeScopeFile(root, ".gitignore", "*.log\n");
    writeScopeFile(root, "sub/.gitignore", "!keep.log\n");
    writeScopeFile(root, "top.log", "x\n");
    writeScopeFile(root, "sub/keep.log", "x\n");
    writeScopeFile(root, "sub/drop.log", "x\n");
    const result = await findFiles(
      { patterns: ["**/*.log"], path: root },
      { workspaceRoots: [root], checkPermission: () => true },
    );
    assert.deepEqual(listedFrom(root, result.files), ["sub/keep.log"], JSON.stringify(result.files));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A scope ruled by one of the ignore files that is not .gitignore. `hidden.js` is what it
 * names, and `sub/other.js` is there to show the rest of the tree survives.
 */
function ignoreFileScope(name: string): { root: string; cleanup: () => void } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-ignore-name-")));
  writeScopeFile(root, "src/keep.js", "needle\n");
  writeScopeFile(root, "sub/other.js", "needle\n");
  writeScopeFile(root, "sub/hidden.js", "needle\n");
  writeScopeFile(root, name, "hidden.js\n");
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("the Node engine honours .ignore, the way ripgrep does", async () => {
  // ripgrep reads .ignore wherever it finds one, git repository or not. The fallback read
  // .gitignore only, so a tree ruled by .ignore listed files here that ripgrep had hidden.
  const { root, cleanup } = ignoreFileScope(".ignore");
  try {
    const result = await findFiles(
      { patterns: ["**/*.js"], path: root },
      { workspaceRoots: [root], checkPermission: () => true },
    );
    assert.equal(result.engine, "node", JSON.stringify(result));
    assert.deepEqual(listedFrom(root, result.files), ["src/keep.js", "sub/other.js"], JSON.stringify(result.files));
  } finally {
    cleanup();
  }
});

test("the Node engine honours .rgignore, the way ripgrep does", async () => {
  const { root, cleanup } = ignoreFileScope(".rgignore");
  try {
    const result = await searchFiles(
      { pattern: "needle", path: root },
      { workspaceRoots: [root], checkPermission: () => true },
    );
    assert.equal(result.engine, "node", JSON.stringify(result));
    assert.deepEqual(listedFrom(root, result.matches), ["src/keep.js", "sub/other.js"], JSON.stringify(result.matches));
  } finally {
    cleanup();
  }
});

test("a .rgignore re-includes what the .gitignore beside it excluded", async () => {
  // Within one directory ripgrep lets .rgignore outrank .ignore, which outranks .gitignore,
  // so the names are read in that order and the last pattern to match is the one that counts.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-ignore-rank-")));
  try {
    writeScopeFile(root, ".gitignore", "*.log\n");
    writeScopeFile(root, ".rgignore", "!keep.log\n");
    writeScopeFile(root, "keep.log", "x\n");
    writeScopeFile(root, "drop.log", "x\n");
    const result = await findFiles(
      { patterns: ["**/*.log"], path: root },
      { workspaceRoots: [root], checkPermission: () => true },
    );
    assert.deepEqual(listedFrom(root, result.files), ["keep.log"], JSON.stringify(result.files));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function capturedFindArgs(input: Record<string, unknown>): Promise<string[][]> {
  childProcessTest.reset();
  const captured: string[][] = [];
  await driveRipgreps(
    () => findFiles(input as never, { workspaceRoots: [SCOPE], config: { ripgrepPath: "bundled-ripgrep" } }),
    (child) => {
      captured.push([...child.args]);
      child.emitStdout("");
      child.emitExit(0);
    },
  );
  return captured;
}

async function capturedSearchArgs(input: Record<string, unknown>): Promise<string[][]> {
  childProcessTest.reset();
  const captured: string[][] = [];
  await driveRipgreps(
    () => searchFiles(input as never, { workspaceRoots: [SCOPE], config: { ripgrepPath: "bundled-ripgrep" } }),
    (child) => {
      captured.push([...child.args]);
      child.emitStdout("");
      child.emitExit(0);
    },
  );
  return captured;
}

test("both ripgreps are asked to read .gitignore outside a git repository", async () => {
  // ripgrep only honours .gitignore inside a git repository, so a scope that is not one had
  // its .gitignore read by the Node walk and skipped by ripgrep - one call, two answers.
  const batches = [
    await capturedFindArgs({ patterns: ["*.ts"], path: SCOPE }),
    await capturedSearchArgs({ pattern: "needle", path: SCOPE }),
  ];
  for (const argLists of batches) {
    assert.ok(argLists.length > 0, "no ripgrep was spawned");
    for (const args of argLists) {
      assert.ok(args.includes("--no-require-git"), `missing --no-require-git: ${args.join(" ")}`);
    }
  }
});

test("no_ignore stays the whole answer: it does not ask for gitignore rules either", async () => {
  const batches = [
    await capturedFindArgs({ patterns: ["*.ts"], path: SCOPE, no_ignore: true }),
    await capturedSearchArgs({ pattern: "needle", path: SCOPE, no_ignore: true }),
  ];
  for (const argLists of batches) {
    for (const args of argLists) {
      assert.ok(args.includes("--no-ignore"), `missing --no-ignore: ${args.join(" ")}`);
      assert.ok(!args.includes("--no-require-git"), `no_ignore must not ask for ignore files: ${args.join(" ")}`);
    }
  }
});

test("a file scope runs ripgrep from the directory holding the file", async () => {
  // spawn's cwd has to be a directory. Handing it the file itself fails with ENOENT, which
  // reads as an unusable ripgrep - so all four candidates were discarded for a reason that
  // had nothing to do with ripgrep, and the search fell back to the Node engine silently.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-file-scope-")));
  writeScopeFile(root, "sub/notes.txt", "needle\n");
  try {
    childProcessTest.reset();
    await withRipgrepOnPath(async () => {
      await driveRipgreps(
        () => searchFiles(
          { pattern: "needle", path: path.join(root, "sub", "notes.txt") },
          { workspaceRoots: [root], config: { ripgrepPath: "bundled-ripgrep" } },
        ),
        (child) => {
          child.emitStdout("");
          child.emitExit(0);
        },
      );
      const child = childProcessTest.spawned[0]!;
      // Compared by name: the temporary directory reaches this test through an 8.3 short name
      // on some machines, so the two sides can spell the same directory differently.
      const cwd = child.options?.cwd ?? "";
      assert.equal(path.basename(cwd), "sub", JSON.stringify(child.options));
      assert.notEqual(path.basename(cwd), "notes.txt", JSON.stringify(child.options));
      assert.equal(child.args[child.args.length - 1], "notes.txt", child.args.join(" "));
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the Node engine searches a file the caller named, hidden or not", async () => {
  // ripgrep does search an explicitly given hidden file, so the fallback has to as well:
  // answering "no matches" for a path the caller pointed at reads as the file being absent.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-dotfile-")));
  writeScopeFile(root, "sub/.env", "needle\n");
  try {
    const result = await searchFiles(
      { pattern: "needle", path: path.join(root, "sub", ".env") },
      { workspaceRoots: [root], checkPermission: () => true },
    );
    assert.equal(result.engine, "node", JSON.stringify(result));
    assert.deepEqual(listedFrom(root, result.matches), ["sub/.env"], JSON.stringify(result.matches));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the Node engine searches a file the caller named, however large", async () => {
  // The byte ceiling keeps a walk from reading a whole tree into memory. A file scope is the
  // entire search, and ripgrep has no such ceiling, so neither should the fallback: a caller
  // that named a large file and got nothing back had no way to tell that from no match.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-bigfile-")));
  writeScopeFile(root, "big.txt", "needle\n");
  try {
    const result = await searchFiles(
      { pattern: "needle", path: path.join(root, "big.txt") },
      { workspaceRoots: [root], checkPermission: () => true, config: { maxFallbackFileBytes: 4 } },
    );
    assert.equal(result.engine, "node", JSON.stringify(result));
    assert.deepEqual(listedFrom(root, result.matches), ["big.txt"], JSON.stringify(result.matches));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("no_ignore lifts the nested rules too", async () => {
  // The escape hatch has to reach the same rules, or it stops being one on exactly the trees
  // where it is asked for.
  const { root, cleanup } = nestedGitignoreScope();
  try {
    const result = await findFiles(
      { patterns: ["**/*.js"], path: root, no_ignore: true },
      { workspaceRoots: [root], checkPermission: () => true },
    );
    assert.deepEqual(
      listedFrom(root, result.files),
      ["other/nested/decoy.js", "src/keep.js", "sub/nested/deep.js", "sub/other.js"],
      JSON.stringify(result.files),
    );
  } finally {
    cleanup();
  }
});
