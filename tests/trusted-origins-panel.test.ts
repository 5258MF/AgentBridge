import test from "node:test";
import assert from "node:assert/strict";
import { BridgePanelProvider } from "../src/extension/src/bridge-panel.js";
import { BridgeStartCancelledError } from "../src/extension/src/bridge-server.js";
import { vscodeTest } from "./helpers/fake-vscode.js";
import { createFakeWebviewView, deferred, executePanelHtml, flushMicrotasks } from "./helpers/panel-harness.js";

const CONFIG_KEY = "agentbridge.bridge.trustedBrowserOrigins";

function bridgeStub(overrides: Record<string, unknown> = {}): any {
  return {
    getStatus: () => ({ tunnelProvider: "cloudflare", state: "stopped", ...overrides }),
    start: async () => ({ tunnelProvider: "cloudflare", state: "running" }),
    stop: async () => ({ tunnelProvider: "cloudflare", state: "stopped" }),
    ...overrides,
  };
}

function renderHarness(initial: string[] = ["https://baseline.example"]): ReturnType<typeof executePanelHtml> {
  vscodeTest.reset();
  vscodeTest.setConfig(CONFIG_KEY, initial);
  const provider = new BridgePanelProvider(bridgeStub(), Promise.resolve());
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view);
  return executePanelHtml(view.webview.html);
}

test("webview preserves dirty and failed-save drafts while queuing newer config", () => {
  const harness = renderHarness();
  const input = harness.element("trustedBrowserOriginsInput");
  harness.posted.length = 0;

  input.value = "https://draft.example";
  input.dispatch("input");
  assert.equal(harness.posted.at(-1)?.type, "trustedBrowserOriginsDirtyChanged");
  assert.equal(harness.posted.at(-1)?.dirty, true);

  harness.dispatchMessage({ type: "trustedBrowserOriginsChanged", origins: ["https://external-one.example"], revision: 1 });
  assert.equal(input.value, "https://draft.example");

  harness.element("trustedBrowserOriginsSaveButton").dispatch("click");
  assert.equal(harness.posted.at(-1)?.type, "setTrustedBrowserOrigins");
  assert.deepEqual(Array.from(harness.posted.at(-1)?.origins ?? []), ["https://draft.example"]);
  harness.dispatchMessage({ type: "trustedBrowserOriginsChanged", origins: ["https://external-two.example"], revision: 2 });
  assert.equal(input.value, "https://draft.example");

  harness.dispatchMessage({ type: "operationFinished", operation: "setTrustedBrowserOrigins", succeeded: false });
  assert.equal(input.value, "https://draft.example", "failed save must preserve the draft");

  input.value = "https://baseline.example";
  input.dispatch("input");
  assert.equal(input.value, "https://external-two.example", "returning to baseline should apply the newest pending config");
  assert.ok(harness.posted.some((message) => message.type === "trustedBrowserOriginsDirtyChanged" && message.dirty === false));
});

test("webview resolves Saved vs Changed by revision and ignores older revisions", () => {
  const harness = renderHarness();
  const input = harness.element("trustedBrowserOriginsInput");
  input.value = "https://draft.example";
  input.dispatch("input");
  harness.element("trustedBrowserOriginsSaveButton").dispatch("click");

  harness.dispatchMessage({ type: "trustedBrowserOriginsChanged", origins: ["https://newer-external.example"], revision: 2 });
  harness.dispatchMessage({ type: "trustedBrowserOriginsSaved", origins: ["https://older-save.example"], revision: 1 });
  assert.equal(input.value, "https://newer-external.example", "newer Changed revision must beat an older save acknowledgement");

  harness.dispatchMessage({ type: "trustedBrowserOriginsChanged", origins: ["https://stale.example"], revision: 1 });
  assert.equal(input.value, "https://newer-external.example", "old revision must not overwrite current state");

  const newerSave = renderHarness();
  const newerInput = newerSave.element("trustedBrowserOriginsInput");
  newerInput.value = "https://draft.example";
  newerInput.dispatch("input");
  newerSave.element("trustedBrowserOriginsSaveButton").dispatch("click");
  newerSave.dispatchMessage({ type: "trustedBrowserOriginsChanged", origins: ["https://external.example"], revision: 2 });
  newerSave.dispatchMessage({ type: "trustedBrowserOriginsSaved", origins: ["https://saved.example"], revision: 3 });
  assert.equal(newerInput.value, "https://saved.example", "newer save acknowledgement must beat older pending config");
});

test("unchanged-content save failure does not block pending external config", () => {
  const harness = renderHarness();
  const input = harness.element("trustedBrowserOriginsInput");
  harness.element("trustedBrowserOriginsSaveButton").dispatch("click");
  harness.dispatchMessage({ type: "trustedBrowserOriginsChanged", origins: ["https://external.example"], revision: 1 });
  assert.equal(input.value, "https://baseline.example");
  harness.dispatchMessage({ type: "operationFinished", operation: "setTrustedBrowserOrigins", succeeded: false });
  assert.equal(input.value, "https://external.example");
});

test("host save replies with effective configuration after a concurrent external change", async () => {
  vscodeTest.reset();
  vscodeTest.setConfig(CONFIG_KEY, ["https://baseline.example"]);
  const updateStarted = deferred<void>();
  const updateGate = deferred<void>();
  vscodeTest.setUpdateHandler(async ({ key }) => {
    assert.equal(key, CONFIG_KEY);
    updateStarted.resolve();
    await updateGate.promise;
  });

  const provider = new BridgePanelProvider(bridgeStub(), Promise.resolve());
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view);
  view.webview.receive({ type: "trustedBrowserOriginsDirtyChanged", dirty: true });
  await flushMicrotasks();
  view.webview.posted.length = 0;
  view.webview.receive({ type: "setTrustedBrowserOrigins", origins: ["https://submitted.example"] });
  await updateStarted.promise;

  vscodeTest.setConfig(CONFIG_KEY, ["https://effective.example"]);
  vscodeTest.emitConfig(CONFIG_KEY);
  updateGate.resolve();
  await flushMicrotasks(16);

  const saved = view.webview.posted.find((message: any) => message.type === "trustedBrowserOriginsSaved");
  assert.ok(saved, "host should send a save acknowledgement");
  assert.deepEqual(saved.origins, ["https://effective.example"], "host must re-read effective config instead of echoing submitted value");
  assert.equal(saved.revision, 1);
});

test("panel treats BridgeStartCancelledError as cancellation but reports ordinary errors", async () => {
  vscodeTest.reset();
  const cancelledProvider = new BridgePanelProvider(bridgeStub({
    start: async () => { throw new BridgeStartCancelledError(); },
  }), Promise.resolve());
  const cancelledView = createFakeWebviewView();
  cancelledProvider.resolveWebviewView(cancelledView);
  cancelledView.webview.receive({ type: "start" });
  await flushMicrotasks(16);
  assert.equal(vscodeTest.errors.length, 0, "cancellation must not be surfaced as an ordinary error");

  vscodeTest.reset();
  const failedProvider = new BridgePanelProvider(bridgeStub({
    start: async () => { throw new Error("real start failure"); },
  }), Promise.resolve());
  const failedView = createFakeWebviewView();
  failedProvider.resolveWebviewView(failedView);
  failedView.webview.receive({ type: "start" });
  await flushMicrotasks(16);
  assert.deepEqual(vscodeTest.errors, ["real start failure"]);
});
