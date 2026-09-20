import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import {
  buildRipgrepArgs,
  isWithinSearchScope,
  resolveRipgrepPath,
  ripgrepSearchDirectory,
  shouldIncludePath,
  DEFAULT_SEARCH_FILES_CONFIG,
} from "../src/extension/src/search-files.js";

const baseOptions = {
  pattern: "needle",
  scopeDisplay: ".",
  scopeRealPath: ".",
  scopeRoot: ".",
  isRegex: false,
  caseSensitive: undefined,
  include: [] as string[],
  exclude: [] as string[],
  contextLines: 1,
  maxResults: 100,
  maxMatchesPerFile: 20,
  noIgnore: false,
  includeHidden: false,
  scopeIsFile: false,
};

test("ripgrep sees includes before the excludes that narrow them", () => {
  // ripgrep lets a later glob win, so an include placed last re-admitted everything the
  // built-in list had just removed: include: ["**/*.ts"] searched node_modules and dist.
  const args = buildRipgrepArgs({ ...baseOptions, include: ["**/*.ts"] }, DEFAULT_SEARCH_FILES_CONFIG);
  const includeAt = args.indexOf("**/*.ts");
  const firstExcludeAt = args.findIndex((arg) => arg.startsWith("!"));
  assert.ok(includeAt >= 0, args.join(" "));
  assert.ok(firstExcludeAt > includeAt, args.join(" "));
});

test("a caller's exclude outranks an include", () => {
  // Same precedence rule: excluding a subset of what the include selects must survive.
  const args = buildRipgrepArgs(
    { ...baseOptions, include: ["**/*.ts"], exclude: ["**/*.test.ts"] },
    DEFAULT_SEARCH_FILES_CONFIG,
  );
  assert.ok(args.indexOf("**/*.ts") < args.indexOf("!**/*.test.ts"), args.join(" "));
});

test("an include does not prune directories in the fallback engine", () => {
  // "**/*.ts" describes files, so matching a directory against it fails. Pruning on that
  // result stopped the walk at the top level and the fallback engine found nothing at all.
  const options = { ...baseOptions, include: ["**/*.ts"] };
  assert.equal(shouldIncludePath("src", "src", options, DEFAULT_SEARCH_FILES_CONFIG, true), true);
  assert.equal(shouldIncludePath("src/a.ts", "src/a.ts", options, DEFAULT_SEARCH_FILES_CONFIG, false), true);
  assert.equal(shouldIncludePath("src/a.md", "src/a.md", options, DEFAULT_SEARCH_FILES_CONFIG, false), false);
});

test("the built-in excludes still prune directories in the fallback engine", () => {
  // Only the caller's include/exclude are file filters; the built-in list is what keeps a
  // walk out of node_modules, so it must keep applying to directories.
  const options = { ...baseOptions, include: ["**/*.ts"] };
  assert.equal(shouldIncludePath("node_modules/pkg", "node_modules/pkg", options, DEFAULT_SEARCH_FILES_CONFIG, true), false);
});

test("a directory an exclude names whole is not descended into", () => {
  // `**/node_modules/**` rejects every path under a directory called node_modules, so reading
  // one could only produce entries that were then discarded one at a time - and a workspace
  // with its dependencies installed paid for a listing of the whole tree. The directory itself
  // does not match that glob, which is why it was read at all: the name is what gives it away.
  const config = DEFAULT_SEARCH_FILES_CONFIG;
  assert.equal(shouldIncludePath("node_modules", "node_modules", baseOptions, config, true), false);
  assert.equal(shouldIncludePath("node_modules", "a/node_modules", baseOptions, config, true), false);
  assert.equal(shouldIncludePath("Vendor", "Vendor", baseOptions, config, true), false, "the built-ins are case-insensitive");
  assert.equal(shouldIncludePath("src", "src", baseOptions, config, true), true);
  assert.equal(shouldIncludePath("src", "a/src", baseOptions, config, true), true);

  // A file of that name is not what the glob names, and is still searched.
  assert.equal(shouldIncludePath("node_modules", "node_modules", baseOptions, config, false), true);

  // A configured exclude names what the agent may see at all, so no_ignore does not lift it.
  const configured = { ...config, extraExcludes: ["**/generated/**"] };
  assert.equal(shouldIncludePath("generated", "generated", baseOptions, configured, true), false);
  assert.equal(shouldIncludePath("generated", "generated", { ...baseOptions, noIgnore: true }, configured, true), false);

  // The caller's own exclude is matched in the case it was written, so a directory that the
  // case-folding would have caught is still descended into: `tmp/x` is not excluded by
  // `**/Tmp/**` either, and pruning it here would have hidden a file the glob lets through.
  // (Not dist: that one is a built-in exclude, so it is pruned whichever way it is spelled.)
  assert.equal(shouldIncludePath("tmp", "tmp", { ...baseOptions, exclude: ["**/tmp/**"] }, config, true), false);
  assert.equal(shouldIncludePath("tmp", "tmp", { ...baseOptions, exclude: ["**/Tmp/**"] }, config, true), true);
});

test("the caller's exclude stops the walk at a directory, the way ripgrep does", () => {
  // `rg -n needle --glob '!assets'` does not report assets/x.txt: ripgrep reads a glob against
  // a directory too and stops there. This engine answered for directories before the exclude
  // was read at all, so a bare `assets` - which names the directory and nothing under it - hid
  // nothing, and the same call answered two ways depending on which engine ran. (Not dist or
  // vendor: those are built-in excludes, so they are pruned whichever way the call is written.)
  const excluded = { ...baseOptions, exclude: ["assets"] };
  assert.equal(shouldIncludePath("assets", "assets", excluded, DEFAULT_SEARCH_FILES_CONFIG, true), false);
  assert.equal(shouldIncludePath("src", "src", excluded, DEFAULT_SEARCH_FILES_CONFIG, true), true);

  // A glob naming one file inside a directory says nothing about the directory.
  const named = { ...baseOptions, exclude: ["assets/x.txt"] };
  assert.equal(shouldIncludePath("assets", "assets", named, DEFAULT_SEARCH_FILES_CONFIG, true), true);
  assert.equal(shouldIncludePath("assets/x.txt", "assets/x.txt", named, DEFAULT_SEARCH_FILES_CONFIG, false), false);

  // A glob naming what is under the directory excludes those files, whether or not the walk
  // stops at it: ripgrep hides assets/x.txt for `!assets/**` and this must hide it too.
  const inner = { ...baseOptions, exclude: ["assets/**"] };
  assert.equal(shouldIncludePath("assets/x.txt", "assets/x.txt", inner, DEFAULT_SEARCH_FILES_CONFIG, false), false);

  // And a suffix names a directory that carries it: `rg -n needle --glob '!**/*.ts'` does not
  // report x.ts/inside.txt, so neither does this.
  const suffix = { ...baseOptions, exclude: ["**/*.ts"] };
  assert.equal(shouldIncludePath("x.ts", "x.ts", suffix, DEFAULT_SEARCH_FILES_CONFIG, true), false);
  assert.equal(shouldIncludePath("docs", "docs", suffix, DEFAULT_SEARCH_FILES_CONFIG, true), true);
});

test("a caller's glob is read from the search scope, the base ripgrep reads it from", () => {
  // ripgrep walks with cwd = the search scope, so "sub/**" means pkg/sub/**. Reading the
  // caller's globs against the workspace instead made the same call answer differently
  // depending only on which engine ran: include ["sub/**"] found the file under ripgrep and
  // nothing under the fallback, and ["pkg/sub/**"] the other way round.
  const options = { ...baseOptions, scopeRoot: "/ws", scopeRealPath: "/ws/pkg", include: ["sub/**"] };
  assert.equal(shouldIncludePath("sub/needle.ts", "pkg/sub/needle.ts", options, DEFAULT_SEARCH_FILES_CONFIG, false), true);
  assert.equal(shouldIncludePath("other.txt", "pkg/other.txt", options, DEFAULT_SEARCH_FILES_CONFIG, false), false);
  const workspaceShaped = { ...options, include: ["pkg/sub/**"] };
  assert.equal(shouldIncludePath("sub/needle.ts", "pkg/sub/needle.ts", workspaceShaped, DEFAULT_SEARCH_FILES_CONFIG, false), false);
});

test("a scope that is itself hidden is still searched", () => {
  // The hidden check ran on the workspace path, so path: ".cache" named ".cache/a.ts" and
  // every entry under it was dropped for being hidden — ripgrep, walking from inside, found
  // them. The scope is what the caller asked to search, so it is not what gets filtered.
  assert.equal(shouldIncludePath("a.ts", ".cache/a.ts", baseOptions, DEFAULT_SEARCH_FILES_CONFIG, false), true);
  assert.equal(shouldIncludePath(".hidden/a.ts", ".cache/.hidden/a.ts", baseOptions, DEFAULT_SEARCH_FILES_CONFIG, false), false);
});

test("no_ignore lifts the built-in excludes but not the configured ones", () => {
  // The built-ins exist to keep a walk fast, so a caller may ask to see past them.
  // agentbridge.files.excludeGlobs is the user saying what the agent may see at all, and a
  // request coming from the other side of the Bridge must not be able to switch it off.
  const config = { ...DEFAULT_SEARCH_FILES_CONFIG, extraExcludes: ["**/secrets/**"] };
  const options = { ...baseOptions, noIgnore: true };
  const args = buildRipgrepArgs(options, config);
  assert.ok(!args.includes("!**/node_modules/**"), args.join(" "));
  assert.ok(args.includes("!**/secrets/**"), args.join(" "));
  assert.equal(shouldIncludePath("node_modules/pkg", "node_modules/pkg", options, config, true), true);
  assert.equal(shouldIncludePath("secrets/token.txt", "secrets/token.txt", options, config, false), false);
});

test("a configured exclude prunes its directory, like it does in find_files", () => {
  // A directory pattern such as "docs" does not match "docs/a.md", so applying it only to
  // files was a no-op: the walk descended and every file underneath came back anyway.
  const config = { ...DEFAULT_SEARCH_FILES_CONFIG, extraExcludes: ["docs"] };
  // The pattern is matched against the entry's own name as well, which is what makes a
  // directory pattern work at any depth: the walk stops at "docs" and never reaches a.md.
  assert.equal(shouldIncludePath("docs", "docs", baseOptions, config, true), false);
  assert.equal(shouldIncludePath("src/docs", "src/docs", baseOptions, config, true), false);
  assert.equal(shouldIncludePath("src/a.md", "src/a.md", baseOptions, config, false), true);
  assert.equal(shouldIncludePath("src/docs.md", "src/docs.md", baseOptions, config, false), true);
});

test("a file scope hands ripgrep the file's name, not a directory to walk", () => {
  // The child ran with cwd = the scope, which for a file scope is a file. spawn cannot use a
  // file as a working directory and fails with ENOENT, which this code reads as an unusable
  // ripgrep: every candidate failed that way, so every search scoped to a single file quietly
  // fell through to the Node engine and ripgrep was never used for the scope it suits best.
  const options = { ...baseOptions, scopeIsFile: true, scopeRealPath: "pkg/.env" };
  const args = buildRipgrepArgs(options, DEFAULT_SEARCH_FILES_CONFIG);
  assert.equal(args[args.length - 1], ".env", args.join(" "));
});

test("a file the caller named is searched even when it is hidden", () => {
  // ripgrep hides hidden paths while walking a directory but does search a file handed to it
  // by name. Filtering the scope's own file made "search this .env" answer "no matches",
  // which reads as the file not being there at all.
  assert.equal(shouldIncludePath(".env", ".env", baseOptions, DEFAULT_SEARCH_FILES_CONFIG, false, true), true);
  // The same file discovered by a walk is still hidden, which is the behaviour being kept.
  assert.equal(shouldIncludePath(".env", ".env", baseOptions, DEFAULT_SEARCH_FILES_CONFIG, false, false), false);
});

test("a file scope resolves matches against the directory ripgrep actually ran in", () => {
  // ripgrep reports paths relative to its working directory, and a file scope runs one level up
  // because a file cannot be a working directory. Resolving against the scope itself turned the
  // scope "pkg/.env" plus the reported ".env" into "pkg/.env/.env", so a file-scoped search
  // answered with a path that does not exist: the match was counted, and the lines shown beside it
  // were read from the right file, but the path printed next to them pointed nowhere.
  const directory = path.resolve("pkg");
  const fileScope = { ...baseOptions, scopeIsFile: true, scopeRealPath: path.join(directory, ".env") };
  assert.equal(ripgrepSearchDirectory(fileScope), directory);
  assert.equal(resolveRipgrepPath(".env", fileScope), path.join(directory, ".env"));
  assert.equal(resolveRipgrepPath(path.join(directory, "other.ts"), fileScope), path.join(directory, "other.ts"), "an absolute report is already resolved");

  // A directory scope is its own working directory, which is what its relative paths assume.
  assert.equal(ripgrepSearchDirectory(baseOptions), ".");
  assert.equal(resolveRipgrepPath("src/a.ts", { ...baseOptions, scopeRealPath: directory }), path.join(directory, "src", "a.ts"));
});

test("a file the caller named is searched whatever the filters say", () => {
  // The fallback applied every filter to an explicit file - hidden, the built-ins, the
  // configured excludes, and the caller's own include and exclude - while ripgrep applies
  // none of them to a path it was handed on its command line: the bundled binary answers
  // `rg --iglob '!**/node_modules/**' needle node_modules/pkg/secret.txt` with the match, and
  // an include naming another suffix does not stop it either. So one call, two engines, two
  // answers: a .env, or a file inside a generated directory, came back as "no matches" here
  // alone, which reads as the file not existing. excludeGlobs is guidance of the same kind as
  // the rest - read_files does not consult it - so nothing is being let through a boundary.
  const config = { ...DEFAULT_SEARCH_FILES_CONFIG, extraExcludes: ["**/secrets/**"] };
  const options = { ...baseOptions, include: ["**/*.md"], exclude: ["**/*.txt"] };
  const named = (file: string) => shouldIncludePath(file, file, options, config, false, true);
  assert.equal(named(".env"), true, "a hidden file");
  assert.equal(named("node_modules/pkg/a.txt"), true, "a built-in exclude");
  assert.equal(named("secrets/token.txt"), true, "a configured exclude");
  assert.equal(named("a.txt"), true, "the caller's own exclude");
  assert.equal(named("a.ts"), true, "the caller's own include");

  // The walk is unchanged: the same paths are still filtered when the engine finds them.
  const walked = (file: string) => shouldIncludePath(file, file, options, config, false);
  assert.equal(walked(".env"), false);
  assert.equal(walked("node_modules/pkg/a.txt"), false);
  assert.equal(walked("secrets/token.txt"), false);
  assert.equal(walked("a.txt"), false);
  assert.equal(walked("a.md"), true);
});

test("a path an engine reports outside the scope is not turned into a match", () => {
  // The path arrives as text from a child process and was resolved without question, so a
  // report naming "../escape.txt" or an absolute path elsewhere on the machine became a match:
  // its lines were read from a file outside the scope and shown as a result of searching
  // inside it. Nothing in an ordinary run produces such a path, which is the argument for not
  // trusting one rather than for assuming it cannot arrive - a replaced binary reaches this
  // reader the same way. Where a link points is not asked here: see the test below.
  const inScope = (reported: string) => {
    const absolute = resolveRipgrepPath(reported, baseOptions);
    return isWithinSearchScope(absolute, baseOptions);
  };
  assert.equal(inScope("src/a.ts"), true);
  assert.equal(inScope("a.ts"), true);
  assert.equal(inScope("../escape.txt"), false, "a parent directory");
  assert.equal(inScope("../../escape.txt"), false);
  assert.equal(inScope(path.resolve(path.sep, "abs", "outside.txt")), false, "an absolute path elsewhere");

  // A file scope is that one file and nothing beside it.
  const fileScope = { ...baseOptions, scopeIsFile: true, scopeRealPath: path.join(path.resolve("."), "pkg", "a.ts") };
  const named = resolveRipgrepPath("a.ts", fileScope);
  assert.equal(isWithinSearchScope(named, fileScope), true, "the file the caller named");
  assert.equal(isWithinSearchScope(resolveRipgrepPath("b.ts", fileScope), fileScope), false, "its sibling");
});

test("a link inside the scope is inside it, because neither engine follows one", () => {
  // The check compares the path as written and never asks the filesystem where a link points,
  // so a path under a link is in scope here even when the file behind it is not. That is the
  // answer both engines are built on: ripgrep is given no --follow, and the fallback walk
  // lists entries withFileTypes, where a link is neither a directory to descend into nor a file
  // to read, so nothing behind one is ever reported and such a path does not arrive. What is
  // left open is a directory replaced by a link between the walk and the read; the comment on
  // the function says so instead of promising more than it does.
  const scope = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agentbridge-scope-")));
  const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agentbridge-outside-")));
  try {
    writeFileSync(path.join(outside, "secret.txt"), "needle\n");
    symlinkSync(outside, path.join(scope, "link"), "junction");
    const options = { ...baseOptions, scopeRealPath: scope, scopeRoot: scope };
    const reported = path.join(scope, "link", "secret.txt");
    assert.equal(isWithinSearchScope(reported, options), true, "the path as an engine would report it");
    assert.equal(realpathSync(reported), path.join(outside, "secret.txt"), "the link really points out of the scope");
    assert.equal(
      isWithinSearchScope(realpathSync(reported), options),
      false,
      "resolved, it is outside - which is what this check does not do",
    );
    assert.ok(
      !buildRipgrepArgs(baseOptions, DEFAULT_SEARCH_FILES_CONFIG).includes("--follow"),
      "a search that followed links would report paths this check cannot place",
    );
  } finally {
    rmSync(scope, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a configured exclude is written against the workspace, whichever directory was searched", () => {
  // The setting is one setting for the whole workspace, so `packages/app/**/generated/**` has
  // to name the same files whether the call searched the root or the package. Read against the
  // path that was searched it would mean something different in every call, and a pattern
  // written for one search would have to be rewritten to be used from another.
  const config = { ...DEFAULT_SEARCH_FILES_CONFIG, extraExcludes: ["packages/app/**/generated/**"] };
  const keep = (scopeRelative: string, workspaceRelative: string) =>
    shouldIncludePath(scopeRelative, workspaceRelative, baseOptions, config);
  assert.equal(keep("generated/a.ts", "packages/app/generated/a.ts"), false, "the excluded file");
  assert.equal(keep("src/a.ts", "packages/app/src/a.ts"), true, "a sibling of it");
  assert.equal(keep("generated/a.ts", "packages/other/generated/a.ts"), true, "the same text in another package");

  // The scope-relative text is not what the pattern is matched against, so a pattern that only
  // lines up when read from the workspace root is not accidentally honoured from a subdirectory.
  const fromPackage = { ...DEFAULT_SEARCH_FILES_CONFIG, extraExcludes: ["**/generated/**"] };
  assert.equal(
    shouldIncludePath("generated/a.ts", "packages/app/generated/a.ts", baseOptions, fromPackage),
    false,
    "a pattern written to work from anywhere still works from the workspace",
  );
});
