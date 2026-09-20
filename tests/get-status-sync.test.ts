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

test("a setting changed while stopped is picked up by the next read", () => {
  // There is no configuration listener, so this read is the only thing that notices. The panel
  // draws from getStatus, which is what makes the radio groups move after a hand edit.
  const manager = makeManager();
  assert.equal(manager.getStatus().tunnelProvider, "cloudflare");
  vscodeTest.setConfig("agentbridge.bridge.tunnelProvider", "ngrok");
  assert.equal(manager.getStatus().tunnelProvider, "ngrok");
});

test("reading the status leaves a current error alone", () => {
  // The same read that re-reads settings also resets the tunnel checks, and it resets the error
  // with them. That is only meant to happen when the settings actually changed: an error the
  // panel is showing must survive being read.
  const manager = makeManager();
  (manager as any).state = "error";
  (manager as any).lastError = "the tunnel could not be checked";
  manager.getStatus();
  manager.getStatus();
  assert.equal((manager as any).lastError, "the tunnel could not be checked");
});

test("a changed provider does drop what was learned about the old one", () => {
  const manager = makeManager();
  (manager as any).state = "error";
  (manager as any).lastError = "the tunnel could not be checked";
  (manager as any).tunnelChecked = true;
  vscodeTest.setConfig("agentbridge.bridge.tunnelProvider", "ngrok");
  manager.getStatus();
  assert.equal((manager as any).tunnelChecked, false);
  assert.equal((manager as any).lastError, undefined);
});
