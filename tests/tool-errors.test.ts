import assert from "node:assert/strict";
import test from "node:test";
import { BridgeManager } from "../src/extension/src/bridge-server.js";
import { IdeToolBroker } from "../src/extension/src/ide-tool-broker.js";
import { formatToolError, ToolError } from "../src/extension/src/tool-errors.js";
import { vscodeTest } from "./helpers/fake-vscode.js";

function makeContext(): any {
  const globalState = new Map<string, unknown>();
  return {
    extensionMode: 1,
    extension: { packageJSON: { version: "0.1.13" } },
    subscriptions: [],
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
    globalState: {
      get: <T>(key: string, fallback?: T) => (globalState.has(key) ? globalState.get(key) : fallback) as T,
      update: async (key: string, value: unknown) => { globalState.set(key, value); },
    },
  };
}

function makeManager(): BridgeManager {
  vscodeTest.reset();
  const output = { append() {}, appendLine() {} } as any;
  const broker = { invokeDirect: async () => ({ text: "", isError: false }), dispose() {} } as any;
  return new BridgeManager(makeContext(), output, broker);
}

async function callTool(manager: BridgeManager, name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }> {
  const result = await (manager as any).handleToolCall(name, args, {});
  return { isError: result.isError, text: result.content[0]?.text ?? "" };
}

test("formatToolError renders codes, hints, pass-through prefixes, and fallbacks", () => {
  assert.equal(
    formatToolError(new ToolError("UNKNOWN_COMMAND_ID", "Unknown command_id: x.", "Start it again.")),
    "UNKNOWN_COMMAND_ID: Unknown command_id: x.\nHint: Start it again.",
  );
  assert.equal(formatToolError(new ToolError("NO_WORKSPACE", "No workspace folder is open.")), "NO_WORKSPACE: No workspace folder is open.");
  assert.equal(
    formatToolError(new Error("TOO_MANY_FILES: at most 20 files may be requested in one call.")),
    "TOO_MANY_FILES: at most 20 files may be requested in one call.",
  );
  assert.equal(formatToolError(new Error("ENOENT: no such file or directory")), "ENOENT: no such file or directory");
  assert.equal(formatToolError(Object.assign(new Error("argument must be a string"), { code: "ERR_INVALID_ARG_TYPE" })), "ERR_INVALID_ARG_TYPE: argument must be a string");
  assert.equal(formatToolError(Object.assign(new Error("lowercase code ignored"), { code: "eperm" })), "TOOL_FAILED: lowercase code ignored");
  assert.equal(formatToolError(new Error("bad input"), "INVALID_ARGUMENT"), "INVALID_ARGUMENT: bad input");
  assert.equal(formatToolError("plain"), "TOOL_FAILED: plain");
});

test("set_todos and report_progress validation failures are INVALID_ARGUMENT tool errors, not protocol errors", async () => {
  const manager = makeManager();
  const todos = await callTool(manager, "set_todos", { todos: "not-an-array" });
  assert.equal(todos.isError, true);
  assert.equal(todos.text, "INVALID_ARGUMENT: set_todos.todos must be an array.");

  const progress = await callTool(manager, "report_progress", { message: "" });
  assert.equal(progress.isError, true);
  assert.equal(progress.text, "INVALID_ARGUMENT: report_progress.message must be a non-empty string.");

  const ok = await callTool(manager, "set_todos", { todos: [{ id: "a", title: "A", status: "in_progress" }] });
  assert.notEqual(ok.isError, true);
  assert.match(ok.text, /^Todo state updated in AgentBridge: 0\/1 completed/);
});

test("Plan mode blocks write tools with READ_ONLY_MODE and a hint", async () => {
  const manager = makeManager();
  (manager as any).readOnlyMode = true;
  const result = await callTool(manager, "apply_patch", { patch: "*** Begin Patch\n*** End Patch" });
  assert.equal(result.isError, true);
  assert.match(result.text, /^READ_ONLY_MODE: Tool apply_patch is disabled in Plan mode \(read-only\)\./);
  assert.match(result.text, /\nHint: Do not retry or work around it\./);
});

test("Plan mode runs allowlisted commands and blocks the rest before they reach the shell", async () => {
  vscodeTest.reset();
  const invoked: string[] = [];
  const broker = {
    invokeDirect: async (name: string, args: Record<string, unknown>) => {
      invoked.push(`${name}: ${String(args.command)}`);
      return { text: "ran", isError: false };
    },
    dispose() {},
  } as any;
  const manager = new BridgeManager(makeContext(), { append() {}, appendLine() {} } as any, broker);
  (manager as any).readOnlyMode = true;

  const blocked = await callTool(manager, "run_command", { command: "git status; Remove-Item -Recurse src", background: false });
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /^READ_ONLY_MODE: In Plan mode, run_command only runs allowlisted read-only commands\. Blocked: Remove-Item is not on the Plan mode allowlist\./);
  assert.match(blocked.text, /\nHint: Do not work around it\..*Allowed: file inspection and search/);
  assert.deepEqual(invoked, [], "a blocked command never reaches the shell");

  const allowed = await callTool(manager, "run_command", { command: "git status -sb", background: false });
  assert.notEqual(allowed.isError, true);
  assert.deepEqual(invoked, ["run_command: git status -sb"]);

  (manager as any).readOnlyMode = false;
  await callTool(manager, "run_command", { command: "Remove-Item dist", background: false });
  assert.deepEqual(invoked.at(-1), "run_command: Remove-Item dist", "Build mode runs any command");
});

test("unknown bridge tools fail with UNKNOWN_TOOL and a refresh hint", async () => {
  const manager = makeManager();
  const result = await callTool(manager, "does_not_exist", {});
  assert.equal(result.isError, true);
  assert.match(result.text, /^UNKNOWN_TOOL: Unknown Bridge tool: does_not_exist\nHint: Refresh the tool list/);
});

test("IDE tool failures carry stable codes instead of free text", async () => {
  vscodeTest.reset();
  const broker = new IdeToolBroker();
  try {
    const unknownCommand = await broker.invokeDirect("get_command_output", { command_id: "cmd_missing" });
    assert.equal(unknownCommand.isError, true);
    assert.match(unknownCommand.text, /^UNKNOWN_COMMAND_ID: Unknown command_id: cmd_missing\.\nHint: Only the 32 most recent finished commands are retained/);

    const badWait = await broker.invokeDirect("get_command_output", { command_id: "cmd_missing", wait_until: "later" });
    assert.equal(badWait.text, "INVALID_ARGUMENT: wait_until must be \"exit\" or \"output\".");

    const notRunning = await broker.invokeDirect("send_command_input", { command_id: "cmd_missing", input: "y" });
    assert.match(notRunning.text, /^UNKNOWN_COMMAND_ID: /);

    const unknownTool = await broker.invokeDirect("no_such_tool", {});
    assert.equal(unknownTool.text, "UNKNOWN_TOOL: Unknown IDE tool: no_such_tool");
  } finally {
    broker.dispose();
  }
});
