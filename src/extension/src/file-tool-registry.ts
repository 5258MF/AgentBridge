import { applyPatch, formatApplyPatchForModel, type ApplyPatchInput } from "./apply-patch.js";
import { findFiles, formatFindFilesForModel, type FindFilesInput } from "./find-files.js";
import { DEFAULT_READ_FILES_CONFIG, formatReadFilesForModel, readFiles, type ReadFilesInput } from "./read-files.js";
import { formatReadImageFileForModel, readImageFile, type ReadImageFileInput } from "./read-files.js";
import { formatByteSize, IMAGE_MAX_BASE64_BYTES, IMAGE_MAX_EDGE, IMAGE_MAX_PIXELS } from "./image-processing.js";
import { formatSearchFilesForModel, searchFiles, type SearchFilesInput } from "./search-files.js";

export const APPLY_PATCH_TOOL = {
  name: "apply_patch",
  description: [
    "Create, edit, move, or delete workspace files with a patch.",
    "",
    "*** Begin Patch",
    "*** Add File: src/util.ts",
    "+export const answer = 42;",
    "*** Update File: src/app.ts",
    "*** Move to: src/main.ts",
    "@@",
    " function greet() {",
    "-  print(\"Hi\")",
    "+  print(\"Hello\")",
    "*** Delete File: old.txt",
    "*** End Patch",
    "",
    "- Put related edits to several files in one patch.",
    "- In Update hunks, context lines start with a space, removed lines with -, added lines with +. Old and context lines must match the file exactly and only once, or nothing is applied; re-read the file and regenerate the patch.",
    "- To replace a whole file, write *** Delete File: X immediately followed by *** Add File: X; the file keeps its line endings. Add File alone fails with FILE_ALREADY_EXISTS on an existing file.",
    "- Missing parent directories are created.",
    "- Pass the version hashes returned by read_files in expected_versions; a file changed since it was read fails with STALE_FILE instead of being edited.",
    "- Returns the applied unified diff.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      patch: {
        type: "string",
        minLength: 1,
        description: "Patch text from *** Begin Patch to *** End Patch.",
      },
      expected_versions: {
        type: "object",
        additionalProperties: { type: "string", pattern: "^sha256:" },
        description: "Map from file path to the sha256:... version returned by read_files for that file. Recommended whenever available.",
      },
    },
    required: ["patch"],
    additionalProperties: false,
  },
} as const;

export const READ_FILES_TOOL = {
  name: "read_files",
  description: [
    "Read UTF-8 text files from the workspace. Each file comes back with line numbers and a version hash.",
    "",
    `- Read several files in one call, at most ${DEFAULT_READ_FILES_CONFIG.maxFilesPerCall} files per call.`,
    "- Omit start_line/end_line to read a whole file; set them (1-based, inclusive) to read part of a large file.",
    `- Long files are cut off at about ${DEFAULT_READ_FILES_CONFIG.maxLinesPerFile} lines or ${DEFAULT_READ_FILES_CONFIG.maxBytesPerFile / 1024} KB per file; continue from next_start_line. Files of ${DEFAULT_READ_FILES_CONFIG.veryLargeFileBytes / (1024 * 1024)} MB or more need an explicit range.`,
    "- Pass the version hashes to apply_patch expected_versions so a file changed in the meantime is not overwritten.",
    "- When you do not know where something is, use search_files first instead of reading many files.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      files: {
        type: "array",
        minItems: 1,
        maxItems: DEFAULT_READ_FILES_CONFIG.maxFilesPerCall,
        description: "Files to read in this call.",
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
    "Read a raster image (PNG, JPEG, GIF, WebP, BMP) from the workspace and show it to you.",
    "",
    "- For screenshots, charts, UI mockups, and diagrams. For SVG use read_files.",
    `- Large images are downscaled to a ${IMAGE_MAX_EDGE} px long edge and at most ${formatByteSize(IMAGE_MAX_BASE64_BYTES)} of base64; small images are sent unchanged. Images over ${IMAGE_MAX_PIXELS / 1_000_000} megapixels are rejected.`,
    "- The text before the image gives the source and sent size; if scaled, divide coordinates by the reported scale to map them to the source file.",
    "- GIF shows only its first frame.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        minLength: 1,
        description: "Image path, relative to the workspace root.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
} as const;

export const FIND_FILES_TOOL = {
  name: "find_files",
  description: [
    "Find workspace files whose paths match glob patterns. Matches names and paths, not contents; use search_files for contents.",
    "",
    "- Pass several patterns in one call (at most 20), e.g. [\"**/*.test.ts\", \"**/package.json\"].",
    "- Returns files only, never directories, newest first by default; sort=path_asc gives a stable order.",
    "- Matching is case-insensitive by default. Ignored, generated, and hidden paths are skipped unless no_ignore or include_hidden is set.",
    "- Returns 100 paths by default (max_results up to 500). If truncated=true, narrow path or patterns first.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      patterns: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: { type: "string", minLength: 1 },
        description: "Glob patterns matched against paths under path.",
      },
      path: {
        type: "string",
        description: "Optional directory scope relative to the workspace root. Defaults to '.'.",
      },
      exclude: {
        type: "array",
        maxItems: 50,
        items: { type: "string", minLength: 1 },
        description: "Glob patterns for paths to leave out.",
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
        description: "Maximum file paths returned. Defaults to 100; hard maximum 500.",
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
    "Search text file contents in the workspace. Returns matching lines with paths and line numbers.",
    "",
    "- Literal text by default; set is_regex=true for a regular expression.",
    "- Smart case by default: an all-lowercase pattern ignores case, any uppercase letter makes it case-sensitive.",
    "- Narrow with path and include/exclude globs, e.g. include=[\"**/*.ts\"].",
    "- Returns up to 100 matches (max_results up to 500; 20 per file by default) with 1 line of context (context_lines up to 5). If truncated=true, narrow the search.",
    "- Ignored, generated, and hidden paths are skipped unless no_ignore or include_hidden is set.",
    "- Read the surrounding code with read_files; use lsp for definitions and references.",
  ].join("\n"),
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
        description: "Surrounding lines on each side of each match. Defaults to 1, maximum 5.",
      },
      max_results: {
        type: "integer",
        minimum: 1,
        maximum: 500,
        description: "Maximum matches returned across the call. Defaults to 100; hard maximum 500.",
      },
      max_matches_per_file: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: "Maximum matches returned from one file. Defaults to 20; hard maximum 100.",
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
  if (row.max_results !== undefined && !Number.isInteger(row.max_results)) {
    throw new Error("INVALID_ARGUMENT: max_results must be an integer when provided.");
  }
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
  for (const key of ["context_lines", "max_results", "max_matches_per_file"] as const) {
    if (row[key] !== undefined && !Number.isInteger(row[key])) {
      throw new Error(`INVALID_ARGUMENT: ${key} must be an integer when provided.`);
    }
  }

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
    });
    return { text: formatFindFilesForModel(result), structuredContent: result };
  }

  if (name === READ_FILES_TOOL.name) {
    const result = await readFiles(parseReadFilesInput(args), {
      workspaceRoots: context.workspaceRoots,
      signal: context.signal,
    });
    return { text: formatReadFilesForModel(result), structuredContent: result };
  }

  if (name === READ_IMAGE_FILE_TOOL.name) {
    const result = await readImageFile(parseReadImageFileInput(args), {
      workspaceRoots: context.workspaceRoots,
      signal: context.signal,
    });
    if (result.status === "success" && result.success) {
      return {
        text: formatReadImageFileForModel(result),
        structuredContent: {
          status: "success",
          path: result.path,
          mimeType: result.success.mimeType,
          sizeBytes: result.success.sizeBytes,
          width: result.success.width,
          height: result.success.height,
          unchanged: result.success.unchanged,
          source: result.success.source,
          notes: result.success.notes,
        },
        images: [{ base64: result.success.base64, mimeType: result.success.mimeType, sizeBytes: result.success.sizeBytes }],
      };
    }
    return {
      text: formatReadImageFileForModel(result),
      structuredContent: { status: "error", path: result.path, error: result.error },
    };
  }

  if (name === SEARCH_FILES_TOOL.name) {
    const result = await searchFiles(parseSearchFilesInput(args), {
      workspaceRoots: context.workspaceRoots,
      signal: context.signal,
    });
    return { text: formatSearchFilesForModel(result), structuredContent: result };
  }

  throw new Error(`Unknown file tool: ${name}`);
}

