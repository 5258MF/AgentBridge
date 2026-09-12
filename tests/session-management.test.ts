import test from "node:test";
import assert from "node:assert/strict";
import { BridgeManager } from "../src/extension/src/bridge-server.js";
import { BridgePanelProvider } from "../src/extension/src/bridge-panel.js";
import { vscodeTest } from "./helpers/fake-vscode.js";
import { createFakeWebviewView, executePanelHtml, flushMicrotasks, type FakeElement } from "./helpers/panel-harness.js";

function makeContext(): any {
  const secrets = new Map<string, string>();
  const globalState = new Map<string, unknown>();
  return {
    extensionMode: 1,
    extension: { packageJSON: { version: "0.1.10" } },
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

function addSession(
  manager: BridgeManager,
  sessionId: string,
  activeRequests: number,
  activeStreams: number,
  closed: string[] = [],
): any {
  const session = {
    transport: {},
    server: { close: async () => { closed.push(sessionId); } },
    lastActivity: Date.now(),
    activeRequests,
    activeStreams,
  };
  ((manager as any).sessions as Map<string, unknown>).set(sessionId, session);
  return session;
}

function sessionInfo(row: FakeElement): string {
  return row.children[1]?.textContent ?? "";
}

test("webview classifies MCP sessions with mutually exclusive status and correct summary counts", () => {
  const manager = makeManager();
  addSession(manager, "processing", 2, 1);
  addSession(manager, "streaming", 0, 1);
  addSession(manager, "idle", 0, 0);
  const provider = new BridgePanelProvider(manager, Promise.resolve());
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view);
  const harness = executePanelHtml(view.webview.html);

  harness.dispatchMessage({ type: "status", status: manager.getStatus(), persistentMode: false, quickTunnelCopied: false });
  const list = harness.element("sessionList");
  const header = list.children[0]!;
  assert.equal(header.children[0]?.children[0]?.children[0]?.textContent, "MCP sessions · 3");
  assert.equal(header.children[0]?.children[0]?.children[1]?.textContent, "Processing 1 · Connection open 1 · Idle 1");
  assert.equal(header.children[0]?.children[1]?.disabled, false);
  assert.match(sessionInfo(list.children[1]!), /^Processing · 2 active requests · Last activity /);
  assert.match(sessionInfo(list.children[2]!), /^Connection open · 1 open streams · Last activity /);
  assert.match(sessionInfo(list.children[3]!), /^Idle · Last activity /);

  const previousChildCount = list.children.length;
  addSession(manager, "processing-two", 1, 0);
  ((manager as any).sessions as Map<string, unknown>).delete("idle");
  harness.dispatchMessage({ type: "status", status: manager.getStatus(), persistentMode: false, quickTunnelCopied: false });
  const refreshedHeader = harness.element("sessionList").children[previousChildCount]!;
  assert.equal(refreshedHeader.children[0]?.children[1]?.disabled, true, "bulk clear must be disabled when there are no idle sessions");
});

test("bulk clear rechecks current request and SSE activity instead of trusting stale idle UI", async () => {
  const manager = makeManager();
  const requestSession = addSession(manager, "request-race", 0, 0);
  const streamSession = addSession(manager, "stream-race", 0, 0);
  const stale = manager.getStatus();
  assert.ok(stale.sessions.every((session) => session.activeRequests === 0 && session.activeStreams === 0));

  const provider = new BridgePanelProvider(manager, Promise.resolve());
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view);
  requestSession.activeRequests = 1;
  streamSession.activeStreams = 1;
  view.webview.posted.length = 0;
  view.webview.receive({ type: "clearIdleSessions" });
  await flushMicrotasks(16);

  const response = view.webview.posted.find((message: any) => message.type === "idleSessionsCleared");
  assert.ok(response, "host should immediately return the cleanup result");
  assert.equal(response.clearedCount, 0);
  assert.equal(response.status.sessions.length, 2);
  assert.equal(response.status.sessions.find((session: any) => session.sessionId === "request-race")?.activeRequests, 1);
  assert.equal(response.status.sessions.find((session: any) => session.sessionId === "stream-race")?.activeStreams, 1);
});

test("bulk clear removes only truly idle sessions and immediately returns refreshed status", async () => {
  const manager = makeManager();
  const closed: string[] = [];
  addSession(manager, "idle", 0, 0, closed);
  addSession(manager, "requesting", 1, 0, closed);
  addSession(manager, "streaming", 0, 1, closed);
  const provider = new BridgePanelProvider(manager, Promise.resolve());
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view);
  view.webview.posted.length = 0;

  view.webview.receive({ type: "clearIdleSessions" });
  await flushMicrotasks(16);

  const response = view.webview.posted.find((message: any) => message.type === "idleSessionsCleared");
  assert.ok(response);
  assert.equal(response.clearedCount, 1);
  assert.deepEqual(closed, ["idle"]);
  assert.deepEqual(response.status.sessions.map((session: any) => session.sessionId).sort(), ["requesting", "streaming"]);
  assert.equal(response.status.sessionCount, 2);
  assert.ok(vscodeTest.information.some((message) => message === "Cleared 1 idle MCP sessions."));
});
