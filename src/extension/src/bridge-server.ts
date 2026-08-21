import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { randomBytes } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport, type EventStore } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, type CallToolResult, isInitializeRequest, type JSONRPCMessage, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as vscode from "vscode";
import { FILE_TOOL_DEFINITIONS, invokeFileTool, isFileToolName } from "./file-tool-registry.js";
import { BRIDGE_EXCLUDED_TOOL_NAMES, getIdeToolDefinition, IDE_TOOL_DEFINITIONS } from "./ide-tool-definitions.js";
import { getManagedShellChoice } from "./ide-tool-broker.js";
import { managedShellExecutable, managedShellOverrideWarning } from "./ide-tool-broker.js";
import type { IdeToolBroker } from "./ide-tool-broker.js";

const execFileAsync = promisify(execFile);
const ROUTE_TOKEN_SECRET = "agentbridge.bridge.routeToken";
const NGROK_DOMAIN_SETTING = "bridge.ngrokDomain";
const NGROK_DOMAIN_STATE_KEY = "agentbridge.bridge.ngrokDomain";
const CLOUDFLARE_NAMED_DOMAIN_SETTING = "bridge.cloudflareNamedDomain";
const CLOUDFLARE_NAMED_DOMAIN_STATE_KEY = "agentbridge.bridge.cloudflareNamedDomain";
const CLOUDFLARE_NAMED_TOKEN_SECRET = "agentbridge.bridge.cloudflareNamedTunnelToken";
const CLOUDFLARE_NAMED_LOCAL_PORT_SETTING = "bridge.cloudflareNamedLocalPort";
const TUNNEL_PROVIDER_SETTING = "bridge.tunnelProvider";
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_ACTIVITY = 60;
const MAX_TODOS = 24;
/** Idle sessions are retained long enough for ChatGPT to pause and resume without being forced to reinitialize. */
const SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const SESSION_PRUNE_INTERVAL_MS = 60_000;
const MAX_SESSIONS = 64;
/** Explicitly pin transport behavior instead of depending on SDK defaults. */
const SESSION_KEEPALIVE_INTERVAL_MS = 15_000;
const SESSION_RETRY_INTERVAL_MS = 2_000;
const SESSION_EVENT_STORE_LIMIT = 512;
const PUBLIC_HEALTH_STARTUP_TIMEOUT_MS = 60_000;
const PUBLIC_HEALTH_REQUEST_TIMEOUT_MS = 5_000;
/** DoH endpoints used as a DNS fallback when the system resolver cannot
 * resolve the tunnel hostname (campus/corporate DNS often fails on
 * *.trycloudflare.com wildcard subdomains). Only the hostname is sent,
 * never the URL path, so the route token is not exposed. */
const PUBLIC_HEALTH_DOH_ENDPOINTS = [
  "https://dns.alidns.com/resolve",
  "https://doh.pub/dns-query",
] as const;
const PUBLIC_HEALTH_DOH_CACHE_TTL_MS = 60_000;
const TUNNEL_RESTART_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
const CLOUDFLARED_WINGET_PACKAGE = "Cloudflare.cloudflared";
const DEFAULT_CLOUDFLARE_NAMED_LOCAL_PORT = 48271;

export type BridgeTunnelProvider = "cloudflare" | "cloudflare-named" | "ngrok";

const BRIDGE_SERVER_INSTRUCTIONS = `You are connected to the currently open AgentBridge workspace.

AgentBridge executes tools and displays your task state, progress, and tool activity to the local user.

Use:
- list_directory/find_files to discover files
- search_files for raw text search
- lsp for semantic code navigation
- read_files before editing
- apply_patch for workspace changes
- get_diagnostics after edits
- run_command for builds and tests
- set_todos to maintain the complete task list for multi-step work
- report_progress to report transient progress for the current task

Task coordination:
- Use set_todos for multi-step work, significant replanning, or validation workflows.
- Send the complete ordered todo list whenever task state changes.
- Keep at most one todo in_progress.
- Use stable todo IDs across updates.
- Keep todos at the goal level; do not create one todo per tool call.
- Use report_progress for what you are doing right now, not for durable task state.
- When there is exactly one in_progress todo, report_progress is automatically associated with it.
- Pass todo_id only when an explicit association is needed.
- Send an empty todo list when the task state should be cleared.

Tool guidance:
- Prefer semantic navigation over broad text search when locating code symbols.
- Do not assume an empty LSP result means a symbol does not exist.
- Use search_files for exact text and lsp for symbols, definitions, references, and type information.
- Reread affected files after stale patch or context-mismatch failures before retrying.
- Prefer small, focused patches with enough unique context.
- Run diagnostics and relevant tests after meaningful edits.
- Report meaningful progress periodically during long work, but avoid progress updates for every tool call.`;

export const SET_TODOS_TOOL = {
  name: "set_todos",
  description: "Set the complete durable task list for the current remote-agent job in AgentBridge. Use this for multi-step work so the local user can see what is done, in progress, and still pending. Send the full list whenever the plan changes; keep at most one item in_progress. Use report_progress for transient details about the current step instead of creating tool-call-sized todos. Send an empty list to clear task state.",
  inputSchema: {
    type: "object",
    required: ["todos"],
    properties: {
      todos: {
        type: "array",
        maxItems: MAX_TODOS,
        description: "Complete ordered todo snapshot for the current job.",
        items: {
          type: "object",
          required: ["id", "title", "status"],
          properties: {
            id: { type: "string", minLength: 1, maxLength: 80, description: "Stable id reused across later set_todos updates." },
            title: { type: "string", minLength: 1, maxLength: 400, description: "Goal-level task title, not an individual tool call." },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
} as const;

export const REPORT_PROGRESS_TOOL = {
  name: "report_progress",
  description: "Report concise transient progress from the remote MCP agent to the AgentBridge UI. For multi-step work, maintain durable task state with set_todos and use report_progress for what you are doing right now. todo_id is optional: when omitted, AgentBridge automatically associates progress with the sole in_progress todo. This tool does not modify workspace files.",
  inputSchema: {
    type: "object",
    required: ["message"],
    properties: {
      message: { type: "string", minLength: 1, maxLength: 2000, description: "Human-readable progress update." },
      phase: { type: "string", maxLength: 160, description: "Optional short phase label, such as Reading, Editing, Testing, or Done." },
      percent: { type: "integer", minimum: 0, maximum: 100, description: "Optional completion estimate from 0 to 100 for the current activity/todo." },
      todo_id: { type: "string", minLength: 1, maxLength: 80, description: "Optional todo id from set_todos. Omit when there is exactly one in_progress todo; AgentBridge will link it automatically." },
    },
    additionalProperties: false,
  },
} as const;

export const BRIDGE_TOOL_DEFINITIONS = [
  ...FILE_TOOL_DEFINITIONS,
  ...IDE_TOOL_DEFINITIONS
    .filter((tool) => !BRIDGE_EXCLUDED_TOOL_NAMES.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  SET_TODOS_TOOL,
  REPORT_PROGRESS_TOOL,
] as const;

/**
 * Tools that modify or drive the local environment. Hidden from tools/list
 * and hard-blocked at call time while read-only mode is active.
 * - apply_patch: writes workspace files.
 * - run_command: executes arbitrary commands in a managed terminal.
 * - send_command_input: feeds input into running processes (defense in depth —
 *   it depends on command ids produced by run_command, but blocking it closes
 *   the "drive an already-running REPL" bypass completely).
 */
const READ_ONLY_BLOCKED_TOOL_NAMES = new Set<string>(["apply_patch", "run_command", "send_command_input"]);

export interface BridgeActivity {
  readonly id: number;
  readonly at: string;
  readonly tool: string;
  readonly status: "running" | "completed" | "error" | "progress";
  readonly durationMs?: number;
  readonly message?: string;
  readonly phase?: string;
  readonly percent?: number;
  readonly todoId?: string;
  readonly todoTitle?: string;
  readonly presentation?: BridgeActivityPresentation;
  readonly sessionId?: string;
}

export interface BridgeTodo {
  readonly id: string;
  readonly title: string;
  readonly status: "pending" | "in_progress" | "completed";
}

export interface BridgeActivityPresentation {
  readonly kind: "files" | "search" | "edit" | "terminal" | "diagnostics" | "lsp" | "generic";
  readonly title: string;
  readonly subtitle?: string;
  readonly input?: string;
  readonly output?: string;
  readonly files?: string[];
  readonly items?: BridgeActivityItem[];
  readonly diff?: string;
  readonly diffPreview?: BridgeDiffFilePreview[];
  readonly terminalId?: string;
  readonly commandId?: string;
  readonly exitCode?: number | null;
}

export interface BridgeDiffFilePreview {
  readonly path: string;
  readonly oldPath?: string;
  readonly newPath?: string;
  readonly hunks: BridgeDiffHunkPreview[];
  readonly truncated?: boolean;
}

export interface BridgeDiffHunkPreview {
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: BridgeDiffLinePreview[];
  readonly truncated?: boolean;
}

export interface BridgeDiffLinePreview {
  readonly kind: "context" | "add" | "delete";
  readonly oldLine?: number;
  readonly newLine?: number;
  readonly text: string;
}

export interface BridgeActivityItem {
  readonly kind: "file" | "folder" | "match" | "diagnostic" | "symbol";
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  readonly label?: string;
  readonly description?: string;
  readonly severity?: "error" | "warning" | "information" | "hint";
  readonly additions?: number;
  readonly deletions?: number;
}

export interface BridgeStatus {
  readonly state: "stopped" | "starting" | "running" | "error";
  readonly transport: "streamable-http";
  readonly tunnelProvider: BridgeTunnelProvider;
  readonly domain: string;
  readonly configuredDomain: string;
  readonly configuredNamedDomain: string;
  readonly namedTunnelTokenConfigured: boolean;
  readonly namedTunnelLocalPort: number;
  readonly namedTunnelOriginUrl: string;
  readonly localUrl?: string;
  readonly publicUrl?: string;
  readonly localPort?: number;
  readonly tunnelInstalled?: boolean;
  readonly tunnelVersion?: string;
  readonly tunnelConfigValid?: boolean;
  readonly lastError?: string;
  readonly toolNames: string[];
  readonly toolCount: number;
  readonly activeRequests: number;
  readonly connected: boolean;
  readonly revision: number;
  readonly stats: {
    readonly toolCalls: number;
    readonly completedToolCalls: number;
    readonly failedToolCalls: number;
    readonly averageDurationMs: number;
    readonly successRate: number;
    readonly lastTool?: string;
    readonly lastToolAt?: string;
  };
  readonly todos: BridgeTodo[];
  readonly activities: BridgeActivity[];
  readonly sessionCount: number;
  readonly sessions: ReadonlyArray<{ readonly sessionId: string; readonly lastActivity: string; readonly activeRequests: number }>;
  /**
   * The shell executable that the next set of AgentBridge managed terminals
   * will spawn. Reflects the effective choice after applying override config
   * and any hard fallback. Used by the panel to surface the current shell to
   * the user via the "管理 Shell" entry in the advanced card.
   */
  readonly managedShellPath: string;
  /**
   * Non-null when the user-configured override in
   * `agentbridge.bridge.managedShell.{windows,unix}` could not be applied
   * (missing path, non-launchable binary, etc). AgentBridge silently fell
   * back to the default shell; the panel shows the warning in red so the
   * user knows the override is inert and can correct it.
   */
   readonly managedShellOverrideWarning: string | null;
  /**
   * How external URL clicks in the AgentBridge panel are routed.
   * - "auto": ChatGPT/arena.ai → VS Code Simple Browser; others → OS default browser (matches the
   *   original ShunCode Bridge widget)
   * - "all": every external URL → VS Code Simple Browser (Cloudflare/ngrok OAuth may break in iframe)
   * - "external": every external URL → OS default browser (legacy fallback)
   * Set by `agentbridge.bridge.openInternalBrowser`; read fresh by the panel and the openExternal
   * handler at request time — no cache, so changes apply immediately without `onDidChangeConfiguration`.
   */
  readonly openInternalBrowser: "auto" | "all" | "external";
  /**
   * When true, tools that modify the local environment (apply_patch,
   * run_command, send_command_input) are hidden from tools/list and
   * hard-blocked at call time. Backed by `agentbridge.bridge.readOnlyMode`
   * (application scope so workspace settings cannot override it).
   */
  readonly readOnlyMode: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function boundedText(value: unknown, maxChars = 16_000): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return undefined;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated for Bridge UI]`;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim()))];
}

function stringField(text: string | undefined, field: string): string | undefined {
  if (!text) return undefined;
  const match = text.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  if (!match) return undefined;
  const raw = match[1].trim();
  if (raw === "null") return undefined;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : String(parsed);
  } catch {
    return raw;
  }
}

function numberField(text: string | undefined, field: string): number | null | undefined {
  const raw = stringField(text, field);
  if (raw === undefined) return undefined;
  if (raw === "null") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function blockBetween(text: string | undefined, begin: string, end: string): string | undefined {
  if (!text) return undefined;
  const start = text.indexOf(begin);
  if (start < 0) return undefined;
  const contentStart = start + begin.length;
  const finish = text.indexOf(end, contentStart);
  const value = text.slice(contentStart, finish >= 0 ? finish : undefined).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  return value || undefined;
}

function parseListDirectoryItems(text: string | undefined): BridgeActivityItem[] {
  if (!text) return [];
  const items: BridgeActivityItem[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\[(DIR|FILE|LINK|OTHER)\]\s+(.+)$/);
    if (!match) continue;
    items.push({ kind: match[1] === "DIR" ? "folder" : "file", path: match[2] });
  }
  return items;
}

function parseDiagnosticsItems(text: string | undefined): BridgeActivityItem[] {
  if (!text) return [];
  const items: BridgeActivityItem[] = [];
  const blocks = text.split(/--- DIAGNOSTIC \d+ ---/).slice(1);
  for (const block of blocks) {
    const lines = block.trim().split(/\r?\n/);
    const location = lines[0]?.match(/^(.+):(\d+):(\d+)$/);
    if (!location) continue;
    const severity = stringField(block, "severity") as BridgeActivityItem["severity"];
    const messageStart = lines.findIndex((line) => line.startsWith("code:"));
    const message = messageStart >= 0 ? lines.slice(messageStart + 1).join(" ").trim() : undefined;
    items.push({
      kind: "diagnostic",
      path: location[1],
      line: Number(location[2]),
      column: Number(location[3]),
      label: message || undefined,
      severity,
    });
  }
  return items;
}

function parseLspItems(text: string | undefined): BridgeActivityItem[] {
  if (!text) return [];
  const items: BridgeActivityItem[] = [];
  const blocks = text.split(/--- RESULT \d+ ---/).slice(1);
  for (const block of blocks) {
    const pathValue = stringField(block, "path");
    if (!pathValue || /^[a-z]+:\/\//i.test(pathValue)) continue;
    const range = stringField(block, "selection_range") ?? stringField(block, "range");
    const position = range?.match(/^(\d+):(\d+)/);
    items.push({
      kind: "symbol",
      path: pathValue,
      line: position ? Number(position[1]) : undefined,
      column: position ? Number(position[2]) : undefined,
      label: stringField(block, "name"),
      description: stringField(block, "kind") ?? stringField(block, "container"),
    });
  }
  return items;
}

const MAX_DIFF_PREVIEW_FILES = 8;
const MAX_DIFF_PREVIEW_HUNKS_PER_FILE = 4;
const MAX_DIFF_PREVIEW_LINES_PER_HUNK = 18;

function diffPath(header: string): string | undefined {
  const value = header.trim();
  if (!value || value === "/dev/null") return undefined;
  return value.replace(/^[ab]\//, "");
}

function parseUnifiedDiffPreview(diff: string | undefined): BridgeDiffFilePreview[] {
  if (!diff) return [];
  const lines = diff.split(/\r?\n/);
  const files: BridgeDiffFilePreview[] = [];
  let currentFile: { oldPath?: string; newPath?: string; hunks: BridgeDiffHunkPreview[]; truncated?: boolean } | undefined;
  let currentHunk: { oldStart: number; newStart: number; lines: BridgeDiffLinePreview[]; truncated?: boolean } | undefined;
  let oldLine = 0;
  let newLine = 0;

  const finishHunk = () => {
    if (!currentFile || !currentHunk) return;
    if (currentFile.hunks.length < MAX_DIFF_PREVIEW_HUNKS_PER_FILE) currentFile.hunks.push(currentHunk);
    else currentFile.truncated = true;
    currentHunk = undefined;
  };

  const finishFile = () => {
    finishHunk();
    if (!currentFile) return;
    const path = currentFile.newPath ?? currentFile.oldPath;
    if (path) {
      if (files.length < MAX_DIFF_PREVIEW_FILES) files.push({ path, ...currentFile });
      else if (files.length > 0) files[files.length - 1] = { ...files[files.length - 1]!, truncated: true };
    }
    currentFile = undefined;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("--- ")) {
      finishFile();
      const oldPath = diffPath(line.slice(4));
      const next = lines[index + 1];
      const newPath = next?.startsWith("+++ ") ? diffPath(next.slice(4)) : undefined;
      currentFile = { oldPath, newPath, hunks: [] };
      if (next?.startsWith("+++ ")) index += 1;
      continue;
    }
    if (!currentFile) continue;
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      finishHunk();
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      currentHunk = { oldStart: oldLine, newStart: newLine, lines: [] };
      continue;
    }
    if (!currentHunk || line === "\\ No newline at end of file" || line === "... <diff truncated>") continue;
    const marker = line[0];
    if (marker !== " " && marker !== "+" && marker !== "-") continue;
    const previewLine: BridgeDiffLinePreview = marker === "+"
      ? { kind: "add", newLine, text: line.slice(1) }
      : marker === "-"
        ? { kind: "delete", oldLine, text: line.slice(1) }
        : { kind: "context", oldLine, newLine, text: line.slice(1) };
    if (currentHunk.lines.length < MAX_DIFF_PREVIEW_LINES_PER_HUNK) currentHunk.lines.push(previewLine);
    else currentHunk.truncated = true;
    if (marker !== "+") oldLine += 1;
    if (marker !== "-") newLine += 1;
  }
  finishFile();
  return files;
}

function bridgePresentation(
  toolName: string,
  args: Record<string, unknown>,
  resultText?: string,
  structuredContent?: Record<string, unknown>,
  isError = false,
): BridgeActivityPresentation {
  const input = boundedText(args, 8_000);
  const output = boundedText(resultText, 24_000);
  const structured = structuredContent ?? {};

  if (toolName === "read_files") {
    const requested = recordArray(args.files).map((file) => typeof file.path === "string" ? file.path : undefined);
    const returned = recordArray(structured.files).map((file) => typeof file.path === "string" ? file.path : undefined);
    const files = uniqueStrings([...requested, ...returned]);
    return {
      kind: "files",
      title: files.length === 1 ? `Read ${files[0]}` : `Read ${files.length || "workspace"} files`,
      subtitle: isError ? "File read failed" : files.length ? `${files.length} file${files.length === 1 ? "" : "s"}` : undefined,
      files,
      items: files.map((file) => ({ kind: "file", path: file })),
      input: undefined,
      output: isError ? output : undefined,
    };
  }

  if (toolName === "read_image_file") {
    const imagePath = typeof args.path === "string" ? args.path : "";
    const statusRow = asRecord(structured);
    const isError2 = statusRow.status === "error";
    const errorRow = asRecord(statusRow.error);
    const successRow = asRecord(statusRow.success);
    const mimeType = typeof successRow.mimeType === "string" ? successRow.mimeType : undefined;
    const sizeBytes = typeof successRow.sizeBytes === "number" ? successRow.sizeBytes : undefined;
    const sizeKB = sizeBytes !== undefined ? `${(sizeBytes / 1024).toFixed(1)} KB` : undefined;
    const subtitleParts: string[] = [];
    if (mimeType) subtitleParts.push(mimeType);
    if (sizeKB) subtitleParts.push(sizeKB);
    return {
      kind: "files",
      title: imagePath ? `Read image ${imagePath}` : "Read image",
      subtitle: isError2
        ? `Image read failed · ${typeof errorRow.code === "string" ? errorRow.code : "ERROR"}`
        : subtitleParts.length ? subtitleParts.join(" · ") : undefined,
      files: imagePath ? [imagePath] : [],
      items: imagePath ? [{ kind: "file", path: imagePath }] : [],
      input: undefined,
      output: isError2 ? output : undefined,
    };
  }

  if (toolName === "find_files") {
    const files = uniqueStrings(recordArray(structured.files).map((file) => typeof file.path === "string" ? file.path : undefined));
    const patterns = Array.isArray(args.patterns) ? args.patterns.filter((value): value is string => typeof value === "string") : [];
    return {
      kind: "files",
      title: files.length ? `Found ${files.length} file${files.length === 1 ? "" : "s"}` : "Find files",
      subtitle: patterns.length ? patterns.join(", ") : undefined,
      files,
      items: files.map((file) => ({ kind: "file", path: file })),
      input: undefined,
      output: isError ? output : undefined,
    };
  }

  if (toolName === "search_files") {
    const matches = recordArray(structured.matches);
    const files = uniqueStrings(matches.map((match) => typeof match.path === "string" ? match.path : undefined));
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    const items: BridgeActivityItem[] = matches.flatMap((match) => {
      if (typeof match.path !== "string") return [];
      return [{
        kind: "match" as const,
        path: match.path,
        line: typeof match.line === "number" ? match.line : undefined,
        column: typeof match.column === "number" ? match.column : undefined,
        label: typeof match.text === "string" ? match.text.trim() : undefined,
      }];
    });
    return {
      kind: "search",
      title: pattern ? `Searched “${pattern}”` : "Searched workspace",
      subtitle: matches.length ? `${matches.length} match${matches.length === 1 ? "" : "es"} in ${files.length} file${files.length === 1 ? "" : "s"}` : undefined,
      files,
      items,
      input: undefined,
      output: isError ? output : undefined,
    };
  }

  if (toolName === "apply_patch") {
    const fileRows = recordArray(structured.files);
    const files = uniqueStrings(fileRows.map((file) => typeof file.destination_path === "string"
      ? file.destination_path
      : typeof file.path === "string" ? file.path : undefined));
    const summary = asRecord(structured.summary);
    const additions = typeof summary.additions === "number" ? summary.additions : undefined;
    const deletions = typeof summary.deletions === "number" ? summary.deletions : undefined;
    const changeSummary = additions !== undefined || deletions !== undefined ? `+${additions ?? 0} -${deletions ?? 0}` : undefined;
    const diff = boundedText(structured.diff, 32_000);
    return {
      kind: "edit",
      title: files.length === 1 ? `Edited ${files[0]}` : `Edited ${files.length || "workspace"} files`,
      subtitle: isError ? "Edit failed" : changeSummary,
      files,
      items: fileRows.flatMap((file) => typeof file.path === "string" ? [{
        kind: "file" as const,
        path: typeof file.destination_path === "string" ? file.destination_path : file.path,
        description: typeof file.action === "string" ? file.action : undefined,
        additions: typeof file.additions === "number" ? file.additions : undefined,
        deletions: typeof file.deletions === "number" ? file.deletions : undefined,
      }] : []),
      input: undefined,
      output: isError ? output : undefined,
      diff,
      diffPreview: parseUnifiedDiffPreview(diff),
    };
  }

  if (toolName === "list_directory") {
    const target = typeof args.path === "string" && args.path.trim() ? args.path.trim() : "workspace";
    const items = parseListDirectoryItems(resultText);
    return {
      kind: "files",
      title: `Explored ${target}`,
      subtitle: items.length ? `${items.length} item${items.length === 1 ? "" : "s"}` : undefined,
      items,
      files: items.filter((item) => item.kind === "file").map((item) => item.path),
      input: undefined,
      output: isError ? output : undefined,
    };
  }

  if (toolName === "run_command") {
    const command = typeof args.command === "string" ? args.command.trim() : "Run command";
    const cwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd.trim() : undefined;
    const terminalId = stringField(resultText, "terminal_id");
    const terminalName = stringField(resultText, "terminal_name");
    const commandId = stringField(resultText, "command_id");
    const exitCode = numberField(resultText, "exit_code");
    const terminalOutput = blockBetween(resultText, "--- OUTPUT BEGIN ---", "--- OUTPUT END ---");
    const status = stringField(resultText, "status");
    const subtitle = [terminalName, cwd, status && status !== "completed" ? status : undefined, exitCode !== undefined && exitCode !== null ? `exit ${exitCode}` : undefined].filter(Boolean).join(" · ") || undefined;
    return { kind: "terminal", title: command || "Run command", subtitle, input: undefined, output: terminalOutput ?? (isError ? output : undefined), terminalId, commandId, exitCode };
  }

  if (toolName === "get_command_output") {
    const commandId = typeof args.command_id === "string" ? args.command_id : undefined;
    return {
      kind: "terminal",
      title: "Read command output",
      subtitle: [stringField(resultText, "terminal_name"), stringField(resultText, "status") ?? commandId].filter(Boolean).join(" · ") || undefined,
      input: undefined,
      output: blockBetween(resultText, "--- OUTPUT BEGIN ---", "--- OUTPUT END ---") ?? output,
      terminalId: stringField(resultText, "terminal_id"),
      commandId,
      exitCode: numberField(resultText, "exit_code"),
    };
  }

  if (toolName === "send_command_input") {
    const commandId = typeof args.command_id === "string" ? args.command_id : undefined;
    return { kind: "terminal", title: "Sent command input", subtitle: commandId, input: boundedText(args.input, 2_000), terminalId: stringField(resultText, "terminal_id"), commandId, output: isError ? output : undefined };
  }

  if (toolName === "get_diagnostics") {
    const scope = typeof args.path === "string" && args.path.trim() ? args.path.trim() : "workspace";
    const items = parseDiagnosticsItems(resultText);
    const errors = items.filter((item) => item.severity === "error").length;
    const warnings = items.filter((item) => item.severity === "warning").length;
    const summary = items.length ? `${errors} error${errors === 1 ? "" : "s"} · ${warnings} warning${warnings === 1 ? "" : "s"}` : "No diagnostics";
    return { kind: "diagnostics", title: `Checked diagnostics · ${scope}`, subtitle: summary, items, input: undefined, output: isError ? output : undefined };
  }

  if (toolName === "lsp") {
    const operationId = typeof args.operation === "string" ? args.operation : "";
    const operation = operationId ? operationId.replace(/_/g, " ") : "code intelligence";
    const subject = typeof args.query === "string" && args.query.trim()
      ? args.query.trim()
      : typeof args.path === "string" && args.path.trim()
        ? args.path.trim()
        : undefined;
    const items = parseLspItems(resultText);
    const resultSummary = items.length ? `${items.length} result${items.length === 1 ? "" : "s"}` : subject;
    const hoverOutput = operationId === "hover" ? blockBetween(resultText, "--- CONTENT BEGIN ---", "--- CONTENT END ---") : undefined;
    return { kind: "lsp", title: `LSP · ${operation}`, subtitle: resultSummary, items, input: undefined, output: isError ? output : hoverOutput };
  }

  return { kind: "generic", title: toolName, input, output };
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
  activeRequests: number;
  activeStreams: number;
}

class BoundedInMemoryEventStore implements EventStore {
  private readonly events = new Map<string, { streamId: string; message: JSONRPCMessage }>();
  private readonly order: string[] = [];
  private sequence = 0;

  constructor(private readonly limit = SESSION_EVENT_STORE_LIMIT) {}

  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const eventId = `${Date.now().toString(36)}-${(++this.sequence).toString(36)}-${randomUUID()}`;
    this.events.set(eventId, { streamId, message });
    this.order.push(eventId);
    while (this.order.length > this.limit) {
      const oldest = this.order.shift();
      if (oldest) this.events.delete(oldest);
    }
    return eventId;
  }

  async replayEventsAfter(lastEventId: string, { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> }): Promise<string> {
    const previous = this.events.get(lastEventId);
    if (!previous) return "";
    let found = false;
    for (const eventId of this.order) {
      if (eventId === lastEventId) {
        found = true;
        continue;
      }
      if (!found) continue;
      const event = this.events.get(eventId);
      if (event?.streamId === previous.streamId) {
        await send(eventId, event.message);
      }
    }
    return previous.streamId;
  }
}

function normalizeHttpsHostname(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`${label} is not a valid hostname.`);
  }
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS.`);
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password || url.port) {
    throw new Error(`Enter only the ${label.toLowerCase()}, without a path, query, port, username, or password.`);
  }
  return url.hostname.toLowerCase();
}

function normalizeNgrokDomain(value: string): string {
  return normalizeHttpsHostname(value, "ngrok reserved domain");
}

function normalizeCloudflareNamedDomain(value: string): string {
  return normalizeHttpsHostname(value, "Cloudflare Named Tunnel hostname");
}

function normalizeNamedTunnelLocalPort(value: number): number {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error("Cloudflare Named Tunnel local port must be an integer from 1024 to 65535.");
  }
  return value;
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_REQUEST_BYTES) {
        reject(new Error(`MCP request body exceeds ${MAX_REQUEST_BYTES} bytes.`));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("MCP request body is not valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function writeJsonError(response: ServerResponse, statusCode: number, message: string): void {
  if (response.headersSent) return;
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({
    jsonrpc: "2.0",
    error: { code: statusCode === 404 ? -32004 : -32000, message },
    id: null,
  }));
}

function cancellationFromAbortSignal(signal: AbortSignal | undefined): { token?: vscode.CancellationToken; dispose(): void } {
  if (!signal) return { token: undefined, dispose: () => undefined };
  const source = new vscode.CancellationTokenSource();
  const listener = () => source.cancel();
  if (signal.aborted) source.cancel();
  else signal.addEventListener("abort", listener, { once: true });
  return {
    token: source.token,
    dispose: () => {
      signal.removeEventListener("abort", listener);
      source.dispose();
    },
  };
}

export class BridgeManager implements vscode.Disposable {
  private state: BridgeStatus["state"] = "stopped";
  private tunnelProvider: BridgeTunnelProvider = "cloudflare";
  private domain = "";
  private configuredDomain = "";
  private configuredNamedDomain = "";
  private namedTunnelToken = "";
  private namedTunnelLocalPort = DEFAULT_CLOUDFLARE_NAMED_LOCAL_PORT;
  private routeToken = "";
  private readOnlyMode = false;
  private readonly sessions = new Map<string, McpSession>();
  private httpServer: HttpServer | undefined;
  private tunnelProcess: ChildProcessWithoutNullStreams | undefined;
  private localPort: number | undefined;
  private lastError: string | undefined;
  private tunnelInstalled: boolean | undefined;
  private tunnelVersion: string | undefined;
  private tunnelConfigValid: boolean | undefined;
  private cloudflaredExecutable = "cloudflared";
  private activeRequests = 0;
  private readonly activities: BridgeActivity[] = [];
  private todos: BridgeTodo[] = [];
  private nextActivityId = 1;
  private revision = 0;
  private toolCalls = 0;
  private completedToolCalls = 0;
  private failedToolCalls = 0;
  private totalToolDurationMs = 0;
  private lastTool: string | undefined;
  private lastToolAt: string | undefined;
  private startPromise: Promise<BridgeStatus> | undefined;
  private sessionPruneTimer: ReturnType<typeof setInterval> | undefined;
  private tunnelRecoveryPromise: Promise<void> | undefined;
  private tunnelRecoveryGeneration: number | undefined;
  private tunnelGeneration = 0;
  private stoppingResources = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly ideToolBroker: IdeToolBroker,
    private readonly authorizeStart: () => Promise<void>,
  ) {}

  async initialize(): Promise<void> {
    this.routeToken = await this.context.secrets.get(ROUTE_TOKEN_SECRET) ?? "";
    if (!this.routeToken) {
      this.routeToken = randomBytes(16).toString("hex");
      await this.context.secrets.store(ROUTE_TOKEN_SECRET, this.routeToken);
    }
    this.tunnelProvider = this.readTunnelProvider();
    this.readOnlyMode = this.readReadOnlyMode();
    this.namedTunnelToken = await this.context.secrets.get(CLOUDFLARE_NAMED_TOKEN_SECRET) ?? "";
    this.namedTunnelLocalPort = this.readNamedTunnelLocalPort();
    await this.restorePersistedDomain();
    await this.restorePersistedNamedDomain();
    this.domain = this.configuredDomainForProvider(this.tunnelProvider);
  }

  getStatus(): BridgeStatus {
    if (this.state !== "running" && this.state !== "starting") {
      this.tunnelProvider = this.readTunnelProvider();
      this.restoreConfiguredDomain();
      this.restoreConfiguredNamedDomain();
      this.namedTunnelLocalPort = this.readNamedTunnelLocalPort();
      this.domain = this.configuredDomainForProvider(this.tunnelProvider);
    }
    const localUrl = this.localPort && this.routeToken ? `http://127.0.0.1:${this.localPort}/mcp/${this.routeToken}` : undefined;
    const publicUrl = this.domain && this.routeToken ? `https://${this.domain}/mcp/${this.routeToken}` : undefined;
    return {
      state: this.state,
      transport: "streamable-http",
      tunnelProvider: this.tunnelProvider,
      domain: this.domain,
      configuredDomain: this.configuredDomain,
      configuredNamedDomain: this.configuredNamedDomain,
      namedTunnelTokenConfigured: Boolean(this.namedTunnelToken),
      namedTunnelLocalPort: this.namedTunnelLocalPort,
      namedTunnelOriginUrl: `http://127.0.0.1:${this.namedTunnelLocalPort}`,
      localUrl,
      publicUrl,
      localPort: this.localPort,
      tunnelInstalled: this.tunnelInstalled,
      tunnelVersion: this.tunnelVersion,
      tunnelConfigValid: this.tunnelConfigValid,
      lastError: this.lastError,
      toolNames: BRIDGE_TOOL_DEFINITIONS.map((tool) => tool.name).filter((name) => !this.readOnlyMode || !READ_ONLY_BLOCKED_TOOL_NAMES.has(name)),
      toolCount: BRIDGE_TOOL_DEFINITIONS.length,
      activeRequests: this.activeRequests,
      connected: this.sessions.size > 0,
      revision: this.revision,
      stats: {
        toolCalls: this.toolCalls,
        completedToolCalls: this.completedToolCalls,
        failedToolCalls: this.failedToolCalls,
        averageDurationMs: this.completedToolCalls > 0 ? Math.round(this.totalToolDurationMs / this.completedToolCalls) : 0,
        successRate: this.completedToolCalls > 0 ? ((this.completedToolCalls - this.failedToolCalls) / this.completedToolCalls) * 100 : 100,
        lastTool: this.lastTool,
        lastToolAt: this.lastToolAt,
      },
      todos: this.todos.map((todo) => ({ ...todo })),
      activities: this.activities.slice(-MAX_ACTIVITY),
      sessionCount: this.sessions.size,
      sessions: Array.from(this.sessions.entries()).map(([sessionId, session]) => ({
        sessionId,
        lastActivity: new Date(session.lastActivity).toISOString(),
        activeRequests: session.activeRequests,
      })),
      managedShellPath: managedShellExecutable(),
      managedShellOverrideWarning: managedShellOverrideWarning(),
      openInternalBrowser: vscode.workspace.getConfiguration("agentbridge.bridge").get<"auto" | "all" | "external">("openInternalBrowser", "auto"),
      readOnlyMode: this.readOnlyMode,
    };
  }

  private readConfiguredDomain(): string {
    return vscode.workspace.getConfiguration("agentbridge").get<string>(NGROK_DOMAIN_SETTING, "").trim();
  }

  private readConfiguredNamedDomain(): string {
    return vscode.workspace.getConfiguration("agentbridge").get<string>(CLOUDFLARE_NAMED_DOMAIN_SETTING, "").trim();
  }

  private readNamedTunnelLocalPort(): number {
    const value = vscode.workspace.getConfiguration("agentbridge").get<number>(CLOUDFLARE_NAMED_LOCAL_PORT_SETTING, DEFAULT_CLOUDFLARE_NAMED_LOCAL_PORT);
    try {
      return normalizeNamedTunnelLocalPort(value);
    } catch {
      return DEFAULT_CLOUDFLARE_NAMED_LOCAL_PORT;
    }
  }

  private configuredDomainForProvider(provider: BridgeTunnelProvider): string {
    return provider === "ngrok" ? this.configuredDomain : provider === "cloudflare-named" ? this.configuredNamedDomain : "";
  }

  private readTunnelProvider(): BridgeTunnelProvider {
    const provider = vscode.workspace.getConfiguration("agentbridge").get<BridgeTunnelProvider>(TUNNEL_PROVIDER_SETTING, "cloudflare");
    return provider === "ngrok" || provider === "cloudflare-named" ? provider : "cloudflare";
  }

  private readReadOnlyMode(): boolean {
    return vscode.workspace.getConfiguration("agentbridge.bridge").get<boolean>("readOnlyMode", false);
  }

  /**
   * Hot-apply read-only mode without restarting the Bridge. The tools/list
   * filter takes effect for the next list request; the hard block in
   * handleToolCall covers clients that cached the old tool list, so toggling
   * is safe at any time.
   */
  setReadOnlyMode(enabled: boolean): void {
    this.readOnlyMode = enabled;
    this.output.appendLine(`[bridge] read-only mode ${enabled ? "enabled" : "disabled"}`);
  }

  private readPersistedDomain(): string {
    return this.context.globalState.get<string>(NGROK_DOMAIN_STATE_KEY, "").trim();
  }

  private readPersistedNamedDomain(): string {
    return this.context.globalState.get<string>(CLOUDFLARE_NAMED_DOMAIN_STATE_KEY, "").trim();
  }

  /**
   * Restore the Bridge domain from either VS Code configuration or the extension's own
   * persistent memento. The memento is intentionally a second source of truth because
   * carrier/user-data migrations can temporarily present an empty configuration value on
   * startup. Whichever store still has the domain repairs the other one.
   */
  private async restorePersistedDomain(): Promise<void> {
    const configured = this.readConfiguredDomain();
    const persisted = this.readPersistedDomain();
    const candidate = configured || persisted;
    if (!candidate) return;

    this.configuredDomain = normalizeNgrokDomain(candidate);
    if (persisted !== this.configuredDomain) {
      await this.context.globalState.update(NGROK_DOMAIN_STATE_KEY, this.configuredDomain);
    }
    if (configured !== this.configuredDomain) {
      try {
        await vscode.workspace.getConfiguration("agentbridge").update(NGROK_DOMAIN_SETTING, this.configuredDomain, vscode.ConfigurationTarget.Global);
      } catch (error) {
        this.output.appendLine(`[bridge] could not repair ngrok domain setting: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private restoreConfiguredDomain(): void {
    const candidate = this.readConfiguredDomain() || this.readPersistedDomain();
    if (!candidate) return;
    try {
      this.configuredDomain = normalizeNgrokDomain(candidate);
    } catch {
      // Keep the last known-good in-memory value. Invalid external settings should not erase it.
    }
  }

  private async persistDomain(domain: string): Promise<void> {
    this.configuredDomain = normalizeNgrokDomain(domain);
    if (this.tunnelProvider === "ngrok") this.domain = this.configuredDomain;

    // Persist to the extension memento first so a configuration write failure cannot make the
    // domain disappear after a restart.
    await this.context.globalState.update(NGROK_DOMAIN_STATE_KEY, this.configuredDomain);
    try {
      await vscode.workspace.getConfiguration("agentbridge").update(NGROK_DOMAIN_SETTING, this.configuredDomain, vscode.ConfigurationTarget.Global);
    } catch (error) {
      this.output.appendLine(`[bridge] ngrok domain saved to extension state, but settings.json update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async configure(domain: string): Promise<BridgeStatus> {
    if (this.state === "running" || this.state === "starting") {
      throw new Error("Stop the Bridge before changing its ngrok domain.");
    }
    await this.persistDomain(domain);
    this.lastError = undefined;
    return this.getStatus();
  }

  private async restorePersistedNamedDomain(): Promise<void> {
    const configured = this.readConfiguredNamedDomain();
    const persisted = this.readPersistedNamedDomain();
    const candidate = configured || persisted;
    if (!candidate) return;

    this.configuredNamedDomain = normalizeCloudflareNamedDomain(candidate);
    if (persisted !== this.configuredNamedDomain) {
      await this.context.globalState.update(CLOUDFLARE_NAMED_DOMAIN_STATE_KEY, this.configuredNamedDomain);
    }
    if (configured !== this.configuredNamedDomain) {
      try {
        await vscode.workspace.getConfiguration("agentbridge").update(CLOUDFLARE_NAMED_DOMAIN_SETTING, this.configuredNamedDomain, vscode.ConfigurationTarget.Global);
      } catch (error) {
        this.output.appendLine(`[bridge] could not repair Cloudflare Named Tunnel hostname setting: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private restoreConfiguredNamedDomain(): void {
    const candidate = this.readConfiguredNamedDomain() || this.readPersistedNamedDomain();
    if (!candidate) return;
    try {
      this.configuredNamedDomain = normalizeCloudflareNamedDomain(candidate);
    } catch {
      // Keep the last known-good in-memory value. Invalid external settings should not erase it.
    }
  }

  async configureNamedTunnel(input: { domain: string; token?: string; localPort: number }): Promise<BridgeStatus> {
    if (this.state === "running" || this.state === "starting") {
      throw new Error("Stop the Bridge before changing its Cloudflare Named Tunnel configuration.");
    }
    const domain = normalizeCloudflareNamedDomain(input.domain);
    const localPort = normalizeNamedTunnelLocalPort(input.localPort);
    const token = input.token?.trim();
    if (token !== undefined && !token) throw new Error("Cloudflare Tunnel Token cannot be empty.");

    this.configuredNamedDomain = domain;
    this.namedTunnelLocalPort = localPort;
    await this.context.globalState.update(CLOUDFLARE_NAMED_DOMAIN_STATE_KEY, domain);
    await vscode.workspace.getConfiguration("agentbridge").update(CLOUDFLARE_NAMED_DOMAIN_SETTING, domain, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration("agentbridge").update(CLOUDFLARE_NAMED_LOCAL_PORT_SETTING, localPort, vscode.ConfigurationTarget.Global);
    if (token !== undefined) {
      this.namedTunnelToken = token;
      await this.context.secrets.store(CLOUDFLARE_NAMED_TOKEN_SECRET, token);
    }
    if (this.tunnelProvider === "cloudflare-named") this.domain = domain;
    this.tunnelConfigValid = undefined;
    this.lastError = undefined;
    return await this.checkNamedTunnel();
  }

  async clearNamedTunnelToken(): Promise<BridgeStatus> {
    if (this.state === "running" || this.state === "starting") {
      throw new Error("Stop the Bridge before clearing its Cloudflare Tunnel Token.");
    }
    this.namedTunnelToken = "";
    await this.context.secrets.delete(CLOUDFLARE_NAMED_TOKEN_SECRET);
    this.tunnelConfigValid = false;
    this.lastError = "Cloudflare Named Tunnel Token is not configured.";
    return this.getStatus();
  }

  async setTunnelProvider(provider: string): Promise<BridgeStatus> {
    if (this.state === "running" || this.state === "starting") {
      throw new Error("Stop the Bridge before changing its tunnel provider.");
    }
    if (provider !== "cloudflare" && provider !== "cloudflare-named" && provider !== "ngrok") {
      throw new Error("Bridge tunnel provider must be cloudflare, cloudflare-named, or ngrok.");
    }
    this.tunnelProvider = provider;
    this.domain = this.configuredDomainForProvider(provider);
    this.tunnelInstalled = undefined;
    this.tunnelVersion = undefined;
    this.tunnelConfigValid = undefined;
    this.lastError = undefined;
    await vscode.workspace.getConfiguration("agentbridge").update(TUNNEL_PROVIDER_SETTING, provider, vscode.ConfigurationTarget.Global);
    return this.getStatus();
  }

  async rotateEndpoint(): Promise<BridgeStatus> {
    if (this.state === "running" || this.state === "starting") {
      throw new Error("Stop the Bridge before rotating its endpoint URL.");
    }
    this.routeToken = randomBytes(16).toString("hex");
    await this.context.secrets.store(ROUTE_TOKEN_SECRET, this.routeToken);
    return this.getStatus();
  }

  async checkTunnel(): Promise<BridgeStatus> {
    this.tunnelProvider = this.readTunnelProvider();
    return this.tunnelProvider === "ngrok"
      ? await this.checkNgrok()
      : this.tunnelProvider === "cloudflare-named"
        ? await this.checkNamedTunnel()
        : await this.checkCloudflared();
  }

  async checkNgrok(): Promise<BridgeStatus> {
    try {
      const version = await execFileAsync("ngrok", ["version"], { windowsHide: true, timeout: 10_000 });
      this.tunnelInstalled = true;
      this.tunnelVersion = String(version.stdout || version.stderr).trim().split(/\r?\n/)[0] || "ngrok";
    } catch (error) {
      this.tunnelInstalled = false;
      this.tunnelConfigValid = false;
      this.tunnelVersion = undefined;
      this.lastError = `ngrok was not found: ${error instanceof Error ? error.message : String(error)}`;
      return this.getStatus();
    }

    try {
      await execFileAsync("ngrok", ["config", "check"], { windowsHide: true, timeout: 10_000 });
      this.tunnelConfigValid = true;
      this.lastError = undefined;
    } catch (error) {
      this.tunnelConfigValid = false;
      this.lastError = `ngrok config check failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    return this.getStatus();
  }

  private async checkCloudflared(): Promise<BridgeStatus> {
    let lastError: unknown;
    for (const executable of this.cloudflaredExecutableCandidates()) {
      try {
        const version = await execFileAsync(executable, ["--version"], { windowsHide: true, timeout: 10_000 });
        this.cloudflaredExecutable = executable;
        this.tunnelInstalled = true;
        this.tunnelVersion = String(version.stdout || version.stderr).trim().split(/\r?\n/)[0] || "cloudflared";
        this.tunnelConfigValid = true;
        this.lastError = undefined;
        return this.getStatus();
      } catch (error) {
        lastError = error;
      }
    }
    this.tunnelInstalled = false;
    this.tunnelConfigValid = false;
    this.tunnelVersion = undefined;
    this.lastError = `cloudflared was not found: ${lastError instanceof Error ? lastError.message : String(lastError ?? "not installed")}`;
    return this.getStatus();
  }

  private async checkNamedTunnel(): Promise<BridgeStatus> {
    await this.checkCloudflared();
    if (!this.tunnelInstalled) return this.getStatus();

    this.namedTunnelToken = await this.context.secrets.get(CLOUDFLARE_NAMED_TOKEN_SECRET) ?? "";
    this.restoreConfiguredNamedDomain();
    this.namedTunnelLocalPort = this.readNamedTunnelLocalPort();
    this.domain = this.configuredNamedDomain;

    if (!this.namedTunnelToken) {
      this.tunnelConfigValid = false;
      this.lastError = "Cloudflare Named Tunnel Token is not configured.";
      return this.getStatus();
    }
    if (!this.configuredNamedDomain) {
      this.tunnelConfigValid = false;
      this.lastError = "Cloudflare Named Tunnel hostname is not configured.";
      return this.getStatus();
    }
    try {
      this.namedTunnelLocalPort = normalizeNamedTunnelLocalPort(this.namedTunnelLocalPort);
    } catch (error) {
      this.tunnelConfigValid = false;
      this.lastError = error instanceof Error ? error.message : String(error);
      return this.getStatus();
    }

    this.tunnelConfigValid = true;
    this.lastError = undefined;
    return this.getStatus();
  }

  private cloudflaredExecutableCandidates(): string[] {
    const candidates = [this.cloudflaredExecutable, "cloudflared"];
    if (process.platform === "win32") {
      if (process.env.LOCALAPPDATA) {
        candidates.push(path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "cloudflared.exe"));
        candidates.push(path.join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "cloudflared.exe"));
      }
      if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, "cloudflared", "cloudflared.exe"));
      if (process.env["ProgramFiles(x86)"]) candidates.push(path.join(process.env["ProgramFiles(x86)"]!, "cloudflared", "cloudflared.exe"));
    }
    return [...new Set(candidates.filter(Boolean))];
  }

  async installCloudflared(): Promise<BridgeStatus> {
    if (this.state === "running" || this.state === "starting") {
      throw new Error("Stop the Bridge before installing cloudflared.");
    }
    this.tunnelProvider = this.readTunnelProvider();
    if (this.tunnelProvider !== "cloudflare" && this.tunnelProvider !== "cloudflare-named") {
      throw new Error("Select a Cloudflare tunnel mode before installing cloudflared.");
    }
    const existing = await this.checkCloudflared();
    if (existing.tunnelInstalled) return this.tunnelProvider === "cloudflare-named" ? await this.checkNamedTunnel() : existing;
    if (process.platform !== "win32") {
      throw new Error("One-click cloudflared installation is currently supported on Windows with Winget.");
    }

    this.output.appendLine(`[bridge] installing cloudflared with Winget package ${CLOUDFLARED_WINGET_PACKAGE}...`);
    try {
      const result = await execFileAsync("winget", [
        "install",
        "--id", CLOUDFLARED_WINGET_PACKAGE,
        "--exact",
        "--source", "winget",
        "--silent",
        "--disable-interactivity",
        "--accept-package-agreements",
        "--accept-source-agreements",
      ], {
        windowsHide: false,
        timeout: 10 * 60 * 1000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const output = String(result.stdout || result.stderr).trim();
      if (output) this.output.appendLine(`[winget] ${output}`);
    } catch (error) {
      const details = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer };
      const output = [details.message, String(details.stdout ?? "").trim(), String(details.stderr ?? "").trim()].filter(Boolean).join("\n");
      this.lastError = `cloudflared installation failed: ${output}`;
      throw new Error(this.lastError);
    }

    const installed = await this.checkCloudflared();
    if (!installed.tunnelInstalled) {
      this.lastError = "cloudflared installation completed, but AgentBridge could not locate the executable. Restart the extension and check the tunnel again.";
      throw new Error(this.lastError);
    }
    this.output.appendLine(`[bridge] cloudflared installation verified: ${installed.tunnelVersion ?? "installed"}`);
    return this.tunnelProvider === "cloudflare-named" ? await this.checkNamedTunnel() : installed;
  }

  async start(domain?: string): Promise<BridgeStatus> {
    if (this.state === "running") return this.getStatus();
    if (this.startPromise) return this.startPromise;
    // During automatic tunnel recovery the local HTTP/MCP runtime is intentionally kept alive.
    // A manual Start click must not create a second listener/tunnel while that recovery owns it.
    if (this.state === "starting" && this.httpServer) return this.getStatus();
    this.startPromise = this.startInternal(domain);
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  /** Development-only transport smoke: opens the exact local Streamable HTTP MCP server without a public tunnel. */
  async startLocalSmoke(): Promise<BridgeStatus> {
    if (this.context.extensionMode !== vscode.ExtensionMode.Development || process.env.AGENTBRIDGE_BRIDGE_SMOKE_LOCAL !== "1") {
      throw new Error("Local Bridge smoke mode is available only in an Extension Development Host with AGENTBRIDGE_BRIDGE_SMOKE_LOCAL=1.");
    }
    if (this.state === "running") return this.getStatus();
    if (!this.routeToken) await this.initialize();
    if (!vscode.workspace.workspaceFolders?.length) throw new Error("Open a workspace folder before starting the Bridge smoke server.");
    this.state = "starting";
    this.lastError = undefined;
    try {
      await this.startHttpServer();
      this.state = "running";
      this.output.appendLine(`[bridge-smoke] local Streamable HTTP server running on 127.0.0.1:${this.localPort}`);
      return this.getStatus();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.state = "error";
      await this.stopResources(false);
      throw error;
    }
  }

  private async startInternal(domain?: string): Promise<BridgeStatus> {
    // Final defense-in-depth boundary. Authorization happens before state changes,
    // local TCP listeners, MCP sessions, or tunnel processes are created.
    try {
      await this.authorizeStart();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.state = "error";
      throw error;
    }
    this.stoppingResources = false;
    this.state = "starting";
    this.lastError = undefined;
    try {
      if (!this.routeToken) await this.initialize();
      this.tunnelProvider = this.readTunnelProvider();
      if (this.tunnelProvider === "ngrok") {
        const resolvedDomain = domain ?? (this.configuredDomain || this.readConfiguredDomain() || this.readPersistedDomain());
        await this.persistDomain(resolvedDomain);
      } else if (this.tunnelProvider === "cloudflare-named") {
        this.namedTunnelToken = await this.context.secrets.get(CLOUDFLARE_NAMED_TOKEN_SECRET) ?? "";
        this.restoreConfiguredNamedDomain();
        this.namedTunnelLocalPort = this.readNamedTunnelLocalPort();
        this.domain = this.configuredNamedDomain;
      } else {
        this.domain = "";
      }

      const folders = vscode.workspace.workspaceFolders;
      if (!folders?.length) throw new Error("Open a workspace folder before starting the Bridge.");

      const tunnel = await this.checkTunnel();
      if (!tunnel.tunnelInstalled) throw new Error(this.lastError ?? `${this.tunnelProvider} tunnel client is not installed.`);
      if (!tunnel.tunnelConfigValid) throw new Error(this.lastError ?? `${this.tunnelProvider} tunnel configuration is invalid.`);

      await this.startHttpServer();
      await this.startTunnelOnce();

      this.state = "running";
      const publicUrl = this.getStatus().publicUrl;
      this.output.appendLine(`[bridge] running ${publicUrl} -> 127.0.0.1:${this.localPort}`);
      return this.getStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.state = "error";
      await this.stopResources(false);
      throw error;
    }
  }

  private async startHttpServer(): Promise<void> {
    const endpointPath = `/mcp/${this.routeToken}`;
    const healthPath = `/healthz/${this.routeToken}`;
    const server = createHttpServer((request, response) => {
      void this.handleHttpRequest(endpointPath, healthPath, request, response).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.output.appendLine(`[bridge] HTTP error: ${message}`);
        writeJsonError(response, 500, message);
      });
    });
    this.httpServer = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error & { code?: string }) => {
        server.off("listening", onListening);
        if (this.tunnelProvider === "cloudflare-named" && error.code === "EADDRINUSE") {
          reject(new Error(`Cloudflare Named Tunnel local port ${this.namedTunnelLocalPort} is already in use. Choose another port and update the Cloudflare published application Service URL.`));
          return;
        }
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.tunnelProvider === "cloudflare-named" ? this.namedTunnelLocalPort : 0, "127.0.0.1");
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Bridge local HTTP server did not expose a TCP port.");
    this.localPort = address.port;
    this.sessionPruneTimer = setInterval(() => this.pruneSessions(), SESSION_PRUNE_INTERVAL_MS);
    this.sessionPruneTimer.unref?.();
  }

  private startTunnelProcess(): ChildProcessWithoutNullStreams {
    if (!this.localPort) throw new Error("Bridge local HTTP port is unavailable.");
    const isCloudflare = this.tunnelProvider === "cloudflare" || this.tunnelProvider === "cloudflare-named";
    const command = isCloudflare ? this.cloudflaredExecutable : "ngrok";
    const commandLabel = isCloudflare ? "cloudflared" : "ngrok";
    const args = this.tunnelProvider === "cloudflare"
      ? ["tunnel", "--url", `http://127.0.0.1:${this.localPort}`]
      : this.tunnelProvider === "cloudflare-named"
        ? ["tunnel", "run"]
        : ["http", String(this.localPort), "--url", `https://${this.configuredDomain}`, "--log=stdout", "--log-format=json"];
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.tunnelProvider === "cloudflare-named"
        ? { ...process.env, TUNNEL_TOKEN: this.namedTunnelToken }
        : process.env,
    });
    this.tunnelProcess = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.output.append(`[${commandLabel}] ${String(chunk)}`));
    child.stderr.on("data", (chunk) => this.output.append(`[${commandLabel}] ${String(chunk)}`));
    child.on("error", (error) => {
      this.output.appendLine(`[${commandLabel}] process error: ${error.message}`);
      this.lastError = error.message;
      if (this.tunnelProcess === child && !this.stoppingResources && this.httpServer && this.state === "running") {
        this.tunnelProcess = undefined;
        if (this.tunnelProvider === "cloudflare") this.domain = "";
        this.state = "starting";
        this.revision += 1;
        if (!child.killed) child.kill();
        this.beginTunnelRecovery();
      }
    });
    child.on("exit", (code, signal) => {
      if (this.tunnelProcess === child) this.tunnelProcess = undefined;
      if (!this.stoppingResources && this.httpServer && this.state === "running") {
        const message = `${commandLabel} exited unexpectedly (code=${String(code)}, signal=${String(signal)}); reconnecting without stopping the local MCP server.`;
        this.output.appendLine(`[bridge] ${message}`);
        this.lastError = message;
        if (this.tunnelProvider === "cloudflare") this.domain = "";
        this.state = "starting";
        this.revision += 1;
        this.beginTunnelRecovery();
      }
    });
    return child;
  }

  private async waitForTunnelStartup(child: ChildProcessWithoutNullStreams): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let output = "";
      const cleanup = () => {
        clearTimeout(timer);
        child.off("exit", onExit);
        child.off("error", onError);
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error); else resolve();
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        const detail = output.trim().slice(-4_000);
        finish(new Error(`${this.tunnelProvider} tunnel exited during startup (code=${String(code)}, signal=${String(signal)}).${detail ? ` ${detail}` : ""}`));
      };
      const onError = (error: Error) => finish(error);
      const onData = (chunk: Buffer | string) => {
        output = `${output}${String(chunk)}`.slice(-16_000);
        const lower = output.toLowerCase();
        if (this.tunnelProvider === "cloudflare") {
          const matches = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/ig);
          const tunnelUrl = matches?.find((candidate) => new URL(candidate).hostname.toLowerCase() !== "api.trycloudflare.com");
          if (tunnelUrl) {
            this.domain = new URL(tunnelUrl).hostname.toLowerCase();
            this.revision += 1;
            finish();
          }
          return;
        }
        if (this.tunnelProvider === "cloudflare-named") {
          if (lower.includes("invalid tunnel token") || lower.includes("failed to parse token") || lower.includes("authentication failed") || lower.includes("unauthorized")) {
            finish(new Error(`Cloudflare Named Tunnel authentication failed. Rotate or recopy the Tunnel Token. ${output.trim().slice(-4_000)}`));
            return;
          }
          if (lower.includes("registered tunnel connection") || lower.includes("connection registered") || lower.includes("initial protocol")) {
            finish();
          }
          return;
        }
        if (lower.includes('"msg":"started tunnel"') && lower.includes(this.configuredDomain.toLowerCase())) {
          finish();
          return;
        }
        if (lower.includes("err_ngrok_") || lower.includes("endpoint is already online") || lower.includes("failed to start tunnel")) {
          finish(new Error(`ngrok failed to establish the reserved domain. ${output.trim().slice(-4_000)}`));
        }
      };
      child.once("exit", onExit);
      child.once("error", onError);
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      // Public HTTPS health is the source of truth. Quick Tunnel must emit its generated hostname;
      // Named Tunnel and ngrok log wording can vary between releases.
      const timer = setTimeout(() => {
        if (this.tunnelProvider === "cloudflare") {
          finish(new Error(`cloudflared did not provide a trycloudflare.com URL. ${output.trim().slice(-4_000)}`));
        } else {
          finish();
        }
      }, 45_000);
    });
  }

  private publicHealthUrl(): string {
    return `https://${this.domain}/healthz/${this.routeToken}`;
  }

  private async requestPublicHealth(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PUBLIC_HEALTH_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(this.publicHealthUrl(), {
        method: "GET",
        cache: "no-store",
        headers: this.tunnelProvider === "ngrok" ? { "ngrok-skip-browser-warning": "true" } : undefined,
        signal: controller.signal,
      });
      if (!response.ok) {
        this.output.appendLine(`[bridge] health check system-DNS failed: HTTP ${response.status}`);
        return false;
      }
      const payload = await response.json().catch(() => undefined) as { ok?: unknown } | undefined;
      if (payload?.ok !== true) {
        this.output.appendLine(`[bridge] health check system-DNS failed: payload.ok !== true (${JSON.stringify(payload)})`);
      }
      return payload?.ok === true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[bridge] health check system-DNS error: ${reason}; trying DoH fallback...`);
      const ok = await this.requestPublicHealthViaDoh();
      this.output.appendLine(`[bridge] health check DoH fallback result: ${ok}`);
      return ok;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Resolve the tunnel hostname through DoH and retry the health request
   * against the resolved IP. Fallback for networks whose DNS cannot resolve
   * *.trycloudflare.com wildcard subdomains (e.g. campus/corporate DNS).
   * Uses node:https directly with SNI + Host headers so TLS verification
   * still runs against the real hostname. */
  private async requestPublicHealthViaDoh(): Promise<boolean> {
    const hostname = this.domain;
    if (!hostname) return false;
    const ip = await this.resolveHostViaDoh(hostname);
    if (!ip) {
      this.output.appendLine(`[bridge] DoH fallback: could not resolve ${hostname} via any DoH endpoint`);
      return false;
    }
    this.output.appendLine(`[bridge] DoH fallback: ${hostname} -> ${ip}, sending direct health request...`);
    const { request } = await import("node:https");
    return await new Promise<boolean>((resolve) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PUBLIC_HEALTH_REQUEST_TIMEOUT_MS);
      const req = request(
        {
          hostname: ip,
          port: 443,
          servername: hostname,
          path: `/healthz/${this.routeToken}`,
          method: "GET",
          headers: {
            Host: hostname,
            ...(this.tunnelProvider === "ngrok" ? { "ngrok-skip-browser-warning": "true" } : {}),
          },
          signal: controller.signal,
        },
        (response) => {
          if (!response.statusCode || response.statusCode >= 400) {
            this.output.appendLine(`[bridge] DoH fallback: direct request got HTTP ${response.statusCode ?? "none"}`);
            resolve(false);
            return;
          }
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => (body += chunk));
          response.on("end", () => {
            try {
              const payload = JSON.parse(body) as { ok?: unknown } | undefined;
              resolve(payload?.ok === true);
            } catch {
              resolve(false);
            }
          });
        },
      );
      req.on("error", (error) => {
        this.output.appendLine(`[bridge] DoH fallback: direct request error: ${error instanceof Error ? error.message : String(error)}`);
        resolve(false);
      });
      req.on("close", () => clearTimeout(timer));
      req.end();
    });
  }

  /** Ask a DoH endpoint for an A record of the given hostname. Caches the
   * result briefly to avoid hammering the DoH server during startup retries. */
  private async resolveHostViaDoh(hostname: string): Promise<string | null> {
    if (this.dohCache.hostname === hostname && Date.now() - this.dohCache.at < PUBLIC_HEALTH_DOH_CACHE_TTL_MS) {
      return this.dohCache.ip;
    }
    for (const endpoint of PUBLIC_HEALTH_DOH_ENDPOINTS) {
      try {
        const url = `${endpoint}?name=${encodeURIComponent(hostname)}&type=A`;
        const response = await fetch(url, {
          headers: endpoint.includes("dns-query") ? { accept: "application/dns-json" } : undefined,
        });
        if (!response.ok) continue;
        const payload = await response.json() as { Answer?: Array<{ type: number; data: string }> };
        const record = payload.Answer?.find((answer) => answer.type === 1);
        if (record?.data) {
          this.dohCache = { hostname, ip: record.data, at: Date.now() };
          return record.data;
        }
      } catch {
        // try the next DoH endpoint
      }
    }
    return null;
  }

  private dohCache: { hostname: string; ip: string; at: number } = { hostname: "", ip: "", at: 0 };

  private async waitForPublicHealth(child: ChildProcessWithoutNullStreams): Promise<void> {
    const deadline = Date.now() + PUBLIC_HEALTH_STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null || this.tunnelProcess !== child) {
        throw new Error(`${this.tunnelProvider} tunnel exited before the public Bridge health endpoint became reachable.`);
      }
      if (await this.requestPublicHealth()) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 750));
    }
    if (this.tunnelProvider === "cloudflare-named") {
      throw new Error(`Cloudflare Named Tunnel connected, but ${this.publicHealthUrl()} could not reach Bridge. In Cloudflare Tunnels, set the published application hostname to ${this.configuredNamedDomain} and its Service URL to http://127.0.0.1:${this.namedTunnelLocalPort}.`);
    }
    throw new Error(`Public Bridge health check timed out after ${Math.round(PUBLIC_HEALTH_STARTUP_TIMEOUT_MS / 1000)} seconds: ${this.publicHealthUrl()}`);
  }

  private async startTunnelOnce(): Promise<void> {
    const child = this.startTunnelProcess();
    try {
      await this.waitForTunnelStartup(child);
      await this.waitForPublicHealth(child);
      if (this.tunnelProcess !== child) throw new Error(`${this.tunnelProvider} tunnel changed before health verification completed.`);
      this.output.appendLine(`[bridge] public health verified: ${this.publicHealthUrl()}`);
    } catch (error) {
      if (this.tunnelProcess === child) this.tunnelProcess = undefined;
      if (!child.killed) child.kill();
      throw error;
    }
  }

  private beginTunnelRecovery(): void {
    if (this.stoppingResources || !this.httpServer) return;
    if (this.tunnelRecoveryPromise && this.tunnelRecoveryGeneration === this.tunnelGeneration) return;
    const generation = this.tunnelGeneration;
    const recovery = (async () => {
      let attempt = 0;
      while (!this.stoppingResources && this.httpServer && generation === this.tunnelGeneration) {
        const delayMs = TUNNEL_RESTART_BACKOFF_MS[Math.min(attempt, TUNNEL_RESTART_BACKOFF_MS.length - 1)];
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        if (this.stoppingResources || !this.httpServer || generation !== this.tunnelGeneration) return;
        try {
          this.output.appendLine(`[bridge] ${this.tunnelProvider} reconnect attempt ${attempt + 1}...`);
          await this.startTunnelOnce();
          if (generation !== this.tunnelGeneration || this.stoppingResources) return;
          this.state = "running";
          this.lastError = undefined;
          this.revision += 1;
          this.output.appendLine(`[bridge] ${this.tunnelProvider} tunnel recovered: ${this.getStatus().publicUrl}`);
          return;
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : String(error);
          this.output.appendLine(`[bridge] ${this.tunnelProvider} reconnect attempt ${attempt + 1} failed: ${this.lastError}`);
          attempt += 1;
        }
      }
    });
    let trackedRecovery!: Promise<void>;
    trackedRecovery = recovery().finally(() => {
      if (this.tunnelRecoveryPromise === trackedRecovery) {
        this.tunnelRecoveryPromise = undefined;
        this.tunnelRecoveryGeneration = undefined;
      }
    });
    this.tunnelRecoveryGeneration = generation;
    this.tunnelRecoveryPromise = trackedRecovery;
  }

  private async handleHttpRequest(endpointPath: string, healthPath: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === healthPath) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        writeJsonError(response, 405, "Method not allowed.");
        return;
      }
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.writeHead(200);
      if (request.method !== "HEAD") {
        response.end(JSON.stringify({ ok: true, name: "agentbridge", sessions: this.sessions.size }));
      } else {
        response.end();
      }
      return;
    }
    if (url.pathname !== endpointPath) {
      writeJsonError(response, 404, "Not found");
      return;
    }

    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "content-type, accept, mcp-session-id, mcp-protocol-version, mcp-method, mcp-name, last-event-id, authorization");
    response.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
    response.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }

    // Route to existing session by mcp-session-id header
    const sessionId = request.headers["mcp-session-id"] as string | undefined;

    if (request.method === "POST") {
      const body = await readJsonBody(request);
      await this.handlePost(request, response, body, sessionId);
      return;
    }

    if (request.method === "GET") {
      await this.handleGet(request, response, sessionId);
      return;
    }

    if (request.method === "DELETE") {
      await this.handleDelete(request, response, sessionId);
      return;
    }

    writeJsonError(response, 405, "Method not allowed.");
  }

  private async handlePost(request: IncomingMessage, response: ServerResponse, body: unknown, sessionId: string | undefined): Promise<void> {
    // If sessionId is provided, route to existing session
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        writeJsonError(response, 404, "Session not found. The MCP session may have expired.");
        return;
      }
      session.lastActivity = Date.now();
      session.activeRequests += 1;
      this.activeRequests += 1;
      try {
        await session.transport.handleRequest(request, response, body);
      } finally {
        session.activeRequests = Math.max(0, session.activeRequests - 1);
        session.lastActivity = Date.now();
        this.activeRequests = Math.max(0, this.activeRequests - 1);
      }
      return;
    }

    if (!isInitializeRequest(body)) {
      writeJsonError(response, 400, "Bad Request: a POST without Mcp-Session-Id must be an MCP initialize request.");
      return;
    }
    this.makeRoomForSession();
    if (this.sessions.size >= MAX_SESSIONS) {
      writeJsonError(response, 503, "Bridge session capacity reached. Close an existing MCP session and retry.");
      return;
    }

    // No session ID: validated initialization request. Create a new session.
    const { transport, server } = this.createSession();
    this.activeRequests += 1;
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      // If session creation failed during initialization, clean up
      const newSessionId = transport.sessionId;
      if (newSessionId) this.destroySession(newSessionId);
      throw error;
    } finally {
      this.activeRequests = Math.max(0, this.activeRequests - 1);
    }
  }

  private async handleGet(request: IncomingMessage, response: ServerResponse, sessionId: string | undefined): Promise<void> {
    if (this.tunnelProvider === "cloudflare") {
      response.setHeader("Allow", "POST, DELETE, OPTIONS");
      writeJsonError(response, 405, "Standalone SSE is disabled for Cloudflare Quick Tunnel; use Streamable HTTP POST responses.");
      return;
    }
    if (!sessionId) {
      writeJsonError(response, 400, "Bad Request: Mcp-Session-Id header is required for GET requests.");
      return;
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      writeJsonError(response, 404, "Session not found. The MCP session may have expired.");
      return;
    }
    session.lastActivity = Date.now();
    session.activeStreams += 1;
    let released = false;
    const releaseStream = () => {
      if (released) return;
      released = true;
      session.activeStreams = Math.max(0, session.activeStreams - 1);
      session.lastActivity = Date.now();
    };
    response.once("close", releaseStream);
    try {
      await session.transport.handleRequest(request, response);
    } finally {
      response.off("close", releaseStream);
      releaseStream();
    }
  }

  private async handleDelete(request: IncomingMessage, response: ServerResponse, sessionId: string | undefined): Promise<void> {
    if (!sessionId) {
      writeJsonError(response, 400, "Bad Request: Mcp-Session-Id header is required for DELETE requests.");
      return;
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      writeJsonError(response, 404, "Session not found.");
      return;
    }
    await session.transport.handleRequest(request, response);
    this.destroySession(sessionId);
  }

  private createSession(): { transport: StreamableHTTPServerTransport; server: McpServer } {
    const instructions = this.readOnlyMode
      ? `${BRIDGE_SERVER_INSTRUCTIONS}\n\nRead-only mode is ACTIVE: apply_patch, run_command, and send_command_input are disabled. Do not attempt file modifications or command execution; report findings and proposed changes to the user instead.`
      : BRIDGE_SERVER_INSTRUCTIONS;
    const server = new McpServer(
      { name: "agentbridge", version: "0.1.4" },
      { capabilities: { tools: {}, logging: {} }, instructions },
    );
    let transport!: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: this.tunnelProvider === "cloudflare",
      eventStore: new BoundedInMemoryEventStore(),
      keepAliveMs: SESSION_KEEPALIVE_INTERVAL_MS,
      retryInterval: SESSION_RETRY_INTERVAL_MS,
      onsessioninitialized: (sid) => {
        this.sessions.set(sid, {
          transport,
          server,
          lastActivity: Date.now(),
          activeRequests: 0,
          activeStreams: 0,
        });
        this.revision += 1;
        this.output.appendLine(`[bridge] new MCP session: ${sid}`);
      },
      onsessionclosed: (sid) => {
        this.destroySession(sid);
      },
    });

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const shell = getManagedShellChoice();
      return {
        tools: BRIDGE_TOOL_DEFINITIONS
          .filter((tool) => !this.readOnlyMode || !READ_ONLY_BLOCKED_TOOL_NAMES.has(tool.name))
          .map((tool) => ({
            name: tool.name,
            description: tool.description
              .replace("${RUNTIME_SHELL_DESCRIPTION}", shell.description)
              .replace("${RUNTIME_SHELL_SYNTAX_HINT}", shell.syntaxHint),
            inputSchema: tool.inputSchema,
          })),
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const toolName = request.params.name;
      const result = await this.handleToolCall(toolName, request.params.arguments ?? {}, { signal: extra.signal, sessionId: transport.sessionId ?? undefined });
      return {
        content: result.content,
        isError: result.isError,
        structuredContent: result.structuredContent as Record<string, unknown> | undefined,
      } as CallToolResult;
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) this.destroySession(sid);
    };

    return { transport, server };
  }

  private async handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
    extra: { signal?: AbortSignal; sessionId?: string },
  ): Promise<{ content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError?: boolean; structuredContent?: Record<string, unknown> }> {
    if (this.readOnlyMode && READ_ONLY_BLOCKED_TOOL_NAMES.has(toolName)) {
      const errorMsg = `Tool ${toolName} is disabled in read-only mode. AgentBridge is currently running with modifications and command execution blocked.`;
      const activityId = this.pushActivity({
        tool: toolName,
        status: "running",
        presentation: bridgePresentation(toolName, args),
        sessionId: extra.sessionId,
      });
      this.finishActivity(activityId, "error", 0, errorMsg, bridgePresentation(toolName, args, errorMsg, undefined, true));
      return {
        content: [{ type: "text" as const, text: errorMsg }],
        isError: true,
      };
    }
    if (toolName === SET_TODOS_TOOL.name) {
      return this.handleSetTodos(args);
    }
    if (toolName === REPORT_PROGRESS_TOOL.name) {
      return this.handleReportProgress(args, extra.sessionId);
    }

    const activityId = this.pushActivity({
      tool: toolName,
      status: "running",
      presentation: bridgePresentation(toolName, args),
      sessionId: extra.sessionId,
    });
    const startedAt = Date.now();
    try {
      if (isFileToolName(toolName)) {
        const result = await invokeFileTool(toolName, args, {
          workspaceRoots: this.workspaceRoots(),
          signal: extra.signal,
        });
        this.finishActivity(
          activityId,
          "completed",
          Date.now() - startedAt,
          undefined,
          bridgePresentation(toolName, args, result.text, result.structuredContent as Record<string, unknown>),
        );
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
          { type: "text" as const, text: result.text },
        ];
        if (result.images) {
          for (const img of result.images) {
            content.push({ type: "image" as const, data: img.base64, mimeType: img.mimeType });
          }
        }
        return {
          content,
          structuredContent: result.structuredContent as Record<string, unknown>,
        };
      }

      if (BRIDGE_EXCLUDED_TOOL_NAMES.has(toolName)) {
        throw new Error(`The ${toolName} tool is not available in Bridge mode.`);
      }

      const definition = getIdeToolDefinition(toolName);
      if (definition) {
        const cancellation = cancellationFromAbortSignal(extra.signal);
        try {
          const result = await this.ideToolBroker.invokeDirect(toolName, asRecord(args), cancellation.token);
          this.finishActivity(
            activityId,
            result.isError ? "error" : "completed",
            Date.now() - startedAt,
            result.isError ? result.text : undefined,
            bridgePresentation(toolName, args, result.text, undefined, result.isError),
          );
          return {
            isError: result.isError || undefined,
            content: [{ type: "text" as const, text: result.text }],
          };
        } finally {
          cancellation.dispose();
        }
      }

      throw new Error(`Unknown Bridge tool: ${toolName}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.finishActivity(activityId, "error", Date.now() - startedAt, message, bridgePresentation(toolName, args, message, undefined, true));
      return {
        isError: true,
        content: [{ type: "text" as const, text: message }],
      };
    }
  }

  private isSessionActive(session: McpSession): boolean {
    return session.activeRequests > 0 || session.activeStreams > 0;
  }

  private pruneSessions(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (!this.isSessionActive(session) && now - session.lastActivity >= SESSION_IDLE_TIMEOUT_MS) {
        this.destroySession(sessionId);
      }
    }
    this.trimInactiveSessions(MAX_SESSIONS);
  }

  private makeRoomForSession(): void {
    this.trimInactiveSessions(MAX_SESSIONS - 1);
  }

  private trimInactiveSessions(maxSize: number): void {
    while (this.sessions.size > maxSize) {
      const oldestInactive = [...this.sessions.entries()]
        .filter(([, session]) => !this.isSessionActive(session))
        .sort((a, b) => a[1].lastActivity - b[1].lastActivity)[0];
      if (!oldestInactive) return;
      this.destroySession(oldestInactive[0]);
    }
  }

  public destroySession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.revision += 1;
    try { void session.transport.close(); } catch { /* ignore */ }
    try { void session.server.close(); } catch { /* ignore */ }
    this.output.appendLine(`[bridge] session destroyed: ${sessionId}`);
  }

  private handleReportProgress(value: unknown, sessionId?: string): { content: Array<{ type: "text"; text: string }> } {
    const input = asRecord(value);
    const message = typeof input.message === "string" ? input.message.trim() : "";
    if (!message) throw new Error("report_progress.message must be a non-empty string.");
    if (message.length > 2_000) throw new Error("report_progress.message must be at most 2000 characters.");
    const phase = typeof input.phase === "string" ? input.phase.trim().slice(0, 160) : undefined;
    let percent: number | undefined;
    if (input.percent !== undefined) {
      if (!Number.isInteger(input.percent) || Number(input.percent) < 0 || Number(input.percent) > 100) {
        throw new Error("report_progress.percent must be an integer from 0 to 100.");
      }
      percent = Number(input.percent);
    }
    const requestedTodoId = typeof input.todo_id === "string" ? input.todo_id.trim() : "";
    let linkedTodo: BridgeTodo | undefined;
    if (requestedTodoId) {
      linkedTodo = this.todos.find((todo) => todo.id === requestedTodoId);
      if (!linkedTodo) throw new Error(`report_progress.todo_id does not match a current todo: ${requestedTodoId}`);
    } else {
      linkedTodo = this.todos.find((todo) => todo.status === "in_progress");
    }
    this.pushActivity({
      tool: REPORT_PROGRESS_TOOL.name,
      status: "progress",
      message,
      phase,
      percent,
      todoId: linkedTodo?.id,
      todoTitle: linkedTodo?.title,
      sessionId,
    });
    this.output.appendLine(`[bridge-progress]${linkedTodo ? ` [${linkedTodo.id}]` : ""}${phase ? ` ${phase}:` : ""} ${message}${percent !== undefined ? ` (${percent}%)` : ""}`);
    return { content: [{ type: "text", text: linkedTodo ? `Progress reported to AgentBridge for todo ${linkedTodo.id}.` : "Progress reported to AgentBridge." }] };
  }

  private handleSetTodos(value: unknown): { content: Array<{ type: "text"; text: string }> } {
    const input = asRecord(value);
    if (!Array.isArray(input.todos)) throw new Error("set_todos.todos must be an array.");
    if (input.todos.length > MAX_TODOS) throw new Error(`set_todos.todos must contain at most ${MAX_TODOS} items.`);

    const seen = new Set<string>();
    const todos: BridgeTodo[] = input.todos.map((raw, index) => {
      const item = asRecord(raw);
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const title = typeof item.title === "string" ? item.title.trim() : "";
      const status = item.status;
      if (!id || id.length > 80) throw new Error(`set_todos.todos[${index}].id must be 1-80 characters.`);
      if (seen.has(id)) throw new Error(`set_todos.todos contains duplicate id: ${id}`);
      seen.add(id);
      if (!title || title.length > 400) throw new Error(`set_todos.todos[${index}].title must be 1-400 characters.`);
      if (status !== "pending" && status !== "in_progress" && status !== "completed") {
        throw new Error(`set_todos.todos[${index}].status must be pending, in_progress, or completed.`);
      }
      return { id, title, status };
    });

    if (todos.filter((todo) => todo.status === "in_progress").length > 1) {
      throw new Error("set_todos supports at most one in_progress todo.");
    }

    this.todos = todos;
    this.revision += 1;
    const completed = todos.filter((todo) => todo.status === "completed").length;
    const current = todos.find((todo) => todo.status === "in_progress");
    this.output.appendLine(todos.length
      ? `[bridge-todos] ${completed}/${todos.length} completed${current ? ` · current: [${current.id}] ${current.title}` : ""}`
      : "[bridge-todos] cleared");
    return {
      content: [{
        type: "text",
        text: todos.length
          ? `Todo state updated in AgentBridge: ${completed}/${todos.length} completed${current ? `; current todo ${current.id}: ${current.title}` : ""}.`
          : "Todo state cleared in AgentBridge.",
      }],
    };
  }

  private workspaceRoots(): string[] {
    const roots = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
    if (!roots.length) throw new Error("No workspace folder is open.");
    return roots;
  }

  private pushActivity(input: Omit<BridgeActivity, "id" | "at">): number {
    const at = new Date().toISOString();
    const item: BridgeActivity = {
      id: this.nextActivityId++,
      at,
      ...input,
    };
    this.activities.push(item);
    if (this.activities.length > MAX_ACTIVITY) this.activities.splice(0, this.activities.length - MAX_ACTIVITY);
    if (input.status !== "progress") {
      this.toolCalls += 1;
      this.lastTool = input.tool;
      this.lastToolAt = at;
    }
    this.revision += 1;
    return item.id;
  }

  private finishActivity(
    id: number,
    status: "completed" | "error",
    durationMs: number,
    message?: string,
    presentation?: BridgeActivityPresentation,
  ): void {
    const index = this.activities.findIndex((item) => item.id === id);
    if (index < 0) return;
    const current = this.activities[index];
    if (current.status === "running") {
      this.completedToolCalls += 1;
      this.totalToolDurationMs += durationMs;
      if (status === "error") this.failedToolCalls += 1;
    }
    this.activities[index] = { ...current, status, durationMs, message: message ?? current.message, presentation: presentation ?? current.presentation };
    this.revision += 1;
  }

  async stop(): Promise<BridgeStatus> {
    await this.stopResources(true);
    return this.getStatus();
  }

  private async stopResources(markStopped: boolean): Promise<void> {
    this.stoppingResources = true;
    this.tunnelGeneration += 1;
    if (this.sessionPruneTimer) {
      clearInterval(this.sessionPruneTimer);
      this.sessionPruneTimer = undefined;
    }

    // Tear down all active sessions
    for (const sid of [...this.sessions.keys()]) this.destroySession(sid);

    const tunnel = this.tunnelProcess;
    this.tunnelProcess = undefined;
    if (tunnel && !tunnel.killed) {
      if (process.platform === "win32" && tunnel.pid) {
        try {
          await execFileAsync("taskkill", ["/PID", String(tunnel.pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 });
        } catch {
          tunnel.kill();
        }
      } else {
        tunnel.kill();
      }
    }

    this.activeRequests = 0;

    const server = this.httpServer;
    this.httpServer = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.localPort = undefined;
    if (this.tunnelProvider === "cloudflare") this.domain = "";
    if (markStopped) {
      this.state = "stopped";
      this.lastError = undefined;
      this.output.appendLine("[bridge] stopped");
    }
    this.stoppingResources = false;
  }

  async disposeAsync(): Promise<void> {
    await this.stopResources(true);
  }

  dispose(): void {
    void this.stopResources(true);
  }
}

