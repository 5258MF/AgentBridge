import test from "node:test";
import assert from "node:assert/strict";
import { BridgeManager } from "../src/extension/src/bridge-server.js";
import { vscodeTest } from "./helpers/fake-vscode.js";

function makeManager(): BridgeManager {
  vscodeTest.reset();
  const secrets = new Map<string, string>();
  const globalState = new Map<string, unknown>();
  const context = {
    extensionMode: 1,
    extension: { packageJSON: { version: "0.1.11" } },
    subscriptions: [],
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => { secrets.set(key, value); },
      delete: async (key: string) => { secrets.delete(key); },
    },
    globalState: {
      get: <T>(key: string, fallback?: T) => (globalState.has(key) ? globalState.get(key) : fallback) as T,
      update: async (key: string, value: unknown) => { globalState.set(key, value); },
    },
  } as any;
  const output = { append() {}, appendLine() {} } as any;
  const broker = { invokeDirect: async () => ({ text: "", isError: false }), dispose() {} } as any;
  return new BridgeManager(context, output, broker);
}

async function callSetTodos(manager: BridgeManager, todos: unknown): Promise<void> {
  await (manager as any).handleToolCall("set_todos", { todos }, {});
}

test("a todo update is on the timeline and in the count", async () => {
  // The plan a caller keeps across a job is the one thing the panel exists to show, and it was
  // the one call that left no trace: handleToolCall returned before the activity was pushed, so
  // the timeline jumped from one file call to the next and the counter under-counted.
  const manager = makeManager();
  await callSetTodos(manager, [{ id: "a", title: "Read the file", status: "in_progress" }]);

  const activities = (manager as any).activities as Array<{ tool: string; status: string }>;
  assert.equal(activities.length, 1, JSON.stringify(activities));
  assert.equal(activities[0]?.tool, "set_todos");
  assert.equal(activities[0]?.status, "completed");
  assert.equal((manager as any).toolCalls, 1);
  assert.equal((manager as any).lastTool, "set_todos");
});

test("a rejected todo update is on the timeline as a failure", async () => {
  const manager = makeManager();
  await assert.rejects(
    () => callSetTodos(manager, [{ id: "a", title: "Read the file", status: "halfway" }]),
    /status must be/,
  );

  const activities = (manager as any).activities as Array<{ tool: string; status: string; message?: string }>;
  assert.equal(activities.length, 1, JSON.stringify(activities));
  assert.equal(activities[0]?.status, "error");
  assert.match(activities[0]?.message ?? "", /status must be/);
});
