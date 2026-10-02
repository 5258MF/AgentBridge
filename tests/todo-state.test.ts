import assert from "node:assert/strict";
import test from "node:test";
import { BridgeManager } from "../src/extension/src/bridge-server.js";
import type { BridgeTodo } from "../src/extension/src/activity-presentation.js";
import { vscodeTest } from "./helpers/fake-vscode.js";
import { deferred } from "./helpers/panel-harness.js";

type Memento = ReturnType<typeof vscodeTest.createMemento>;
const STATE_KEY = "agentbridge.bridge.todos";
const INITIAL: BridgeTodo[] = [
  { id: "read", title: "Read the project", status: "completed" },
  { id: "edit", title: "Implement the feature", status: "in_progress" },
  { id: "test", title: "Validate the change", status: "pending" },
];

function makeManager(workspaceState = vscodeTest.createMemento(), globalState = vscodeTest.createMemento(), log: string[] = []): BridgeManager {
  vscodeTest.reset();
  const context: any = {
    extensionMode: 1,
    extension: { packageJSON: { version: "0.1.16" } },
    subscriptions: [],
    workspaceState,
    globalState,
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
  };
  const output = { append() {}, appendLine(line: string) { log.push(line); } } as any;
  const broker = { invokeDirect: async () => ({ text: "", isError: false }), dispose() {} } as any;
  return new BridgeManager(context, output, broker);
}

function call(manager: BridgeManager, name: string, args: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
  return (manager as any).handleToolCall(name, args, { sessionId });
}

async function readTodos(manager: BridgeManager, sessionId?: string): Promise<BridgeTodo[]> {
  const result = await call(manager, "get_todos", {}, sessionId);
  assert.notEqual(result.isError, true);
  return result.structuredContent.todos;
}

test("get_todos reads an empty list without changing status or writing storage", async () => {
  const storage = vscodeTest.createMemento();
  storage.update = async () => { assert.fail("get_todos must not save anything"); };
  const manager = makeManager(storage);
  const before = manager.getStatus();
  const result = await call(manager, "get_todos");
  assert.notEqual(result.isError, true);
  assert.equal(result.content[0].text, "Current todo list in AgentBridge: []");
  assert.deepEqual(result.structuredContent, { todos: [] });
  assert.deepEqual(manager.getStatus(), before);
});

test("all MCP connections to one Bridge share a list and readback returns a copy", async () => {
  const manager = makeManager();
  await call(manager, "set_todos", { todos: INITIAL }, "connection-a");
  const snapshot = await readTodos(manager, "connection-b");
  assert.deepEqual(snapshot, INITIAL);
  (snapshot[0] as { title: string }).title = "Changed by the reader";
  assert.deepEqual(await readTodos(manager, "connection-a"), INITIAL);

  const replacement: BridgeTodo[] = [{ id: "next", title: "Next task", status: "pending" }];
  await call(manager, "set_todos", { todos: replacement }, "connection-b");
  assert.deepEqual(await readTodos(manager, "connection-a"), replacement);
});

test("different workspaces stay isolated even with shared extension global storage", async () => {
  const global = vscodeTest.createMemento();
  const storageA = vscodeTest.createMemento();
  const storageB = vscodeTest.createMemento();
  const a = makeManager(storageA, global);
  const b = makeManager(storageB, global);
  await call(a, "set_todos", { todos: INITIAL });
  assert.deepEqual(await readTodos(b), []);
  const other: BridgeTodo[] = [{ id: "other", title: "Other workspace task", status: "in_progress" }];
  await call(b, "set_todos", { todos: other });
  assert.deepEqual(await readTodos(a), INITIAL);
  assert.deepEqual(await readTodos(makeManager(storageA, global)), INITIAL);
  assert.deepEqual(await readTodos(makeManager(storageB, global)), other);
  assert.deepEqual(global.keys(), [], "todo persistence must not use globalState");
});

test("todo order, stable IDs and all three states survive stop and extension reload", async () => {
  const storage = vscodeTest.createMemento();
  const manager = makeManager(storage);
  const result = await call(manager, "set_todos", { todos: INITIAL });
  assert.notEqual(result.isError, true);
  assert.deepEqual(storage.get(STATE_KEY), INITIAL);
  await manager.stop();
  assert.deepEqual(await readTodos(manager, "new-connection"), INITIAL);
  assert.deepEqual(makeManager(storage).getStatus().todos, INITIAL);
});

test("clearing a list is persisted and does not clear another workspace", async () => {
  const storage = vscodeTest.createMemento();
  const manager = makeManager(storage);
  const other = makeManager();
  await call(manager, "set_todos", { todos: INITIAL });
  await call(other, "set_todos", { todos: INITIAL });
  const cleared = await call(manager, "set_todos", { todos: [] });
  assert.notEqual(cleared.isError, true);
  assert.deepEqual(storage.get(STATE_KEY), []);
  assert.deepEqual(await readTodos(makeManager(storage)), []);
  assert.deepEqual(await readTodos(other), INITIAL);
});

test("Plan mode permits reading and updating todos; progress and history cleanup preserve the list", async () => {
  const storage = vscodeTest.createMemento();
  const manager = makeManager(storage);
  manager.setReadOnlyMode(true);
  const updated = await call(manager, "set_todos", { todos: INITIAL });
  assert.notEqual(updated.isError, true);
  assert.deepEqual(await readTodos(manager), INITIAL);
  const progress = await call(manager, "report_progress", { message: "Finished this operation", percent: 100 });
  assert.notEqual(progress.isError, true);
  manager.clearActivityHistory();
  assert.deepEqual(await readTodos(manager), INITIAL, "progress is independent of todo status");
  assert.deepEqual(await readTodos(makeManager(storage)), INITIAL);
});

test("invalid updates do not change the stored or visible list", async () => {
  const storage = vscodeTest.createMemento();
  const manager = makeManager(storage);
  await call(manager, "set_todos", { todos: INITIAL });
  const invalidLists = [
    "not a list",
    [{ id: "", title: "Missing ID", status: "pending" }],
    [{ id: "a", title: " ", status: "pending" }],
    [{ id: "a", title: "Invalid state", status: "done" }],
    [INITIAL[0], INITIAL[0]],
    [{ ...INITIAL[0], status: "in_progress" }, INITIAL[1]],
    Array.from({ length: 25 }, (_, i) => ({ id: String(i), title: "Task", status: "pending" })),
  ];
  for (const todos of invalidLists) {
    const result = await call(manager, "set_todos", { todos });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^INVALID_ARGUMENT:/);
    assert.deepEqual(await readTodos(manager), INITIAL);
    assert.deepEqual(storage.get(STATE_KEY), INITIAL);
  }
  const unexpected = await call(manager, "get_todos", { todos: [] });
  assert.equal(unexpected.isError, true);
  assert.match(unexpected.content[0].text, /^INVALID_ARGUMENT:/);
});

test("invalid saved state is ignored without preventing extension activation", async () => {
  for (const saved of [null, "broken", [{ ...INITIAL[0], status: "done" }], [INITIAL[0], INITIAL[0]]]) {
    const storage = vscodeTest.createMemento();
    await storage.update(STATE_KEY, saved);
    const log: string[] = [];
    const manager = makeManager(storage, vscodeTest.createMemento(), log);
    assert.deepEqual(await readTodos(manager), []);
    assert.ok(log.some((line) => line.includes("Ignoring invalid saved workspace todo state")));
  }
});

test("a failed save returns a tool error, preserves the previous list and allows retry", async () => {
  const storage = vscodeTest.createMemento();
  const manager = makeManager(storage);
  await call(manager, "set_todos", { todos: INITIAL });
  const save = storage.update;
  storage.update = async () => { throw new Error("Disk unavailable"); };
  const failed = await call(manager, "set_todos", { todos: [] });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /^TODO_SAVE_FAILED:/);
  assert.deepEqual(await readTodos(manager), INITIAL);
  assert.deepEqual(storage.get(STATE_KEY), INITIAL);
  storage.update = save;
  const retried = await call(manager, "set_todos", { todos: [] });
  assert.notEqual(retried.isError, true);
  assert.deepEqual(await readTodos(makeManager(storage)), []);
});

test("rejected Memento saves cannot leak their cached list into recovery or later storage writes", async () => {
  for (const rollbackFails of [false, true]) {
    const storage = vscodeTest.createMemento();
    const persisted = new Map<string, unknown>();
    const setCache = storage.update;
    let failuresRemaining = 0;
    storage.update = async (key, value) => {
      // VS Code mutates its cache before awaiting persistence, and keeps it on rejection.
      await setCache(key, value);
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error("Storage commit failed after changing the cache");
      }
      for (const cachedKey of storage.keys()) persisted.set(cachedKey, storage.get(cachedKey));
    };
    const manager = makeManager(storage);
    await call(manager, "set_todos", { todos: INITIAL });
    failuresRemaining = rollbackFails ? 2 : 1;
    const rejected = await call(manager, "set_todos", { todos: [] });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /^TODO_SAVE_FAILED:/);
    if (rollbackFails) assert.match(rejected.content[0].text, /saved state could not be confirmed/);
    else assert.match(rejected.content[0].text, /previous list has been restored/);
    assert.deepEqual(await readTodos(manager), INITIAL);
    assert.deepEqual(storage.get(STATE_KEY), INITIAL, "Memento's cache must be rolled back too");
    assert.deepEqual(makeManager(storage).getStatus().todos, INITIAL);
    await storage.update("another-workspace-key", "value");
    assert.deepEqual(persisted.get(STATE_KEY), INITIAL, "later writes must not persist a rejected todo update");
  }
});

test("simultaneous updates are saved in order and only committed snapshots are readable", async () => {
  const storage: Memento = vscodeTest.createMemento();
  const manager = makeManager(storage);
  const save = storage.update;
  const firstStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  const writes: unknown[] = [];
  storage.update = async (key, value) => {
    writes.push(value);
    if (writes.length === 1) {
      firstStarted.resolve();
      await releaseFirst.promise;
    }
    await save(key, value);
  };
  const first = call(manager, "set_todos", { todos: INITIAL }, "a");
  await firstStarted.promise;
  const second = call(manager, "set_todos", { todos: [] }, "b");
  assert.deepEqual(await readTodos(manager), [], "the first save has not committed yet");
  assert.equal(writes.length, 1, "the second save must wait for the first");
  releaseFirst.resolve();
  const results = await Promise.all([first, second]);
  assert.ok(results.every((result) => result.isError !== true));
  assert.deepEqual(writes, [INITIAL, []]);
  assert.deepEqual(await readTodos(manager), []);
  assert.deepEqual(await readTodos(makeManager(storage)), []);
});

test("async extension shutdown waits for a pending todo save", async () => {
  const storage = vscodeTest.createMemento();
  const manager = makeManager(storage);
  const save = storage.update;
  const started = deferred<void>();
  const release = deferred<void>();
  storage.update = async (key, value) => {
    started.resolve();
    await release.promise;
    await save(key, value);
  };
  const pending = call(manager, "set_todos", { todos: INITIAL });
  await started.promise;
  let disposed = false;
  const shutdown = manager.disposeAsync().then(() => { disposed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(disposed, false);
  release.resolve();
  await Promise.all([pending, shutdown]);
  assert.deepEqual(makeManager(storage).getStatus().todos, INITIAL);
});
