import { spawn } from "node:child_process";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { rgPath as bundledRipgrepPath } from "@vscode/ripgrep";

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
  maxFallbackFilesScanned: number;
  binaryProbeBytes: number;
  ripgrepPath?: string;
  commonExcludes: string[];
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
  maxFallbackFilesScanned: 20_000,
  binaryProbeBytes: 8 * 1024,
  commonExcludes: [
    "**/.git/**",
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/out/**",
    "**/out-build/**",
    "**/out-vscode/**",
    "**/coverage/**",
    "**/.next/**",
    "**/target/**",
    "**/vendor/**",
    "**/VSCode-win32-x64/**",
    "**/release/**",
    "**/*.zip",
  ],
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
  | "MAX_FILES_SCANNED";

export interface SearchFilesResult {
  pattern: string;
  mode: "literal" | "regex";
  case_mode: "sensitive" | "insensitive" | "smart";
  scope: string;
  engine: "ripgrep" | "node";
  matches: SearchMatch[];
  summary: {
    returned_matches: number;
    files_with_matches: number;
    files_scanned: number | null;
    skipped_binary_files: number;
    skipped_large_files: number;
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
  maxResults: number;
  maxMatchesPerFile: number;
  noIgnore: boolean;
  includeHidden: boolean;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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

function clampInteger(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min) {
    throw new SearchToolError("INVALID_ARGUMENT", `${name} must be an integer >= ${min}.`);
  }
  return Math.min(value, max);
}

function smartCaseSensitive(pattern: string): boolean {
  return /[A-Z]/.test(pattern);
}

function normalizeInput(input: SearchFilesInput, config: SearchFilesConfig): Omit<NormalizedOptions, "scopeRealPath" | "scopeRoot"> {
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

  return {
    pattern: input.pattern,
    scopeDisplay: input.path ?? ".",
    isRegex: input.is_regex ?? false,
    caseSensitive: input.case_sensitive,
    include,
    exclude,
    contextLines: clampInteger(input.context_lines, config.defaultContextLines, 0, config.maxContextLines, "context_lines"),
    maxResults: clampInteger(input.max_results, config.defaultMaxResults, 1, config.hardMaxResults, "max_results"),
    maxMatchesPerFile: clampInteger(
      input.max_matches_per_file,
      config.defaultMaxMatchesPerFile,
      1,
      config.hardMaxMatchesPerFile,
      "max_matches_per_file",
    ),
    noIgnore: input.no_ignore ?? false,
    includeHidden: input.include_hidden ?? false,
  };
}

function displayPath(root: string, filePath: string): string {
  const relative = path.relative(root, filePath);
  return (relative || path.basename(filePath)).split(path.sep).join("/");
}

function matchesAnyGlob(relativePath: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  const normalized = relativePath.split(path.sep).join("/");
  const base = path.posix.basename(normalized);
  return patterns.some((pattern) => {
    try {
      return path.matchesGlob(normalized, pattern) || path.matchesGlob(base, pattern);
    } catch {
      return false;
    }
  });
}

function shouldIncludePath(relativePath: string, options: NormalizedOptions, config: SearchFilesConfig): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  if (!options.includeHidden) {
    const segments = normalized.split("/");
    if (segments.some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..")) return false;
  }
  if (!options.noIgnore && matchesAnyGlob(normalized, config.commonExcludes)) return false;
  if (options.include.length > 0 && !matchesAnyGlob(normalized, options.include)) return false;
  if (options.exclude.length > 0 && matchesAnyGlob(normalized, options.exclude)) return false;
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

async function loadRootGitignore(root: string): Promise<string[]> {
  try {
    const text = await readFile(path.join(root, ".gitignore"), "utf8");
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch {
    return [];
  }
}

function gitignorePatternMatches(relativePath: string, rawPattern: string): boolean {
  const negated = rawPattern.startsWith("!");
  const source = negated ? rawPattern.slice(1) : rawPattern;
  if (!source) return false;
  const normalized = source.replace(/^\//, "").replace(/\\/g, "/");
  const candidate = relativePath.replace(/\\/g, "/");
  const directoryPattern = normalized.endsWith("/");
  const clean = directoryPattern ? normalized.slice(0, -1) : normalized;
  const patterns = clean.includes("/")
    ? [clean, directoryPattern ? `${clean}/**` : clean]
    : [clean, `**/${clean}`, `**/${clean}/**`];
  return matchesAnyGlob(candidate, patterns);
}

function ignoredByRootGitignore(relativePath: string, patterns: string[]): boolean {
  let ignored = false;
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    if (gitignorePatternMatches(relativePath, raw) || (negated && gitignorePatternMatches(relativePath, raw.slice(1)))) {
      ignored = !negated;
    }
  }
  return ignored;
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

  const needle = sensitive ? options.pattern : options.pattern.toLocaleLowerCase();
  return (line) => {
    const haystack = sensitive ? line : line.toLocaleLowerCase();
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

  if (scopeStat.isFile()) {
    const relative = displayPath(options.scopeRoot, options.scopeRealPath);
    return { files: shouldIncludePath(relative, options, config) ? [options.scopeRealPath] : [], filesScanned: 1, hitLimit: false };
  }

  const gitignore = options.noIgnore ? [] : await loadRootGitignore(options.scopeRoot);
  const files: string[] = [];
  let filesScanned = 0;
  let hitLimit = false;
  const stack = [options.scopeRealPath];

  while (stack.length > 0) {
    if (signal?.aborted) throw new DOMException("Search was cancelled.", "AbortError");
    const directory = stack.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") continue;
      throw error;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = displayPath(options.scopeRoot, absolute);
      if (!shouldIncludePath(relative, options, config)) continue;
      if (!options.noIgnore && ignoredByRootGitignore(relative, gitignore)) continue;
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      filesScanned += 1;
      if (filesScanned > config.maxFallbackFilesScanned) {
        hitLimit = true;
        break;
      }
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

    const fileStat = await stat(filePath);
    if (fileStat.size > config.maxFallbackFileBytes) {
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
      if ((error as NodeJS.ErrnoException).code === "EACCES") continue;
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

function buildRipgrepArgs(options: NormalizedOptions, config: SearchFilesConfig): string[] {
  const args = ["--json", "--line-number", "--column", "--color=never", "--max-count", String(options.maxMatchesPerFile + 1)];
  if (!options.isRegex) args.push("--fixed-strings");
  if (options.caseSensitive === true) args.push("--case-sensitive");
  else if (options.caseSensitive === false) args.push("--ignore-case");
  else args.push("--smart-case");
  if (options.noIgnore) args.push("--no-ignore");
  if (options.includeHidden) args.push("--hidden");

  if (!options.noIgnore) {
    for (const glob of config.commonExcludes) args.push("--glob", `!${glob}`);
  }
  for (const glob of options.include) args.push("--glob", glob);
  for (const glob of options.exclude) args.push("--glob", `!${glob}`);
  args.push("--", options.pattern, options.scopeRealPath);
  return args;
}

async function trySearchWithRipgrep(
  executable: string,
  options: NormalizedOptions,
  config: SearchFilesConfig,
  signal?: AbortSignal,
): Promise<EngineResult | null> {
  return new Promise((resolve, reject) => {
    const args = buildRipgrepArgs(options, config);
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], signal });
    const matches: RawMatch[] = [];
    const perFile = new Map<string, number>();
    const truncationReasons = new Set<SearchTruncationReason>();
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
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event?.type !== "match") return;
      const data = event.data;
      const pathText = data?.path?.text;
      const lineText = data?.lines?.text;
      const lineNumber = data?.line_number;
      if (typeof pathText !== "string" || typeof lineText !== "string" || !Number.isInteger(lineNumber)) return;

      const absolute = path.isAbsolute(pathText) ? pathText : path.resolve(options.scopeRealPath, pathText);
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
      const firstSubmatch = Array.isArray(data?.submatches) ? data.submatches[0] : undefined;
      matches.push({
        absolutePath: absolute,
        displayPath: display,
        line: lineNumber,
        column: Number.isInteger(firstSubmatch?.start) ? firstSubmatch.start + 1 : 1,
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
      if (stdoutPending) parseLine(stdoutPending);
      // rg exits 0 when matches exist, 1 when no matches, and 2 on an actual error.
      if (code !== 0 && code !== 1 && !(signalName && truncationReasons.has("MAX_RESULTS"))) {
        if (/regex parse error|error parsing regex|invalid regex/i.test(stderr)) {
          finish(null, new SearchToolError("INVALID_PATTERN", stderr.trim() || "Invalid regular expression."));
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
): Promise<SearchMatch[]> {
  const cache = new Map<string, string[]>();
  const result: SearchMatch[] = [];

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
    if (!lines) {
      try {
        const fileStat = await stat(match.absolutePath);
        if (fileStat.size > config.maxFallbackFileBytes) {
          lines = [];
        } else {
          const text = await readFile(match.absolutePath, "utf8");
          lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
        }
      } catch {
        lines = [];
      }
      cache.set(match.absolutePath, lines);
    }

    const before: SearchContextLine[] = [];
    const after: SearchContextLine[] = [];
    for (let lineNumber = Math.max(1, match.line - contextLines); lineNumber < match.line; lineNumber += 1) {
      const value = truncateLine(lines[lineNumber - 1] ?? "", config.maxLineChars);
      before.push({ line: lineNumber, text: value.text, truncated: value.truncated });
    }
    for (let lineNumber = match.line + 1; lineNumber <= Math.min(lines.length, match.line + contextLines); lineNumber += 1) {
      const value = truncateLine(lines[lineNumber - 1] ?? "", config.maxLineChars);
      after.push({ line: lineNumber, text: value.text, truncated: value.truncated });
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
    const options: NormalizedOptions = {
      ...normalized,
      scopeRealPath: scope.realPath,
      scopeRoot: scope.root,
    };

    if (context.signal?.aborted) throw new DOMException("Search was cancelled.", "AbortError");
    if (context.checkPermission && !(await context.checkPermission(options.scopeRealPath))) {
      throw new SearchToolError("PERMISSION_DENIED", "Searching this path is not permitted by the current policy.");
    }

    const engine = await searchWithPreferredEngine(options, config, context.signal, context.checkPermission);
    const enriched = await addContext(engine.matches, options.contextLines, config);
    const bounded = applyOutputBudget(enriched, config, engine.truncationReasons);
    const filesWithMatches = new Set(bounded.map((match) => match.path)).size;

    return {
      pattern: options.pattern,
      mode: options.isRegex ? "regex" : "literal",
      case_mode: options.caseSensitive === true ? "sensitive" : options.caseSensitive === false ? "insensitive" : "smart",
      scope: options.scopeDisplay,
      engine: engine.engine,
      matches: bounded,
      summary: {
        returned_matches: bounded.length,
        files_with_matches: filesWithMatches,
        files_scanned: engine.filesScanned,
        skipped_binary_files: engine.skippedBinaryFiles,
        skipped_large_files: engine.skippedLargeFiles,
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

  if (result.summary.truncated) {
    parts.push(
      `NOTE: Search results were bounded (${result.summary.truncation_reasons.join(", ")}). Narrow path/include/exclude/pattern or run a follow-up search if more results are needed.`,
    );
  }
  if (result.engine === "node") {
    parts.push("NOTE: ripgrep was unavailable; the built-in Node fallback engine was used.");
  }
  if (result.summary.skipped_large_files > 0 || result.summary.skipped_binary_files > 0) {
    parts.push(
      `NOTE: fallback engine skipped ${result.summary.skipped_large_files} large file(s) and ${result.summary.skipped_binary_files} binary file(s).`,
    );
  }

  parts.push("=== SEARCH_FILES END ===");
  return parts.join("\n");
}

