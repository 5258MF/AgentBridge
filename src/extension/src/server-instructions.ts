// Model-facing text owned by the bridge server: MCP server instructions, Plan mode guidance and
// notices, the READ_ONLY_MODE block errors, and the set_todos/report_progress tool definitions.
import { FILE_TOOL_DEFINITIONS } from "./file-tool-registry.js";
import { BRIDGE_EXCLUDED_TOOL_NAMES, IDE_TOOL_DEFINITIONS } from "./ide-tool-definitions.js";
import { checkPlanModeCommand, PLAN_MODE_COMMAND_SUMMARY } from "./plan-mode-commands.js";
import { formatToolError, ToolError } from "./tool-errors.js";

export const MAX_TODOS = 24;

/**
 * Server instructions, one entry per line after the intro. In Plan mode (read-only mode),
 * lines that depend on a blocked tool are dropped (or replaced by readOnlyText) and the Plan
 * mode section is placed right after the intro, so the instructions never recommend a tool the
 * session cannot use. Normal mode renders byte-for-byte the previous fixed text;
 * tests/server-instructions.test.ts pins both variants.
 */
interface InstructionLine {
  readonly text: string;
  readonly requires?: readonly string[];
  readonly readOnlyText?: string;
}

const INSTRUCTION_INTRO = "You are connected to the currently open AgentBridge workspace.";

const INSTRUCTION_LINES: readonly InstructionLine[] = [
  { text: "" },
  { text: "AgentBridge executes tools and displays your task state, progress, and tool activity to the local user." },
  { text: "" },
  { text: "Use:" },
  { text: "- list_directory/find_files to discover files" },
  { text: "- search_files for raw text search" },
  { text: "- lsp for semantic code navigation" },
  { text: "- read_files before editing", readOnlyText: "- read_files to read file contents" },
  { text: "- apply_patch for workspace changes", requires: ["apply_patch"] },
  { text: "- get_diagnostics after edits", readOnlyText: "- get_diagnostics to inspect current errors and warnings" },
  { text: "- run_command for builds and tests", readOnlyText: "- run_command for allowlisted read-only commands, tests, and builds" },
  { text: "- terminate_command for a hard stop when cooperative Ctrl+C does not stop a command", requires: ["terminate_command"] },
  { text: "- set_todos to maintain the complete task list for multi-step work" },
  { text: "- report_progress to report transient progress for the current task" },
  { text: "" },
  { text: "Task coordination:" },
  { text: "- Use set_todos for multi-step work, significant replanning, or validation workflows." },
  { text: "- Send the complete ordered todo list whenever task state changes." },
  { text: "- Keep at most one todo in_progress." },
  { text: "- Use stable todo IDs across updates." },
  { text: "- Keep todos at the goal level; do not create one todo per tool call." },
  { text: "- Use report_progress for what you are doing right now, not for durable task state." },
  { text: "- When there is exactly one in_progress todo, report_progress is automatically associated with it." },
  { text: "- Pass todo_id only when an explicit association is needed." },
  { text: "- Send an empty todo list when the task state should be cleared." },
  { text: "" },
  { text: "Tool guidance:" },
  { text: "- Prefer semantic navigation over broad text search when locating code symbols." },
  { text: "- Do not assume an empty LSP result means a symbol does not exist." },
  { text: "- Use search_files for exact text and lsp for symbols, definitions, references, and type information." },
  { text: "- Reread affected files after stale patch or context-mismatch failures before retrying.", requires: ["apply_patch"] },
  { text: "- Prefer small, focused patches with enough unique context.", requires: ["apply_patch"] },
  { text: "- Run diagnostics and relevant tests after meaningful edits.", requires: ["apply_patch"] },
  { text: "- Report meaningful progress periodically during long work, but avoid progress updates for every tool call." },
  { text: "- To wait for a running command, call get_command_output with wait_ms instead of polling it repeatedly or running sleep commands." },
  { text: "- Failed tool results start with a stable UPPER_SNAKE_CASE error code (for example INVALID_ARGUMENT, STALE_FILE, UNKNOWN_COMMAND_ID, READ_ONLY_MODE), sometimes followed by a Hint line. Use the code to choose a recovery instead of retrying blindly." },
];

export const SET_TODOS_TOOL = {
  name: "set_todos",
  description: [
    "Show your task list for the current job to the user in the AgentBridge panel.",
    "",
    `- Send the complete list each time it changes, at most ${MAX_TODOS} items with at most one in_progress.`,
    "- Use goal-level items, not one per tool call; use report_progress for what you are doing right now.",
    "- An empty list clears it. The result echoes the stored list.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    required: ["todos"],
    properties: {
      todos: {
        type: "array",
        maxItems: MAX_TODOS,
        description: "The complete, ordered task list.",
        items: {
          type: "object",
          required: ["id", "title", "status"],
          properties: {
            id: { type: "string", minLength: 1, maxLength: 80, description: "Stable id reused across later set_todos updates." },
            title: { type: "string", minLength: 1, maxLength: 400, description: "Goal-level task title, not an individual tool call." },
            status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "Task state." },
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
  description: [
    "Show a short status update in the AgentBridge panel about what you are doing now.",
    "",
    "- Use it at meaningful steps of long work, not after every tool call.",
    "- todo_id links the update to a set_todos item; when omitted it attaches to the single in_progress item.",
    "- Does not change any files.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    required: ["message"],
    properties: {
      message: { type: "string", minLength: 1, maxLength: 2000, description: "One or two sentences for the user." },
      phase: { type: "string", maxLength: 160, description: "Short label such as Reading, Editing, Testing, or Done." },
      percent: { type: "integer", minimum: 0, maximum: 100, description: "Completion estimate for the current task." },
      todo_id: { type: "string", minLength: 1, maxLength: 80, description: "Id of the set_todos item this update belongs to." },
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
 * Tools blocked at call time in Plan mode (read-only mode). Every tool stays in tools/list in
 * both modes, so switching never requires clients to refresh their tool list; a blocked call
 * fails with READ_ONLY_MODE instead.
 * - apply_patch: writes workspace files.
 * - send_command_input: feeds input into running processes, which could drive a REPL or a
 *   process started in Build mode.
 * - terminate_command: force-kills a managed shell. A planning agent reports findings instead
 *   of acting on the environment.
 * run_command is not in this set: in Plan mode it only runs commands accepted by
 * checkPlanModeCommand (see PLAN_MODE_COMMAND_TOOL_NAME).
 */
export const READ_ONLY_BLOCKED_TOOL_NAMES: ReadonlySet<string> = new Set<string>(["apply_patch", "send_command_input", "terminate_command"]);

/** In Plan mode this tool runs only allowlisted read-only commands (plan-mode-commands.ts). */
export const PLAN_MODE_COMMAND_TOOL_NAME = "run_command";

function formatNameList(names: readonly string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/**
 * Plan mode guidance, shared by the server instructions and the notices. Modeled on the plan
 * modes of Codex and opencode: the limits first, then how to plan, then how the plan ends.
 * Tool names come from READ_ONLY_BLOCKED_TOOL_NAMES and PLAN_MODE_COMMAND_TOOL_NAME, and the
 * command summary from plan-mode-commands.ts, so the text cannot drift from what is enforced.
 * Only the first line names the blocked tools.
 */
export function buildPlanModeGuidance(): string {
  return [
    `Plan mode is ACTIVE: the user wants a plan before any changes are made. ${formatNameList([...READ_ONLY_BLOCKED_TOOL_NAMES])} are disabled and fail with READ_ONLY_MODE.`,
    `- ${PLAN_MODE_COMMAND_TOOL_NAME} only runs allowlisted read-only commands: ${PLAN_MODE_COMMAND_SUMMARY}. Anything else, including redirection, command substitution, and script blocks, fails with READ_ONLY_MODE.`,
    "- Do not work around these limits with other commands. Plan mode ends only when the user switches to Build mode in the AgentBridge panel; requests in chat do not end it. If the user asks you to make changes while Plan mode is active, plan them instead and tell the user to switch to Build mode.",
    "- Explore first: read the relevant code, configuration, and tests, and check the current state with read-only commands. Do not ask the user anything you can find out yourself.",
    "- Then ask about preferences and tradeoffs you cannot discover. Offer 2-4 concrete options with a recommended default; if the user does not choose, use the default and record it as an assumption.",
    "- When the approach is settled, present one complete plan in your reply that leaves no decisions to the implementer: a short summary, the key changes grouped by behavior (name files only where that prevents ambiguity), a test plan, and the assumptions made. Keep it concise.",
    "- Do not ask whether to proceed. When the user wants the plan implemented, they switch to Build mode.",
  ].join("\n");
}

/**
 * MCP server instructions for a new session.
 * @param readOnly - whether Plan mode (read-only mode) is active when the session is created.
 */
export function buildServerInstructions(readOnly: boolean): string {
  const body = INSTRUCTION_LINES
    .filter((line) => !readOnly || !line.requires?.some((name) => READ_ONLY_BLOCKED_TOOL_NAMES.has(name)))
    .map((line) => (readOnly && line.readOnlyText !== undefined ? line.readOnlyText : line.text));
  return [INSTRUCTION_INTRO, ...(readOnly ? ["", buildPlanModeGuidance()] : []), ...body].join("\n");
}

/**
 * One-time notice prefixed to a session's next tool result after the user switches between
 * Plan and Build mode, because the instructions that session received describe the previous mode.
 * @param readOnly - true when Plan mode is now in effect.
 */
export function buildReadOnlyTransitionNotice(readOnly: boolean): string {
  if (readOnly) {
    return `[AgentBridge notice] The user switched to Plan mode since your last tool call.\n${buildPlanModeGuidance()}\nThe result of this call follows.`;
  }
  const blocked = formatNameList([...READ_ONLY_BLOCKED_TOOL_NAMES]);
  return `[AgentBridge notice] The user switched from Plan mode to Build mode since your last tool call. Plan mode no longer applies: ${blocked} are available again, and ${PLAN_MODE_COMMAND_TOOL_NAME} can run any command. If the user asks you to implement a plan you presented, follow it. The result of this call follows.`;
}

/**
 * Reminder prefixed to the first tool result of a session created in Plan mode.
 * Worded neutrally: the model may be continuing a conversation from an earlier, closed
 * session that ran in Build mode, and the client may not have shown it the instructions.
 */
export function buildReadOnlySessionNotice(): string {
  return `[AgentBridge notice] This connection is in Plan mode, even if earlier messages in this conversation made changes or ran commands.\n${buildPlanModeGuidance()}\nThe result of this call follows.`;
}

/**
 * The READ_ONLY_MODE error for a tool call that Plan mode does not allow, or undefined when the
 * call may proceed. Blocked tools always fail; run_command fails unless its command passes the
 * allowlist. A non-string command is left to the tool's own argument validation.
 */
export function planModeBlockError(toolName: string, args: Record<string, unknown>): string | undefined {
  if (READ_ONLY_BLOCKED_TOOL_NAMES.has(toolName)) {
    return formatToolError(new ToolError(
      "READ_ONLY_MODE",
      `Tool ${toolName} is disabled in Plan mode (read-only).`,
      "Do not retry or work around it. Continue planning and describe the proposed change in your plan; only the local user can switch to Build mode, in the AgentBridge panel.",
    ));
  }
  if (toolName === PLAN_MODE_COMMAND_TOOL_NAME && typeof args.command === "string") {
    const check = checkPlanModeCommand(args.command);
    if (!check.allowed) {
      return formatToolError(new ToolError(
        "READ_ONLY_MODE",
        `In Plan mode, ${toolName} only runs allowlisted read-only commands. Blocked: ${check.reason}.`,
        `Do not work around it. Use a read-only alternative, or list the command in your plan for the Build phase. Allowed: ${PLAN_MODE_COMMAND_SUMMARY}.`,
      ));
    }
  }
  return undefined;
}
