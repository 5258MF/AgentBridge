import { spawn } from "node:child_process";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { rgPath as bundledRipgrepPath } from "@vscode/ripgrep";
import { COMMON_EXCLUDE_GLOBS, prunableDirectoryNames } from "./find-files.js";
import { boundedInteger, boundedNotes } from "./bounded-integer.js";
import { isRipgrepUsageError, isSupportedGlob, matchesAnyGlob } from "./glob.js";
import { isIgnoreFileName, extendGitignoreRules, gitignoreIgnores, ignoreRulesOutside, type GitignoreRules } from "./gitignore.js";
import { describeSkippedFilters } from "./skipped-filters.js";
import { estimateTokens } from "./file-tool-utils.js";

export interface SearchFilesInput {
  pattern: string;
  path?: string;
  /** false/omitted = literal search; true = regular expression search. */
  is_regex?: boolean;
  /** true = case-sensitive, false = case-insensitive, omitted = smart-case. */
  case_sensitive?: boolean;
  /** Glob filters relative to the search scope/workspace, for example TypeScript source globs. */
  include?: string[];
  /** Glob filters to exclude, for example test-file globs. */
  exclude?: string[];
  /** Number of surrounding lines returned on each side of a match. */
  context_lines?: number;
  /** Maximum matches returned across the whole call. */
  max_results?: number;
  /** Maximum matches returned from any one file. */
  max_matches_per_file?: number;
  /** Ignore .gitignore/common excludes when true. */
  no_ignore?: boolean;
  /** Include hidden files/directories when true. */
  include_hidden?: boolean;
}

export interface SearchFilesConfig {
  defaultContextLines: number;
  maxContextLines: number;
  defaultMaxResults: number;
  hardMaxResults: number;
  defaultMaxMatchesPerFile: number;
  hardMaxMatchesPerFile: number;
  maxOutputBytes: number;
  maxEstimatedTokens: number;
  maxLineChars: number;
  maxFallbackFileBytes: number;
  maxContextCacheBytes: number;
  maxFallbackFilesScanned: number;
  binaryProbeBytes: number;
  ripgrepPath?: string;
  commonExcludes: string[];
  /** Added to commonExcludes rather than replacing it, so built-ins cannot be lost. */
  extraExcludes?: readonly string[];
}

export const DEFAULT_SEARCH_FILES_CONFIG: SearchFilesConfig = {
  defaultContextLines: 1,
  maxContextLines: 5,
  defaultMaxResults: 100,
  hardMaxResults: 500,
  defaultMaxMatchesPerFile: 20,
  hardMaxMatchesPerFile: 100,
  maxOutputBytes: 128 * 1024,
  maxEstimatedTokens: 30_000,
  maxLineChars: 1_200,
  maxFallbackFileBytes: 2 * 1024 * 1024,
  maxContextCacheBytes: 16 * 1024 * 1024,
  maxFallbackFilesScanned: 20_000,
  binaryProbeBytes: 8 * 1024,
  commonExcludes: [...COMMON_EXCLUDE_GLOBS],
};

export type SearchFilesErrorCode =
  | "FILE_NOT_FOUND"
  | "NOT_A_FILE_OR_DIRECTORY"
  | "PATH_OUTSIDE_WORKSPACE"
  | "PERMISSION_DENIED"
  | "INVALID_PATTERN"
  | "INVALID_ARGUMENT"
  | "ABORTED"
  | "IO_ERROR";

export interface SearchContextLine {
  line: number;
  text: string;
  truncated: boolean;
}

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
  text_truncated: boolean;
  before: SearchContextLine[];
  after: SearchContextLine[];
}

export type SearchTruncationReason =
  | "MAX_RESULTS"
  | "MAX_MATCHES_PER_FILE"
  | "OUTPUT_BYTE_BUDGET"
  | "OUTPUT_TOKEN_BUDGET"
  | "MAX_FILES_SCANNED"
  | "CONTEXT_CACHE_BYTE_BUDGET"
  | "CONTEXT_FILE_TOO_LARGE";

export interface SearchFilesResult {
  pattern: string;
  mode: "literal" | "regex";
  case_mode: "sensitive" | "insensitive" | "smart";
  scope: string;
  engine: "ripgrep" | "node";
  /**
   * Which of the default filters were in force, so an empty result can say so. See find_files:
   * a caller cannot otherwise tell "this text is not here" from "this text is gitignored".
   */
  filters: {
    ignored_skipped: boolean;
    hidden_skipped: boolean;
  };
  matches: SearchMatch[];
  /** Arguments that were brought into range; see boundedInteger. Absent or empty when none were. */
  adjusted_arguments?: string[];
  summary: {
    returned_matches: number;
    files_with_matches: number;
    files_scanned: number | null;
    skipped_binary_files: number;
    skipped_large_files: number;
    skipped_outside_scope: number;
    truncated: boolean;
    truncation_reasons: SearchTruncationReason[];
  };
}

export interface SearchFilesContext {
  workspaceRoots: string[];
  config?: Partial<SearchFilesConfig>;
  signal?: AbortSignal;
  checkPermission?: (realPath: string) => Promise<boolean> | boolean;
}

class SearchToolError extends Error {
  constructor(
    public readonly code: SearchFilesErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface RawMatch {
  absolutePath: string;
  displayPath: string;
  line: number;
  column: number;
  text: string;
}

interface EngineResult {
  engine: "ripgrep" | "node";
  matches: RawMatch[];
  filesScanned: number | null;
  skippedBinaryFiles: number;
  skippedLargeFiles: number;
  /** Matches an engine reported at a path outside the scope it was asked to search. */
  skippedOutsideScope: number;
  truncationReasons: Set<SearchTruncationReason>;
}

interface NormalizedOptions {
  pattern: string;
  scopeDisplay: string;
  scopeRealPath: string;
  scopeRoot: string;
  isRegex: boolean;
  caseSensitive: boolean | undefined;
  include: string[];
  exclude: string[];
  contextLines: number;
  /** What was brought into range, to be said in the answer. See boundedInteger. Optional
   *  because a caller that builds options by hand has nothing to report. */
  adjusted_arguments?: string[];
  maxResults: number;
  maxMatchesPerFile: number;
  noIgnore: boolean;
  includeHidden: boolean;
  /** True when path named a single file. A file scope is handed to ripgrep by name, from the
   *  directory holding it, and is not filtered the way a walk is. */
  scopeIsFile: boolean;
}

function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function canonicalRoots(roots: string[]): Promise<string[]> {
  if (roots.length === 0) {
    throw new SearchToolError("PATH_OUTSIDE_WORKSPACE", "No workspace root is configured.");
  }
  return Promise.all(roots.map((root) => realpath(root)));
}

async function resolveSafeScope(requestedPath: string, roots: string[]): Promise<{ realPath: string; root: string }> {
  const canonical = await canonicalRoots(roots);
  const candidates = path.isAbsolute(requestedPath)
    ? [requestedPath]
    : canonical.map((root) => path.resolve(root, requestedPath));

  let sawNotFound = false;
  for (const candidate of candidates) {
    try {
      const target = await realpath(candidate);
      const root = canonical.find((candidateRoot) => isInsideRoot(candidateRoot, target));
      if (root) return { realPath: target, root };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        sawNotFound = true;
        continue;
      }
      if (code === "EACCES" || code === "EPERM") {
        throw new SearchToolError("PERMISSION_DENIED", "Permission denied while resolving the search path.");
      }
      throw error;
    }
  }

  if (sawNotFound) throw new SearchToolError("FILE_NOT_FOUND", "Search path does not exist.");
  throw new SearchToolError("PATH_OUTSIDE_WORKSPACE", "Search path resolves outside the allowed workspace roots.");
}

function smartCaseSensitive(pattern: string): boolean {
  return /[A-Z]/.test(pattern);
}

function normalizeInput(input: SearchFilesInput, config: SearchFilesConfig): Omit<NormalizedOptions, "scopeRealPath" | "scopeRoot" | "scopeIsFile"> {
  if (typeof input.pattern !== "string" || input.pattern.length === 0) {
    throw new SearchToolError("INVALID_ARGUMENT", "pattern must be a non-empty string.");
  }
  if (input.pattern.length > 20_000) {
    throw new SearchToolError("INVALID_ARGUMENT", "pattern is too long.");
  }
  if (input.path !== undefined && (typeof input.path !== "string" || input.path.length === 0)) {
    throw new SearchToolError("INVALID_ARGUMENT", "path must be a non-empty string when provided.");
  }

  const include = input.include ?? [];
  const exclude = input.exclude ?? [];
  if (!Array.isArray(include) || include.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new SearchToolError("INVALID_ARGUMENT", "include must be an array of non-empty glob strings.");
  }
  if (!Array.isArray(exclude) || exclude.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new SearchToolError("INVALID_ARGUMENT", "exclude must be an array of non-empty glob strings.");
  }
  // Checked here rather than left to ripgrep because only one of the two engines has a
  // ripgrep to complain: the fallback reads the same glob as a literal, so an ill-formed
  // pattern used to be an error under one engine and a quietly different search under the
  // other. find_files has always refused these.
  for (const glob of [...include, ...exclude]) {
    if (!isSupportedGlob(glob)) {
      throw new SearchToolError("INVALID_ARGUMENT", "Glob patterns must be non-empty, at most 4000 characters, and free of unclosed character classes, unbalanced alternate groups and trailing escapes.");
    }
  }

  // Out-of-range numbers are brought into range rather than refused, and named in the answer, so
  // a caller that asked for more than the tool allows can see what it got.
  const contextLines = boundedInteger(input.context_lines, config.defaultContextLines, 0, config.maxContextLines, "context_lines");
  const maxResults = boundedInteger(input.max_results, config.defaultMaxResults, 1, config.hardMaxResults, "max_results");
  const maxMatchesPerFile = boundedInteger(
    input.max_matches_per_file,
    config.defaultMaxMatchesPerFile,
    1,
    config.hardMaxMatchesPerFile,
    "max_matches_per_file",
  );
  const adjusted_arguments = [contextLines, maxResults, maxMatchesPerFile]
    .map((bound) => bound.note)
    .filter((note): note is string => Boolean(note));

  return {
    pattern: input.pattern,
    scopeDisplay: input.path ?? ".",
    isRegex: input.is_regex ?? false,
    caseSensitive: input.case_sensitive,
    include,
    exclude,
    contextLines: contextLines.value,
    maxResults: maxResults.value,
    maxMatchesPerFile: maxMatchesPerFile.value,
    adjusted_arguments,
    noIgnore: input.no_ignore ?? false,
    includeHidden: input.include_hidden ?? false,
  };
}

function displayPath(root: string, filePath: string): string {
  const relative = path.relative(root, filePath);
  return (relative || path.basename(filePath)).split(path.sep).join("/");
}

/**
 * Whether a walked entry is still in scope.
 *
 * Two bases are in play and they are not interchangeable. The caller's `include`/`exclude`
 * and the hidden check are matched against the path as seen from the *search scope*, which is
 * the base ripgrep uses: it walks with cwd = scope, so "sub/**" names what a workspace-relative
 * reading of the same file would call "pkg/sub/**". Matching them against the workspace made
 * the two engines answer the same call differently depending only on whether ripgrep was
 * installed, and made a scope that is itself hidden (`path: ".cache"`) find nothing at all in
 * the fallback while ripgrep found everything.
 *
 * The built-in and the configured exclude lists stay workspace-relative, as they are in
 * find_files: they are a setting about the workspace rather than about one search, and their
 * patterns are either basenames or "**"-prefixed, so the base does not change what they select.
 *
 * `include`/`exclude` describe files, so they are only applied to files: matching a directory
 * against a file glob like "**\/*.ts" fails, and pruning on that result stopped the walk from
 * ever entering a directory whose files would have matched — an include turned the fallback
 * engine into a search that found nothing.
 */
const EMPTY_GLOBS: readonly string[] = [];
const pruneNameCache = new WeakMap<readonly string[], { caseSensitive: boolean; names: Set<string> }>();

/**
 * The directory names behind a set of exclude globs, remembered per array.
 *
 * The globs do not change during a walk and the same arrays are handed to this function once
 * per entry, so the names are derived once per array rather than once per path. A WeakMap
 * keeps that from holding anything alive: a caller that builds its exclude list per call
 * has it collected with the call.
 */
function pruneNamesFor(globs: readonly string[], caseSensitive = false): Set<string> {
  const cached = pruneNameCache.get(globs);
  // The case is part of what was computed: the same globs read the other way are a different
  // set of names, and answering with the wrong one would prune a directory the caller may see.
  if (cached && cached.caseSensitive === caseSensitive) return cached.names;
  const names = prunableDirectoryNames(globs, caseSensitive);
  pruneNameCache.set(globs, { caseSensitive, names });
  return names;
}

export function shouldIncludePath(
  scopeRelativePath: string,
  workspaceRelativePath: string,
  options: NormalizedOptions,
  config: SearchFilesConfig,
  isDirectory = false,
  /** The file the caller named as the scope: not hidden-filtered, see below. */
  explicitFile = false,
): boolean {
  const scope = scopeRelativePath.split(path.sep).join("/");
  const workspace = workspaceRelativePath.split(path.sep).join("/");
  // A file the caller named is searched whatever the filters say: ripgrep applies neither the
  // hidden rule nor any glob - --glob, --iglob, include or exclude - to a path it was handed
  // on its command line, only to the paths it finds while walking a directory. Checked against
  // the bundled ripgrep: `rg --iglob '!**/node_modules/**' needle node_modules/pkg/secret.txt`
  // still answers with the match, and so does an include that names another suffix entirely.
  // Filtering it here made the two engines disagree about the same call - a hidden file or one
  // inside a generated directory came back as "no matches" from this engine alone, which reads
  // as the file not being there at all. excludeGlobs is the same kind of guidance as the rest:
  // read_files does not consult it either, so a caller is not being let through a boundary.
  if (explicitFile) return true;
  // A directory an exclude names whole is not descended into. `**/node_modules/**` rejects
  // every path under such a directory, so reading it could only produce entries that were then
  // discarded one at a time - and a workspace with its dependencies installed paid for a
  // listing of that whole tree. See prunableDirectoryNames for the shapes this is safe for.
  // The caller's own exclude is matched the way it is matched below: in the case it was
  // written, where the built-ins are case-insensitive the way ripgrep reads them.
  if (isDirectory) {
    const entryName = workspace.slice(workspace.lastIndexOf("/") + 1);
    const folded = entryName.toLowerCase();
    if (!options.noIgnore && pruneNamesFor(config.commonExcludes).has(folded)) return false;
    if (pruneNamesFor(config.extraExcludes ?? EMPTY_GLOBS).has(folded)) return false;
    if (pruneNamesFor(options.exclude, true).has(entryName)) return false;
  }
  if (!options.includeHidden) {
    const segments = scope.split("/");
    if (segments.some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..")) return false;
  }
  // Case-insensitive, the way ripgrep is asked to read them: they are emitted as --iglob so a
  // "Vendor" directory is hidden as "vendor" is. This engine never sets --glob-case-insensitive
  // - case_sensitive governs the text being searched, not the paths - so matching these
  // case-sensitively here made the two engines disagree about the same directory.
  if (!options.noIgnore && matchesAnyGlob(workspace, config.commonExcludes, false)) return false;
  // Applied to directories too, and regardless of no_ignore: a configured exclude names a
  // path the agent should not be shown, so the walk stops at the directory instead of
  // descending and then discarding every file underneath it.
  //
  // The patterns are written against the workspace root, not against the path that was searched,
  // and that is the intent rather than an accident of which variable was in scope: the setting
  // is a workspace setting, so `packages/app/**/generated/**` names the same files whichever
  // subdirectory a call searched. Read against the scope it would mean something different in
  // every call - from `packages/app` the same text would have to be written `**/generated/**`,
  // and a pattern written once could not be moved between calls without being rewritten.
  if (matchesAnyGlob(workspace, config.extraExcludes ?? [], false)) return false;
  // The caller's exclude is read against a directory as well, because that is what ripgrep
  // does: it stops at a directory the glob names instead of walking it. Checked against the
  // bundled ripgrep, `rg -n needle --glob '!dist'` does not report dist/x.txt and
  // `--glob '!**/*.ts'` does not report x.ts/inside.txt. Answering for directories before the
  // exclude was read made this engine report both: a bare `dist` names the directory and
  // nothing under it, so descending into it and then matching the exclude against every file
  // found there hid nothing at all - the same call answered two ways.
  // Sensitive, and deliberately unlike find_files, which follows case_sensitive here: that
  // tool asks ripgrep for --glob-case-insensitive and this one never does, so a caller's
  // exclude reaches each engine with a different case rule already. Reading it the other way
  // round here would make this engine disagree with the ripgrep it is standing in for.
  if (options.exclude.length > 0 && matchesAnyGlob(scope, options.exclude, true)) return false;
  if (isDirectory) return true;
  // An include is a filter on files, not on the directories that hold them: `**/*.ts` says
  // nothing about a directory called docs, and ripgrep walks it.
  if (options.include.length > 0 && !matchesAnyGlob(scope, options.include, true)) return false;
  return true;
}

async function appearsBinary(filePath: string, probeBytes: number): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(probeBytes);
    const { bytesRead } = await handle.read(buffer, 0, probeBytes, 0);
    if (bytesRead === 0) return false;
    let suspicious = 0;
    for (let index = 0; index < bytesRead; index += 1) {
      const byte = buffer[index]!;
      if (byte === 0) return true;
      const allowedControl = byte === 9 || byte === 10 || byte === 13;
      if ((byte < 32 && !allowedControl) || byte === 127) suspicious += 1;
    }
    return suspicious / bytesRead > 0.1;
  } finally {
    await handle.close();
  }
}

/**
 * ripgrep reports match offsets in bytes, while the fallback matcher reports JavaScript
 * string indices. Converting keeps the column the same whichever backend ran — without it a
 * line containing non-ASCII text comes back with a column that points into the middle of a
 * multi-byte character.
 */
export function byteOffsetToColumn(line: string, byteOffset: unknown): number {
  const offset = typeof byteOffset === "number" && Number.isInteger(byteOffset) ? byteOffset : -1;
  if (offset <= 0) return 1;
  let bytes = 0;
  let units = 0;
  for (const character of line) {
    if (bytes >= offset) break;
    bytes += Buffer.byteLength(character, "utf8");
    units += character.length;
  }
  return units + 1;
}

function compileFallbackMatcher(options: NormalizedOptions): (line: string) => { matched: boolean; column: number } {
  const sensitive = options.caseSensitive ?? smartCaseSensitive(options.pattern);
  if (options.isRegex) {
    const flags = sensitive ? "" : "i";
    let regex: RegExp;
    try {
      regex = new RegExp(options.pattern, flags);
    } catch (error) {
      throw new SearchToolError("INVALID_PATTERN", `Invalid regular expression: ${(error as Error).message}`);
    }
    return (line) => {
      regex.lastIndex = 0;
      const match = regex.exec(line);
      return match ? { matched: true, column: match.index + 1 } : { matched: false, column: 0 };
    };
  }

  // Locale-invariant on purpose: under a Turkish locale "I" lower-cases to "ı", so a
  // case-insensitive search for "image" would miss a line containing "IMAGE".
  const needle = sensitive ? options.pattern : options.pattern.toLowerCase();
  return (line) => {
    const haystack = sensitive ? line : line.toLowerCase();
    const index = haystack.indexOf(needle);
    return index >= 0 ? { matched: true, column: index + 1 } : { matched: false, column: 0 };
  };
}

async function collectCandidateFiles(
  options: NormalizedOptions,
  config: SearchFilesConfig,
  signal?: AbortSignal,
): Promise<{ files: string[]; filesScanned: number; hitLimit: boolean }> {
  const scopeStat = await stat(options.scopeRealPath);
  if (!scopeStat.isFile() && !scopeStat.isDirectory()) {
    throw new SearchToolError("NOT_A_FILE_OR_DIRECTORY", "Search path is not a regular file or directory.");
  }

  if (options.scopeIsFile) {
    // A file scope is its own root, so the path a glob is written against is the file's name.
    const scope = path.basename(options.scopeRealPath);
    const relative = displayPath(options.scopeRoot, options.scopeRealPath);
    return { files: shouldIncludePath(scope, relative, options, config, false, true) ? [options.scopeRealPath] : [], filesScanned: 1, hitLimit: false };
  }

  // Each directory carries the ignore rules that apply to it, so a .gitignore below the scope
  // root is honoured the way ripgrep honours it. Reading only the root's file used to be the
  // difference between the two engines: the fallback searched files that ripgrep skipped. The
  // rules above the root count as well, and so does the global exclude, which is why the walk
  // starts from ignoreRulesOutside rather than from nothing.
  const files: string[] = [];
  let filesScanned = 0;
  // What the budget counts. find_files counts every entry it walks into, directories
  // included, because a tree of empty directories costs as much to walk as a tree of files
  // and nothing here can tell how deep it goes before it gets there. Counting only the
  // files left the walk unbounded on a tree made of directories: on a machine without a
  // ripgrep a million empty folders was a walk with no ceiling but the abort signal.
  let entriesScanned = 0;
  let hitLimit = false;
  const stack: { directory: string; rules: GitignoreRules }[] = [{
    directory: options.scopeRealPath,
    rules: options.noIgnore ? [] : await ignoreRulesOutside(options.scopeRealPath, options.scopeRoot),
  }];

  while (stack.length > 0) {
    if (signal?.aborted) throw new DOMException("Search was cancelled.", "AbortError");
    const { directory, rules: parentRules } = stack.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") continue;
      throw error;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    let rules = parentRules;
    if (!options.noIgnore && entries.some((entry) => !entry.isDirectory() && isIgnoreFileName(entry.name))) {
      rules = await extendGitignoreRules(
        parentRules,
        directory,
        path.relative(options.scopeRoot, directory).split(path.sep).join("/"),
      );
    }

    for (const entry of entries) {
      entriesScanned += 1;
      if (entriesScanned > config.maxFallbackFilesScanned) {
        hitLimit = true;
        break;
      }
      const absolute = path.join(directory, entry.name);
      const scope = path.relative(options.scopeRealPath, absolute).split(path.sep).join("/");
      const relative = displayPath(options.scopeRoot, absolute);
      const isDirectory = entry.isDirectory();
      if (!shouldIncludePath(scope, relative, options, config, isDirectory)) continue;
      if (!options.noIgnore && gitignoreIgnores(relative, rules, isDirectory)) continue;
      if (isDirectory) {
        stack.push({ directory: absolute, rules });
        continue;
      }
      if (!entry.isFile()) continue;
      filesScanned += 1;
      files.push(absolute);
    }
    if (hitLimit) break;
  }

  files.sort((a, b) => displayPath(options.scopeRoot, a).localeCompare(displayPath(options.scopeRoot, b)));
  return { files, filesScanned: Math.min(filesScanned, config.maxFallbackFilesScanned), hitLimit };
}

async function searchWithNode(
  options: NormalizedOptions,
  config: SearchFilesConfig,
  signal?: AbortSignal,
  checkPermission?: SearchFilesContext["checkPermission"],
): Promise<EngineResult> {
  const candidateResult = await collectCandidateFiles(options, config, signal);
  const matcher = compileFallbackMatcher(options);
  const matches: RawMatch[] = [];
  const perFile = new Map<string, number>();
  const truncationReasons = new Set<SearchTruncationReason>();
  if (candidateResult.hitLimit) truncationReasons.add("MAX_FILES_SCANNED");
  let skippedBinaryFiles = 0;
  let skippedLargeFiles = 0;

  outer: for (const filePath of candidateResult.files) {
    if (signal?.aborted) throw new DOMException("Search was cancelled.", "AbortError");
    if (checkPermission && !(await checkPermission(filePath))) continue;

    // A candidate can vanish between the walk finding it and this read: a build cleaning up,
    // an editor writing over it. That is not a missing search path, which is what ENOENT is
    // reported as everywhere else in this tool, and find_files already skips it - so the two
    // agree now, and the rest of the tree is still searched.
    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(filePath);
    } catch (error) {
      // A file the caller named is the whole search, so its disappearing is the search path
      // going away - which is what this tool reports everywhere else - and not one tree entry
      // out of many that happened to be deleted mid-walk. Answering "no matches" for it says
      // the file has no match in it, which is a different thing from the file being gone.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (options.scopeIsFile) throw new SearchToolError("FILE_NOT_FOUND", "Search path does not exist.");
        continue;
      }
      throw error;
    }
    // The ceiling exists to keep a walk from reading a whole tree into memory. A file the
    // caller named is the whole search, and ripgrep has no such ceiling, so the fallback does
    // not either: returning nothing for a file that was pointed at reads as it being absent.
    if (!options.scopeIsFile && fileStat.size > config.maxFallbackFileBytes) {
      skippedLargeFiles += 1;
      continue;
    }
    if (await appearsBinary(filePath, config.binaryProbeBytes)) {
      skippedBinaryFiles += 1;
      continue;
    }

    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch (error) {
      // Same race one step later: the file passed the stat above and was gone before the read.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES") continue;
      if (code === "ENOENT") {
        if (options.scopeIsFile) throw new SearchToolError("FILE_NOT_FOUND", "Search path does not exist.");
        continue;
      }
      throw error;
    }
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
    const display = displayPath(options.scopeRoot, filePath);

    for (let index = 0; index < lines.length; index += 1) {
      const found = matcher(lines[index]!);
      if (!found.matched) continue;
      const count = perFile.get(display) ?? 0;
      if (count >= options.maxMatchesPerFile) {
        truncationReasons.add("MAX_MATCHES_PER_FILE");
        continue;
      }
      if (matches.length >= options.maxResults) {
        truncationReasons.add("MAX_RESULTS");
        break outer;
      }
      perFile.set(display, count + 1);
      matches.push({
        absolutePath: filePath,
        displayPath: display,
        line: index + 1,
        column: found.column,
        text: lines[index]!,
      });
    }
  }

  return {
    engine: "node",
    matches,
    filesScanned: candidateResult.filesScanned,
    skippedBinaryFiles,
    skippedLargeFiles,
    skippedOutsideScope: 0,
    truncationReasons,
  };
}

function ripgrepCandidates(config: SearchFilesConfig): string[] {
  const executable = process.platform === "win32" ? "rg.exe" : "rg";
  const candidates = [
    config.ripgrepPath,
    process.env.RIPGREP_PATH,
    bundledRipgrepPath,
    executable,
  ].filter((value): value is string => Boolean(value));
  return [...new Set(candidates)];
}

export function buildRipgrepArgs(options: NormalizedOptions, config: SearchFilesConfig): string[] {
  const args = ["--json", "--line-number", "--column", "--color=never", "--max-count", String(options.maxMatchesPerFile + 1)];
  if (!options.isRegex) args.push("--fixed-strings");
  if (options.caseSensitive === true) args.push("--case-sensitive");
  else if (options.caseSensitive === false) args.push("--ignore-case");
  else args.push("--smart-case");
  if (options.noIgnore) args.push("--no-ignore");
  // As in find_files: without this, .gitignore is only read inside a git repository, and the
  // two engines answered differently about a scope that is not one.
  else args.push("--no-require-git");
  if (options.includeHidden) args.push("--hidden");

  // ripgrep applies later globs with higher precedence, so exclusions must come after the
  // includes they are meant to narrow. With the excludes first, any include re-admitted what
  // they had just removed — an include of "**/*.ts" brought back every excluded test file,
  // and the built-in list stopped keeping node_modules and friends out of a scoped search.
  for (const glob of options.include) args.push("--glob", glob);
  // --iglob, not --glob: the built-in and configured excludes are case-insensitive on purpose,
  // so "Vendor/" is hidden the way "vendor/" is. --glob-case-insensitive is a whole-command
  // switch and this tool never sets it - its case_sensitive governs the text being searched,
  // not the paths - so a plain --glob here would leave those directories in. --iglob is
  // per-glob, so the caller's own include and exclude keep the case-sensitivity they asked for.
  if (!options.noIgnore) {
    for (const glob of config.commonExcludes) args.push("--iglob", `!${glob}`);
  }
  // Configured excludes are not part of the ignore system. The built-ins above exist to keep
  // a search fast, so no_ignore may lift them; agentbridge.files.excludeGlobs is the user's
  // decision about what the agent may see at all, and a caller must not be able to switch it
  // off from the other side of the Bridge.
  for (const glob of config.extraExcludes ?? []) args.push("--iglob", `!${glob}`);
  for (const glob of options.exclude) args.push("--glob", `!${glob}`);
  // Search root is "." because the child process runs with cwd = scopeRealPath.
  // ripgrep matches --glob patterns against paths as walked from the given root, so an
  // absolute root would make relative globs like "extension/**/*.ts" and "!dist/**" never match.
  // A file scope is the exception: spawn's cwd has to be a directory, so the child runs one
  // level up and is handed the file's own name. Handing it the file as cwd fails with ENOENT,
  // which reads as an unusable ripgrep and quietly costs every file-scoped search its engine.
  args.push("--", options.pattern, options.scopeIsFile ? path.basename(options.scopeRealPath) : ".");
  return args;
}

/**
 * The directory the ripgrep child runs in. A file cannot be a working directory, so a file scope
 * runs one level up - and that same directory is the base its reported paths are relative to.
 */
export function ripgrepSearchDirectory(options: Pick<NormalizedOptions, "scopeIsFile" | "scopeRealPath">): string {
  return options.scopeIsFile ? path.dirname(options.scopeRealPath) : options.scopeRealPath;
}

/**
 * Make an absolute path out of one ripgrep reported. ripgrep emits paths relative to the directory
 * it ran in, which for a file scope is the file's parent rather than the file, so resolving against
 * the scope itself produced "pkg/.env/.env" for every match inside a file-scoped search: the match
 * was counted, but the path it was reported at does not exist.
 */
export function resolveRipgrepPath(pathText: string, options: Pick<NormalizedOptions, "scopeIsFile" | "scopeRealPath">): string {
  return path.isAbsolute(pathText) ? pathText : path.resolve(ripgrepSearchDirectory(options), pathText);
}

/**
 * Whether a path an engine reported is one it was asked to search.
 *
 * The path comes back as text from a child process and was resolved without question, so a
 * report naming `../escape.txt` or an absolute path elsewhere on the machine was turned into a
 * match and read: its lines were fetched from a file outside the scope and shown as a result of
 * searching inside it. Nothing in a normal run produces such a path, which is the argument for
 * not trusting one rather than for assuming it cannot happen - a replaced or tampered-with
 * ripgrep reaches this reader the same way.
 *
 * What is compared is the path as written, and that is the whole of it: `path.resolve` folds
 * "." and ".." and never asks the filesystem where a link points, so a link inside the scope is
 * inside the scope here. That is the answer both engines are built on - ripgrep is run without
 * `--follow`, and the fallback walk lists entries `withFileTypes`, where a link is neither a
 * directory to descend into nor a file to read, so nothing behind one is ever reported. What is
 * left open is a directory replaced by a link between the walk and the read: its path is still
 * inside as written and the file behind the link is what gets read. Closing that takes an open
 * handle and a question put to it, which is a different check made elsewhere, not this one.
 */
export function isWithinSearchScope(
  absolutePath: string,
  options: Pick<NormalizedOptions, "scopeIsFile" | "scopeRealPath" | "scopeRoot">,
): boolean {
  const target = path.resolve(absolutePath);
  if (options.scopeIsFile) return target === path.resolve(options.scopeRealPath);
  return containsPath(options.scopeRealPath, target) && containsPath(options.scopeRoot, target);
}

function containsPath(parent: string, child: string): boolean {
  const resolvedParent = path.resolve(parent);
  if (child === resolvedParent) return true;
  return child.startsWith(resolvedParent.endsWith(path.sep) ? resolvedParent : resolvedParent + path.sep);
}

/**
 * One line of ripgrep's --json output, as far as search_files reads it. Every field is
 * optional and unknown-shaped because the line is whatever the child process emitted: a
 * different ripgrep build, or a build with a different feature set, may send events this
 * shape does not describe, and the reader has to keep ignoring those instead of trusting them.
 */
interface RipgrepJsonEvent {
  type?: unknown;
  data?: {
    path?: { text?: unknown };
    lines?: { text?: unknown };
    line_number?: unknown;
    submatches?: Array<{ start?: unknown }>;
  };
}

async function trySearchWithRipgrep(
  executable: string,
  options: NormalizedOptions,
  config: SearchFilesConfig,
  signal?: AbortSignal,
): Promise<EngineResult | null> {
  return new Promise((resolve, reject) => {
    const args = buildRipgrepArgs(options, config);
    const cwd = ripgrepSearchDirectory(options);
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], signal });
    const matches: RawMatch[] = [];
    const perFile = new Map<string, number>();
    const truncationReasons = new Set<SearchTruncationReason>();
    let skippedOutsideScope = 0;
    let stdoutPending = "";
    let stderr = "";
    let unavailable = false;
    let settled = false;

    const finish = (value: EngineResult | null, error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        unavailable = true;
        finish(null);
        return;
      }
      if (error.name === "AbortError") {
        finish(null, error);
        return;
      }
      finish(null, error);
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
    });

    const parseLine = (line: string): void => {
      if (!line.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object") return;
      const event = parsed as RipgrepJsonEvent;
      if (event.type !== "match") return;
      const data = event.data;
      const pathText = data?.path?.text;
      const lineText = data?.lines?.text;
      const lineNumber = data?.line_number;
      if (typeof pathText !== "string" || typeof lineText !== "string") return;
      if (typeof lineNumber !== "number" || !Number.isInteger(lineNumber)) return;

      const absolute = resolveRipgrepPath(pathText, options);
      if (!isWithinSearchScope(absolute, options)) {
        skippedOutsideScope += 1;
        return;
      }
      const display = displayPath(options.scopeRoot, absolute);
      const count = perFile.get(display) ?? 0;
      if (count >= options.maxMatchesPerFile) {
        truncationReasons.add("MAX_MATCHES_PER_FILE");
        return;
      }
      if (matches.length >= options.maxResults) {
        truncationReasons.add("MAX_RESULTS");
        child.kill();
        return;
      }
      perFile.set(display, count + 1);
      const submatches = data?.submatches;
      const firstSubmatch = Array.isArray(submatches) ? submatches[0] : undefined;
      matches.push({
        absolutePath: absolute,
        displayPath: display,
        line: lineNumber,
        column: byteOffsetToColumn(lineText, firstSubmatch?.start),
        text: lineText.replace(/\r?\n$/, ""),
      });
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutPending += chunk;
      while (true) {
        const newline = stdoutPending.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutPending.slice(0, newline);
        stdoutPending = stdoutPending.slice(newline + 1);
        parseLine(line);
      }
    });

    child.on("close", (code, signalName) => {
      if (unavailable || settled) return;
      // A child that died from a signal while the caller's signal is aborted was killed by
      // that cancellation. Saying so here rather than waiting for the "error" event keeps
      // the answer independent of the order the two arrive in - Node reports the abort on a
      // later tick than the one that started the kill, and the exit only once the process
      // handle closes - and a cancellation must never come back as an I/O error.
      if (signalName && signal?.aborted) {
        finish(null, new DOMException("Search was cancelled.", "AbortError"));
        return;
      }
      if (stdoutPending) parseLine(stdoutPending);
      // rg exits 0 when matches exist, 1 when no matches, and 2 on an actual error.
      if (code !== 0 && code !== 1 && !(signalName && truncationReasons.has("MAX_RESULTS"))) {
        if (/regex parse error|error parsing regex|invalid regex/i.test(stderr)) {
          finish(null, new SearchToolError("INVALID_PATTERN", stderr.trim() || "Invalid regular expression."));
          return;
        }
        // A ripgrep that rejects the flags it was given cannot serve the search, but the next
        // candidate may: the bundled binary is only the first of several, and a build that
        // does not know one of these flags used to fail every search on that machine.
        if (isRipgrepUsageError(stderr)) {
          unavailable = true;
          finish(null);
          return;
        }
        finish(null, new SearchToolError("IO_ERROR", stderr.trim() || `ripgrep exited with code ${code}.`));
        return;
      }
      finish({
        engine: "ripgrep",
        matches,
        filesScanned: null,
        skippedBinaryFiles: 0,
        skippedLargeFiles: 0,
        skippedOutsideScope,
        truncationReasons,
      });
    });
  });
}

async function searchWithPreferredEngine(
  options: NormalizedOptions,
  config: SearchFilesConfig,
  signal?: AbortSignal,
  checkPermission?: SearchFilesContext["checkPermission"],
): Promise<EngineResult> {
  // A permission callback is evaluated per file, so use the Node engine where every candidate passes policy checks.
  if (!checkPermission) {
    for (const candidate of ripgrepCandidates(config)) {
      try {
        const result = await trySearchWithRipgrep(candidate, options, config, signal);
        if (result) return result;
      } catch (error) {
        if ((error as Error)?.name === "AbortError") throw error;
        if (error instanceof SearchToolError && error.code === "INVALID_PATTERN") throw error;
        // Only fall back for unavailable/unusable ripgrep. Real search errors should surface.
        if (error instanceof SearchToolError) throw error;
      }
    }
  }
  return searchWithNode(options, config, signal, checkPermission);
}

function truncateLine(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)} … <line truncated>`, truncated: true };
}

async function addContext(
  rawMatches: RawMatch[],
  contextLines: number,
  config: SearchFilesConfig,
  truncationReasons: Set<SearchTruncationReason>,
): Promise<SearchMatch[]> {
  const cache = new Map<string, string[] | null>();
  const result: SearchMatch[] = [];
  let cachedFileBytes = 0;

  for (const match of rawMatches) {
    const hit = truncateLine(match.text, config.maxLineChars);
    if (contextLines === 0) {
      result.push({
        path: match.displayPath,
        line: match.line,
        column: match.column,
        text: hit.text,
        text_truncated: hit.truncated,
        before: [],
        after: [],
      });
      continue;
    }

    let lines = cache.get(match.absolutePath);
    if (lines === undefined) {
      try {
        const fileStat = await stat(match.absolutePath);
        if (fileStat.size > config.maxFallbackFileBytes) {
          // Too large to hold for its surrounding lines, which is a different thing from the
          // cache being full: the match is still reported, and the caller is told why the
          // lines around it are missing rather than being left to guess.
          lines = null;
          truncationReasons.add("CONTEXT_FILE_TOO_LARGE");
        } else if (cachedFileBytes + fileStat.size > config.maxContextCacheBytes) {
          lines = null;
          truncationReasons.add("CONTEXT_CACHE_BYTE_BUDGET");
        } else {
          const text = await readFile(match.absolutePath, "utf8");
          lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
          cachedFileBytes += fileStat.size;
        }
      } catch {
        lines = null;
      }
      cache.set(match.absolutePath, lines);
    }

    const before: SearchContextLine[] = [];
    const after: SearchContextLine[] = [];
    if (lines !== null) {
      for (let lineNumber = Math.max(1, match.line - contextLines); lineNumber < match.line; lineNumber += 1) {
        const value = truncateLine(lines[lineNumber - 1] ?? "", config.maxLineChars);
        before.push({ line: lineNumber, text: value.text, truncated: value.truncated });
      }
      for (let lineNumber = match.line + 1; lineNumber <= Math.min(lines.length, match.line + contextLines); lineNumber += 1) {
        const value = truncateLine(lines[lineNumber - 1] ?? "", config.maxLineChars);
        after.push({ line: lineNumber, text: value.text, truncated: value.truncated });
      }
    }

    result.push({
      path: match.displayPath,
      line: match.line,
      column: match.column,
      text: hit.text,
      text_truncated: hit.truncated,
      before,
      after,
    });
  }

  return result;
}

function serializedMatchSize(match: SearchMatch): { bytes: number; tokens: number } {
  const text = [
    `${match.path}:${match.line}:${match.column}`,
    ...match.before.map((item) => `${item.line}|${item.text}`),
    `${match.line}>${match.text}`,
    ...match.after.map((item) => `${item.line}|${item.text}`),
  ].join("\n");
  return { bytes: Buffer.byteLength(text, "utf8"), tokens: estimateTokens(text) };
}

function applyOutputBudget(matches: SearchMatch[], config: SearchFilesConfig, reasons: Set<SearchTruncationReason>): SearchMatch[] {
  const result: SearchMatch[] = [];
  let bytes = 0;
  let tokens = 0;
  for (const match of matches) {
    const size = serializedMatchSize(match);
    if (bytes + size.bytes > config.maxOutputBytes) {
      reasons.add("OUTPUT_BYTE_BUDGET");
      break;
    }
    if (tokens + size.tokens > config.maxEstimatedTokens) {
      reasons.add("OUTPUT_TOKEN_BUDGET");
      break;
    }
    result.push(match);
    bytes += size.bytes;
    tokens += size.tokens;
  }
  return result;
}

function normalizeError(error: unknown): never {
  if (error instanceof SearchToolError) throw error;
  if ((error as Error)?.name === "AbortError") {
    throw new SearchToolError("ABORTED", "Search was cancelled.");
  }
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") throw new SearchToolError("FILE_NOT_FOUND", "Search path does not exist.");
  if (code === "EACCES" || code === "EPERM") throw new SearchToolError("PERMISSION_DENIED", "Permission denied during search.");
  throw new SearchToolError("IO_ERROR", (error as Error)?.message || "Unexpected search I/O error.");
}

export async function searchFiles(input: SearchFilesInput, context: SearchFilesContext): Promise<SearchFilesResult> {
  const config: SearchFilesConfig = { ...DEFAULT_SEARCH_FILES_CONFIG, ...context.config };
  try {
    const normalized = normalizeInput(input, config);
    const scope = await resolveSafeScope(normalized.scopeDisplay, context.workspaceRoots);
    const scopeStat = await stat(scope.realPath);
    const options: NormalizedOptions = {
      ...normalized,
      scopeRealPath: scope.realPath,
      scopeRoot: scope.root,
      scopeIsFile: scopeStat.isFile(),
    };

    if (context.signal?.aborted) throw new DOMException("Search was cancelled.", "AbortError");
    if (context.checkPermission && !(await context.checkPermission(options.scopeRealPath))) {
      throw new SearchToolError("PERMISSION_DENIED", "Searching this path is not permitted by the current policy.");
    }

    const engine = await searchWithPreferredEngine(options, config, context.signal, context.checkPermission);
    const enriched = await addContext(engine.matches, options.contextLines, config, engine.truncationReasons);
    const bounded = applyOutputBudget(enriched, config, engine.truncationReasons);
    const filesWithMatches = new Set(bounded.map((match) => match.path)).size;

    return {
      pattern: options.pattern,
      mode: options.isRegex ? "regex" : "literal",
      case_mode: options.caseSensitive === true ? "sensitive" : options.caseSensitive === false ? "insensitive" : "smart",
      scope: options.scopeDisplay,
      engine: engine.engine,
      adjusted_arguments: options.adjusted_arguments ?? [],
      filters: {
        ignored_skipped: !options.noIgnore,
        hidden_skipped: !options.includeHidden,
      },
      matches: bounded,
      summary: {
        returned_matches: bounded.length,
        files_with_matches: filesWithMatches,
        files_scanned: engine.filesScanned,
        skipped_binary_files: engine.skippedBinaryFiles,
        skipped_large_files: engine.skippedLargeFiles,
        skipped_outside_scope: engine.skippedOutsideScope,
        truncated: engine.truncationReasons.size > 0,
        truncation_reasons: [...engine.truncationReasons],
      },
    };
  } catch (error) {
    return normalizeError(error);
  }
}

export function formatSearchFilesForModel(result: SearchFilesResult): string {
  const parts = [
    "=== SEARCH_FILES BEGIN ===",
    `pattern: ${JSON.stringify(result.pattern)}`,
    `mode: ${result.mode}`,
    `case_mode: ${result.case_mode}`,
    `scope: ${JSON.stringify(result.scope)}`,
    `engine: ${result.engine}`,
    ...((result.adjusted_arguments ?? []).length > 0
      ? [`adjusted: ${(result.adjusted_arguments ?? []).join("; ")}.`]
      : []),
    `returned_matches: ${result.summary.returned_matches}`,
    `files_with_matches: ${result.summary.files_with_matches}`,
    `truncated: ${result.summary.truncated}`,
  ];

  for (let index = 0; index < result.matches.length; index += 1) {
    const match = result.matches[index]!;
    parts.push(`--- MATCH ${index + 1} ---`, `${match.path}:${match.line}:${match.column}`);
    for (const line of match.before) parts.push(`${line.line}| ${line.text}`);
    parts.push(`${match.line}> ${match.text}`);
    for (const line of match.after) parts.push(`${line.line}| ${line.text}`);
    if (match.text_truncated || match.before.some((line) => line.truncated) || match.after.some((line) => line.truncated)) {
      parts.push("NOTE: One or more displayed lines were shortened to protect the context budget.");
    }
  }

  const skipped = describeSkippedFilters(result.filters, "text", result.matches.length > 0);
  if (skipped) parts.push(skipped);
  if (result.summary.truncated) {
    parts.push(
      `NOTE: Search results were bounded (${result.summary.truncation_reasons.join(", ")}). Narrow path/include/exclude/pattern or run a follow-up search if more results are needed.`,
    );
  }
  if (result.engine === "node") {
    parts.push("NOTE: ripgrep was unavailable; the built-in Node fallback engine was used.");
  }
  if (result.summary.skipped_outside_scope > 0) {
    parts.push(
      `NOTE: ${result.summary.skipped_outside_scope} match(es) were dropped because the path they were reported at is outside the scope that was searched. An engine is not trusted with paths beyond the one it was given.`,
    );
  }
  if (result.summary.skipped_large_files > 0 || result.summary.skipped_binary_files > 0) {
    parts.push(
      `NOTE: fallback engine skipped ${result.summary.skipped_large_files} large file(s) and ${result.summary.skipped_binary_files} binary file(s).`,
    );
  }

  parts.push("=== SEARCH_FILES END ===");
  return parts.join("\n");
}

