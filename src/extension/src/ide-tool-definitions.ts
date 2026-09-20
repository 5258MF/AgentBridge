export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  vscodeToolName: string;
  capability: "read" | "execute";
}

export const IDE_TOOL_DEFINITIONS: readonly AgentToolDefinition[] = [
  {
    name: "list_directory",
    vscodeToolName: "agentbridge_list_directory",
    capability: "read",
    description: "List the immediate contents of a workspace directory. Use this to understand what is in a known directory; use find_files when searching by filename/path pattern. Depth is intentionally limited to 1 or 2.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative directory path. Defaults to the workspace root." },
        depth: { type: "integer", enum: [1, 2], default: 1, description: "Directory depth to list. Keep this small; use find_files for recursive discovery. A value outside the range is brought into it, and the answer names what was used." },
        include_hidden: { type: "boolean", default: false, description: "Include dot-prefixed entries." },
        no_ignore: { type: "boolean", default: false, description: "Include common generated/ignored directories such as node_modules, dist and .git." },
        max_entries: { type: "integer", minimum: 1, maximum: 500, default: 200, description: "Maximum returned entries. A value outside the range is brought into it, and the answer names what was used." },
      },
      additionalProperties: false
    }
  },
  {
    name: "run_command",
    vscodeToolName: "agentbridge_run_command",
    capability: "execute",
    description: "Run a shell command in an AgentBridge-managed persistent real PTY that is independent of the user's terminal profiles and VS Code Shell Integration. ${RUNTIME_SHELL_DESCRIPTION}. ${RUNTIME_SHELL_SYNTAX_HINT} Shell state such as environment variables, functions and the current directory persists when the same terminal is reused. Omit cwd to continue from the most recently used idle AgentBridge terminal's current directory; a new terminal starts at the workspace root. Interactive input, resize, and TTY-aware CLI behavior are supported. Concurrent commands may use additional managed terminals, up to 8 live terminals total; when all are busy, additional run_command calls fail until a terminal becomes available or a stuck command is terminated. Explicitly choose background=true for long-running servers/watchers and background=false for commands whose result should be awaited. Returns a command_id for later output inspection or interactive input. Execution modes: pty (default) runs in the managed persistent terminal above and supports interactive input; direct runs the command through a one-shot child process with piped output and a process-level exit code (no terminal view, no interactive input). Prefer execution=\"direct\" for non-interactive one-shot commands such as builds, tests and scripts; keep the default pty for interactive programs, TUIs, and background=true servers that should stay visible in a terminal. The result header always carries the same fixed fields: facts that would be absent are explicit instead (script_bridge is null when the command was not bridged through a temp script, hint is \"none\" when the command is not running) — parse the header by field name, never by line presence.",
    inputSchema: {
      type: "object",
      required: ["command", "background"],
      properties: {
        command: { type: "string", minLength: 1, description: "Shell command to run." },
        cwd: { type: "string", description: "Optional workspace-relative working directory. When omitted, reuse the most recently used idle AgentBridge terminal and continue from its current directory; a new terminal starts at the workspace root." },
        background: { type: "boolean", description: "Whether this is expected to keep running. Must be chosen explicitly." },
        execution: { type: "string", enum: ["pty", "direct"], default: "pty", description: "pty = managed persistent terminal (interactive, visible in a terminal tab); direct = one-shot child process with a process-level exit code (non-interactive, no terminal view). direct spawns a fresh shell per command (about 1-4s PowerShell cold-start overhead on Windows); prefer the default pty when running many rapid sequential commands that need shell state. Not compatible with background=true." },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 120000, default: 120000, description: "For foreground commands, maximum time to wait before returning status=running. The command is not killed on timeout. A value outside the range is brought into it, and the answer names what was used." },
      },
      additionalProperties: false
    }
  },
  {
    name: "get_command_output",
    vscodeToolName: "agentbridge_get_command_output",
    capability: "execute",
    description: "Read new output and status from a previously started run_command using its command_id. Use next_offset on subsequent reads to avoid repeating old output.",
    inputSchema: {
      type: "object",
      required: ["command_id"],
      properties: {
        command_id: { type: "string", minLength: 1 },
        offset: { type: "integer", minimum: 0, default: 0, description: "Absolute UTF-8 byte offset into captured output. A value outside the range is brought into it, and the answer names what was used." },
        max_bytes: { type: "integer", minimum: 1, maximum: 131072, default: 32768, description: "Maximum bytes of captured output returned in one read. Defaults to 32768; hard maximum 131072. A value outside the range is brought into it, and the answer names what was used." }
      },
      additionalProperties: false
    }
  },
  {
    name: "send_command_input",
    vscodeToolName: "agentbridge_send_command_input",
    capability: "execute",
    description: "Send text to a running managed terminal for prompts, REPLs, or other interactive input. A newline is appended by default. To request Ctrl+C, send \\u0003 with append_newline=false. Ctrl+C is cooperative and may leave the command running; check with get_command_output and use terminate_command when a hard stop is required.",
    inputSchema: {
      type: "object",
      required: ["command_id", "input"],
      properties: {
        command_id: { type: "string", minLength: 1 },
        input: { type: "string" },
        append_newline: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "terminate_command",
    vscodeToolName: "agentbridge_terminate_command",
    capability: "execute",
    description: "Hard-stop a running AgentBridge command by terminating its managed shell and closing that terminal. Terminal-local state such as cwd, environment changes, and history is discarded. Use when cooperative Ctrl+C did not stop the command and get_command_output still reports status=running. To try Ctrl+C first, call send_command_input with input=\"\\u0003\" and append_newline=false. Calling this for an already-finished command is idempotent and returns its current status.",
    inputSchema: {
      type: "object",
      required: ["command_id"],
      properties: {
        command_id: { type: "string", minLength: 1 }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_diagnostics",
    vscodeToolName: "agentbridge_get_diagnostics",
    capability: "read",
    description: "Read current diagnostics from VS Code and active language services, including unsaved editor state when providers report it. Use after edits/builds to inspect errors and warnings structurally instead of parsing compiler output when diagnostics are available.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional workspace-relative file or directory scope." },
        severity: {
          type: "array",
          items: { type: "string", enum: ["error", "warning", "information", "hint"] },
          uniqueItems: true,
          description: "Optional severity filter. Defaults to all severities. A value that is not one of the four is reported as ignored rather than refused; if none of them is recognised, no filter is applied and the report says so."
        },
        max_results: { type: "integer", minimum: 1, maximum: 500, default: 100, description: "Maximum diagnostics returned. Defaults to 100; hard maximum 500. A value outside the range is brought into it, and the answer names what was used." }
      },
      additionalProperties: false
    }
  },
  {
    name: "lsp",
    vscodeToolName: "agentbridge_lsp",
    capability: "read",
    description: "Navigate code semantically through the language services already active in VS Code. Use this for code symbols rather than text search: workspace/document symbols, go-to-definition, references, implementations, and hover/type information. Results include provider_state, project_anchor, project_anchor_source, warmup_performed, and semantic_result_inconclusive metadata so empty semantic results and heuristic warm-up anchors are not over-interpreted. Use search_files for raw text and read_files after lsp locates the relevant implementation.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          enum: ["workspace_symbols", "document_symbols", "definition", "references", "implementation", "hover"],
          description: "Semantic operation to execute through VS Code language feature providers."
        },
        path: { type: "string", description: "Workspace source path. Workspace-relative is preferred; absolute paths are accepted only when they remain inside the workspace. Required for document_symbols/definition/references/implementation/hover. Optional for workspace_symbols as a project/file/directory anchor to activate the relevant language project before semantic search." },
        line: { type: "integer", minimum: 1, description: "1-based source line. Required for definition/references/implementation/hover." },
        column: { type: "integer", minimum: 1, description: "1-based UTF-16 source column. Required for definition/references/implementation/hover." },
        query: { type: "string", description: "Symbol query. Required for workspace_symbols." },
        include_declaration: { type: "boolean", default: true, description: "For references, include the symbol declaration/definition when present." },
        max_results: { type: "integer", minimum: 1, maximum: 500, description: "Maximum returned semantic results. Operation-specific defaults are used when omitted. A value outside the range is brought into it, and the answer names what was used." },
      },
      additionalProperties: false
    }
  }
] as const;

/**
 * IDE tools that only make sense inside the native Chat runtime and must not be
 * exposed over the Bridge MCP surface. Remote agents connected through Bridge
 * have their own pacing; a tool that sleeps on the local terminal is meaningless
 * to them and only pollutes their tool list.
 *
 * Empty on purpose, not by oversight: this build registers no tool that is local-only, so
 * there is nothing to exclude. The set is the one place to name one, and the two filters
 * that read it stay correct whether or not it ever holds anything.
 */
export const BRIDGE_EXCLUDED_TOOL_NAMES: ReadonlySet<string> = new Set<string>();

export function getIdeToolDefinition(name: string): AgentToolDefinition | undefined {
  return IDE_TOOL_DEFINITIONS.find((tool) => tool.name === name);
}

