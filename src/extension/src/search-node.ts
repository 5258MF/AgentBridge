// The bounded Node search loop. Literal searches run in the extension host;
// regular-expression searches run this same loop only in search-regex-worker.js.
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { EngineResult, NormalizedOptions, SearchFilesConfig, SearchFilesContext } from "./search-files.js";

export interface NodeSearchCandidates {
  files: string[];
  filesScanned: number;
  hitLimit: boolean;
}

export class NodeSearchPatternError extends Error {
  readonly code = "INVALID_PATTERN";
}

function compileMatcher(options: NormalizedOptions): (line: string) => { matched: boolean; column: number } {
  const sensitive = options.caseSensitive ?? /[A-Z]/.test(options.pattern);
  if (options.isRegex) {
    let regex: RegExp;
    try {
      regex = new RegExp(options.pattern, sensitive ? "" : "i");
    } catch (error) {
      throw new NodeSearchPatternError(`Invalid regular expression: ${(error as Error).message}`);
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

export async function scanNodeSearchFiles(
  candidates: NodeSearchCandidates,
  options: NormalizedOptions,
  config: SearchFilesConfig,
  signal?: AbortSignal,
  checkPermission?: SearchFilesContext["checkPermission"],
): Promise<EngineResult> {
  const matcher = compileMatcher(options);
  const matches: EngineResult["matches"] = [];
  const perFile = new Map<string, number>();
  const truncationReasons: EngineResult["truncationReasons"] = new Set();
  if (candidates.hitLimit) truncationReasons.add("MAX_FILES_SCANNED");
  let skippedBinaryFiles = 0;
  let skippedLargeFiles = 0;

  outer: for (const filePath of candidates.files) {
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
    const relative = path.relative(options.scopeRoot, filePath);
    const display = (relative || path.basename(filePath)).split(path.sep).join("/");
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
      matches.push({ absolutePath: filePath, displayPath: display, line: index + 1, column: found.column, text: lines[index]! });
    }
  }

  return {
    engine: "node",
    matches,
    filesScanned: candidates.filesScanned,
    skippedBinaryFiles,
    skippedLargeFiles,
    truncationReasons,
  };
}
