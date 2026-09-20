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
    extension: { packageJSON: { version: "0.1.11" } },
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

test("deactivation cancels persistent auto-start before it can revive the disposed Bridge", async () => {
  vscodeTest.reset();
  vscodeTest.setConfig("agentbridge.bridge.persistentMode", true);
  const context = makeContext();
  const originalStart = BridgeManager.prototype.start;
  let starts = 0;
  BridgeManager.prototype.start = async function () {
    starts += 1;
    return this.getStatus();
  };

  try {
    activate(context);
    await deactivate();
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    assert.equal(starts, 0, "the delayed persistent callback must not start a disposed Bridge");
  } finally {
    BridgeManager.prototype.start = originalStart;
    for (const disposable of context.__subscriptions.reverse()) disposable.dispose();
  }
});

function status() {
  return { state: "stopped", tunnelProvider: "cloudflare", tunnelInstalled: true, tunnelVersion: "cloudflared 2024.1.0" };
}

async function runActivation(persistentMode: boolean): Promise<string[]> {
  vscodeTest.reset();
  vscodeTest.setConfig("agentbridge.bridge.persistentMode", persistentMode);
  const context = makeContext();
  const originalCheck = BridgeManager.prototype.checkTunnel;
  const originalStart = BridgeManager.prototype.start;
  const calls: string[] = [];
  BridgeManager.prototype.checkTunnel = async function () { calls.push("checkTunnel"); return status() as any; };
  BridgeManager.prototype.start = async function () { calls.push("start"); return status() as any; };
  try {
    activate(context);
    await new Promise((resolve) => setTimeout(resolve, 400));
    return calls;
  } finally {
    BridgeManager.prototype.checkTunnel = originalCheck;
    BridgeManager.prototype.start = originalStart;
    await deactivate();
    for (const disposable of context.__subscriptions.reverse()) disposable.dispose();
  }
}

test("a window that does not start the Bridge still checks the tunnel", async () => {
  assert.deepEqual(await runActivation(false), ["checkTunnel"], "the tunnel is checked; starting is left to the user");
});

test("persistent mode starts the Bridge and does not check the tunnel twice", async () => {
  assert.deepEqual(await runActivation(true), ["start"], "start() performs its own check");
});
