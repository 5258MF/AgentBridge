import assert from "node:assert/strict";
import test from "node:test";
import { BridgeManager, buildServerInstructions, READ_ONLY_BLOCKED_TOOL_NAMES } from "../src/extension/src/bridge-server.js";
import { vscodeTest } from "./helpers/fake-vscode.js";

/** The fixed instructions shipped before they became data-driven; normal mode must not change. */
const NORMAL_MODE_INSTRUCTIONS = "You are connected to the currently open AgentBridge workspace.\n\nAgentBridge executes tools and displays your task state, progress, and tool activity to the local user.\n\nUse:\n- list_directory/find_files to discover files\n- search_files for raw text search\n- lsp for semantic code navigation\n- read_files before editing\n- apply_patch for workspace changes\n- get_diagnostics after edits\n- run_command for builds and tests\n- terminate_command for a hard stop when cooperative Ctrl+C does not stop a command\n- set_todos to maintain the complete task list for multi-step work\n- report_progress to report transient progress for the current task\n\nTask coordination:\n- Use set_todos for multi-step work, significant replanning, or validation workflows.\n- Send the complete ordered todo list whenever task state changes.\n- Keep at most one todo in_progress.\n- Use stable todo IDs across updates.\n- Keep todos at the goal level; do not create one todo per tool call.\n- Use report_progress for what you are doing right now, not for durable task state.\n- When there is exactly one in_progress todo, report_progress is automatically associated with it.\n- Pass todo_id only when an explicit association is needed.\n- Send an empty todo list when the task state should be cleared.\n\nTool guidance:\n- Prefer semantic navigation over broad text search when locating code symbols.\n- Do not assume an empty LSP result means a symbol does not exist.\n- Use search_files for exact text and lsp for symbols, definitions, references, and type information.\n- Reread affected files after stale patch or context-mismatch failures before retrying.\n- Prefer small, focused patches with enough unique context.\n- Run diagnostics and relevant tests after meaningful edits.\n- Report meaningful progress periodically during long work, but avoid progress updates for every tool call.\n- To wait for a running command, call get_command_output with wait_ms instead of polling it repeatedly or running sleep commands.\n- Failed tool results start with a stable UPPER_SNAKE_CASE error code (for example INVALID_ARGUMENT, STALE_FILE, UNKNOWN_COMMAND_ID, READ_ONLY_MODE), sometimes followed by a Hint line. Use the code to choose a recovery instead of retrying blindly.";

function makeManager(): BridgeManager {
  vscodeTest.reset();
  const globalState = new Map<string, unknown>();
  const context: any = {
    extensionMode: 1,
    extension: { packageJSON: { version: "0.1.13" } },
    subscriptions: [],
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
    globalState: {
      get: <T>(key: string, fallback?: T) => (globalState.has(key) ? globalState.get(key) : fallback) as T,
      update: async (key: string, value: unknown) => { globalState.set(key, value); },
    },
  };
  const output = { append() {}, appendLine() {} } as any;
  const broker = { invokeDirect: async () => ({ text: "", isError: false }), dispose() {} } as any;
  return new BridgeManager(context, output, broker);
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("normal-mode server instructions are unchanged byte for byte", () => {
  assert.equal(buildServerInstructions(false), NORMAL_MODE_INSTRUCTIONS);
});

test("read-only instructions lead with the read-only section and never recommend blocked tools", () => {
  const text = buildServerInstructions(true);
  const paragraphs = text.split("\n\n");
  assert.equal(paragraphs[0], "You are connected to the currently open AgentBridge workspace.");
  const readOnly = paragraphs[1];
  assert.match(readOnly, /^Read-only mode is ACTIVE: .+ are disabled\./);
  assert.match(readOnly, /Present proposed changes as a patch or diff in your reply/);
  assert.match(readOnly, /Suggest commands for the user to run/);
  for (const blocked of READ_ONLY_BLOCKED_TOOL_NAMES) {
    assert.ok(readOnly.includes(blocked), `read-only section must name ${blocked}`);
  }
  const rest = paragraphs.slice(2).join("\n\n");
  for (const blocked of READ_ONLY_BLOCKED_TOOL_NAMES) {
    assert.ok(!rest.includes(blocked), `outside the read-only section, ${blocked} must not be recommended`);
  }
  assert.doesNotMatch(rest, /before editing|after edits|after meaningful edits|focused patches/);
  assert.match(rest, /- read_files to read file contents/);
  assert.match(rest, /- get_diagnostics to inspect current errors and warnings/);
  assert.match(rest, /- set_todos to maintain the complete task list/);
  assert.match(rest, /READ_ONLY_MODE/);
});

test("toggling read-only mode notifies connected sessions exactly when the mode changes", async () => {
  const manager = makeManager();
  let notified = 0;
  const sessions = (manager as any).sessions as Map<string, unknown>;
  sessions.set("ok", { server: { sendToolListChanged: async () => { notified += 1; } }, lastActivity: Date.now(), activeRequests: 0, activeStreams: 0 });
  sessions.set("broken", { server: { sendToolListChanged: async () => { throw new Error("stream closed"); } }, lastActivity: Date.now(), activeRequests: 0, activeStreams: 0 });
  sessions.set("legacy", { server: {}, lastActivity: Date.now(), activeRequests: 0, activeStreams: 0 });

  manager.setReadOnlyMode(true);
  await flush();
  assert.equal(notified, 1);

  manager.setReadOnlyMode(true);
  await flush();
  assert.equal(notified, 1, "an unchanged mode must not notify again");

  manager.setReadOnlyMode(false);
  await flush();
  assert.equal(notified, 2);
});
