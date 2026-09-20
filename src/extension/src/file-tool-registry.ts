import { applyPatch, formatApplyPatchForModel, type ApplyPatchInput } from "./apply-patch.js";
import { findFiles, formatFindFilesForModel, type FindFilesInput } from "./find-files.js";
import { formatReadFilesForModel, readFiles, type ReadFilesInput } from "./read-files.js";
import { formatReadImageFileForModel, readImageFile, type ReadImageFileInput } from "./read-files.js";
import { formatSearchFilesForModel, searchFiles, type SearchFilesInput } from "./search-files.js";

export const APPLY_PATCH_TOOL = {
  name: "apply_patch",
  description: [
    "Apply a structured multi-file patch directly inside the current workspace.",
    "Use this as the primary workspace edit tool. Prefer one apply_patch call containing related file edits instead of many small write calls.",
    "Patch syntax starts with '*** Begin Patch' and ends with '*** End Patch'. Supported directives are '*** Update File:', optional immediate '*** Move to:', '*** Add File:', and '*** Delete File:'. Update hunks start with '@@' and use unchanged lines prefixed by one space, removed lines prefixed by '-', and added lines prefixed by '+'.",
    "Update hunk old/context lines must match exactly and uniquely. If context is stale or ambiguous the patch fails without partial application; re-read the file and regenerate the patch.",
    "Every file you update or delete must carry an expected_versions entry holding the sha256 version read_files returned for it: a mismatch returns STALE_FILE and a missing entry returns MISSING_EXPECTED_VERSION, so an edit is never applied over content you have not read. Files you only add need no version.",
    "Returns the actual unified diff produced by the applied workspace changes.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      patch: {
        type: "string",
        minLength: 1,
        description: "Structured patch text using *** Begin Patch / *** End Patch. Sections are *** Add File: <path>, *** Update File: <path> (with @@ hunks) and *** Delete File: <path>; a rename is an *** Update File: <path> followed on the next line by *** Move to: <new path>, not a directive of its own. A path may appear once.",
      },
      expected_versions: {
        type: "object",
        additionalProperties: { type: "string", pattern: "^sha256:" },
        description: "Map from file path to the sha256:... version read_files returned. Required for every '*** Update File:' and '*** Delete File:' target; omitted for files the patch only adds.",
      },
    },
    required: ["patch"],
    additionalProperties: false,
  },
} as const;

export const READ_FILES_TOOL = {
  name: "read_files",
  description: [
    "Read one or more UTF-8 text files from the current workspace.",
    "Batch independent files together in one call.",
    "For small files, omit start_line/end_line to read the complete file.",
    "For large files, results may be truncated and include next_start_line.",
    "A satisfied explicit range can still report has_more=true when the file continues afterward.",
    "Use 1-based inclusive start_line/end_line for targeted reads.",
    "Files at or above the very-large-file threshold require an explicit range. Smaller files may still be automatically truncated by per-file line/byte/token budgets; prefer search_files before targeted reads when location is unknown.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      files: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        description: "Files to read. Independent files should be requested together.",
        items: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "File path relative to the workspace root.",
            },
            start_line: {
              type: "integer",
              minimum: 1,
              description: "Optional 1-based inclusive first line.",
            },
            end_line: {
              type: "integer",
              minimum: 1,
              description: "Optional 1-based inclusive last line.",
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    required: ["files"],
    additionalProperties: false,
  },
} as const;

export const READ_IMAGE_FILE_TOOL = {
  name: "read_image_file",
  description: [
    "Read a single raster image file (PNG/JPEG/GIF/WebP/BMP) from the workspace and return an MCP image content block containing the base64-encoded file data.",
    "Use this to inspect or reason about screenshots, charts, UI designs, exported diagrams, error dialogs, or other raster images.",
    "Supported MIME types: image/png, image/jpeg, image/gif, image/webp, image/bmp.",
    "SVG is XML text — use read_files for SVG, not this tool.",
    `Hard file-size limit: 5 MB by default (the agentbridge.files.imageMaxBytes setting). Larger images must be reduced before reading.`,
    "Returns a short text summary (path, MIME, size) followed by one image content item for clients that support image input.",
    "Paths are workspace-relative; absolute paths are accepted only when they resolve inside the workspace.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        minLength: 1,
        description: "Workspace-relative image file path (or absolute path that resolves inside the workspace).",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
} as const;

export const FIND_FILES_TOOL = {
  name: "find_files",
  description: [
    "Find files by path/name glob patterns inside the current workspace; this does not search file contents.",
    "Use find_files when you know a filename, extension, or path shape but not the exact path. Use search_files when you need to search file contents.",
    "Batch independent file patterns together in the patterns array instead of making separate calls.",
    "Patterns are evaluated within path, which defaults to the workspace root. Results are files only, never directories.",
    "By default matching is case-insensitive, ignored/common generated directories and hidden paths are skipped, and results are sorted by modification time newest first.",
    "Use exclude for additional path globs, include_hidden/no_ignore only when those files are intentionally needed, and sort='path_asc' when deterministic path order matters.",
    "Every result names the filters that were in force, because ignored and hidden paths are skipped by default. An empty result is not proof the file is absent, and neither is a non-empty one: retry with no_ignore=true and/or include_hidden=true before writing the file from scratch.",
    "Results are hard-bounded: at most 5000 candidate paths are collected internally before sorting, and by default only 100 paths are returned (hard maximum 500). If truncated=true, narrow path/patterns before increasing max_results.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      patterns: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: { type: "string", minLength: 1 },
        description: "One or more glob patterns to find in a single call, e.g. ['**/*-files.ts', '**/mcp-server.ts'].",
      },
      path: {
        type: "string",
        description: "Optional directory scope relative to the workspace root. Defaults to '.'.",
      },
      exclude: {
        type: "array",
        maxItems: 50,
        items: { type: "string", minLength: 1 },
        description: "Optional glob patterns to exclude from the result.",
      },
      case_sensitive: {
        type: "boolean",
        description: "Whether glob matching is case-sensitive. Defaults to false.",
      },
      no_ignore: {
        type: "boolean",
        description: "Set true to bypass ignore files/common generated-directory excludes. Defaults to false.",
      },
      include_hidden: {
        type: "boolean",
        description: "Set true to include hidden files/directories. Defaults to false.",
      },
      max_results: {
        type: "integer",
        minimum: 1,
        maximum: 500,
        description: "Maximum file paths returned. Defaults to 100; hard maximum 500. A value outside the range is brought into it, and the answer names what was used.",
      },
      sort: {
        type: "string",
        enum: ["modified_desc", "path_asc"],
        description: "Result order. Defaults to modified_desc (newest first); path_asc gives deterministic lexical order.",
      },
    },
    required: ["patterns"],
    additionalProperties: false,
  },
} as const;

export const SEARCH_FILES_TOOL = {
  name: "search_files",
  description: [
    "Search UTF-8 text file contents inside the current workspace and return bounded path/line/snippet matches.",
    "Use this to locate relevant code before calling read_files.",
    "Literal search is the default; set is_regex=true only when regular-expression semantics are required.",
    "Omit case_sensitive for smart-case (lowercase patterns are case-insensitive; uppercase makes the search case-sensitive).",
    "Use path to narrow the directory/file scope and include/exclude glob arrays to filter files.",
    "context_lines returns nearby lines for disambiguation; keep it small because search is for locating code, not reading whole files.",
    "Results are hard-bounded by per-file/global/output budgets. If truncated=true, narrow the query and search again.",
    "By default ignored/common generated directories and hidden paths are skipped, and every result names the filters that were in force: an empty result is not proof the text is absent, and neither is a non-empty one. Retry with no_ignore=true and/or include_hidden=true before concluding otherwise.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        minLength: 1,
        description: "Text or regex pattern to search for. Literal text by default.",
      },
      path: {
        type: "string",
        description: "Optional file or directory scope relative to the workspace root. Defaults to '.'.",
      },
      is_regex: {
        type: "boolean",
        description: "Set true to interpret pattern as a regular expression. Defaults to false (literal search).",
      },
      case_sensitive: {
        type: "boolean",
        description: "Optional case mode. true=sensitive, false=insensitive, omitted=smart-case.",
      },
      include: {
        type: "array",
        items: { type: "string", minLength: 1 },
        description: "Optional glob filters for files to include, e.g. ['**/*.ts', '**/*.tsx'].",
      },
      exclude: {
        type: "array",
        items: { type: "string", minLength: 1 },
        description: "Optional glob filters for files to exclude, e.g. ['**/*.test.ts'].",
      },
      context_lines: {
        type: "integer",
        minimum: 0,
        maximum: 5,
        description: "Surrounding lines on each side of each match. Defaults to 1, maximum 5. A value outside the range is brought into it, and the answer names what was used.",
      },
      max_results: {
        type: "integer",
        minimum: 1,
        maximum: 500,
        description: "Maximum matches returned across the call. Defaults to 100; hard maximum 500. A value outside the range is brought into it, and the answer names what was used.",
      },
      max_matches_per_file: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: "Maximum matches returned from one file. Defaults to 20; hard maximum 100. A value outside the range is brought into it, and the answer names what was used.",
      },
      no_ignore: {
        type: "boolean",
        description: "Set true to ignore .gitignore/common excludes. Defaults to false.",
      },
      include_hidden: {
        type: "boolean",
        description: "Set true to include hidden files/directories. Defaults to false.",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
} as const;

export const FILE_TOOL_DEFINITIONS = [APPLY_PATCH_TOOL, FIND_FILES_TOOL, READ_FILES_TOOL, READ_IMAGE_FILE_TOOL, SEARCH_FILES_TOOL] as const;
export const FILE_TOOL_NAMES = FILE_TOOL_DEFINITIONS.map((tool) => tool.name);
export type FileToolName = (typeof FILE_TOOL_DEFINITIONS)[number]["name"];

export interface FileToolInvocationContext {
  workspaceRoots: string[];
  signal?: AbortSignal;
  /** Extra globs for find_files and search_files, added to the built-in excludes. */
  excludeGlobs?: readonly string[];
  /** read_files implicit-read ceiling; left unset to keep the built-in default. */
  veryLargeFileBytes?: number;
  /** read_image_file size ceiling; left unset to keep the built-in default. */
  imageMaxBytes?: number;
}

export interface FileToolImagePayload {
  base64: string;
  mimeType: string;
  sizeBytes: number;
}

export interface FileToolInvocationResult {
  text: string;
  structuredContent: unknown;
  images?: FileToolImagePayload[];
  /** Set when the call itself failed. A per-file status inside a successful answer is not this. */
  isError?: boolean;
}

function parseApplyPatchInput(value: unknown): ApplyPatchInput {
  if (!value || typeof value !== "object") throw new Error("INVALID_ARGUMENT: expected an object.");
  const row = value as Record<string, unknown>;
  if (typeof row.patch !== "string" || row.patch.length === 0) {
    throw new Error("INVALID_ARGUMENT: patch must be a non-empty string.");
  }
  if (row.expected_versions !== undefined) {
    if (!row.expected_versions || typeof row.expected_versions !== "object" || Array.isArray(row.expected_versions)) {
      throw new Error("INVALID_ARGUMENT: expected_versions must be an object mapping paths to sha256 versions.");
    }
    for (const [filePath, version] of Object.entries(row.expected_versions as Record<string, unknown>)) {
      if (!filePath || typeof version !== "string" || !version.startsWith("sha256:")) {
        throw new Error("INVALID_ARGUMENT: expected_versions entries must map non-empty paths to sha256:... strings.");
      }
    }
  }
  return {
    patch: row.patch,
    expected_versions: row.expected_versions as Record<string, string> | undefined,
  };
}

function parseReadFilesInput(value: unknown): ReadFilesInput {
  if (!value || typeof value !== "object" || !Array.isArray((value as { files?: unknown }).files)) {
    throw new Error("INVALID_ARGUMENT: expected an object with a files array.");
  }
  const files = (value as { files: unknown[] }).files;
  if (files.length === 0) throw new Error("INVALID_ARGUMENT: files must not be empty.");

  return {
    files: files.map((item, index) => {
      if (!item || typeof item !== "object") {
        throw new Error(`INVALID_ARGUMENT: files[${index}] must be an object.`);
      }
      const row = item as Record<string, unknown>;
      if (typeof row.path !== "string" || row.path.length === 0) {
        throw new Error(`INVALID_ARGUMENT: files[${index}].path must be a non-empty string.`);
      }
      if (row.start_line !== undefined && (!Number.isInteger(row.start_line) || (row.start_line as number) < 1)) {
        throw new Error(`INVALID_ARGUMENT: files[${index}].start_line must be an integer >= 1.`);
      }
      if (row.end_line !== undefined && (!Number.isInteger(row.end_line) || (row.end_line as number) < 1)) {
        throw new Error(`INVALID_ARGUMENT: files[${index}].end_line must be an integer >= 1.`);
      }
      return {
        path: row.path,
        start_line: row.start_line as number | undefined,
        end_line: row.end_line as number | undefined,
      };
    }),
  };
}

function parseFindFilesInput(value: unknown): FindFilesInput {
  if (!value || typeof value !== "object") throw new Error("INVALID_ARGUMENT: expected an object.");
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.patterns) || row.patterns.length === 0 || row.patterns.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error("INVALID_ARGUMENT: patterns must be a non-empty array of non-empty strings.");
  }
  if (row.path !== undefined && (typeof row.path !== "string" || row.path.length === 0)) {
    throw new Error("INVALID_ARGUMENT: path must be a non-empty string when provided.");
  }
  if (row.exclude !== undefined && (!Array.isArray(row.exclude) || row.exclude.some((item) => typeof item !== "string" || item.length === 0))) {
    throw new Error("INVALID_ARGUMENT: exclude must be an array of non-empty strings when provided.");
  }
  for (const key of ["case_sensitive", "no_ignore", "include_hidden"] as const) {
    if (row[key] !== undefined && typeof row[key] !== "boolean") throw new Error(`INVALID_ARGUMENT: ${key} must be a boolean when provided.`);
  }
  // max_results is not checked for being an integer here: boundedInteger answers a value that
  // is not one with the default and says so, which is what every other tool does, and refusing
  // it here would make the two file tools the only ones that answer a mistyped number with an
  // error instead of with the number they used.
  if (row.sort !== undefined && row.sort !== "modified_desc" && row.sort !== "path_asc") {
    throw new Error("INVALID_ARGUMENT: sort must be 'modified_desc' or 'path_asc'.");
  }
  return {
    patterns: row.patterns as string[],
    path: row.path as string | undefined,
    exclude: row.exclude as string[] | undefined,
    case_sensitive: row.case_sensitive as boolean | undefined,
    no_ignore: row.no_ignore as boolean | undefined,
    include_hidden: row.include_hidden as boolean | undefined,
    max_results: row.max_results as number | undefined,
    sort: row.sort as "modified_desc" | "path_asc" | undefined,
  };
}

function parseSearchFilesInput(value: unknown): SearchFilesInput {
  if (!value || typeof value !== "object") {
    throw new Error("INVALID_ARGUMENT: expected an object.");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.pattern !== "string" || row.pattern.length === 0) {
    throw new Error("INVALID_ARGUMENT: pattern must be a non-empty string.");
  }

  if (row.path !== undefined && (typeof row.path !== "string" || row.path.length === 0)) {
    throw new Error("INVALID_ARGUMENT: path must be a non-empty string when provided.");
  }
  for (const key of ["is_regex", "case_sensitive", "no_ignore", "include_hidden"] as const) {
    if (row[key] !== undefined && typeof row[key] !== "boolean") {
      throw new Error(`INVALID_ARGUMENT: ${key} must be a boolean when provided.`);
    }
  }
  for (const key of ["include", "exclude"] as const) {
    if (
      row[key] !== undefined &&
      (!Array.isArray(row[key]) || (row[key] as unknown[]).some((item) => typeof item !== "string" || item.length === 0))
    ) {
      throw new Error(`INVALID_ARGUMENT: ${key} must be an array of non-empty strings when provided.`);
    }
  }
  // These three are not checked for being integers, either: boundedInteger answers a value that
  // is not one with the default and says so, which is what every other tool does, and refusing
  // it here would make the file tools the only ones that answer a mistyped number with an error
  // instead of with the number they used.
  return {
    pattern: row.pattern,
    path: row.path as string | undefined,
    is_regex: row.is_regex as boolean | undefined,
    case_sensitive: row.case_sensitive as boolean | undefined,
    include: row.include as string[] | undefined,
    exclude: row.exclude as string[] | undefined,
    context_lines: row.context_lines as number | undefined,
    max_results: row.max_results as number | undefined,
    max_matches_per_file: row.max_matches_per_file as number | undefined,
    no_ignore: row.no_ignore as boolean | undefined,
    include_hidden: row.include_hidden as boolean | undefined,
  };
}

function parseReadImageFileInput(value: unknown): ReadImageFileInput {
  if (!value || typeof value !== "object") throw new Error("INVALID_ARGUMENT: expected an object.");
  const row = value as Record<string, unknown>;
  if (typeof row.path !== "string" || row.path.length === 0) {
    throw new Error("INVALID_ARGUMENT: path must be a non-empty string.");
  }
  return { path: row.path };
}

export function isFileToolName(name: string): name is FileToolName {
  return FILE_TOOL_NAMES.includes(name as FileToolName);
}

export async function invokeFileTool(
  name: string,
  args: unknown,
  context: FileToolInvocationContext,
): Promise<FileToolInvocationResult> {
  if (name === APPLY_PATCH_TOOL.name) {
    const result = await applyPatch(parseApplyPatchInput(args), {
      workspaceRoots: context.workspaceRoots,
      signal: context.signal,
    });
    return { text: formatApplyPatchForModel(result), structuredContent: result };
  }

  if (name === FIND_FILES_TOOL.name) {
    const result = await findFiles(parseFindFilesInput(args), {
      workspaceRoots: context.workspaceRoots,
      signal: context.signal,
      config: { extraExcludes: context.excludeGlobs },
    });
    return { text: formatFindFilesForModel(result), structuredContent: result };
  }

  if (name === READ_FILES_TOOL.name) {
    const result = await readFiles(parseReadFilesInput(args), {
      workspaceRoots: context.workspaceRoots,
      signal: context.signal,
      // Only override when the caller actually supplied a value: spreading an undefined
      // ceiling into the defaults would silently disable the limit.
      config: context.veryLargeFileBytes === undefined
        ? undefined
        : { veryLargeFileBytes: context.veryLargeFileBytes },
    });
    return { text: formatReadFilesForModel(result), structuredContent: result };
  }

  if (name === READ_IMAGE_FILE_TOOL.name) {
    const result = await readImageFile(parseReadImageFileInput(args), {
      workspaceRoots: context.workspaceRoots,
      signal: context.signal,
      config: context.imageMaxBytes === undefined ? undefined : { maxBytes: context.imageMaxBytes },
    });
    if (result.status === "success" && result.success) {
      return {
        text: formatReadImageFileForModel(result),
        structuredContent: { status: "success", path: result.path, mimeType: result.success.mimeType, sizeBytes: result.success.sizeBytes },
        images: [{ base64: result.success.base64, mimeType: result.success.mimeType, sizeBytes: result.success.sizeBytes }],
      };
    }
    // One file, one answer: there is no other file in the call to succeed alongside it, so a
    // failure here is the call failing and not one row of a report. Saying so in the text
    // alone let a caller that trusts isError read "ERROR ..." and carry on as if it had the
    // image.
    return {
      text: formatReadImageFileForModel(result),
      structuredContent: { status: "error", path: result.path, error: result.error },
      isError: true,
    };
  }

  if (name === SEARCH_FILES_TOOL.name) {
    const result = await searchFiles(parseSearchFilesInput(args), {
      workspaceRoots: context.workspaceRoots,
      signal: context.signal,
      config: { extraExcludes: context.excludeGlobs },
    });
    return { text: formatSearchFilesForModel(result), structuredContent: result };
  }

  throw new Error(`Unknown file tool: ${name}`);
}

