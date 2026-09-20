import test from "node:test";
import assert from "node:assert/strict";
import { BridgeManager } from "../src/extension/src/bridge-server.js";
import { vscodeTest } from "./helpers/fake-vscode.js";

function makeManager(): BridgeManager {
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

function readOnly(): boolean {
  return (makeManager() as any).readReadOnlyMode();
}

test("a workspace cannot switch read-only mode off", () => {
  // Read-only mode is a restriction, so the scope that is easiest for someone else to write -
  // a settings.json in a repository - must not be the one that decides whether it holds. The
  // merged configuration read the workspace first, which let a repository re-enable apply_patch
  // and run_command for anyone who opened it.
  vscodeTest.reset();
  vscodeTest.setConfig("agentbridge.bridge.readOnlyMode", true);
  vscodeTest.setWorkspaceConfig("agentbridge.bridge.readOnlyMode", false);
  assert.equal(readOnly(), true);
});

test("a workspace can still tighten a project read-only", () => {
  vscodeTest.reset();
  vscodeTest.setConfig("agentbridge.bridge.readOnlyMode", false);
  vscodeTest.setWorkspaceConfig("agentbridge.bridge.readOnlyMode", true);
  assert.equal(readOnly(), true);
});

test("read-only mode is off when nothing sets it", () => {
  vscodeTest.reset();
  vscodeTest.setConfig("agentbridge.bridge.readOnlyMode", false);
  assert.equal(readOnly(), false);
});
