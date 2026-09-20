import test from "node:test";
import assert from "node:assert/strict";
import { BridgeManager } from "../src/extension/src/bridge-server.js";
import { vscodeTest } from "./helpers/fake-vscode.js";

function makeContext(): any {
  const secrets = new Map<string, string>();
  const globalState = new Map<string, unknown>();
  return {
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
  };
}

function makeManager(): BridgeManager {
  vscodeTest.reset();
  const output = { append() {}, appendLine() {} } as any;
  const broker = { invokeDirect: async () => ({ text: "", isError: false }), dispose() {} } as any;
  return new BridgeManager(makeContext(), output, broker);
}

/** handleReportProgress is an implementation detail of the manager; a caller reaches it by name. */
function report(manager: BridgeManager, input: Record<string, unknown>): string {
  const result = (manager as unknown as {
    handleReportProgress: (value: unknown, sessionId?: string) => { content: Array<{ type: string; text: string }> };
  }).handleReportProgress(input);
  return result.content[0]!.text;
}

test("a percentage past the end is reported as the end, and says so", () => {
  // Every other bounded number a caller sends is brought into range and named in the answer.
  // This one was refused outright, so a caller reporting 120% lost the whole progress report -
  // the message along with the number - and the panel it exists to feed stayed empty. A
  // percentage past the end is a caller being optimistic, not a call that cannot be answered.
  const manager = makeManager();
  const text = report(manager, { message: "almost done", percent: 120 });
  assert.match(text, /Progress reported to AgentBridge/);
  assert.match(text, /report_progress\.percent was 120: above 100, so 100 was used/);

  const clean = report(manager, { message: "halfway", percent: 50 });
  assert.equal(clean, "Progress reported to AgentBridge.", "a percentage in range says nothing extra");

  const below = report(manager, { message: "starting", percent: -5 });
  assert.match(below, /report_progress\.percent was -5: below 0, so 0 was used/);

  const whole = report(manager, { message: "no number" });
  assert.equal(whole, "Progress reported to AgentBridge.", "no percent asked for is no adjustment");

  // null is how a caller that has no percentage writes "none". boundedInteger reads a value
  // that is not a number as absent and falls back to 0, so this used to come back as 0%.
  const nullPercent = report(manager, { message: "no number", percent: null });
  assert.equal(nullPercent, "Progress reported to AgentBridge.", "a null percent is no percent, not zero");
  assert.doesNotMatch(nullPercent, /0%/, "a progress entry with no percentage is not shown as 0%");
  manager.dispose();
});
