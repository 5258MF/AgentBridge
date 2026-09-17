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
  assert.match(view.webview.html, /agentbridge-session-list-heading[^}]*flex-wrap:\s*nowrap/);
  assert.match(view.webview.html, /agentbridge-session-list-summary[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/);
  assert.match(view.webview.html, /agentbridge-session-todos-region:empty\s*{\s*display:\s*none/);
  assert.match(view.webview.html, /agentbridge-session-history-toolbar[^}]*min-height:\s*31px[^}]*padding:\s*4px 12px/);
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

test("activity history cleanup preserves running tools, todos, sessions, and cumulative stats", () => {
  const manager = makeManager();
  addSession(manager, "connected", 1, 0);
  (manager as any).todos = [{ id: "todo-1", title: "Keep this todo", status: "in_progress" }];
  (manager as any).toolCalls = 9;
  (manager as any).completedToolCalls = 7;
  (manager as any).failedToolCalls = 2;
  (manager as any).totalToolDurationMs = 3_500;
  (manager as any).activities.push(
    { id: 1, at: new Date().toISOString(), tool: "read_files", status: "completed", durationMs: 25 },
    { id: 2, at: new Date().toISOString(), tool: "run_command", status: "running" },
    { id: 3, at: new Date().toISOString(), tool: "report_progress", status: "progress", message: "Working" },
    { id: 4, at: new Date().toISOString(), tool: "search_files", status: "error", durationMs: 10, message: "failed" },
  );
  const before = manager.getStatus();

  assert.equal(manager.clearActivityHistory(), 3);
  const after = manager.getStatus();

  assert.deepEqual(after.activities.map((activity) => [activity.id, activity.status]), [[2, "running"]]);
  assert.deepEqual(after.todos, before.todos);
  assert.equal(after.sessionCount, before.sessionCount);
  assert.deepEqual(after.sessions, before.sessions);
  assert.deepEqual(after.stats, before.stats);
  assert.equal(after.revision, before.revision + 1);

  const revisionAfterClear = after.revision;
  assert.equal(manager.clearActivityHistory(), 0);
  assert.equal(manager.getStatus().revision, revisionAfterClear, "no-op cleanup must not bump revision");

  (manager as any).finishActivity(2, "completed", 40);
  assert.deepEqual(manager.getStatus().activities.map((activity) => [activity.id, activity.status]), [[2, "completed"]], "a retained running activity must still be finishable after cleanup");
});

test("activity history cleanup never clears todos, even when every todo is completed", () => {
  const manager = makeManager();
  (manager as any).todos = [
    { id: "done-1", title: "Done one", status: "completed" },
    { id: "done-2", title: "Done two", status: "completed" },
  ];
  const beforeCompletedClear = manager.getStatus();

  assert.equal(manager.clearActivityHistory(), 0);
  const afterCompletedClear = manager.getStatus();
  assert.deepEqual(afterCompletedClear.todos, beforeCompletedClear.todos);
  assert.equal(afterCompletedClear.revision, beforeCompletedClear.revision, "todo-only state must not make activity cleanup mutate revision");

  (manager as any).todos = [
    { id: "done", title: "Done", status: "completed" },
    { id: "pending", title: "Pending", status: "pending" },
  ];
  const beforePendingClear = manager.getStatus().revision;

  assert.equal(manager.clearActivityHistory(), 0);
  assert.deepEqual(manager.getStatus().todos.map((todo) => [todo.id, todo.status]), [["done", "completed"], ["pending", "pending"]]);
  assert.equal(manager.getStatus().revision, beforePendingClear, "an unfinished todo list must be preserved without a revision bump");
});

test("activity history clear button disables without history and host immediately returns refreshed state", async () => {
  const manager = makeManager();
  const provider = new BridgePanelProvider(manager, Promise.resolve());
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view);
  const harness = executePanelHtml(view.webview.html);

  harness.dispatchMessage({
    type: "status",
    status: { ...manager.getStatus(), revision: 1, activities: [] },
    persistentMode: false,
    quickTunnelCopied: false,
  });
  assert.equal(harness.element("clearHistoryButton").disabled, true);

  const running = { id: 10, at: new Date().toISOString(), tool: "run_command", status: "running" };
  const completed = { id: 11, at: new Date().toISOString(), tool: "read_files", status: "completed", durationMs: 15 };
  (manager as any).activities.push(running, completed);
  harness.dispatchMessage({
    type: "status",
    status: { ...manager.getStatus(), revision: 2 },
    persistentMode: false,
    quickTunnelCopied: false,
  });
  assert.equal(harness.element("clearHistoryButton").disabled, false);
  harness.element("clearHistoryButton").click();
  assert.ok(harness.posted.some((message: any) => message.type === "clearActivityHistory"));

  view.webview.posted.length = 0;
  view.webview.receive({ type: "clearActivityHistory" });
  await flushMicrotasks(16);

  const response = view.webview.posted.find((message: any) => message.type === "activityHistoryCleared");
  assert.ok(response, "host should return activity cleanup state immediately");
  assert.equal(response.clearedCount, 1);
  assert.deepEqual(response.status.activities.map((activity: any) => [activity.id, activity.status]), [[10, "running"]]);
  harness.dispatchMessage(response);
  assert.equal(harness.element("clearHistoryButton").disabled, true, "only a running activity remains, so there is nothing clearable");
});

test("activity history clear button stays disabled for an all-completed todo list without activity history", () => {
  const manager = makeManager();
  const provider = new BridgePanelProvider(manager, Promise.resolve());
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view);
  const harness = executePanelHtml(view.webview.html);

  harness.dispatchMessage({
    type: "status",
    status: {
      ...manager.getStatus(),
      revision: 1,
      activities: [],
      todos: [{ id: "done", title: "Finished", status: "completed" }],
    },
    persistentMode: false,
    quickTunnelCopied: false,
  });
  assert.equal(harness.element("clearHistoryButton").disabled, true);
  harness.element("clearHistoryButton").click();
  assert.equal(harness.posted.some((message: any) => message.type === "clearActivityHistory"), false);
});

test("webview presents public health compactly and exposes a manual check", () => {
  const manager = makeManager();
  const provider = new BridgePanelProvider(manager, Promise.resolve());
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view);
  const harness = executePanelHtml(view.webview.html);
  const checkedAt = new Date().toISOString();

  harness.dispatchMessage({
    type: "status",
    status: {
      ...manager.getStatus(),
      state: "running",
      tunnelChecked: true,
      tunnelInstalled: true,
      tunnelConfigValid: true,
      publicUrl: "https://agentbridge-test.example.com/mcp/redacted-test-token",
      publicHealthState: "healthy",
      publicHealthAvailable: true,
      publicHealthAutomatic: true,
      publicHealthChecking: false,
      publicHealthFailureCount: 0,
      publicHealthLastCheckedAt: checkedAt,
      publicHealthLastSuccessAt: checkedAt,
    },
    persistentMode: false,
    quickTunnelCopied: false,
  });
  assert.equal(harness.element("sessionPublicHealthBadge").textContent, "Public healthy");
  assert.match(harness.element("sessionPublicHealthBadge").className, /state-healthy/);
  assert.equal(harness.element("configPublicHealthBadge").textContent, "Public healthy");
  assert.equal(harness.element("connectionBadge").textContent, "Public healthy", "collapsed Connection Settings must expose public health");
  assert.match(harness.element("connectionBadge").className, /agentbridge-public-health-badge state-healthy/);
  assert.equal(harness.element("publicHealthDetails").textContent, "The public endpoint is reachable.");
  assert.match(harness.element("publicHealthMeta").textContent, /Last checked:/);
  assert.equal(harness.element("checkPublicHealthButton").disabled, false);

  harness.dispatchMessage({
    type: "status",
    status: {
      ...manager.getStatus(),
      state: "running",
      tunnelChecked: true,
      tunnelInstalled: true,
      tunnelConfigValid: true,
      publicUrl: "https://agentbridge-test.example.com/mcp/redacted-test-token",
      publicHealthState: "unhealthy",
      publicHealthAvailable: true,
      publicHealthAutomatic: true,
      publicHealthChecking: false,
      publicHealthFailureCount: 2,
      publicHealthLastCheckedAt: checkedAt,
      publicHealthLastSuccessAt: checkedAt,
      publicHealthError: "Public health check returned HTTP 502.",
    },
    persistentMode: false,
    quickTunnelCopied: false,
  });
  assert.equal(harness.element("sessionPublicHealthBadge").textContent, "Public unavailable");
  assert.match(harness.element("sessionPublicHealthBadge").className, /state-unhealthy/);
  assert.equal(harness.element("connectionBadge").textContent, "Public unavailable");
  assert.match(harness.element("connectionDetails").textContent, /^The public endpoint failed consecutive checks while the local Bridge remains running\./);
  assert.match(harness.element("publicHealthMeta").textContent, /Consecutive failures: 2/);
  assert.match(view.webview.html, /agentbridge-session-connection-heading[\s\S]*connectionTitle[\s\S]*sessionPublicHealthBadge/);
  assert.doesNotMatch(view.webview.html, /agentbridge-session-connection-actions[^<]*<span[^>]*sessionPublicHealthBadge/);
  assert.match(view.webview.html, /agentbridge-public-health-badge[^}]*background:\s*var\(--vscode-badge-background\)[^}]*font-size:\s*11px/);
  assert.match(view.webview.html, /sessionPublicHealthBadge[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(view.webview.html, /agentbridge-session-connection-heading \.agentbridge-public-health-badge[^}]*flex:\s*0 1 auto[^}]*text-overflow:\s*ellipsis/);
  assert.ok(view.webview.html.indexOf('id="publicHealthPanel"') < view.webview.html.indexOf('id="tunnelSetupPanel"'), "expanded health details belong at the top of Connection Settings, not inside Tunnel Status");

  harness.element("checkPublicHealthButton").click();
  const healthRequest = harness.posted.find((message: any) => message.type === "checkPublicHealth");
  assert.equal(typeof healthRequest?.requestId, "string");
  assert.equal(harness.element("checkPublicHealthButton").disabled, true);
  assert.equal(harness.element("checkPublicHealthButton").textContent, "Checking");

  harness.dispatchMessage({
    type: "status",
    status: {
      ...manager.getStatus(),
      state: "running",
      publicUrl: "https://agentbridge-test.example.com/mcp/redacted-test-token",
      publicHealthState: "healthy",
      publicHealthAvailable: true,
      publicHealthAutomatic: true,
      publicHealthChecking: false,
      publicHealthFailureCount: 0,
    },
    persistentMode: false,
    quickTunnelCopied: false,
  });
  assert.equal(harness.element("checkPublicHealthButton").disabled, true, "ordinary polling must not clear a pending manual check");

  harness.dispatchMessage({
    type: "publicHealthChecked",
    requestId: "stale-health-request",
    status: {
      ...manager.getStatus(),
      state: "running",
      publicHealthState: "healthy",
      publicHealthAvailable: true,
      publicHealthAutomatic: true,
      publicHealthChecking: false,
      publicHealthFailureCount: 0,
    },
    persistentMode: false,
    quickTunnelCopied: false,
  });
  assert.equal(harness.element("checkPublicHealthButton").disabled, true, "a stale completion must not clear the current request");

  harness.dispatchMessage({
    type: "publicHealthChecked",
    requestId: healthRequest.requestId,
    status: {
      ...manager.getStatus(),
      state: "running",
      publicUrl: "https://agentbridge-test.example.com/mcp/redacted-test-token",
      publicHealthState: "healthy",
      publicHealthAvailable: true,
      publicHealthAutomatic: true,
      publicHealthChecking: false,
      publicHealthFailureCount: 0,
    },
    persistentMode: false,
    quickTunnelCopied: false,
  });
  assert.equal(harness.element("checkPublicHealthButton").disabled, false);

  harness.dispatchMessage({
    type: "status",
    status: {
      ...manager.getStatus(),
      state: "running",
      tunnelProvider: "ngrok",
      publicUrl: "https://agentbridge-test.ngrok-free.dev/mcp/redacted-test-token",
      publicHealthState: "healthy",
      publicHealthAvailable: true,
      publicHealthAutomatic: false,
      publicHealthChecking: false,
      publicHealthFailureCount: 0,
    },
    persistentMode: false,
    quickTunnelCopied: false,
  });
  assert.match(harness.element("publicHealthMeta").textContent, /verified only at startup and on manual checks/);

  harness.dispatchMessage({
    type: "status",
    status: {
      ...manager.getStatus(),
      state: "running",
      publicUrl: "https://configured-but-not-running.example.com/mcp/redacted-test-token",
      publicHealthState: "inactive",
      publicHealthAvailable: false,
      publicHealthAutomatic: false,
      publicHealthChecking: false,
      publicHealthFailureCount: 0,
    },
    persistentMode: false,
    quickTunnelCopied: false,
  });
  assert.equal(harness.element("publicHealthPanel").style.display, "none");
  assert.equal(harness.element("sessionPublicHealthBadge").style.display, "none");
  assert.equal(harness.element("checkPublicHealthButton").disabled, true);

  harness.dispatchMessage({
    type: "status",
    status: {
      ...manager.getStatus(),
      state: "starting",
      tunnelChecked: true,
      tunnelInstalled: true,
      tunnelConfigValid: true,
      publicHealthState: "checking",
      publicHealthAvailable: false,
      publicHealthAutomatic: false,
      publicHealthChecking: false,
      publicHealthFailureCount: 0,
    },
    persistentMode: false,
    quickTunnelCopied: false,
  });
  assert.equal(harness.element("connectionBadge").textContent, "Starting…");
  assert.equal(harness.element("connectionDetails").textContent, "Generating a new temporary Cloudflare MCP address…");
});

test("manual public health check uses a dedicated completion message instead of global busy state", async () => {
  const manager = makeManager();
  let checks = 0;
  let failure: Error | undefined;
  (manager as any).checkPublicHealth = async () => {
    checks += 1;
    if (failure) throw failure;
    return manager.getStatus();
  };
  const provider = new BridgePanelProvider(manager, Promise.resolve());
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view);
  view.webview.posted.length = 0;

  view.webview.receive({ type: "checkPublicHealth", requestId: "health-success" });
  await flushMicrotasks(16);

  assert.equal(checks, 1);
  assert.ok(view.webview.posted.some((message: any) => message.type === "publicHealthChecked" && message.requestId === "health-success"));
  assert.equal(
    view.webview.posted.some((message: any) => message.type === "operationFinished" && message.operation === "checkPublicHealth"),
    false,
    "a health completion must not reset an unrelated panel operation",
  );

  view.webview.posted.length = 0;
  failure = new Error("simulated public health failure");
  view.webview.receive({ type: "checkPublicHealth", requestId: "health-failure" });
  await flushMicrotasks(16);
  assert.equal(checks, 2);
  assert.ok(view.webview.posted.some((message: any) => message.type === "publicHealthChecked" && message.requestId === "health-failure"), "failure still releases the Webview pending state");
  assert.ok(vscodeTest.errors.includes("simulated public health failure"));
  assert.equal(view.webview.posted.some((message: any) => message.type === "operationFinished"), false);
});

test("a session initialized after teardown begins is closed instead of being retained", async () => {
  const manager = makeManager();
  let reservationReleases = 0;
  const ownerServer = {};
  (manager as any).httpServer = ownerServer;
  const ownerGeneration = (manager as any).tunnelGeneration;
  const created = (manager as any).createSession(ownerServer, ownerGeneration, () => { reservationReleases += 1; });
  const callback = (created.transport as any)._webStandardTransport._onsessioninitialized as ((sid: string) => void | Promise<void>);
  assert.equal(typeof callback, "function");
  (manager as any).stoppingResources = true;
  (manager as any).httpServer = undefined;
  try {
    await callback("late-session");
    await flushMicrotasks(8);
    assert.equal(reservationReleases, 1);
    assert.equal(manager.getStatus().sessionCount, 0);
    assert.equal(manager.getStatus().connected, false);
  } finally {
    (manager as any).stoppingResources = false;
  }
});

test("an initialization owned by an old HTTP server cannot enter a restarted Bridge or release its reservation", async () => {
  const manager = makeManager();
  const oldOwner = {};
  const newOwner = {};
  const oldGeneration = 7;
  (manager as any).httpServer = oldOwner;
  (manager as any).tunnelGeneration = oldGeneration;
  let reservationReleases = 0;
  const created = (manager as any).createSession(oldOwner, oldGeneration, () => { reservationReleases += 1; });
  const callback = (created.transport as any)._webStandardTransport._onsessioninitialized as ((sid: string) => void | Promise<void>);

  (manager as any).httpServer = newOwner;
  (manager as any).tunnelGeneration = oldGeneration + 1;
  (manager as any).pendingInitializations = 1;
  let responseStatus: number | undefined;
  const staleResponse = {
    headersSent: false,
    writeHead(status: number) { responseStatus = status; return this; },
    end() { return this; },
  };
  await (manager as any).handlePost(oldOwner, oldGeneration, {}, staleResponse, {}, undefined);
  assert.equal(responseStatus, 503, "a POST parsed after its listener was replaced must be rejected before admission");
  assert.equal((manager as any).pendingInitializations, 1, "the rejected old POST must not alter the new generation's admission count");

  await callback("old-server-session");
  await flushMicrotasks(8);

  assert.equal(reservationReleases, 1);
  assert.equal((manager as any).pendingInitializations, 1, "an old reservation must not consume a new generation's capacity slot");
  assert.equal(manager.getStatus().sessionCount, 0, "the old server's session must be closed instead of retained");
});
