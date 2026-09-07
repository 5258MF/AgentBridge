import { spawn } from "node:child_process";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { rgPath as bundledRipgrepPath } from "@vscode/ripgrep";

export interface FindFilesInput {
  patterns: string[];
  path?: string;
  exclude?: string[];
  case_sensitive?: boolean;
  no_ignore?: boolean;
  include_hidden?: boolean;
  max_results?: number;
  sort?: "modified_desc" | "path_asc";
}

export interface FindFilesConfig {
  defaultMaxResults: number;
  hardMaxResults: number;
  maxCandidates: number;
  statConcurrency: number;
  ripgrepPath?: string;
  commonExcludes: string[];
}

export const DEFAULT_FIND_FILES_CONFIG: FindFilesConfig = {
  defaultMaxResults: 100,
  hardMaxResults: 500,
  maxCandidates: 5_000,
  statConcurrency: 32,
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

export type FindFilesErrorCode =
  | "FILE_NOT_FOUND"
  | "NOT_A_DIRECTORY"
  | "PATH_OUTSIDE_WORKSPACE"
  | "PERMISSION_DENIED"
  | "INVALID_GLOB"
  | "INVALID_ARGUMENT"
  | "ABORTED"
  | "IO_ERROR";

export type FindFilesTruncationReason = "MAX_RESULTS" | "MAX_CANDIDATES";

export interface FoundFile {
  path: string;
  size_bytes: number;
  modified_ms: number;
}

export interface FindFilesResult {
  patterns: string[];
  scope: string;
  engine: "ripgrep" | "node";
  sort: "modified_desc" | "path_asc";
  files: FoundFile[];
  summary: {
    candidate_paths: number;
    returned_files: number;
    truncated: boolean;
    truncation_reasons: FindFilesTruncationReason[];
  };
}

export interface FindFilesContext {
  workspaceRoots: string[];
  config?: Partial<FindFilesConfig>;
  signal?: AbortSignal;
  checkPermission?: (realPath: string) => Promise<boolean> | boolean;
}

class FindFilesError extends Error {
  constructor(
    public readonly code: FindFilesErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface NormalizedOptions {
  patterns: string[];
  exclude: string[];
  scopeDisplay: string;
  scopeRealPath: string;
  scopeRoot: string;
  caseSensitive: boolean;
  noIgnore: boolean;
  includeHidden: boolean;
  maxResults: number;
  sort: "modified_desc" | "path_asc";
}

interface CandidateResult {
  engine: "ripgrep" | "node";
  paths: string[];
  candidateCount: number;
  truncationReasons: Set<FindFilesTruncationReason>;
}

function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function canonicalRoots(roots: string[]): Promise<string[]> {
  if (roots.length === 0) throw new FindFilesError("PATH_OUTSIDE_WORKSPACE", "No workspace root is configured.");
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
      if (!root) continue;
      const targetStat = await stat(target);
      if (!targetStat.isDirectory()) throw new FindFilesError("NOT_A_DIRECTORY", "find_files path must be a directory.");
      return { realPath: target, root };
    } catch (error) {
      if (error instanceof FindFilesError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        sawNotFound = true;
        continue;
      }
      if (code === "EACCES" || code === "EPERM") {
        throw new FindFilesError("PERMISSION_DENIED", "Permission denied while resolving the search directory.");
      }
      throw error;
    }
  }

  if (sawNotFound) throw new FindFilesError("FILE_NOT_FOUND", "Search directory does not exist.");
  throw new FindFilesError("PATH_OUTSIDE_WORKSPACE", "Search directory resolves outside the allowed workspace roots.");
}

function validateGlob(pattern: string): void {
  if (!pattern || pattern.length > 4_000) {
    throw new FindFilesError("INVALID_GLOB", "Glob patterns must be non-empty and at most 4000 characters.");
  }
  try {
    path.matchesGlob("probe/example.ts", pattern);
  } catch (error) {
    throw new FindFilesError("INVALID_GLOB", `Invalid glob pattern ${JSON.stringify(pattern)}: ${(error as Error).message}`);
  }
}

function normalizeInput(input: FindFilesInput, config: FindFilesConfig): Omit<NormalizedOptions, "scopeRealPath" | "scopeRoot"> {
  if (!Array.isArray(input.patterns) || input.patterns.length === 0) {
    throw new FindFilesError("INVALID_ARGUMENT", "patterns must be a non-empty array of glob strings.");
  }
  if (input.patterns.length > 20) {
    throw new FindFilesError("INVALID_ARGUMENT", "At most 20 glob patterns may be requested in one call.");
  }
  const patterns = [...new Set(input.patterns)];
  for (const pattern of patterns) {
    if (typeof pattern !== "string") throw new FindFilesError("INVALID_ARGUMENT", "Every patterns item must be a string.");
    validateGlob(pattern);
  }

  const exclude = input.exclude ?? [];
  if (!Array.isArray(exclude) || exclude.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new FindFilesError("INVALID_ARGUMENT", "exclude must be an array of non-empty glob strings.");
  }
  if (exclude.length > 50) throw new FindFilesError("INVALID_ARGUMENT", "At most 50 exclude globs may be provided.");
  for (const pattern of exclude) validateGlob(pattern);

  if (input.path !== undefined && (typeof input.path !== "string" || input.path.length === 0)) {
    throw new FindFilesError("INVALID_ARGUMENT", "path must be a non-empty directory path when provided.");
  }
  if (input.max_results !== undefined && (!Number.isInteger(input.max_results) || input.max_results < 1)) {
    throw new FindFilesError("INVALID_ARGUMENT", "max_results must be an integer >= 1.");
  }
  if (input.sort !== undefined && input.sort !== "modified_desc" && input.sort !== "path_asc") {
    throw new FindFilesError("INVALID_ARGUMENT", "sort must be 'modified_desc' or 'path_asc'.");
  }

  return {
    patterns,
    exclude,
    scopeDisplay: input.path ?? ".",
    caseSensitive: input.case_sensitive ?? false,
    noIgnore: input.no_ignore ?? false,
    includeHidden: input.include_hidden ?? false,
    maxResults: Math.min(input.max_results ?? config.defaultMaxResults, config.hardMaxResults),
    sort: input.sort ?? "modified_desc",
  };
}

function displayPath(root: string, filePath: string): string {
  const relative = path.relative(root, filePath);
  return (relative || path.basename(filePath)).split(path.sep).join("/");
}

function matchesGlob(value: string, pattern: string, caseSensitive: boolean): boolean {
  const candidate = value.split(path.sep).join("/");
  if (caseSensitive) return path.matchesGlob(candidate, pattern);
  return path.matchesGlob(candidate.toLocaleLowerCase(), pattern.toLocaleLowerCase());
}

function matchesAny(value: string, patterns: string[], caseSensitive: boolean): boolean {
  return patterns.some((pattern) => matchesGlob(value, pattern, caseSensitive));
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

function gitignoreMatches(relativePath: string, patterns: string[]): boolean {
  let ignored = false;
  const candidate = relativePath.replace(/\\/g, "/");
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const source = (negated ? raw.slice(1) : raw).replace(/^\//, "").replace(/\\/g, "/");
    if (!source) continue;
    const directoryPattern = source.endsWith("/");
    const clean = directoryPattern ? source.slice(0, -1) : source;
    const variants = clean.includes("/")
      ? [clean, directoryPattern ? `${clean}/**` : clean]
      : [clean, `**/${clean}`, `**/${clean}/**`];
    if (variants.some((pattern) => path.matchesGlob(candidate, pattern))) ignored = !negated;
  }
  return ignored;
}

function ripgrepCandidates(config: FindFilesConfig): string[] {
  const executable = process.platform === "win32" ? "rg.exe" : "rg";
  return [...new Set([config.ripgrepPath, process.env.RIPGREP_PATH, bundledRipgrepPath, executable].filter(Boolean) as string[])];
}

function buildRipgrepArgs(options: NormalizedOptions, config: FindFilesConfig): string[] {
  const args = ["--files", "--color=never"];
  if (!options.caseSensitive) args.push("--glob-case-insensitive");
  if (options.noIgnore) args.push("--no-ignore");
  if (options.includeHidden) args.push("--hidden");
  for (const pattern of options.patterns) args.push("--glob", pattern);
  // ripgrep applies later globs with higher precedence, so exclusions must come after includes.
  if (!options.noIgnore) {
    for (const glob of config.commonExcludes) args.push("--glob", `!${glob}`);
  }
  for (const pattern of options.exclude) args.push("--glob", `!${pattern}`);
  // Search root is "." because the child process runs with cwd = scopeRealPath.
  // ripgrep matches --glob patterns against paths as walked from the given root, so an
  // absolute root would make relative globs like "src/**/*.ts" and "!dist/**" never match.
  args.push("--", ".");
  return args;
}

async function tryFindWithRipgrep(
  executable: string,
  options: NormalizedOptions,
  config: FindFilesConfig,
  signal?: AbortSignal,
): Promise<CandidateResult | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, buildRipgrepArgs(options, config), {
      cwd: options.scopeRealPath,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    const paths: string[] = [];
    const seen = new Set<string>();
    const reasons = new Set<FindFilesTruncationReason>();
    let pending = "";
    let stderr = "";
    let settled = false;
    let unavailable = false;

    const finish = (value: CandidateResult | null, error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };

    const accept = (line: string): void => {
      const value = line.trim();
      if (!value) return;
      const absolute = path.isAbsolute(value) ? value : path.resolve(options.scopeRealPath, value);
      const realDisplay = displayPath(options.scopeRoot, absolute);
      if (seen.has(realDisplay)) return;
      seen.add(realDisplay);
      if (paths.length >= config.maxCandidates) {
        reasons.add("MAX_CANDIDATES");
        child.kill();
        return;
      }
      paths.push(absolute);
    };

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        unavailable = true;
        finish(null);
        return;
      }
      finish(null, error);
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      while (true) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        accept(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
    });

    child.on("close", (code, signalName) => {
      if (unavailable || settled) return;
      if (pending) accept(pending);
      if (code !== 0 && code !== 1 && !(signalName && reasons.has("MAX_CANDIDATES"))) {
        finish(null, new FindFilesError("IO_ERROR", stderr.trim() || `ripgrep exited with code ${code}.`));
        return;
      }
      finish({
        engine: "ripgrep",
        paths,
        candidateCount: paths.length,
        truncationReasons: reasons,
      });
    });
  });
}

async function findWithNode(
  options: NormalizedOptions,
  config: FindFilesConfig,
  signal?: AbortSignal,
  checkPermission?: FindFilesContext["checkPermission"],
): Promise<CandidateResult> {
  const paths: string[] = [];
  const reasons = new Set<FindFilesTruncationReason>();
  const gitignore = options.noIgnore ? [] : await loadRootGitignore(options.scopeRoot);
  const stack = [options.scopeRealPath];

  while (stack.length > 0) {
    if (signal?.aborted) throw new DOMException("File discovery was cancelled.", "AbortError");
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
      const workspaceRelative = displayPath(options.scopeRoot, absolute);
      const scopeRelative = path.relative(options.scopeRealPath, absolute).split(path.sep).join("/");
      const hidden = scopeRelative.split("/").some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..");
      if (!options.includeHidden && hidden) continue;
      if (!options.noIgnore && matchesAny(workspaceRelative, config.commonExcludes, true)) continue;
      if (!options.noIgnore && gitignoreMatches(workspaceRelative, gitignore)) continue;
      if (matchesAny(scopeRelative, options.exclude, options.caseSensitive)) continue;

      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!matchesAny(scopeRelative, options.patterns, options.caseSensitive)) continue;
      if (checkPermission && !(await checkPermission(absolute))) continue;

      if (paths.length >= config.maxCandidates) {
        reasons.add("MAX_CANDIDATES");
        return { engine: "node", paths, candidateCount: paths.length, truncationReasons: reasons };
      }
      paths.push(absolute);
    }
  }

  return { engine: "node", paths, candidateCount: paths.length, truncationReasons: reasons };
}

async function findWithPreferredEngine(
  options: NormalizedOptions,
  config: FindFilesConfig,
  signal?: AbortSignal,
  checkPermission?: FindFilesContext["checkPermission"],
): Promise<CandidateResult> {
  if (!checkPermission) {
    for (const candidate of ripgrepCandidates(config)) {
      try {
        const result = await tryFindWithRipgrep(candidate, options, config, signal);
        if (result) return result;
      } catch (error) {
        if ((error as Error)?.name === "AbortError") throw error;
        if (error instanceof FindFilesError) throw error;
      }
    }
  }
  return findWithNode(options, config, signal, checkPermission);
}

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, fn: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await fn(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function enrichFiles(paths: string[], options: NormalizedOptions, config: FindFilesConfig): Promise<FoundFile[]> {
  const enriched = await mapWithConcurrency<string, FoundFile | undefined>(paths, config.statConcurrency, async (filePath) => {
    try {
      const fileStat = await stat(filePath);
      return {
        path: displayPath(options.scopeRoot, filePath),
        size_bytes: fileStat.size,
        modified_ms: fileStat.mtimeMs,
      } satisfies FoundFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  });
  const files = enriched.filter((file): file is FoundFile => file !== undefined);

  if (options.sort === "path_asc") {
    files.sort((a, b) => a.path.localeCompare(b.path));
  } else {
    files.sort((a, b) => b.modified_ms - a.modified_ms || a.path.localeCompare(b.path));
  }
  return files;
}

function normalizeError(error: unknown): never {
  if (error instanceof FindFilesError) throw error;
  if ((error as Error)?.name === "AbortError") throw new FindFilesError("ABORTED", "File discovery was cancelled.");
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") throw new FindFilesError("FILE_NOT_FOUND", "Search directory or candidate file no longer exists.");
  if (code === "EACCES" || code === "EPERM") throw new FindFilesError("PERMISSION_DENIED", "Permission denied during file discovery.");
  throw new FindFilesError("IO_ERROR", (error as Error)?.message || "Unexpected file discovery I/O error.");
}

export async function findFiles(input: FindFilesInput, context: FindFilesContext): Promise<FindFilesResult> {
  const config: FindFilesConfig = { ...DEFAULT_FIND_FILES_CONFIG, ...context.config };
  try {
    const normalized = normalizeInput(input, config);
    const scope = await resolveSafeScope(normalized.scopeDisplay, context.workspaceRoots);
    const options: NormalizedOptions = { ...normalized, scopeRealPath: scope.realPath, scopeRoot: scope.root };

    if (context.signal?.aborted) throw new DOMException("File discovery was cancelled.", "AbortError");
    if (context.checkPermission && !(await context.checkPermission(options.scopeRealPath))) {
      throw new FindFilesError("PERMISSION_DENIED", "Discovering files in this directory is not permitted by the current policy.");
    }

    const candidates = await findWithPreferredEngine(options, config, context.signal, context.checkPermission);
    const files = await enrichFiles(candidates.paths, options, config);
    if (files.length > options.maxResults) candidates.truncationReasons.add("MAX_RESULTS");
    const bounded = files.slice(0, options.maxResults);

    return {
      patterns: options.patterns,
      scope: options.scopeDisplay,
      engine: candidates.engine,
      sort: options.sort,
      files: bounded,
      summary: {
        candidate_paths: candidates.candidateCount,
        returned_files: bounded.length,
        truncated: candidates.truncationReasons.size > 0,
        truncation_reasons: [...candidates.truncationReasons],
      },
    };
  } catch (error) {
    return normalizeError(error);
  }
}

export function formatFindFilesForModel(result: FindFilesResult): string {
  const parts = [
    "=== FIND_FILES BEGIN ===",
    `patterns: ${JSON.stringify(result.patterns)}`,
    `scope: ${JSON.stringify(result.scope)}`,
    `engine: ${result.engine}`,
    `sort: ${result.sort}`,
    `collected_candidate_paths: ${result.summary.candidate_paths}`,
    `returned_files: ${result.summary.returned_files}`,
    `truncated: ${result.summary.truncated}`,
    "--- FILES ---",
  ];
  for (const file of result.files) parts.push(file.path);
  if (result.files.length === 0) parts.push("(no matching files)");
  if (result.summary.truncated) {
    parts.push(
      `NOTE: File discovery was bounded (${result.summary.truncation_reasons.join(", ")}). Narrow the scope/patterns or increase max_results when more paths are truly needed.`,
    );
  }
  if (result.engine === "node") parts.push("NOTE: ripgrep was unavailable or per-file permission checks required the Node fallback engine.");
  parts.push("=== FIND_FILES END ===");
  return parts.join("\n");
}

