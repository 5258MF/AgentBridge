import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BridgeManager } from "../src/extension/src/bridge-server.js";
import { buildReadOnlySessionNotice, buildReadOnlyTransitionNotice, READ_ONLY_BLOCKED_TOOL_NAMES } from "../src/extension/src/server-instructions.js";
import { vscodeTest } from "./helpers/fake-vscode.js";

/** Any blocked tool; the block applies before argument validation, so empty args are fine. */
const SOME_BLOCKED_TOOL = [...READ_ONLY_BLOCKED_TOOL_NAMES][0];

function makeManager(logLines?: string[]): BridgeManager {
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
  const output = { append() {}, appendLine(line: string) { logLines?.push(line); } } as any;
  const broker = { invokeDirect: async () => ({ text: "", isError: false }), dispose() {} } as any;
  return new BridgeManager(context, output, broker);
}

function addSession(manager: BridgeManager, sessionId: string, toldReadOnly: boolean | undefined, firstCallReminderPending?: boolean): void {
  ((manager as any).sessions as Map<string, unknown>).set(sessionId, {
    server: { sendToolListChanged: async () => undefined },
    lastActivity: Date.now(),
    activeRequests: 0,
    activeStreams: 0,
    toldReadOnly,
    firstCallReminderPending,
  });
}

async function call(manager: BridgeManager, sessionId: string, name = "set_todos", args: Record<string, unknown> = { todos: [] }): Promise<{ text: string; isError?: boolean; count: number }> {
  const result = await (manager as any).handleToolCall(name, args, { sessionId });
  return { text: result.content[0]?.text ?? "", isError: result.isError, count: result.content.length };
}

const ON = /^\[AgentBridge notice\] The user switched to Plan mode since your last tool call/;
const OFF = /^\[AgentBridge notice\] The user switched from Plan mode to Build mode/;
const SESSION_ON = /^\[AgentBridge notice\] This connection is in Plan mode/;

/** Mirrors createSession: the reminder is pending exactly when the session starts read-only. */
function addNewSession(manager: BridgeManager, sessionId: string): void {
  const readOnly = (manager as any).readOnlyMode === true;
  addSession(manager, sessionId, readOnly, readOnly);
}

test("notice text names every blocked tool and says what to do", () => {
  const on = buildReadOnlyTransitionNotice(true);
  for (const name of READ_ONLY_BLOCKED_TOOL_NAMES) assert.ok(on.includes(name), name);
  for (const name of READ_ONLY_BLOCKED_TOOL_NAMES) assert.ok(buildReadOnlyTransitionNotice(false).includes(name), name);
  assert.match(on, /READ_ONLY_MODE/);
  assert.match(on, /run_command only runs allowlisted read-only commands/);
  assert.match(on, /present one complete plan/);
  assert.match(on, /plan them instead/, "a request to make changes becomes a request to plan them");
  assert.match(buildReadOnlyTransitionNotice(false), /available again, and run_command can run any command/);
});

test("a toggle is announced once, in the next tool result, prefixed to its text", async () => {
  const manager = makeManager();
  addSession(manager, "s1", false);
  assert.doesNotMatch((await call(manager, "s1")).text, /AgentBridge notice/, "no change, no notice");

  manager.setReadOnlyMode(true);
  const first = await call(manager, "s1");
  assert.match(first.text, ON);
  assert.match(first.text, /\n\nTodo state cleared in AgentBridge/, "the real result follows the notice");
  assert.equal(first.count, 1, "merged into the first text block, not a separate item");
  assert.doesNotMatch((await call(manager, "s1")).text, /AgentBridge notice/, "only once");

  manager.setReadOnlyMode(false);
  assert.match((await call(manager, "s1")).text, OFF);
  assert.doesNotMatch((await call(manager, "s1")).text, /AgentBridge notice/);
});

test("a blocked call after turning read-only on carries the notice and the READ_ONLY_MODE error", async () => {
  const manager = makeManager();
  addSession(manager, "s1", false);
  manager.setReadOnlyMode(true);
  const result = await call(manager, "s1", SOME_BLOCKED_TOOL, {});
  assert.equal(result.isError, true);
  assert.match(result.text, ON);
  assert.ok(result.text.includes(`\n\nREAD_ONLY_MODE: Tool ${SOME_BLOCKED_TOOL} is disabled`));
});

test("net-zero toggles owe nothing, and sessions are tracked independently", async () => {
  const manager = makeManager();
  addSession(manager, "old", false);
  manager.setReadOnlyMode(true);
  addSession(manager, "new", true); // connected while read-only: its instructions already said so
  manager.setReadOnlyMode(false);
  manager.setReadOnlyMode(true);
  assert.doesNotMatch((await call(manager, "new")).text, /AgentBridge notice/, "on -> off -> on ends where it was told");
  assert.match((await call(manager, "old")).text, ON);
  manager.setReadOnlyMode(false);
  manager.setReadOnlyMode(true);
  assert.doesNotMatch((await call(manager, "old")).text, /AgentBridge notice/);
  assert.match((await call(manager, "new")).text, /Todo state cleared/);
});

test("calls without a known session, or legacy sessions without a told state, are unchanged", async () => {
  const manager = makeManager();
  addSession(manager, "legacy", undefined);
  manager.setReadOnlyMode(true);
  assert.doesNotMatch((await call(manager, "legacy")).text, /AgentBridge notice/);
  assert.doesNotMatch((await call(manager, "missing")).text, /AgentBridge notice/);
  const direct = await (manager as any).handleToolCall("set_todos", { todos: [] }, {});
  assert.doesNotMatch(direct.content[0].text, /AgentBridge notice/);
});

test("session notice names every blocked tool and addresses earlier usage", () => {
  const text = buildReadOnlySessionNotice();
  for (const name of READ_ONLY_BLOCKED_TOOL_NAMES) assert.ok(text.includes(name), name);
  assert.match(text, /READ_ONLY_MODE/);
  assert.match(text, /even if earlier messages in this conversation made changes or ran commands/);
  assert.match(text, /present one complete plan/);
  assert.doesNotMatch(text, /since your last tool call/, "a fresh session has no last call");
});

test("a session created in read-only mode is reminded on its first tool call, once", async () => {
  const manager = makeManager();
  manager.setReadOnlyMode(true);
  addNewSession(manager, "fresh");
  const first = await call(manager, "fresh");
  assert.match(first.text, SESSION_ON);
  assert.match(first.text, /\n\nTodo state cleared in AgentBridge/);
  assert.equal(first.count, 1);
  assert.doesNotMatch((await call(manager, "fresh")).text, /AgentBridge notice/, "only once");

  addNewSession(manager, "blocked");
  const blocked = await call(manager, "blocked", SOME_BLOCKED_TOOL, {});
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, SESSION_ON);
  assert.ok(blocked.text.includes(`\n\nREAD_ONLY_MODE: Tool ${SOME_BLOCKED_TOOL} is disabled`));
});

test("a session created in normal mode gets no first-call reminder", async () => {
  const manager = makeManager();
  addNewSession(manager, "normal");
  assert.doesNotMatch((await call(manager, "normal")).text, /AgentBridge notice/);
});

test("toggles before the first call: transition notices win, and the reminder is not repeated", async () => {
  const manager = makeManager();
  manager.setReadOnlyMode(true);
  addNewSession(manager, "a");
  manager.setReadOnlyMode(false);
  assert.match((await call(manager, "a")).text, OFF, "instructions said read-only, now it is off");
  manager.setReadOnlyMode(true);
  assert.match((await call(manager, "a")).text, ON);
  assert.doesNotMatch((await call(manager, "a")).text, /AgentBridge notice/);

  addNewSession(manager, "b");
  manager.setReadOnlyMode(false);
  manager.setReadOnlyMode(true);
  assert.match((await call(manager, "b")).text, SESSION_ON, "net-zero toggle still leaves the first-call reminder");
  assert.doesNotMatch((await call(manager, "b")).text, /AgentBridge notice/);
});

test("a repeated setReadOnlyMode with the same value is a no-op (panel + config listener both fire)", () => {
  const lines: string[] = [];
  const manager = makeManager(lines);
  manager.setReadOnlyMode(true);
  manager.setReadOnlyMode(true);
  manager.setReadOnlyMode(false);
  manager.setReadOnlyMode(false);
  const toggles = lines.filter((line) => line.startsWith("[bridge] read-only mode"));
  assert.deepEqual(toggles, ["[bridge] read-only mode enabled", "[bridge] read-only mode disabled"]);
});

test("every Bridge start begins in Build mode, in memory and in settings", async () => {
  const lines: string[] = [];
  const manager = makeManager(lines);
  vscodeTest.setConfig("agentbridge.bridge.readOnlyMode", true);
  manager.setReadOnlyMode(true);
  await (manager as any).resetToBuildModeForStart();
  assert.equal(manager.getStatus().readOnlyMode, false);
  assert.equal(vscodeTest.getConfig("agentbridge.bridge.readOnlyMode"), false, "persisted, so the panel and settings agree");
  assert.equal(lines.filter((line) => line === "[bridge] read-only mode disabled").length, 1);
  assert.equal(lines.filter((line) => line.startsWith("[bridge] start: Build mode")).length, 1);

  const before = lines.length;
  await (manager as any).resetToBuildModeForStart();
  assert.equal(lines.length, before, "already in Build mode: nothing to do");
});

test("the Build-mode reset runs on start before the HTTP server, and not in automatic tunnel recovery", () => {
  const source = readFileSync(path.join(process.cwd(), "src/extension/src/bridge-server.ts"), "utf8");
  assert.equal(source.split("this.resetToBuildModeForStart()").length, 2, "called from exactly one place");
  const startInternal = source.indexOf("private async startInternal(");
  const call = source.indexOf("this.resetToBuildModeForStart()");
  const httpServer = source.indexOf("await this.startHttpServer()", startInternal);
  const nextMethod = source.indexOf("\n  private async ", startInternal + 1);
  assert.ok(startInternal > 0 && startInternal < call && call < httpServer && call < nextMethod, "inside startInternal, before any session can exist");
});
