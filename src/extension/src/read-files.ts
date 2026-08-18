import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export interface ReadFileRequest {
  path: string;
  start_line?: number;
  end_line?: number;
}

export interface ReadFilesInput {
  files: ReadFileRequest[];
}

export interface ReadFilesConfig {
  maxFilesPerCall: number;
  concurrency: number;
  maxLinesPerFile: number;
  maxBytesPerFile: number;
  maxEstimatedTokensPerFile: number;
  maxLineChars: number;
  maxTotalBytesPerCall: number;
  maxEstimatedTokensPerCall: number;
  veryLargeFileBytes: number;
  binaryProbeBytes: number;
}

export const DEFAULT_READ_FILES_CONFIG: ReadFilesConfig = {
  maxFilesPerCall: 20,
  concurrency: 8,
  maxLinesPerFile: 2_000,
  maxBytesPerFile: 64 * 1024,
  maxEstimatedTokensPerFile: 16_000,
  maxLineChars: 4_000,
  maxTotalBytesPerCall: 256 * 1024,
  maxEstimatedTokensPerCall: 50_000,
  veryLargeFileBytes: 2 * 1024 * 1024,
  binaryProbeBytes: 8 * 1024,
};

export type ReadFileErrorCode =
  | "FILE_NOT_FOUND"
  | "NOT_A_FILE"
  | "PATH_OUTSIDE_WORKSPACE"
  | "PERMISSION_DENIED"
  | "BINARY_FILE"
  | "UNSUPPORTED_ENCODING"
  | "INVALID_LINE_RANGE"
  | "FILE_TOO_LARGE_FOR_IMPLICIT_READ"
  | "ABORTED"
  | "IO_ERROR";

export interface ReadFileSuccess {
  path: string;
  status: "success";
  start_line: number;
  end_line: number | null;
  total_lines: number;
  /** True only when a per-file output budget stopped the requested read early. */
  truncated: boolean;
  /** True when the underlying file contains lines after end_line. */
  has_more: boolean;
  /** Next physical file line after end_line when has_more is true. */
  next_start_line: number | null;
  content: string;
  size_bytes: number;
  returned_bytes: number;
  estimated_tokens: number;
  version: string;
  truncated_line_numbers: number[];
  very_large_file: boolean;
}

export interface ReadFileFailure {
  path: string;
  status: "error";
  error: {
    code: ReadFileErrorCode;
    message: string;
  };
}

export interface ReadFileSkipped {
  path: string;
  status: "skipped";
  reason: "BATCH_OUTPUT_BUDGET_EXCEEDED";
  message: string;
}

export type ReadFileResult = ReadFileSuccess | ReadFileFailure | ReadFileSkipped;

export interface ReadFilesResult {
  files: ReadFileResult[];
  summary: {
    requested: number;
    succeeded: number;
    failed: number;
    skipped: number;
    truncated: number;
  };
}

export interface ReadFilesContext {
  workspaceRoots: string[];
  config?: Partial<ReadFilesConfig>;
  signal?: AbortSignal;
  checkPermission?: (realPath: string) => Promise<boolean> | boolean;
}

class ReadToolError extends Error {
  constructor(
    public readonly code: ReadFileErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function validateRange(request: ReadFileRequest): void {
  const { start_line: start, end_line: end } = request;
  if (start !== undefined && (!Number.isInteger(start) || start < 1)) {
    throw new ReadToolError("INVALID_LINE_RANGE", "start_line must be an integer greater than or equal to 1.");
  }
  if (end !== undefined && (!Number.isInteger(end) || end < 1)) {
    throw new ReadToolError("INVALID_LINE_RANGE", "end_line must be an integer greater than or equal to 1.");
  }
  if (end !== undefined && start !== undefined && end < start) {
    throw new ReadToolError("INVALID_LINE_RANGE", "end_line must be greater than or equal to start_line.");
  }
}

function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function resolveSafePath(requestedPath: string, roots: string[]): Promise<string> {
  if (roots.length === 0) {
    throw new ReadToolError("PATH_OUTSIDE_WORKSPACE", "No workspace root is configured.");
  }

  const canonicalRoots = await Promise.all(roots.map((root) => realpath(root)));
  const candidates = path.isAbsolute(requestedPath)
    ? [requestedPath]
    : canonicalRoots.map((root) => path.resolve(root, requestedPath));

  let lastNotFound: unknown;
  for (const candidate of candidates) {
    try {
      const canonicalTarget = await realpath(candidate);
      if (canonicalRoots.some((root) => isInsideRoot(root, canonicalTarget))) {
        return canonicalTarget;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        lastNotFound = error;
        continue;
      }
      if (code === "EACCES" || code === "EPERM") {
        throw new ReadToolError("PERMISSION_DENIED", "Permission denied while resolving the requested path.");
      }
      throw error;
    }
  }

  if (lastNotFound) {
    throw new ReadToolError("FILE_NOT_FOUND", "File does not exist.");
  }
  throw new ReadToolError("PATH_OUTSIDE_WORKSPACE", "Requested path resolves outside the allowed workspace roots.");
}

async function appearsBinary(filePath: string, probeBytes: number): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(probeBytes);
    const { bytesRead } = await handle.read(buffer, 0, probeBytes, 0);
    if (bytesRead === 0) return false;

    let suspicious = 0;
    for (let i = 0; i < bytesRead; i += 1) {
      const byte = buffer[i]!;
      if (byte === 0) return true;
      const isAllowedControl = byte === 9 || byte === 10 || byte === 13;
      if ((byte < 32 && !isAllowedControl) || byte === 127) suspicious += 1;
    }
    return suspicious / bytesRead > 0.1;
  } finally {
    await handle.close();
  }
}

interface StreamReadResult {
  lines: string[];
  startLine: number;
  endLine: number | null;
  totalLines: number;
  truncated: boolean;
  hasMore: boolean;
  returnedBytes: number;
  estimatedTokens: number;
  truncatedLineNumbers: number[];
  version: string;
}

async function readTextRange(
  filePath: string,
  request: ReadFileRequest,
  config: ReadFilesConfig,
  signal?: AbortSignal,
): Promise<StreamReadResult> {
  const startLine = request.start_line ?? 1;
  const requestedEnd = request.end_line ?? null;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const hash = createHash("sha256");
  const lines: string[] = [];
  const truncatedLineNumbers: number[] = [];

  let pending = "";
  let totalLines = 0;
  let returnedBytes = 0;
  let estimatedTokenCount = 0;
  let budgetTruncated = false;
  let firstDecodedChunk = true;

  const considerLine = (rawLine: string, lineNumber: number): void => {
    const inRequestedRange = lineNumber >= startLine && (requestedEnd === null || lineNumber <= requestedEnd);
    if (!inRequestedRange || budgetTruncated) return;

    let line = rawLine;
    if (line.length > config.maxLineChars) {
      line = `${line.slice(0, config.maxLineChars)} … <line truncated>`;
      truncatedLineNumbers.push(lineNumber);
    }

    const formatted = `${lineNumber}: ${line}`;
    const candidateBytes = Buffer.byteLength(formatted + "\n", "utf8");
    const candidateTokens = estimateTokens(formatted + "\n");

    const wouldExceed =
      lines.length >= config.maxLinesPerFile ||
      returnedBytes + candidateBytes > config.maxBytesPerFile ||
      estimatedTokenCount + candidateTokens > config.maxEstimatedTokensPerFile;

    if (wouldExceed) {
      budgetTruncated = true;
      return;
    }

    lines.push(formatted);
    returnedBytes += candidateBytes;
    estimatedTokenCount += candidateTokens;
  };

  const processDecodedText = (text: string): void => {
    if (text.length === 0) return;
    pending += text;
    while (true) {
      const newlineIndex = pending.indexOf("\n");
      if (newlineIndex < 0) break;
      let line = pending.slice(0, newlineIndex);
      pending = pending.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      totalLines += 1;
      considerLine(line, totalLines);
    }
  };

  try {
    const stream = createReadStream(filePath, { signal });
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buffer);
      let decoded = decoder.decode(buffer, { stream: true });
      if (firstDecodedChunk) {
        firstDecodedChunk = false;
        if (decoded.charCodeAt(0) === 0xfeff) decoded = decoded.slice(1);
      }
      processDecodedText(decoded);
    }

    const finalDecoded = decoder.decode();
    processDecodedText(finalDecoded);
  } catch (error) {
    if (error instanceof TypeError && /encoded data/i.test(error.message)) {
      throw new ReadToolError("UNSUPPORTED_ENCODING", "File is not valid UTF-8 text.");
    }
    throw error;
  }

  if (pending.length > 0) {
    if (pending.endsWith("\r")) pending = pending.slice(0, -1);
    totalLines += 1;
    considerLine(pending, totalLines);
  }

  const lastReturned = lines.length > 0
    ? Number.parseInt(lines.at(-1)!.slice(0, lines.at(-1)!.indexOf(":")), 10)
    : null;

  return {
    lines,
    startLine,
    endLine: lastReturned,
    totalLines,
    truncated: budgetTruncated,
    hasMore: lastReturned !== null && lastReturned < totalLines,
    returnedBytes,
    estimatedTokens: estimatedTokenCount,
    truncatedLineNumbers,
    version: `sha256:${hash.digest("hex")}`,
  };
}

function normalizeError(requestPath: string, error: unknown): ReadFileFailure {
  if (error instanceof ReadToolError) {
    return { path: requestPath, status: "error", error: { code: error.code, message: error.message } };
  }

  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") {
    return { path: requestPath, status: "error", error: { code: "FILE_NOT_FOUND", message: "File does not exist." } };
  }
  if (code === "EACCES" || code === "EPERM") {
    return { path: requestPath, status: "error", error: { code: "PERMISSION_DENIED", message: "Permission denied while reading file." } };
  }
  if ((error as Error)?.name === "AbortError") {
    return { path: requestPath, status: "error", error: { code: "ABORTED", message: "File read was cancelled." } };
  }
  return {
    path: requestPath,
    status: "error",
    error: { code: "IO_ERROR", message: (error as Error)?.message || "Unexpected file I/O error." },
  };
}

async function readSingleFile(
  request: ReadFileRequest,
  roots: string[],
  config: ReadFilesConfig,
  signal?: AbortSignal,
  checkPermission?: ReadFilesContext["checkPermission"],
): Promise<ReadFileResult> {
  try {
    validateRange(request);
    const safePath = await resolveSafePath(request.path, roots);

    if (checkPermission && !(await checkPermission(safePath))) {
      throw new ReadToolError("PERMISSION_DENIED", "Reading this file is not permitted by the current policy.");
    }

    if (signal?.aborted) {
      throw new DOMException("File read was cancelled.", "AbortError");
    }

    const fileStat = await stat(safePath);
    if (!fileStat.isFile()) {
      throw new ReadToolError("NOT_A_FILE", "Requested path is not a regular file.");
    }

    const hasExplicitRange = request.start_line !== undefined || request.end_line !== undefined;
    if (fileStat.size >= config.veryLargeFileBytes && !hasExplicitRange) {
      throw new ReadToolError(
        "FILE_TOO_LARGE_FOR_IMPLICIT_READ",
        `File is ${fileStat.size} bytes, which exceeds the ${config.veryLargeFileBytes}-byte implicit-read threshold. Use start_line/end_line or search/grep first.`,
      );
    }

    if (signal?.aborted) {
      throw new DOMException("File read was cancelled.", "AbortError");
    }
    if (await appearsBinary(safePath, config.binaryProbeBytes)) {
      throw new ReadToolError("BINARY_FILE", "This file appears to be binary and cannot be read as text.");
    }

    const read = await readTextRange(safePath, request, config, signal);
    return {
      path: request.path,
      status: "success",
      start_line: request.start_line ?? 1,
      end_line: read.endLine,
      total_lines: read.totalLines,
      truncated: read.truncated,
      has_more: read.hasMore,
      next_start_line: read.hasMore && read.endLine !== null ? read.endLine + 1 : null,
      content: read.lines.join("\n"),
      size_bytes: fileStat.size,
      returned_bytes: read.returnedBytes,
      estimated_tokens: read.estimatedTokens,
      version: read.version,
      truncated_line_numbers: read.truncatedLineNumbers,
      very_large_file: fileStat.size >= config.veryLargeFileBytes,
    };
  } catch (error) {
    return normalizeError(request.path, error);
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index]!, index);
    }
  });

  await Promise.all(runners);
  return results;
}

function applyBatchBudget(results: ReadFileResult[], config: ReadFilesConfig): ReadFileResult[] {
  let bytes = 0;
  let tokens = 0;

  return results.map((result) => {
    if (result.status !== "success") return result;

    if (
      bytes + result.returned_bytes > config.maxTotalBytesPerCall ||
      tokens + result.estimated_tokens > config.maxEstimatedTokensPerCall
    ) {
      return {
        path: result.path,
        status: "skipped",
        reason: "BATCH_OUTPUT_BUDGET_EXCEEDED",
        message: "This file was read but omitted because the read_files batch output budget was reached. Request it in a subsequent call if needed.",
      } satisfies ReadFileSkipped;
    }

    bytes += result.returned_bytes;
    tokens += result.estimated_tokens;
    return result;
  });
}

export async function readFiles(input: ReadFilesInput, context: ReadFilesContext): Promise<ReadFilesResult> {
  const config: ReadFilesConfig = { ...DEFAULT_READ_FILES_CONFIG, ...context.config };

  if (!Array.isArray(input.files) || input.files.length === 0) {
    throw new Error("read_files requires at least one file.");
  }
  if (input.files.length > config.maxFilesPerCall) {
    throw new Error(`TOO_MANY_FILES: at most ${config.maxFilesPerCall} files may be requested in one call.`);
  }

  const dedup = new Map<string, Promise<ReadFileResult>>();
  const rawResults = await mapWithConcurrency(input.files, config.concurrency, async (request) => {
    const key = JSON.stringify([request.path, request.start_line ?? null, request.end_line ?? null]);
    let pending = dedup.get(key);
    if (!pending) {
      pending = readSingleFile(
        request,
        context.workspaceRoots,
        config,
        context.signal,
        context.checkPermission,
      );
      dedup.set(key, pending);
    }
    return pending;
  });

  const files = applyBatchBudget(rawResults, config);
  return {
    files,
    summary: {
      requested: files.length,
      succeeded: files.filter((item) => item.status === "success").length,
      failed: files.filter((item) => item.status === "error").length,
      skipped: files.filter((item) => item.status === "skipped").length,
      truncated: files.filter((item) => item.status === "success" && item.truncated).length,
    },
  };
}

export function formatReadFilesForModel(result: ReadFilesResult): string {
  const parts: string[] = ["=== READ_FILES BEGIN ==="];

  for (const file of result.files) {
    parts.push("=== FILE BEGIN ===", `path: ${JSON.stringify(file.path)}`, `status: ${file.status}`);

    if (file.status === "error") {
      parts.push(
        `error_code: ${file.error.code}`,
        `message: ${file.error.message}`,
        "=== FILE END ===",
      );
      continue;
    }

    if (file.status === "skipped") {
      parts.push(
        `reason: ${file.reason}`,
        `message: ${file.message}`,
        "=== FILE END ===",
      );
      continue;
    }

    const lineRange = file.end_line === null ? `${file.start_line}-EOF` : `${file.start_line}-${file.end_line}`;
    parts.push(
      `lines: ${lineRange}`,
      `total_lines: ${file.total_lines}`,
      `truncated: ${file.truncated}`,
      `has_more: ${file.has_more}`,
      `next_start_line: ${file.next_start_line ?? "null"}`,
      `version: ${file.version}`,
      "--- CONTENT BEGIN ---",
      file.content,
      "--- CONTENT END ---",
    );

    if (file.truncated) {
      parts.push(
        `NOTE: Requested output was truncated by the per-file budget. Continue with start_line=${file.next_start_line ?? "?"}.`,
      );
    } else if (file.has_more) {
      parts.push(
        `NOTE: The requested range was satisfied, but the file continues after line ${file.end_line ?? "?"}. The next file line is ${file.next_start_line ?? "?"}.`,
      );
    }

    if (file.truncated_line_numbers.length > 0) {
      parts.push(`NOTE: Oversized line content was truncated at line(s): ${file.truncated_line_numbers.join(", ")}.`);
    }
    if (file.very_large_file) {
      parts.push("NOTE: This is a very large file. Prefer search/grep and targeted line ranges instead of sequentially reading it.");
    }
    parts.push("=== FILE END ===");
  }

  const { summary } = result;
  parts.push(
    "=== SUMMARY ===",
    `requested: ${summary.requested}`,
    `succeeded: ${summary.succeeded}`,
    `failed: ${summary.failed}`,
    `skipped: ${summary.skipped}`,
    `truncated: ${summary.truncated}`,
    "=== READ_FILES END ===",
  );
  return parts.join("\n");
}

// ===== Image file reading =====

export type ImageFileErrorCode =
  | "FILE_NOT_FOUND"
  | "NOT_A_FILE"
  | "PATH_OUTSIDE_WORKSPACE"
  | "PERMISSION_DENIED"
  | "UNSUPPORTED_IMAGE_TYPE"
  | "IMAGE_TOO_LARGE"
  | "IO_ERROR"
  | "ABORTED";

export interface ReadImageFileInput {
  path: string;
}

export interface ReadImageFileSuccess {
  path: string;
  absolutePath: string;
  mimeType: string;
  base64: string;
  sizeBytes: number;
}

export interface ReadImageFileResult {
  status: "success" | "error";
  path: string;
  success?: ReadImageFileSuccess;
  error?: { code: ImageFileErrorCode; message: string };
}

export const READ_IMAGE_FILE_SIZE_LIMIT = 5 * 1024 * 1024;

export const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

function lookupImageMime(filePath: string): string | undefined {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext];
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export async function readImageFile(
  input: ReadImageFileInput,
  context: { workspaceRoots: string[]; signal?: AbortSignal },
): Promise<ReadImageFileResult> {
  const requestedPath = input.path;
  if (typeof requestedPath !== "string" || requestedPath.length === 0) {
    return { status: "error", path: "", error: { code: "IO_ERROR", message: "Path must be a non-empty string." } };
  }

  let absolutePath: string;
  try {
    absolutePath = await resolveSafePath(requestedPath, context.workspaceRoots);
  } catch (err) {
    if (err instanceof ReadToolError) {
      return { status: "error", path: requestedPath, error: { code: err.code as ImageFileErrorCode, message: err.message } };
    }
    return { status: "error", path: requestedPath, error: { code: "IO_ERROR", message: err instanceof Error ? err.message : String(err) } };
  }

  if (context.signal?.aborted) {
    return { status: "error", path: requestedPath, error: { code: "ABORTED", message: "Operation aborted." } };
  }

  let stats: import("node:fs").Stats;
  try {
    stats = await stat(absolutePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { status: "error", path: requestedPath, error: { code: "FILE_NOT_FOUND", message: "File does not exist." } };
    if (code === "EACCES" || code === "EPERM") return { status: "error", path: requestedPath, error: { code: "PERMISSION_DENIED", message: "Permission denied while stat-ing the file." } };
    return { status: "error", path: requestedPath, error: { code: "IO_ERROR", message: `stat failed: ${(err as Error).message ?? String(err)}` } };
  }
  if (!stats.isFile()) {
    return { status: "error", path: requestedPath, error: { code: "NOT_A_FILE", message: "Path is not a regular file (directories, sockets and devices are not supported)." } };
  }
  if (stats.size > READ_IMAGE_FILE_SIZE_LIMIT) {
    return {
      status: "error",
      path: requestedPath,
      error: {
        code: "IMAGE_TOO_LARGE",
        message: `Image is ${formatBytes(stats.size)}, which exceeds the ${formatBytes(READ_IMAGE_FILE_SIZE_LIMIT)} hard limit. Downsample the file out-of-band and retry.`,
      },
    };
  }

  const mimeType = lookupImageMime(absolutePath);
  if (!mimeType) {
    return {
      status: "error",
      path: requestedPath,
      error: {
        code: "UNSUPPORTED_IMAGE_TYPE",
        message: `Unsupported image extension. Supported: ${Object.keys(IMAGE_MIME_BY_EXT).join(", ")}. For SVG (XML text) use read_files instead.`,
      },
    };
  }

  if (context.signal?.aborted) {
    return { status: "error", path: requestedPath, error: { code: "ABORTED", message: "Operation aborted." } };
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(absolutePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return { status: "error", path: requestedPath, error: { code: "PERMISSION_DENIED", message: "Permission denied while reading the file." } };
    return { status: "error", path: requestedPath, error: { code: "IO_ERROR", message: `readFile failed: ${(err as Error).message ?? String(err)}` } };
  }

  if (context.signal?.aborted) {
    return { status: "error", path: requestedPath, error: { code: "ABORTED", message: "Operation aborted." } };
  }

  return {
    status: "success",
    path: requestedPath,
    success: {
      path: requestedPath,
      absolutePath,
      mimeType,
      base64: buffer.toString("base64"),
      sizeBytes: buffer.byteLength,
    },
  };
}

export function formatReadImageFileForModel(result: ReadImageFileResult): string {
  if (result.status === "error") {
    return `read_image_file ${result.path}\n  ERROR ${result.error?.code ?? "UNKNOWN"}: ${result.error?.message ?? ""}`;
  }
  const s = result.success!;
  return `read_image_file ${result.path}\n  mime    ${s.mimeType}\n  size    ${formatBytes(s.sizeBytes)}\n  base64  ${formatBytes(s.base64.length)}\n  status  ok`;
}


