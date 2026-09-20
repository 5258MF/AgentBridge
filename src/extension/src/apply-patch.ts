import { createHash, randomUUID } from "node:crypto";
import { access, link, open, realpath, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { createCanonicalUnifiedDiff } from "./canonical-diff.js";

export interface ApplyPatchInput {
  patch: string;
  expected_versions?: Record<string, string>;
}

export interface ApplyPatchConfig {
  maxPatchBytes: number;
  maxOperations: number;
  maxFiles: number;
  maxFileBytes: number;
  maxDiffBytes: number;
}

export const DEFAULT_APPLY_PATCH_CONFIG: ApplyPatchConfig = {
  maxPatchBytes: 256 * 1024,
  maxOperations: 50,
  maxFiles: 20,
  maxFileBytes: 10 * 1024 * 1024,
  maxDiffBytes: 64 * 1024,
};

export type ApplyPatchErrorCode =
  | "INVALID_PATCH"
  | "TOO_MANY_OPERATIONS"
  | "TOO_MANY_FILES"
  | "PATCH_TOO_LARGE"
  | "FILE_NOT_FOUND"
  | "FILE_ALREADY_EXISTS"
  | "NOT_A_FILE"
  | "PATH_OUTSIDE_WORKSPACE"
  | "PERMISSION_DENIED"
  | "BINARY_FILE"
  | "UNSUPPORTED_ENCODING"
  | "FILE_TOO_LARGE"
  | "STALE_FILE"
  | "MISSING_EXPECTED_VERSION"
  | "PATCH_CONTEXT_NOT_FOUND"
  | "PATCH_CONTEXT_AMBIGUOUS"
  | "PATCH_CONTEXT_MISMATCH"
  | "ABORTED"
  | "ROLLBACK_FAILED"
  | "IO_ERROR";

export type PatchAction = "add" | "update" | "delete" | "move";

export interface AppliedPatchFile {
  action: PatchAction;
  path: string;
  destination_path?: string;
  old_version: string | null;
  new_version: string | null;
  additions: number;
  deletions: number;
}

export interface ApplyPatchResult {
  status: "success";
  files: AppliedPatchFile[];
  summary: {
    files_changed: number;
    additions: number;
    deletions: number;
  };
  diff: string;
  diff_truncated: boolean;
  diff_format: "unified";
  diff_source: "runtime_old_vs_new";
  commit_strategy: "staged_atomic_per_file";
  multi_file_atomic: false;
}

export interface ApplyPatchContext {
  workspaceRoots: string[];
  config?: Partial<ApplyPatchConfig>;
  signal?: AbortSignal;
  checkPermission?: (absolutePath: string) => Promise<boolean> | boolean;
}

class PatchToolError extends Error {
  constructor(
    public readonly code: ApplyPatchErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

interface ParsedHunk {
  oldLines: string[];
  newLines: string[];
  additions: number;
  deletions: number;
  endOfFile: boolean;
  /**
   * Whether the hunk's old side is marked as ending without a newline. A marker is a claim
   * about a file's last line, so it says as much about where the hunk sits as about the
   * newline: read against the file, it is only consistent with a hunk that reaches the end of
   * a file that really has no trailing newline.
   */
  oldEndsWithoutNewline: boolean;
  /** The same claim for the new side. It decides what gets written back. */
  newEndsWithoutNewline: boolean;
}

type ParsedOperation =
  | { action: "add"; path: string; lines: string[] }
  | { action: "update"; path: string; moveTo?: string; hunks: ParsedHunk[] }
  | { action: "delete"; path: string };

interface TextFileSnapshot {
  bytes: Buffer;
  text: string;
  lines: string[];
  endsWithNewline: boolean;
  eol: "\n" | "\r\n";
  bom: boolean;
  version: string;
}

interface ResolvedExistingPath {
  requestedPath: string;
  absolutePath: string;
  root: string;
  mode: number;
}

interface ResolvedNewPath {
  requestedPath: string;
  absolutePath: string;
  root: string;
}

interface MutationPlan {
  action: PatchAction;
  sourcePath?: string;
  destinationPath?: string;
  sourceDisplay: string;
  destinationDisplay?: string;
  oldBytes?: Buffer;
  newBytes?: Buffer;
  oldMode?: number;
  oldVersion: string | null;
  newVersion: string | null;
  additions: number;
  deletions: number;
}

interface StagedWrite {
  plan: MutationPlan;
  targetPath: string;
  tempPath: string;
}

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  /** Number of held or queued acquisitions; 0 means the lock can be evicted from fileLocks. */
  holders = 0;

  async acquire(): Promise<() => void> {
    this.holders++;
    let released = false;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = () => {
        if (released) return;
        released = true;
        this.holders--;
        resolve();
      };
    });
    const previous = this.tail;
    this.tail = previous.then(() => current);
    await previous;
    return release;
  }
}

const fileLocks = new Map<string, Mutex>();

function lockFor(filePath: string): Mutex {
  let mutex = fileLocks.get(filePath);
  if (!mutex) {
    mutex = new Mutex();
    fileLocks.set(filePath, mutex);
  }
  return mutex;
}

async function withFileLocks<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
  const locks: Array<{ key: string; mutex: Mutex; release: () => void }> = [];
  const keys = [...new Set(paths)].sort((a, b) => a.localeCompare(b));
  try {
    for (const key of keys) {
      const mutex = lockFor(key);
      locks.push({ key, mutex, release: await mutex.acquire() });
    }
    return await fn();
  } finally {
    for (let index = locks.length - 1; index >= 0; index -= 1) {
      const { key, mutex, release } = locks[index]!;
      release();
      // Safe to evict at zero: any concurrent acquirer increments holders synchronously
      // between lockFor() and acquire(), so no pending reference can exist here.
      if (mutex.holders === 0) fileLocks.delete(key);
    }
  }
}

function hashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function canonicalRoots(roots: string[]): Promise<string[]> {
  if (roots.length === 0) throw new PatchToolError("PATH_OUTSIDE_WORKSPACE", "No workspace root is configured.");
  return Promise.all(roots.map((root) => realpath(root)));
}

/** Resolutions shared by one applyPatch call, keyed by the path as requested. */
export interface PathResolutionCache {
  existing: Map<string, ResolvedExistingPath>;
  created: Map<string, ResolvedNewPath>;
}

export function createPathResolutionCache(): PathResolutionCache {
  return { existing: new Map(), created: new Map() };
}

/**
 * Resolves a path, reusing a result from the same applyPatch call when there is one. Locking,
 * preflight and the write phase each used to call realpath independently, so a symlink swapped
 * in between meant the lock was held on one real path while a different one was checked and
 * then written — the mutual exclusion did not actually cover the file being changed.
 */
async function resolveExistingPath(
  requestedPath: string,
  roots: string[],
  cache?: PathResolutionCache,
): Promise<ResolvedExistingPath> {
  const cached = cache?.existing.get(requestedPath);
  if (cached) return cached;
  const resolved = await resolveExistingPathOnce(requestedPath, roots);
  cache?.existing.set(requestedPath, resolved);
  return resolved;
}

async function resolveExistingPathOnce(requestedPath: string, roots: string[]): Promise<ResolvedExistingPath> {
  const canonical = await canonicalRoots(roots);
  const candidates = path.isAbsolute(requestedPath)
    ? [requestedPath]
    : canonical.map((root) => path.resolve(root, requestedPath));
  let sawMissing = false;

  for (const candidate of candidates) {
    try {
      const target = await realpath(candidate);
      const root = canonical.find((candidateRoot) => isInsideRoot(candidateRoot, target));
      if (!root) continue;
      const targetStat = await stat(target);
      if (!targetStat.isFile()) throw new PatchToolError("NOT_A_FILE", `${requestedPath} is not a regular file.`);
      return { requestedPath, absolutePath: target, root, mode: targetStat.mode };
    } catch (error) {
      if (error instanceof PatchToolError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        sawMissing = true;
        continue;
      }
      if (code === "EACCES" || code === "EPERM") {
        throw new PatchToolError("PERMISSION_DENIED", `Permission denied while resolving ${requestedPath}.`);
      }
      throw error;
    }
  }

  if (sawMissing) throw new PatchToolError("FILE_NOT_FOUND", `${requestedPath} does not exist.`);
  throw new PatchToolError("PATH_OUTSIDE_WORKSPACE", `${requestedPath} resolves outside the allowed workspace roots.`);
}

/**
 * Resolves a path that need not exist yet. The parent directory is resolved through
 * realpath, so it is exposed to the same swap: the locks and the write each resolved it
 * afresh, and a symlinked parent replaced in between left the pair guarding one directory
 * while another was written to. Results are shared within one call like the existing ones.
 */
export async function resolveNewPath(requestedPath: string, roots: string[], cache?: PathResolutionCache): Promise<ResolvedNewPath> {
  const cached = cache?.created.get(requestedPath);
  if (cached) return cached;
  const resolved = await resolveNewPathOnce(requestedPath, roots);
  cache?.created.set(requestedPath, resolved);
  return resolved;
}

async function resolveNewPathOnce(requestedPath: string, roots: string[]): Promise<ResolvedNewPath> {
  const canonical = await canonicalRoots(roots);
  const candidates = path.isAbsolute(requestedPath)
    ? [path.resolve(requestedPath)]
    : canonical.map((root) => path.resolve(root, requestedPath));

  for (const candidate of candidates) {
    const parent = path.dirname(candidate);
    try {
      const realParent = await realpath(parent);
      const root = canonical.find((candidateRoot) => isInsideRoot(candidateRoot, realParent));
      if (!root) continue;
      const absolutePath = path.join(realParent, path.basename(candidate));
      if (!isInsideRoot(root, absolutePath)) continue;
      return { requestedPath, absolutePath, root };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      if (code === "EACCES" || code === "EPERM") {
        throw new PatchToolError("PERMISSION_DENIED", `Permission denied while resolving parent directory for ${requestedPath}.`);
      }
      throw error;
    }
  }

  throw new PatchToolError(
    "PATH_OUTSIDE_WORKSPACE",
    `${requestedPath} has no existing parent directory inside the allowed workspace roots.`,
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function decodeSnapshot(bytes: Buffer, config: ApplyPatchConfig, displayPath: string): TextFileSnapshot {
  if (bytes.length > config.maxFileBytes) {
    throw new PatchToolError("FILE_TOO_LARGE", `${displayPath} is larger than the ${config.maxFileBytes}-byte patch limit.`);
  }
  if (bytes.includes(0)) throw new PatchToolError("BINARY_FILE", `${displayPath} appears to be binary.`);

  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const payload = bom ? bytes.subarray(3) : bytes;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    throw new PatchToolError("UNSUPPORTED_ENCODING", `${displayPath} is not valid UTF-8 text.`);
  }

  const eol = dominantEol(text);
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const endsWithNewline = normalized.endsWith("\n");
  const body = endsWithNewline ? normalized.slice(0, -1) : normalized;
  const lines = body.length > 0 ? body.split("\n") : normalized.length > 0 ? [""] : [];
  return {
    bytes,
    text: normalized,
    lines,
    endsWithNewline,
    eol,
    bom,
    version: hashBytes(bytes),
  };
}

function encodeText(lines: string[], endsWithNewline: boolean, eol: "\n" | "\r\n", bom: boolean): Buffer {
  let normalized = lines.join("\n");
  // An empty file has no line to terminate, so emptying a file must not leave a lone "\n"
  // behind — the result has to be zero bytes, not a blank line.
  if (endsWithNewline && lines.length > 0) normalized += "\n";
  const text = eol === "\r\n" ? normalized.replace(/\n/g, "\r\n") : normalized;
  const body = Buffer.from(text, "utf8");
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}

/**
 * Explain an Add File that landed on a file which is already there.
 *
 * An existing *empty* file is the one case a caller cannot act on from the code alone: Add is
 * refused, and Update looks like it needs context to match against. It does not — a file with
 * no lines has exactly one position, so a hunk of additions only is unambiguous there. Say so,
 * or the only way out a reader can see is deleting the file first.
 */
async function fileAlreadyExistsMessage(absolutePath: string, displayPath: string): Promise<string> {
  const base = `${displayPath} already exists.`;
  let size: number;
  try {
    const info = await stat(absolutePath);
    if (!info.isFile()) return base;
    size = info.size;
  } catch {
    return base;
  }
  if (size !== 0) return base;
  return `${base} It is empty: use Update File with a hunk of additions only (no context, no removals), which is unambiguous against a file with no lines.`;
}

/**
 * The line ending to write back. Chooses the dominant one rather than reacting to a single
 * CRLF: a mostly-LF file with one stray CRLF used to be rewritten as CRLF throughout, so a
 * one-line patch turned into a whole-file change. Genuinely mixed files are still normalized
 * to the winner — fixing that properly needs per-line endings in the snapshot.
 */
export function dominantEol(text: string): "\n" | "\r\n" {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? "\r\n" : "\n";
}

/**
 * One file, one spelling. The duplicate check, the resolution cache and the expected-version
 * lookup all compare paths as written, so "./a.txt" and "a.txt" used to be two unrelated
 * entries: a patch updating both slipped past the duplicate check and applied the second
 * edit to a snapshot taken before the first was written, and a version keyed "./a.txt" was
 * reported as missing for a file the patch called "a.txt". Folding "." and ".." away here
 * gives every spelling of one path a single form.
 *
 * The trim is kept on purpose: a model that writes `*** Add File: a.txt ` with a space at the end
 * is far more common than a file whose name really begins or ends with one. A name like that
 * cannot be addressed here at all - the space is gone before the path is looked up, and the
 * format has no quoting to put it back - so the choice is between two callers, not two bugs.
 */
function normalizePatchPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0")) throw new PatchToolError("INVALID_PATCH", "Patch paths must be non-empty.");
  const slashed = trimmed.replace(/\\/g, "/");
  // A UNC prefix is two leading slashes and posix.normalize would fold them into one, which
  // names a different Windows path, so it is put back afterwards.
  const prefix = slashed.startsWith("//") ? "//" : "";
  const rest = slashed.slice(prefix.length);
  if (!rest) return prefix || trimmed;
  return prefix + path.posix.normalize(rest);
}

/**
 * Two paths that differ only in case name one file on Windows and on a macOS volume left
 * case-insensitive, and two files on Linux. The duplicate check and the expected-version
 * lookup folded case unconditionally, so on Linux a patch that legitimately edits `A.txt`
 * and `a.txt` was refused as touching one path twice, and a version the caller keyed for
 * one of them was offered as the version of the other. Folding only where the filesystem
 * does. The platform is a parameter so both answers can be checked from any machine.
 *
 * Folding on macOS is the common case rather than the certain one: a volume can be formatted
 * case-sensitive, and then `A.txt` and `a.txt` are two files that this reads as one. The volume's
 * own property is not consulted - a patch that edits both on such a volume is refused as a
 * duplicate instead of being applied to a file the check did not know it had two of.
 */
export function patchPathKey(value: string, platform: string = process.platform): string {
  return platform === "win32" || platform === "darwin" ? value.toLowerCase() : value;
}

/**
 * True when the line after `index` still belongs to the current hunk body. A blank line
 * is an empty context line when real hunk content follows it, and a separator when the
 * hunk or the patch ends there. Writers and models routinely strip the trailing space
 * from context lines, so both shapes have to be told apart by what follows.
 */
function hunkBodyContinues(lines: readonly string[], index: number, endIndex: number): boolean {
  const next = index + 1;
  if (next >= endIndex) return false;
  const row = lines[next]!;
  // "*** End of File" terminates the hunk but the hunk still spans to the end of the file,
  // so a blank line in front of it is the file's last (empty) line rather than a separator.
  if (row === "*** End of File") return true;
  return !row.startsWith("@@") && !row.startsWith("*** ");
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/**
 * A patch is text a caller wrote, and what a caller writes is often wrapped in a code fence or
 * preceded by a blank line. Neither changes what the patch says, so both are stripped before the
 * directives are read - a fence costs a whole round trip otherwise, and the retry teaches the
 * caller nothing about the patch itself.
 *
 * Only the outermost wrapper goes: a line inside a patch cannot start with a fence, because every
 * line of a hunk body carries its own leading space, +/- or directive.
 *
 * The two ends are treated alike, which is the whole point of it: a fence is stripped from the
 * front whether or not one closes it, and from the back whether or not one opened it. A caller
 * that opens a fence and forgets to close it, or closes one it never opened, is describing the
 * same wrapper from one side; refusing the second while forgiving the first made whether a patch
 * was accepted depend on which half of the pair the caller dropped.
 */
function stripPatchWrapper(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let start = 0;
  while (start < lines.length && lines[start]!.trim().length === 0) start += 1;
  const fenced = /^(?:```|~~~)/.test(lines[start] ?? "");
  if (fenced) {
    start += 1;
    while (start < lines.length && lines[start]!.trim().length === 0) start += 1;
  }
  let end = lines.length;
  while (end > start && lines[end - 1]!.trim().length === 0) end -= 1;
  // Every closing fence is wrapper, not only the first one: a caller that closes twice has made
  // the same mistake as one that never closed at all, and the second fence used to be answered
  // as content after the patch. Trailing blank lines inside the fence are wrapper too.
  while (end > start && /^(?:```|~~~)/.test(lines[end - 1] ?? "")) {
    end -= 1;
    while (end > start && lines[end - 1]!.trim().length === 0) end -= 1;
  }
  return lines.slice(start, end);
}

function parsePatch(patchText: string, config: ApplyPatchConfig): ParsedOperation[] {
  if (Buffer.byteLength(patchText, "utf8") > config.maxPatchBytes) {
    throw new PatchToolError("PATCH_TOO_LARGE", `Patch exceeds ${config.maxPatchBytes} bytes.`);
  }

  const lines = stripPatchWrapper(patchText);
  if (lines[0] !== "*** Begin Patch") throw new PatchToolError("INVALID_PATCH", "Patch must start with '*** Begin Patch'.");
  const endIndex = lines.lastIndexOf("*** End Patch");
  if (endIndex < 1) throw new PatchToolError("INVALID_PATCH", "Patch must end with '*** End Patch'.");
  if (lines.slice(endIndex + 1).some((line) => line.trim().length > 0)) {
    throw new PatchToolError("INVALID_PATCH", "Unexpected content after '*** End Patch'.");
  }

  const operations: ParsedOperation[] = [];
  let index = 1;
  while (index < endIndex) {
    const line = lines[index]!;
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    if (line.startsWith("*** Add File: ")) {
      const filePath = normalizePatchPath(line.slice("*** Add File: ".length));
      index += 1;
      const content: string[] = [];
      while (index < endIndex && !lines[index]!.startsWith("*** ")) {
        const row = lines[index]!;
        // A blank line separates blocks here as it does everywhere else in the patch, so a
        // file written with one between its Add File sections was rejected as a content line
        // that had lost its '+'. An empty line in the file is still written as '+'.
        if (row.trim().length === 0) {
          index += 1;
          continue;
        }
        if (!row.startsWith("+")) {
          throw new PatchToolError("INVALID_PATCH", `Add File lines must start with '+': ${row}`);
        }
        content.push(row.slice(1));
        index += 1;
      }
      operations.push({ action: "add", path: filePath, lines: content });
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      const filePath = normalizePatchPath(line.slice("*** Delete File: ".length));
      operations.push({ action: "delete", path: filePath });
      index += 1;
      continue;
    }

    if (line.startsWith("*** Update File: ")) {
      const filePath = normalizePatchPath(line.slice("*** Update File: ".length));
      index += 1;
      let moveTo: string | undefined;
      if (index < endIndex && lines[index]!.startsWith("*** Move to: ")) {
        moveTo = normalizePatchPath(lines[index]!.slice("*** Move to: ".length));
        index += 1;
      }

      const hunks: ParsedHunk[] = [];
      while (index < endIndex && !lines[index]!.startsWith("*** Add File: ") && !lines[index]!.startsWith("*** Delete File: ") && !lines[index]!.startsWith("*** Update File: ")) {
        if (lines[index]!.trim().length === 0) {
          index += 1;
          continue;
        }
        if (!lines[index]!.startsWith("@@")) {
          throw new PatchToolError("INVALID_PATCH", `Expected '@@' hunk header while updating ${filePath}.`);
        }
        index += 1;
        const oldLines: string[] = [];
        const newLines: string[] = [];
        let additions = 0;
        let deletions = 0;
        let endOfFile = false;
        let lastMarker: string | null = null;
        let oldNoNewlineAt: number | null = null;
        let newNoNewlineAt: number | null = null;

        while (index < endIndex) {
          const row = lines[index]!;
          if (row.startsWith("@@") || row.startsWith("*** Add File: ") || row.startsWith("*** Delete File: ") || row.startsWith("*** Update File: ")) break;
          if (row === "*** End of File") {
            endOfFile = true;
            index += 1;
            break;
          }
          if (row.startsWith("*** Move to: ")) {
            throw new PatchToolError("INVALID_PATCH", "'*** Move to:' must appear immediately after '*** Update File:'.");
          }
          // The canonical diff marks a side whose last line has no trailing newline. The
          // marker follows the line it describes, so after a removal it belongs to the old
          // side only, after an addition to the new side, and after context to both.
          if (row === "\\ No newline at end of file") {
            if (lastMarker === null) {
              throw new PatchToolError("INVALID_PATCH", `'\\ No newline at end of file' must follow a line.`);
            }
            if (lastMarker !== "+") oldNoNewlineAt = oldLines.length - 1;
            if (lastMarker !== "-") newNoNewlineAt = newLines.length - 1;
            index += 1;
            continue;
          }
          if (row.length === 0) {
            // An empty line inside a hunk is an empty context line, provided the hunk
            // body continues after it. A blank line sitting right before the next
            // directive or the end of the patch is a separator, not file content.
            if (hunkBodyContinues(lines, index, endIndex)) {
              oldLines.push("");
              newLines.push("");
              // The line is context, so the marker has to say so: it is what a following
              // "\ No newline at end of file" is read against, and leaving it at the previous
              // line's marker attributed the marker to the wrong side - after an addition it
              // then stated a fact about the new file only, and the check that the old file
              // really ends without a newline was skipped for a file that does end with one.
              lastMarker = " ";
            }
            index += 1;
            continue;
          }
          const marker = row[0]!;
          const content = row.slice(1);
          if (marker === " ") {
            oldLines.push(content);
            newLines.push(content);
          } else if (marker === "-") {
            oldLines.push(content);
            deletions += 1;
          } else if (marker === "+") {
            newLines.push(content);
            additions += 1;
          } else {
            throw new PatchToolError("INVALID_PATCH", `Unsupported patch hunk line: ${row}`);
          }
          lastMarker = marker;
          index += 1;
        }

        // "No newline at end of file" can only be true of a file's last line. A marker that
        // landed anywhere else in the hunk is not a statement about the file at all, and used
        // to be taken as one: sitting after a context line in the middle of a hunk it silently
        // stripped the file's trailing newline, and sitting after a removal it was discarded
        // so the file kept one the patch said it would not.
        if (oldNoNewlineAt !== null && oldNoNewlineAt !== oldLines.length - 1) {
          throw new PatchToolError("INVALID_PATCH", `'\\ No newline at end of file' must follow the last line of the hunk.`);
        }
        if (newNoNewlineAt !== null && newNoNewlineAt !== newLines.length - 1) {
          throw new PatchToolError("INVALID_PATCH", `'\\ No newline at end of file' must follow the last line of the hunk.`);
        }

        // A hunk with no old lines is an insertion into an empty file. It is allowed here
        // because the parser cannot see the target: applyHunks rejects it anywhere else,
        // where an empty needle matches every position and reads back as ambiguous.
        hunks.push({
          oldLines,
          newLines,
          additions,
          deletions,
          endOfFile,
          oldEndsWithoutNewline: oldNoNewlineAt !== null,
          newEndsWithoutNewline: newNoNewlineAt !== null,
        });
      }

      // Hunks are located by context search, so two hunks looking for the same text cannot
      // both mean something: the second matches either the same original region again or the
      // text the first one just produced, and silently overwrites it. Compare the searched-for
      // text alone — a different replacement does not make the repeat meaningful, because the
      // second hunk still cannot be placed independently of the first.
      for (let i = 1; i < hunks.length; i += 1) {
        for (let j = 0; j < i; j += 1) {
          if (sameLines(hunks[i]!.oldLines, hunks[j]!.oldLines)) {
            throw new PatchToolError(
              "INVALID_PATCH",
              `Update File ${filePath} has hunk ${i + 1} searching for the same text as hunk ${j + 1}. Each hunk is located by context, so the second one cannot be placed independently; give the hunks distinct context.`,
            );
          }
        }
      }

      if (hunks.length === 0 && !moveTo) {
        throw new PatchToolError("INVALID_PATCH", `Update File ${filePath} must contain at least one hunk or a move destination.`);
      }
      operations.push({ action: "update", path: filePath, moveTo, hunks });
      continue;
    }

    throw new PatchToolError("INVALID_PATCH", `Unsupported patch directive: ${line}`);
  }

  if (operations.length === 0) throw new PatchToolError("INVALID_PATCH", "Patch contains no file operations.");
  if (operations.length > config.maxOperations) {
    throw new PatchToolError("TOO_MANY_OPERATIONS", `Patch has ${operations.length} operations; maximum is ${config.maxOperations}.`);
  }

  const touched = new Set<string>();
  for (const operation of operations) {
    const source = patchPathKey(operation.path);
    if (touched.has(source)) throw new PatchToolError("INVALID_PATCH", `Patch touches ${operation.path} more than once.`);
    touched.add(source);
    if (operation.action === "update" && operation.moveTo) {
      const destination = patchPathKey(operation.moveTo);
      if (touched.has(destination)) throw new PatchToolError("INVALID_PATCH", `Patch destination ${operation.moveTo} is touched more than once.`);
      touched.add(destination);
    }
  }
  if (touched.size > config.maxFiles) {
    throw new PatchToolError("TOO_MANY_FILES", `Patch touches ${touched.size} paths; maximum is ${config.maxFiles}.`);
  }
  return operations;
}

/**
 * Where a hunk's searched-for lines sit in the file: a position, -1 for nowhere, -2 for more
 * than one place. Ambiguity is settled by the second candidate, so the scan stops there.
 */
export function findSequence(lines: string[], needle: string[], requireEndOfFile: boolean): number {
  // Only the first candidate matters, and only up to the second: the answer is -1 when there
  // is none, -2 when there are several, and a position when there is exactly one. Collecting
  // every position was a full scan of the file for a needle that is almost always short and
  // unique, and an empty needle - which the parser rejects later but this function still sees -
  // built one candidate per line before anything looked at them.
  let found = -1;
  for (let start = 0; start + needle.length <= lines.length; start += 1) {
    if (requireEndOfFile && start + needle.length !== lines.length) continue;
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (lines[start + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    if (found >= 0) return -2;
    found = start;
  }
  return found;
}

function applyHunks(
  filePath: string,
  snapshot: TextFileSnapshot,
  hunks: ParsedHunk[],
): { lines: string[]; additions: number; deletions: number; endsWithNewline: boolean } {
  const lines = [...snapshot.lines];
  let additions = 0;
  let deletions = 0;
  // Only a hunk that reaches the current end of the file decides the trailing newline; a hunk
  // in the middle carries the parser's default of true and says nothing about the last line.
  // Without this every ordinary edit forced a trailing newline onto files that had none.
  let endsWithNewline = snapshot.endsWithNewline;

  for (const hunk of hunks) {
    const start = findSequence(lines, hunk.oldLines, hunk.endOfFile);
    if (start === -1) {
      throw new PatchToolError(
        "PATCH_CONTEXT_NOT_FOUND",
        `Could not find the exact hunk context in ${filePath}. Re-read the file and regenerate the patch against the current content.`,
      );
    }
    if (start === -2) {
      throw new PatchToolError(
        "PATCH_CONTEXT_AMBIGUOUS",
        `Hunk context matches multiple locations in ${filePath}. Include more unchanged context around the edit.`,
      );
    }
    const reachesEnd = start + hunk.oldLines.length === lines.length;
    // The old side's marker is a claim about the file as it stands now, so it has to be checked
    // rather than believed: a patch written against a different trailing newline is a patch
    // written against a different file, and applying it quietly wrote a newline the patch said
    // was not there - or dropped one it said was.
    // Only an explicit marker is checked. A patch that says nothing about the trailing newline
    // makes no claim to contradict — the common case is a model that never heard of the marker,
    // and refusing those would break every edit to a file that happens to end without one.
    if (hunk.oldEndsWithoutNewline && !reachesEnd) {
      throw new PatchToolError(
        "PATCH_CONTEXT_MISMATCH",
        `A hunk of ${filePath} marks the end of the file as having no trailing newline, but it does not reach the end of the file.`,
      );
    }
    if (hunk.oldEndsWithoutNewline && reachesEnd && endsWithNewline) {
      throw new PatchToolError(
        "PATCH_CONTEXT_MISMATCH",
        `A hunk of ${filePath} marks the end of the file as having no trailing newline, but the file ends with one. Re-read the file and regenerate the patch.`,
      );
    }
    lines.splice(start, hunk.oldLines.length, ...hunk.newLines);
    additions += hunk.additions;
    deletions += hunk.deletions;
    if (reachesEnd) endsWithNewline = !hunk.newEndsWithoutNewline;
  }
  return { lines, additions, deletions, endsWithNewline };
}

function normalizedExpectedVersions(input: ApplyPatchInput): Map<string, string> {
  const map = new Map<string, string>();
  for (const [filePath, version] of Object.entries(input.expected_versions ?? {})) {
    if (typeof version !== "string" || !version.startsWith("sha256:")) {
      throw new PatchToolError("INVALID_PATCH", `expected_versions[${filePath}] must be a sha256:... version string.`);
    }
    // Same normalisation as patch paths, so "./a.txt", "a\b.txt" and stray whitespace resolve
    // to the entry callers wrote rather than reporting the version as missing.
    map.set(patchPathKey(normalizePatchPath(filePath)), version);
  }
  return map;
}

async function loadSnapshot(filePath: string, displayPath: string, config: ApplyPatchConfig): Promise<TextFileSnapshot> {
  return decodeSnapshot(await readFile(filePath), config, displayPath);
}

async function collectLockPaths(
  operations: ParsedOperation[],
  context: ApplyPatchContext,
  resolved: PathResolutionCache,
): Promise<string[]> {
  const lockPaths: string[] = [];
  for (const operation of operations) {
    if (context.signal?.aborted) throw new DOMException("Patch application was cancelled.", "AbortError");

    if (operation.action === "add") {
      const destination = await resolveNewPath(operation.path, context.workspaceRoots, resolved);
      lockPaths.push(destination.absolutePath);
      continue;
    }

    const source = await resolveExistingPath(operation.path, context.workspaceRoots, resolved);
    lockPaths.push(source.absolutePath);
    if (operation.action === "update" && operation.moveTo) {
      const destination = await resolveNewPath(operation.moveTo, context.workspaceRoots, resolved);
      lockPaths.push(destination.absolutePath);
    }
  }
  return lockPaths;
}

async function preflight(
  operations: ParsedOperation[],
  input: ApplyPatchInput,
  context: ApplyPatchContext,
  config: ApplyPatchConfig,
  resolved: PathResolutionCache,
): Promise<MutationPlan[]> {
  const expected = normalizedExpectedVersions(input);
  const plans: MutationPlan[] = [];

  for (const operation of operations) {
    if (context.signal?.aborted) throw new DOMException("Patch application was cancelled.", "AbortError");

    if (operation.action === "add") {
      const destination = await resolveNewPath(operation.path, context.workspaceRoots, resolved);
      if (context.checkPermission && !(await context.checkPermission(destination.absolutePath))) {
        throw new PatchToolError("PERMISSION_DENIED", `Creating ${operation.path} is not permitted by the current policy.`);
      }
      if (await pathExists(destination.absolutePath)) {
        throw new PatchToolError("FILE_ALREADY_EXISTS", await fileAlreadyExistsMessage(destination.absolutePath, operation.path));
      }
      const newBytes = encodeText(operation.lines, operation.lines.length > 0, "\n", false);
      plans.push({
        action: "add",
        destinationPath: destination.absolutePath,
        sourceDisplay: operation.path,
        oldVersion: null,
        newVersion: hashBytes(newBytes),
        newBytes,
        additions: operation.lines.length,
        deletions: 0,
      });
      continue;
    }

    const source = await resolveExistingPath(operation.path, context.workspaceRoots, resolved);
    if (context.checkPermission && !(await context.checkPermission(source.absolutePath))) {
      throw new PatchToolError("PERMISSION_DENIED", `Modifying ${operation.path} is not permitted by the current policy.`);
    }
    const snapshot = await loadSnapshot(source.absolutePath, operation.path, config);
    const expectedVersion = expected.get(patchPathKey(operation.path));
    // Editing or deleting an existing file without the version read_files reported is the
    // one way a patch can silently overwrite content the agent never saw, so the version
    // is mandatory here. Additions are exempt: a new file has no previous version.
    if (!expectedVersion) {
      throw new PatchToolError(
        "MISSING_EXPECTED_VERSION",
        `${operation.path} needs an expected version before it can be ${operation.action === "delete" ? "deleted" : "modified"}. Pass expected_versions["${operation.path}"] with the sha256:... version read_files returned for it.`,
      );
    }
    if (snapshot.version !== expectedVersion) {
      throw new PatchToolError(
        "STALE_FILE",
        `${operation.path} changed since it was read. Expected ${expectedVersion}, current ${snapshot.version}. Re-read before patching.`,
      );
    }

    if (operation.action === "delete") {
      plans.push({
        action: "delete",
        sourcePath: source.absolutePath,
        sourceDisplay: operation.path,
        oldBytes: snapshot.bytes,
        oldMode: source.mode,
        oldVersion: snapshot.version,
        newVersion: null,
        additions: 0,
        deletions: snapshot.lines.length,
      });
      continue;
    }

    const applied = applyHunks(operation.path, snapshot, operation.hunks);
    // A "\ No newline" marker on the hunk that reaches the end of the file decides the new
    // file's trailing newline; anywhere else the file keeps whatever it had. Without this a
    // patch could never add or remove the final newline, so a diff handed back by apply_patch
    // would not feed back in — the same change would silently do nothing the second time.
    const newBytes = encodeText(applied.lines, applied.endsWithNewline, snapshot.eol, snapshot.bom);
    if (operation.moveTo) {
      const destination = await resolveNewPath(operation.moveTo, context.workspaceRoots, resolved);
      if (context.checkPermission && !(await context.checkPermission(destination.absolutePath))) {
        throw new PatchToolError("PERMISSION_DENIED", `Moving to ${operation.moveTo} is not permitted by the current policy.`);
      }
      if (await pathExists(destination.absolutePath)) {
        throw new PatchToolError("FILE_ALREADY_EXISTS", `${operation.moveTo} already exists.`);
      }
      plans.push({
        action: "move",
        sourcePath: source.absolutePath,
        destinationPath: destination.absolutePath,
        sourceDisplay: operation.path,
        destinationDisplay: operation.moveTo,
        oldBytes: snapshot.bytes,
        newBytes,
        oldMode: source.mode,
        oldVersion: snapshot.version,
        newVersion: hashBytes(newBytes),
        additions: applied.additions,
        deletions: applied.deletions,
      });
    } else {
      plans.push({
        action: "update",
        sourcePath: source.absolutePath,
        sourceDisplay: operation.path,
        oldBytes: snapshot.bytes,
        newBytes,
        oldMode: source.mode,
        oldVersion: snapshot.version,
        newVersion: hashBytes(newBytes),
        additions: applied.additions,
        deletions: applied.deletions,
      });
    }
  }

  return plans;
}

async function assertSourceUnchanged(plan: MutationPlan): Promise<void> {
  if (!plan.sourcePath || !plan.oldVersion) return;
  const current = await readFile(plan.sourcePath);
  const currentVersion = hashBytes(current);
  if (currentVersion !== plan.oldVersion) {
    throw new PatchToolError(
      "STALE_FILE",
      `${plan.sourceDisplay} changed during patch preflight. Expected ${plan.oldVersion}, current ${currentVersion}. Re-read and retry.`,
    );
  }
}

function tempPathFor(targetPath: string): string {
  return path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.agentbridge-${process.pid}-${randomUUID()}.tmp`,
  );
}

async function stageBytes(targetPath: string, bytes: Buffer, mode?: number): Promise<string> {
  const tempPath = tempPathFor(targetPath);
  const handle = await open(tempPath, "wx", mode === undefined ? 0o666 : mode & 0o777);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return tempPath;
}

async function stagePlans(plans: MutationPlan[]): Promise<StagedWrite[]> {
  const staged: StagedWrite[] = [];
  try {
    for (const plan of plans) {
      if (!plan.newBytes) continue;
      const targetPath = plan.action === "update" ? plan.sourcePath! : plan.destinationPath!;
      const tempPath = await stageBytes(targetPath, plan.newBytes, plan.oldMode);
      staged.push({ plan, targetPath, tempPath });
    }
    return staged;
  } catch (error) {
    await Promise.all(staged.map((entry) => unlink(entry.tempPath).catch(() => undefined)));
    throw error;
  }
}

function stagedFor(plan: MutationPlan, staged: StagedWrite[]): StagedWrite {
  const entry = staged.find((candidate) => candidate.plan === plan);
  if (!entry) throw new PatchToolError("IO_ERROR", `Missing staged content for ${plan.sourceDisplay}.`);
  return entry;
}

async function installNewFromStage(entry: StagedWrite): Promise<void> {
  await link(entry.tempPath, entry.targetPath);
  await unlink(entry.tempPath);
}

async function replaceExistingFromStage(entry: StagedWrite): Promise<void> {
  await rename(entry.tempPath, entry.targetPath);
}

async function restoreExistingFile(filePath: string, bytes: Buffer, mode?: number): Promise<void> {
  const tempPath = await stageBytes(filePath, bytes, mode);
  try {
    await rename(tempPath, filePath);
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

async function restoreMissingFile(filePath: string, bytes: Buffer, mode?: number): Promise<void> {
  const tempPath = await stageBytes(filePath, bytes, mode);
  try {
    await link(tempPath, filePath);
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

async function rollbackPlans(completed: MutationPlan[]): Promise<void> {
  const failures: string[] = [];
  for (let index = completed.length - 1; index >= 0; index -= 1) {
    const plan = completed[index]!;
    try {
      if (plan.action === "update") {
        await restoreExistingFile(plan.sourcePath!, plan.oldBytes!, plan.oldMode);
      } else if (plan.action === "add") {
        if (await pathExists(plan.destinationPath!)) await unlink(plan.destinationPath!);
      } else if (plan.action === "delete") {
        await restoreMissingFile(plan.sourcePath!, plan.oldBytes!, plan.oldMode);
      } else {
        if (await pathExists(plan.destinationPath!)) await unlink(plan.destinationPath!);
        if (!(await pathExists(plan.sourcePath!))) {
          await restoreMissingFile(plan.sourcePath!, plan.oldBytes!, plan.oldMode);
        }
      }
    } catch (error) {
      failures.push(`${plan.sourceDisplay}: ${(error as Error).message}`);
    }
  }
  if (failures.length > 0) {
    throw new PatchToolError("ROLLBACK_FAILED", `Patch failed and rollback was incomplete: ${failures.join("; ")}`);
  }
}

async function commitPlans(plans: MutationPlan[], signal?: AbortSignal): Promise<void> {
  // Stage every new file image before mutating any workspace path. Updates are then installed with an
  // atomic same-directory rename; creates/move destinations use a no-overwrite hard-link install.
  const staged = await stagePlans(plans);
  const completed: MutationPlan[] = [];
  try {
    for (const plan of plans) {
      if (signal?.aborted) throw new DOMException("Patch application was cancelled.", "AbortError");
      if (plan.action === "update") {
        await assertSourceUnchanged(plan);
        await replaceExistingFromStage(stagedFor(plan, staged));
      } else if (plan.action === "add") {
        await installNewFromStage(stagedFor(plan, staged));
      } else if (plan.action === "delete") {
        await assertSourceUnchanged(plan);
        await unlink(plan.sourcePath!);
      } else {
        await assertSourceUnchanged(plan);
        const entry = stagedFor(plan, staged);
        await installNewFromStage(entry);
        try {
          await unlink(plan.sourcePath!);
        } catch (error) {
          await unlink(plan.destinationPath!).catch(() => undefined);
          throw error;
        }
      }
      completed.push(plan);
    }
  } catch (error) {
    try {
      await rollbackPlans(completed);
    } catch (rollbackError) {
      throw rollbackError;
    }
    throw error;
  } finally {
    await Promise.all(staged.map((entry) => unlink(entry.tempPath).catch(() => undefined)));
  }
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return { text: `${text.slice(0, low)}\n... <diff truncated>`, truncated: true };
}

function normalizeError(error: unknown): never {
  if (error instanceof PatchToolError) throw error;
  if ((error as Error)?.name === "AbortError") throw new PatchToolError("ABORTED", "Patch application was cancelled.");
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") throw new PatchToolError("FILE_NOT_FOUND", "A patch target disappeared during application.");
  if (code === "EACCES" || code === "EPERM") throw new PatchToolError("PERMISSION_DENIED", "Permission denied while applying patch.");
  throw new PatchToolError("IO_ERROR", (error as Error)?.message || "Unexpected patch I/O error.");
}

export async function applyPatch(input: ApplyPatchInput, context: ApplyPatchContext): Promise<ApplyPatchResult> {
  const config: ApplyPatchConfig = { ...DEFAULT_APPLY_PATCH_CONFIG, ...context.config };
  try {
    if (!input || typeof input.patch !== "string" || input.patch.length === 0) {
      throw new PatchToolError("INVALID_PATCH", "patch must be a non-empty string.");
    }
    const operations = parsePatch(input.patch, config);
    // One resolution set for the whole call: locking, preflight and the write phase must all
    // act on the same real path, or the lock does not cover the file being changed.
    const resolved = createPathResolutionCache();
    const lockPaths = await collectLockPaths(operations, context, resolved);

    return await withFileLocks(lockPaths, async () => {
      // Re-run all validation while locks are held. This protects concurrent AgentBridge writers and makes
      // expected_version/context checks authoritative immediately before mutation.
      const plans = await preflight(operations, input, context, config, resolved);
      const canonicalDiff = createCanonicalUnifiedDiff(
        plans.map((plan) => ({
          action: plan.action,
          old_path: plan.action === "add" ? undefined : plan.sourceDisplay,
          new_path: plan.action === "delete" ? undefined : plan.destinationDisplay ?? plan.sourceDisplay,
          old_bytes: plan.oldBytes,
          new_bytes: plan.newBytes,
        })),
      );
      await commitPlans(plans, context.signal);
      const files: AppliedPatchFile[] = plans.map((plan) => ({
        action: plan.action,
        path: plan.sourceDisplay,
        ...(plan.destinationDisplay ? { destination_path: plan.destinationDisplay } : {}),
        old_version: plan.oldVersion,
        new_version: plan.newVersion,
        additions: plan.additions,
        deletions: plan.deletions,
      }));
      const diff = truncateUtf8(canonicalDiff, config.maxDiffBytes);
      return {
        status: "success",
        files,
        summary: {
          files_changed: files.length,
          additions: files.reduce((sum, file) => sum + file.additions, 0),
          deletions: files.reduce((sum, file) => sum + file.deletions, 0),
        },
        diff: diff.text,
        diff_truncated: diff.truncated,
        diff_format: "unified",
        diff_source: "runtime_old_vs_new",
        commit_strategy: "staged_atomic_per_file",
        multi_file_atomic: false,
      };
    });
  } catch (error) {
    return normalizeError(error);
  }
}

export function formatApplyPatchForModel(result: ApplyPatchResult): string {
  const parts = [
    "=== APPLY_PATCH BEGIN ===",
    `status: ${result.status}`,
    `files_changed: ${result.summary.files_changed}`,
    `additions: ${result.summary.additions}`,
    `deletions: ${result.summary.deletions}`,
    `diff_format: ${result.diff_format}`,
    `diff_source: ${result.diff_source}`,
    `commit_strategy: ${result.commit_strategy}`,
    `multi_file_atomic: ${result.multi_file_atomic}`,
  ];
  for (const file of result.files) {
    parts.push(
      "--- FILE ---",
      `action: ${file.action}`,
      `path: ${JSON.stringify(file.path)}`,
      ...(file.destination_path ? [`destination_path: ${JSON.stringify(file.destination_path)}`] : []),
      `old_version: ${file.old_version ?? "null"}`,
      `new_version: ${file.new_version ?? "null"}`,
      `additions: ${file.additions}`,
      `deletions: ${file.deletions}`,
    );
  }
  parts.push("--- CANONICAL APPLIED DIFF ---", result.diff);
  if (result.diff_truncated) parts.push("NOTE: Diff display was truncated; the patch itself was applied in full.");
  parts.push("=== APPLY_PATCH END ===");
  return parts.join("\n");
}

