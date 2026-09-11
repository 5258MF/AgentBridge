import test from "node:test";
import assert from "node:assert/strict";
import { activate, deactivate } from "../src/extension/src/extension.js";
import { BridgeManager, BridgeStartCancelledError } from "../src/extension/src/bridge-server.js";
import { vscodeTest } from "./helpers/fake-vscode.js";

function makeContext(): any {
  const secrets = new Map<string, string>();
  const globalState = new Map<string, unknown>();
  const subscriptions: Array<{ dispose(): void }> = [];
  return {
    extensionMode: 1,
    extension: { packageJSON: { version: "0.1.10" } },
    subscriptions: { push: (...items: Array<{ dispose(): void }>) => subscriptions.push(...items) },
    __subscriptions: subscriptions,
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => { secrets.set(key, value); },
      delete: async (key: string) => { secrets.delete(key); },
    },
    globalState: {
      get: <T>(key: string, fallback?: T) => (globalState.has(key) ? globalState.get(key) : fallback) as T,
      update: async (key: string, value: unknown) => { globalState.set(key, value); },
    },
  };
}

test("start command treats cancellation as a normal status return and propagates real errors", async () => {
  vscodeTest.reset();
  const context = makeContext();
  const originalStart = BridgeManager.prototype.start;
  let mode: "cancel" | "error" = "cancel";
  BridgeManager.prototype.start = async function () {
    if (mode === "cancel") throw new BridgeStartCancelledError();
    throw new Error("real command failure");
  };

  try {
    activate(context);
    const startCommand = vscodeTest.getCommand<() => Promise<any>>("agentbridge.bridge.start");
    const cancelled = await startCommand();
    assert.equal(cancelled.state, "stopped", "cancelled command should return the current status");

    mode = "error";
    await assert.rejects(startCommand(), /real command failure/);
  } finally {
    BridgeManager.prototype.start = originalStart;
    await deactivate();
    for (const disposable of context.__subscriptions.reverse()) disposable.dispose();
  }
});
