import assert from "node:assert/strict";
import test from "node:test";
import { BridgeManager, READ_ONLY_BLOCKED_TOOL_NAMES } from "../src/extension/src/bridge-server.js";
import { BridgePanelProvider } from "../src/extension/src/bridge-panel.js";
import { vscodeTest } from "./helpers/fake-vscode.js";
import { createFakeWebviewView, executePanelHtml } from "./helpers/panel-harness.js";

function makeManager(): BridgeManager {
  vscodeTest.reset();
  const globalState = new Map<string, unknown>();
  const context: any = {
    extensionMode: 1,
    extension: { packageJSON: { version: "0.1.13" } },
    subscriptions: [],
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
    globalState: {
      get: <T>(key: string, fallback?: T) => (globalState.has(key) ? globalState.get(key) : fallback) as T,
      update: async (key: string, value: unknown) => { globalState.set(key, value); },
    },
  };
  const output = { append() {}, appendLine() {} } as any;
  const broker = { invokeDirect: async () => ({ text: "", isError: false }), dispose() {} } as any;
  return new BridgeManager(context, output, broker);
}

function openPanel(tunnelProvider: string) {
  const manager = makeManager();
  const provider = new BridgePanelProvider(manager, Promise.resolve());
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view);
  const harness = executePanelHtml(view.webview.html);
  const sendStatus = (readOnlyMode: boolean) => harness.dispatchMessage({
    type: "status",
    status: { ...manager.getStatus(), tunnelProvider, readOnlyMode },
    persistentMode: false,
    quickTunnelCopied: false,
  });
  sendStatus(false);
  return { harness, sendStatus };
}

function panelHtml(): string {
  const manager = makeManager();
  const provider = new BridgePanelProvider(manager, Promise.resolve());
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view);
  return view.webview.html;
}

test("the Plan | Build switch sits in the hero header next to the state badge, not in advanced settings", () => {
  const html = panelHtml();
  const at = (needle: string) => html.indexOf(needle);
  assert.equal(html.split('id="modePlanButton"').length, 2, "exactly one Plan button");
  assert.equal(html.split('id="modeBuildButton"').length, 2, "exactly one Build button");
  assert.ok(!html.includes('id="readOnlyToggle"') && !html.includes('id="readOnlyBadge"'), "the old switch and badge are gone");
  assert.ok(at('class="agentbridge-card agentbridge-hero"') < at('id="modePlanButton"'), "inside the hero card");
  assert.ok(at('id="modePlanButton"') < at('id="modeBuildButton"') && at('id="modeBuildButton"') < at('id="stateBadge"'), "Plan, Build, then the running/stopped badge");
  assert.ok(at('id="readOnlyNotice"') < at('id="publicUrlSection"'), "the notice is in the hero card, under the status line");
  assert.ok(at('id="modeBuildButton"') < at('id="trustedBrowserOriginsInput"'), "no longer in advanced settings");
});

test("the Plan hover text lists every blocked tool from the live list", () => {
  const planTag = panelHtml().match(/<button[^>]*id="modePlanButton"[^>]*>/)?.[0] ?? "";
  for (const name of READ_ONLY_BLOCKED_TOOL_NAMES) assert.ok(planTag.includes(name), `Plan title names ${name}`);
});

test("the switch shows the current mode and only acts when the other side is clicked", () => {
  const { harness, sendStatus } = openPanel("ngrok");
  const plan = harness.element("modePlanButton");
  const build = harness.element("modeBuildButton");
  const modeMessages = () => harness.posted.filter((message: any) => message?.type === "setReadOnlyMode").length;
  assert.equal(plan.getAttribute("aria-checked"), "false");
  assert.equal(build.getAttribute("aria-checked"), "true");

  build.click();
  assert.equal(modeMessages(), 0, "clicking the active side does nothing");
  plan.click();
  assert.equal(JSON.stringify(harness.posted.at(-1)), JSON.stringify({ type: "setReadOnlyMode", enabled: true }));
  assert.equal(plan.getAttribute("aria-checked"), "true");
  assert.equal(build.getAttribute("aria-checked"), "false");

  sendStatus(true);
  plan.click();
  assert.equal(modeMessages(), 1, "already in Plan mode");
  build.click();
  assert.equal(JSON.stringify(harness.posted.at(-1)), JSON.stringify({ type: "setReadOnlyMode", enabled: false }));
  assert.equal(build.getAttribute("aria-checked"), "true");
  sendStatus(true); // changed elsewhere: the status wins
  assert.equal(plan.getAttribute("aria-checked"), "true");
});

test("the read-only notice appears under the switch and survives status refreshes", () => {
  const { harness, sendStatus } = openPanel("cloudflare");
  const notice = harness.element("readOnlyNotice");
  assert.notEqual(notice.style.display, "", "hidden until the switch is used (the fake DOM ignores inline style attributes)");

  harness.element("modePlanButton").click();
  assert.equal(JSON.stringify(harness.posted.at(-1)), JSON.stringify({ type: "setReadOnlyMode", enabled: true }));
  assert.equal(notice.style.display, "");
  assert.match(notice.textContent, /Plan mode|计划模式/);

  sendStatus(false); // a poll that raced ahead of the setting update must not hide it
  assert.equal(notice.style.display, "");
  sendStatus(true);
  sendStatus(true);
  assert.equal(notice.style.display, "", "periodic status renders keep the notice visible");
  assert.equal(harness.element("addressNotice").style.display, "none", "the address notice is no longer reused");

  sendStatus(false); // changed elsewhere after being confirmed
  assert.equal(notice.style.display, "none");
});

test("the notice is the same for every tunnel and never asks for a tool-list refresh", () => {
  const texts = new Set<string>();
  for (const provider of ["cloudflare", "ngrok", "cloudflare-named"]) {
    const { harness } = openPanel(provider);
    harness.element("modePlanButton").click();
    const notice = harness.element("readOnlyNotice");
    assert.equal(notice.style.display, "");
    assert.doesNotMatch(notice.textContent, /refresh|刷新/, provider);
    texts.add(notice.textContent);
  }
  assert.equal(texts.size, 1, "the tool list no longer changes, so the tunnel type does not matter");
});
