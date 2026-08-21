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
  | "PATCH_CONTEXT_NOT_FOUND"
  | "PATCH_CONTEXT_AMBIGUOUS"
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

async function resolveExistingPath(requestedPath: string, roots: string[]): Promise<ResolvedExistingPath> {
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

async function resolveNewPath(requestedPath: string, roots: string[]): Promise<ResolvedNewPath> {
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

  const eol: "\n" | "\r\n" = text.includes("\r\n") ? "\r\n" : "\n";
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
  if (endsWithNewline) normalized += "\n";
  const text = eol === "\r\n" ? normalized.replace(/\n/g, "\r\n") : normalized;
  const body = Buffer.from(text, "utf8");
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}

function normalizePatchPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0")) throw new PatchToolError("INVALID_PATCH", "Patch paths must be non-empty.");
  return trimmed.replace(/\\/g, "/");
}

function parsePatch(patchText: string, config: ApplyPatchConfig): ParsedOperation[] {
  if (Buffer.byteLength(patchText, "utf8") > config.maxPatchBytes) {
    throw new PatchToolError("PATCH_TOO_LARGE", `Patch exceeds ${config.maxPatchBytes} bytes.`);
  }

  const normalized = patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
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
          if (row.length === 0) {
            throw new PatchToolError("INVALID_PATCH", "Patch hunk lines must start with a space, '+' or '-'.");
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
          index += 1;
        }

        if (oldLines.length === 0) {
          throw new PatchToolError(
            "INVALID_PATCH",
            `Update hunk for ${filePath} has no old/context lines. Include exact surrounding context so the edit can be located safely.`,
          );
        }
        hunks.push({ oldLines, newLines, additions, deletions, endOfFile });
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
    const source = operation.path.toLocaleLowerCase();
    if (touched.has(source)) throw new PatchToolError("INVALID_PATCH", `Patch touches ${operation.path} more than once.`);
    touched.add(source);
    if (operation.action === "update" && operation.moveTo) {
      const destination = operation.moveTo.toLocaleLowerCase();
      if (touched.has(destination)) throw new PatchToolError("INVALID_PATCH", `Patch destination ${operation.moveTo} is touched more than once.`);
      touched.add(destination);
    }
  }
  if (touched.size > config.maxFiles) {
    throw new PatchToolError("TOO_MANY_FILES", `Patch touches ${touched.size} paths; maximum is ${config.maxFiles}.`);
  }
  return operations;
}

function findSequence(lines: string[], needle: string[], requireEndOfFile: boolean): number {
  const candidates: number[] = [];
  for (let start = 0; start + needle.length <= lines.length; start += 1) {
    if (requireEndOfFile && start + needle.length !== lines.length) continue;
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (lines[start + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) candidates.push(start);
  }
  if (candidates.length === 0) return -1;
  if (candidates.length > 1) return -2;
  return candidates[0]!;
}

function applyHunks(filePath: string, snapshot: TextFileSnapshot, hunks: ParsedHunk[]): { lines: string[]; additions: number; deletions: number } {
  const lines = [...snapshot.lines];
  let additions = 0;
  let deletions = 0;

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
    lines.splice(start, hunk.oldLines.length, ...hunk.newLines);
    additions += hunk.additions;
    deletions += hunk.deletions;
  }
  return { lines, additions, deletions };
}

function normalizedExpectedVersions(input: ApplyPatchInput): Map<string, string> {
  const map = new Map<string, string>();
  for (const [filePath, version] of Object.entries(input.expected_versions ?? {})) {
    if (typeof version !== "string" || !version.startsWith("sha256:")) {
      throw new PatchToolError("INVALID_PATCH", `expected_versions[${filePath}] must be a sha256:... version string.`);
    }
    map.set(filePath.replace(/\\/g, "/").toLocaleLowerCase(), version);
  }
  return map;
}

async function loadSnapshot(filePath: string, displayPath: string, config: ApplyPatchConfig): Promise<TextFileSnapshot> {
  return decodeSnapshot(await readFile(filePath), config, displayPath);
}

async function preflight(
  operations: ParsedOperation[],
  input: ApplyPatchInput,
  context: ApplyPatchContext,
  config: ApplyPatchConfig,
): Promise<{ plans: MutationPlan[]; lockPaths: string[] }> {
  const expected = normalizedExpectedVersions(input);
  const plans: MutationPlan[] = [];
  const lockPaths: string[] = [];

  for (const operation of operations) {
    if (context.signal?.aborted) throw new DOMException("Patch application was cancelled.", "AbortError");

    if (operation.action === "add") {
      const destination = await resolveNewPath(operation.path, context.workspaceRoots);
      lockPaths.push(destination.absolutePath);
      if (context.checkPermission && !(await context.checkPermission(destination.absolutePath))) {
        throw new PatchToolError("PERMISSION_DENIED", `Creating ${operation.path} is not permitted by the current policy.`);
      }
      if (await pathExists(destination.absolutePath)) {
        throw new PatchToolError("FILE_ALREADY_EXISTS", `${operation.path} already exists.`);
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

    const source = await resolveExistingPath(operation.path, context.workspaceRoots);
    lockPaths.push(source.absolutePath);
    if (context.checkPermission && !(await context.checkPermission(source.absolutePath))) {
      throw new PatchToolError("PERMISSION_DENIED", `Modifying ${operation.path} is not permitted by the current policy.`);
    }
    const snapshot = await loadSnapshot(source.absolutePath, operation.path, config);
    const expectedVersion = expected.get(operation.path.toLocaleLowerCase());
    if (expectedVersion && snapshot.version !== expectedVersion) {
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
    const newBytes = encodeText(applied.lines, snapshot.endsWithNewline, snapshot.eol, snapshot.bom);
    if (operation.moveTo) {
      const destination = await resolveNewPath(operation.moveTo, context.workspaceRoots);
      lockPaths.push(destination.absolutePath);
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

  return { plans, lockPaths };
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
    const initial = await preflight(operations, input, context, config);

    return await withFileLocks(initial.lockPaths, async () => {
      // Re-run all validation while locks are held. This protects concurrent AgentBridge writers and makes
      // expected_version/context checks authoritative immediately before mutation.
      const locked = await preflight(operations, input, context, config);
      const canonicalDiff = createCanonicalUnifiedDiff(
        locked.plans.map((plan) => ({
          action: plan.action,
          old_path: plan.action === "add" ? undefined : plan.sourceDisplay,
          new_path: plan.action === "delete" ? undefined : plan.destinationDisplay ?? plan.sourceDisplay,
          old_bytes: plan.oldBytes,
          new_bytes: plan.newBytes,
        })),
      );
      await commitPlans(locked.plans, context.signal);
      const files: AppliedPatchFile[] = locked.plans.map((plan) => ({
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

