export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  vscodeToolName: string;
  capability: "read" | "execute";
}

/**
 * Upper bound (and default) for how long a foreground run_command waits before returning
 * status=running. It must stay below common reverse-proxy response deadlines: Cloudflare
 * tunnels abort an origin response with HTTP 524 after 100 seconds, and Quick Tunnel mode
 * serves MCP responses as plain JSON with no bytes sent until the tool returns. Returning
 * earlier keeps the command_id deliverable so the agent can continue with get_command_output.
 */
export const RUN_COMMAND_MAX_FOREGROUND_WAIT_MS = 90_000;

/**
 * Upper bound for get_command_output wait_ms. Like the foreground run_command cap it stays
 * well below the 100-second Cloudflare origin response deadline.
 */
export const GET_COMMAND_OUTPUT_MAX_WAIT_MS = 60_000;

/** How many finished command states stay addressable by command_id. */
export const MAX_RETAINED_FINISHED_COMMANDS = 32;

export const IDE_TOOL_DEFINITIONS: readonly AgentToolDefinition[] = [
  {
    name: "list_directory",
    vscodeToolName: "agentbridge_list_directory",
    capability: "read",
    description: [
      "List the entries of a workspace directory.",
      "",
      "- depth 1 (default) or 2; for deeper or pattern-based discovery use find_files.",
      "- Dot entries and generated or ignored directories (node_modules, dist, .git) are hidden unless include_hidden or no_ignore is set.",
      "- Returns up to 200 entries by default (max_entries up to 500).",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative directory path. Defaults to the workspace root." },
        depth: { type: "integer", enum: [1, 2], default: 1, description: "1 lists the directory itself; 2 also lists its subdirectories." },
        include_hidden: { type: "boolean", default: false, description: "Include dot-prefixed entries." },
        no_ignore: { type: "boolean", default: false, description: "Include common generated/ignored directories such as node_modules, dist and .git." },
        max_entries: { type: "integer", minimum: 1, maximum: 500, default: 200, description: "Maximum entries returned." }
      },
      additionalProperties: false
    }
  },
  {
    name: "run_command",
    vscodeToolName: "agentbridge_run_command",
    capability: "execute",
    description: [
      "Run a shell command in a persistent terminal managed by AgentBridge: ${RUNTIME_SHELL_DESCRIPTION}.",
      "",
      "- Set background explicitly: false to wait for the result, true for servers and watchers that keep running (returns at once with a command_id).",
      `- A foreground command still running after timeout_ms (default and maximum ${RUN_COMMAND_MAX_FOREGROUND_WAIT_MS}) returns status=running with a command_id; it is not killed. Continue with get_command_output.`,
      "- Terminal state (cwd, environment variables, functions) persists between calls. Omit cwd to continue in the last idle terminal's directory; a new terminal starts at the workspace root.",
      "- Up to 8 terminals run at once; when all are busy the call fails until one finishes or is terminated.",
      "- Interactive programs work; answer prompts with send_command_input.",
      "- Syntax: ${RUNTIME_SHELL_SYNTAX_HINT}",
    ].join("\n"),
    inputSchema: {
      type: "object",
      required: ["command", "background"],
      properties: {
        command: { type: "string", minLength: 1, description: "Command line to run." },
        cwd: { type: "string", description: "Working directory relative to the workspace root. Omit to continue in the last idle terminal's directory." },
        background: { type: "boolean", description: "true for commands that keep running (servers, watchers); false to wait for the result." },
        timeout_ms: { type: "integer", minimum: 1000, maximum: RUN_COMMAND_MAX_FOREGROUND_WAIT_MS, default: RUN_COMMAND_MAX_FOREGROUND_WAIT_MS, description: "Foreground only: how long to wait before returning status=running. The command keeps running." }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_command_output",
    vscodeToolName: "agentbridge_get_command_output",
    capability: "execute",
    description: [
      "Read new output and the status of a command started with run_command.",
      "",
      "- Pass the previous next_offset as offset to get only new output.",
      `- To wait for a running command, set wait_ms (at most ${GET_COMMAND_OUTPUT_MAX_WAIT_MS}) instead of calling repeatedly or running sleep: wait_until=exit (default) returns when it finishes, wait_until=output as soon as new output arrives; otherwise it returns at the deadline with wait_result=timeout and the command keeps running.`,
      `- Only the ${MAX_RETAINED_FINISHED_COMMANDS} most recent finished commands are kept.`,
    ].join("\n"),
    inputSchema: {
      type: "object",
      required: ["command_id"],
      properties: {
        command_id: { type: "string", minLength: 1, description: "Id returned by run_command." },
        offset: { type: "integer", minimum: 0, default: 0, description: "Byte offset to read from; pass the previous next_offset." },
        max_bytes: { type: "integer", minimum: 1, maximum: 131072, default: 32768, description: "Maximum output bytes returned in this call." },
        wait_ms: { type: "integer", minimum: 0, maximum: GET_COMMAND_OUTPUT_MAX_WAIT_MS, default: 0, description: "How long to wait while the command is running; 0 returns immediately. The result then includes wait_result and waited_ms." },
        wait_until: { type: "string", enum: ["exit", "output"], default: "exit", description: "exit: return when the command finishes. output: return as soon as new output arrives (useful for servers)." }
      },
      additionalProperties: false
    }
  },
  {
    name: "send_command_input",
    vscodeToolName: "agentbridge_send_command_input",
    capability: "execute",
    description: [
      "Type input into a running command's terminal: answers to prompts, REPL lines, or control keys.",
      "",
      "- A newline is appended unless append_newline=false.",
      "- Ctrl+C: input=\"\\u0003\" with append_newline=false. It may not stop the command; check with get_command_output and use terminate_command for a hard stop.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      required: ["command_id", "input"],
      properties: {
        command_id: { type: "string", minLength: 1, description: "Id returned by run_command." },
        input: { type: "string", description: "Text to send. Use \\u0003 for Ctrl+C." },
        append_newline: { type: "boolean", default: true, description: "Press Enter after the input." }
      },
      additionalProperties: false
    }
  },
  {
    name: "terminate_command",
    vscodeToolName: "agentbridge_terminate_command",
    capability: "execute",
    description: [
      "Force-stop a running command by closing its terminal.",
      "",
      "- Use when Ctrl+C through send_command_input did not stop it.",
      "- The terminal's state (cwd, environment variables, history) is lost.",
      "- Safe to call on a finished command; it returns the current status.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      required: ["command_id"],
      properties: {
        command_id: { type: "string", minLength: 1, description: "Id returned by run_command." }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_diagnostics",
    vscodeToolName: "agentbridge_get_diagnostics",
    capability: "read",
    description: [
      "Read the errors and warnings VS Code currently reports (the Problems panel), including for unsaved edits.",
      "",
      "- Use after edits or builds instead of parsing compiler output.",
      "- Filter with path and severity; returns up to 100 results by default (max_results up to 500).",
      "- Language services may only report files they have analyzed; run the build or tests to check everything.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory to limit results to, relative to the workspace root." },
        severity: {
          type: "array",
          items: { type: "string", enum: ["error", "warning", "information", "hint"] },
          uniqueItems: true,
          description: "Severities to include. Defaults to all."
        },
        max_results: { type: "integer", minimum: 1, maximum: 500, default: 100, description: "Maximum diagnostics returned." }
      },
      additionalProperties: false
    }
  },
  {
    name: "lsp",
    vscodeToolName: "agentbridge_lsp",
    capability: "read",
    description: [
      "Navigate code by symbols using the language services running in VS Code.",
      "",
      "- operation: workspace_symbols (needs query), document_symbols (needs path), or definition, references, implementation, hover (need path, line, and column, all 1-based).",
      "- Use search_files for plain text and read_files to read the code lsp finds.",
      "- An empty result can mean the language service is not ready or does not cover the file; check provider_state and semantic_result_inconclusive before concluding a symbol does not exist.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          enum: ["workspace_symbols", "document_symbols", "definition", "references", "implementation", "hover"],
          description: "What to look up."
        },
        path: { type: "string", description: "Source file relative to the workspace root. Required except for workspace_symbols, where it optionally points at the project to search." },
        line: { type: "integer", minimum: 1, description: "1-based source line. Required for definition/references/implementation/hover." },
        column: { type: "integer", minimum: 1, description: "1-based UTF-16 source column. Required for definition/references/implementation/hover." },
        query: { type: "string", description: "Symbol query. Required for workspace_symbols." },
        include_declaration: { type: "boolean", default: true, description: "For references, include the symbol declaration/definition when present." },
        max_results: { type: "integer", minimum: 1, maximum: 500, description: "Maximum returned semantic results. Operation-specific defaults are used when omitted." }
      },
      additionalProperties: false
    }
  }
] as const;

export const IDE_TOOL_NAMES = IDE_TOOL_DEFINITIONS.map((tool) => tool.name);

/**
 * IDE tools that only make sense inside the native Chat runtime and must not be
 * exposed over the Bridge MCP surface. Remote agents connected through Bridge
 * have their own pacing; a tool that sleeps on the local terminal is meaningless
 * to them and only pollutes their tool list.
 */
export const BRIDGE_EXCLUDED_TOOL_NAMES: ReadonlySet<string> = new Set<string>();

export function getIdeToolDefinition(name: string): AgentToolDefinition | undefined {
  return IDE_TOOL_DEFINITIONS.find((tool) => tool.name === name);
}

