import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_SEARCH_FILES_CONFIG, searchFiles, type SearchFilesInput } from "../src/extension/src/search-files.js";
import { runRegexSearch, type RegexSearchInput } from "../src/extension/src/search-regex-runner.js";

function makeFixture(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-search-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root: string, relative: string, content = "search-target\n"): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

async function nodeSearch(root: string, input: Omit<SearchFilesInput, "pattern">) {
  // A permission callback selects the real Node fallback without depending on installed rg.
  const result = await searchFiles({ pattern: "search-target", context_lines: 0, ...input }, {
    workspaceRoots: [root],
    checkPermission: () => true,
  });
  assert.equal(result.engine, "node");
  return result.matches.map((match) => match.path);
}

test("Node search finds included files through directories that do not match the file glob", async (t) => {
  const root = makeFixture(t);
  write(root, "index.ts");
  write(root, "src/main.ts");
  write(root, "src/nested/util.ts");
  write(root, "src/main.js");
  write(root, "assets.ts/readme.txt");

  assert.deepEqual(await nodeSearch(root, { include: ["**/*.ts"] }), [
    "index.ts",
    "src/main.ts",
    "src/nested/util.ts",
  ]);
  assert.deepEqual(await nodeSearch(root, { include: ["src/**/*.ts"] }), [
    "src/main.ts",
    "src/nested/util.ts",
  ]);
});

test("Node search keeps hidden, ignored, and excluded paths filtered while traversing includes", async (t) => {
  const root = makeFixture(t);
  write(root, "src/main.ts");
  write(root, "src/nested/util.ts");
  write(root, "src/main.test.ts");
  write(root, "src/ignored.ts");
  write(root, ".hidden/private.ts");
  write(root, "dist/bundle.ts");
  write(root, "node_modules/pkg/index.ts");
  write(root, "excluded/nested/file.ts");
  write(root, ".gitignore", "src/ignored.ts\n");

  assert.deepEqual(await nodeSearch(root, {
    include: ["**/*.ts"],
    exclude: ["excluded/**", "**/*.test.ts"],
  }), ["src/main.ts", "src/nested/util.ts"]);
});

test("Node search applies include globs to scoped directories and individual files", async (t) => {
  const root = makeFixture(t);
  write(root, "src/main.ts");
  write(root, "src/nested/util.ts");
  write(root, "src/notes.js");
  write(root, "other/outside.ts");

  assert.deepEqual(await nodeSearch(root, { path: "src", include: ["**/*.ts"] }), [
    "src/main.ts",
    "src/nested/util.ts",
  ]);
  assert.deepEqual(await nodeSearch(root, { path: "src/main.ts", include: ["**/*.ts"] }), ["src/main.ts"]);
  assert.deepEqual(await nodeSearch(root, { path: "src/notes.js", include: ["**/*.ts"] }), []);
});

test("Node regex workers preserve matching, case handling, context, and result limits", async (t) => {
  const root = makeFixture(t);
  write(root, "src/main.ts", "before\r\n  TARGET12\r\ntarget34\r\nafter\r\n");
  const context = { workspaceRoots: [root], checkPermission: () => true };
  const result = await searchFiles({ pattern: "target\\d+", is_regex: true, include: ["**/*.ts"], max_matches_per_file: 1 }, context);
  assert.equal(result.engine, "node");
  assert.deepEqual(result.matches.map(({ path, line, column, text }) => ({ path, line, column, text })), [
    { path: "src/main.ts", line: 2, column: 3, text: "  TARGET12" },
  ]);
  assert.deepEqual(result.matches[0]?.before.map((line) => line.text), ["before"]);
  assert.deepEqual(result.matches[0]?.after.map((line) => line.text), ["target34"]);
  assert.deepEqual(result.summary.truncation_reasons, ["MAX_MATCHES_PER_FILE"]);
  const sensitive = await searchFiles({ pattern: "TARGET\\d+", is_regex: true, context_lines: 0 }, context);
  assert.equal(sensitive.matches.length, 1);
  assert.equal(sensitive.matches[0]?.line, 2);
  const explicit = await searchFiles({ pattern: "target\\d+", is_regex: true, case_sensitive: true, context_lines: 0 }, context);
  assert.equal(explicit.matches[0]?.line, 3);
  const limited = await searchFiles({ pattern: "target\\d+", is_regex: true, max_results: 1 }, context);
  assert.deepEqual(limited.summary.truncation_reasons, ["MAX_RESULTS"]);
});

test("Node regex search rejects invalid patterns and excludes permission-denied files", async (t) => {
  const root = makeFixture(t);
  write(root, "allowed.txt");
  write(root, "denied.txt");
  const context = { workspaceRoots: [root], checkPermission: (file: string) => path.basename(file) !== "denied.txt" };
  await assert.rejects(searchFiles({ pattern: "[", is_regex: true }, context), { code: "INVALID_PATTERN" });
  const result = await searchFiles({ pattern: "search-target", is_regex: true }, context);
  assert.deepEqual(result.matches.map((match) => match.path), ["allowed.txt"]);
});

test("backtracking regex searches time out while host timers and literal searches stay responsive", { timeout: 15_000 }, async (t) => {
  const root = makeFixture(t);
  // A short input also keeps a regression to synchronous matching finite.
  write(root, "slow.txt", "a".repeat(24) + "!");
  write(root, "fast.txt");
  const context = { workspaceRoots: [root], checkPermission: () => true, config: { regexTimeoutMs: 500 } };
  let heartbeat = false;
  const timer = setTimeout(() => { heartbeat = true; }, 100);
  t.after(() => clearTimeout(timer));
  const timedOut = assert.rejects(searchFiles({ pattern: "^(a+)+$", is_regex: true, path: "slow.txt" }, context), { code: "SEARCH_TIMEOUT" });
  const literal = await searchFiles({ pattern: "search-target", path: "fast.txt" }, context);
  assert.equal(literal.matches.length, 1);
  await timedOut;
  assert.equal(heartbeat, true, "the regex must not prevent the host timer from running");
  const next = await searchFiles({ pattern: "search-target", is_regex: true, path: "fast.txt" }, { ...context, config: undefined });
  assert.equal(next.matches.length, 1, "a timed-out search must release its worker slot");
});

test("Node regex search can be cancelled while pending and before it starts", { timeout: 15_000 }, async (t) => {
  const root = makeFixture(t);
  write(root, "slow.txt", "a".repeat(24) + "!");
  const abort = new AbortController();
  const context = { workspaceRoots: [root], checkPermission: () => true, signal: abort.signal };
  const cancelled = assert.rejects(searchFiles({ pattern: "^(a+)+$", is_regex: true }, context), { code: "ABORTED" });
  const timer = setTimeout(() => abort.abort(), 100);
  t.after(() => clearTimeout(timer));
  await cancelled;
  await assert.rejects(searchFiles({ pattern: "a", is_regex: true }, context), { code: "ABORTED" });
});

test("regex worker concurrency is bounded and cancellation releases slots before settling", async (t) => {
  const root = makeFixture(t);
  write(root, "input.txt");
  const input: RegexSearchInput = {
    candidates: { files: [path.join(root, "input.txt")], filesScanned: 1, hitLimit: false },
    options: {
      pattern: "search-target", isRegex: true, caseSensitive: undefined, scopeRoot: root, scopeRealPath: root,
      scopeDisplay: ".", include: [], exclude: [], contextLines: 0, maxResults: 100, maxMatchesPerFile: 20,
      noIgnore: false, includeHidden: false,
    },
    config: DEFAULT_SEARCH_FILES_CONFIG,
  };
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const first = runRegexSearch(input, firstAbort.signal).catch((error: unknown) => error);
  const second = runRegexSearch(input, secondAbort.signal).catch((error: unknown) => error);
  try {
    await assert.rejects(runRegexSearch(input), { code: "SEARCH_BUSY" });
  } finally {
    firstAbort.abort();
    secondAbort.abort();
    await Promise.all([first, second]);
  }
  const result = await runRegexSearch(input);
  assert.equal(result.matches.length, 1);
});
