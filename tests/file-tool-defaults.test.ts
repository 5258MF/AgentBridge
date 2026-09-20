import test from "node:test";
import assert from "node:assert/strict";
import { COMMON_EXCLUDE_GLOBS, DEFAULT_FIND_FILES_CONFIG, excludeDirectoryNames, formatFindFilesForModel, type FindFilesResult } from "../src/extension/src/find-files.js";
import { DEFAULT_SEARCH_FILES_CONFIG, formatSearchFilesForModel, type SearchFilesResult } from "../src/extension/src/search-files.js";
import { DEFAULT_READ_FILES_CONFIG } from "../src/extension/src/read-files.js";

test("find_files and search_files share one exclude list", () => {
  // They used to keep separate copies, so an exclude added to one tool silently missed the
  // other and the two tools disagreed about what exists in the workspace.
  assert.deepEqual(DEFAULT_SEARCH_FILES_CONFIG.commonExcludes, DEFAULT_FIND_FILES_CONFIG.commonExcludes);
  assert.deepEqual(DEFAULT_FIND_FILES_CONFIG.commonExcludes, [...COMMON_EXCLUDE_GLOBS]);
});

test("the built-in excludes are never empty", () => {
  assert.ok(DEFAULT_FIND_FILES_CONFIG.commonExcludes.includes("**/node_modules/**"));
  assert.ok(DEFAULT_FIND_FILES_CONFIG.commonExcludes.includes("**/.git/**"));
});

test("list_directory hides every directory find and search hide", () => {
  // It kept its own shorter list, so a build output directory that find_files skipped still
  // showed up in list_directory — and a directory the user excluded did too.
  const names = excludeDirectoryNames(COMMON_EXCLUDE_GLOBS);
  for (const name of ["out", "out-build", "out-vscode", "release", "vscode-win32-x64", ".git", "node_modules", "vendor"]) {
    assert.ok(names.has(name), name);
  }
});

test("the names are lower-cased so a differently-spelled directory is hidden too", () => {
  // "Vendor" and "Build" are the same noise as "vendor" and "build", and on a case-insensitive
  // filesystem readdir hands back whichever spelling the directory was created with, so an
  // exact comparison let them through here while find_files hid them.
  assert.deepEqual([...excludeDirectoryNames(["**/Vendor/**", "**/BUILD/**"])].sort(), ["build", "vendor"]);
});

test("a glob that is not a bare directory name does not become one", () => {
  // "**/*.zip" names files, not a directory to prune.
  const names = excludeDirectoryNames(["**/*.zip", "**/dist/**", "dist/", "**/build"]);
  assert.deepEqual([...names].sort(), ["build", "dist"]);
});

function emptyFind(filters: { ignored_skipped: boolean; hidden_skipped: boolean }): FindFilesResult {
  return {
    patterns: ["**/*.ts"],
    scope: ".",
    engine: "node",
    sort: "path_asc",
    filters,
    files: [],
    summary: { candidate_paths: 0, returned_files: 0, truncated: false, truncation_reasons: [] },
  };
}

function emptySearch(filters: { ignored_skipped: boolean; hidden_skipped: boolean }): SearchFilesResult {
  return {
    pattern: "needle",
    mode: "literal",
    case_mode: "smart",
    scope: ".",
    engine: "ripgrep",
    filters,
    matches: [],
    summary: {
      returned_matches: 0,
      files_with_matches: 0,
      files_scanned: 0,
      skipped_binary_files: 0,
      skipped_large_files: 0,
      skipped_outside_scope: 0,
      truncated: false,
      truncation_reasons: [],
    },
  };
}

test("an empty result says what was skipped, so it does not read as absence", () => {
  // A caller that asked for a gitignored file saw "(no matching files)" and concluded the file
  // was not there, then wrote it from scratch. Both tools now name the filter that was applied
  // and the option that lifts it.
  const found = formatFindFilesForModel(emptyFind({ ignored_skipped: true, hidden_skipped: true }));
  assert.ok(found.includes("no_ignore=true"), found);
  assert.ok(found.includes("include_hidden=true"), found);

  const searched = formatSearchFilesForModel(emptySearch({ ignored_skipped: true, hidden_skipped: false }));
  assert.ok(searched.includes("no_ignore=true"), searched);
  assert.ok(!searched.includes("include_hidden=true"), searched);
});

test("a result with the filters lifted says nothing about skipping", () => {
  // The note is only true while a filter is in force; once both are lifted an empty result is
  // proof enough and the hint would send the caller looking for an option it already used.
  const found = formatFindFilesForModel(emptyFind({ ignored_skipped: false, hidden_skipped: false }));
  assert.ok(found.includes("(no matching files)"), found);
  assert.ok(!found.includes("no_ignore=true"), found);
  assert.ok(!found.includes("include_hidden=true"), found);
});

test("a generated file of a few megabytes can still be read without a line range", () => {
  // Bundles and lockfiles routinely pass 2 MB; the bytes returned stay capped separately.
  assert.ok(DEFAULT_READ_FILES_CONFIG.veryLargeFileBytes >= 8 * 1024 * 1024);
});

test("a result that found something still says what it skipped", () => {
  // A non-empty answer is the one a caller trusts, and it is equally not evidence that nothing was
  // filtered out. The file behind the gitignore rule is still missing from it.
  const found = formatFindFilesForModel({
    ...emptyFind({ ignored_skipped: true, hidden_skipped: true }),
    files: [{ path: "src/a.ts" } as any],
    summary: { candidate_paths: 1, returned_files: 1, truncated: false, truncation_reasons: [] },
  });
  assert.ok(found.includes("no_ignore=true"), found);
  assert.ok(found.includes("include_hidden=true"), found);

  const searched = formatSearchFilesForModel({
    ...emptySearch({ ignored_skipped: true, hidden_skipped: false }),
    matches: [{ path: "src/a.ts", line: 1, column: 1, text: "needle", before: [], after: [], text_truncated: false } as any],
    summary: { ...emptySearch({ ignored_skipped: true, hidden_skipped: false }).summary, returned_matches: 1, files_with_matches: 1 },
  });
  assert.ok(searched.includes("no_ignore=true"), searched);
  assert.ok(!searched.includes("include_hidden=true"), `a filter that was not applied is not named: ${searched}`);
});
