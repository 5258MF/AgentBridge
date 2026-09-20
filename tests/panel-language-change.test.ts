import test from "node:test";
import assert from "node:assert/strict";
import { BridgePanelProvider } from "../src/extension/src/bridge-panel.js";
import { vscodeTest } from "./helpers/fake-vscode.js";
import { createFakeWebviewView, executePanelHtml, flushMicrotasks } from "./helpers/panel-harness.js";

function status(): Record<string, unknown> {
  return { state: "running", tunnelProvider: "cloudflare", tunnelInstalled: true, tunnelConfigValid: true, tunnelChecked: true };
}

function build(): { provider: BridgePanelProvider; view: any } {
  vscodeTest.reset();
  const provider = new BridgePanelProvider({
    getStatus: () => status(),
  } as any, Promise.resolve());
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view);
  return { provider, view };
}

test("a language change rebuilds the panel on the tab the reader was reading", async () => {
  const { view } = build();
  const before = view.webview.html as string;
  assert.match(before, /<button class="agentbridge-tab active" id="tabConfig"/, before);

  view.webview.receive({ type: "setLanguage", value: "zh-CN", advancedOpen: true, activeTab: "session" });
  await flushMicrotasks();

  const after = view.webview.html as string;
  assert.match(after, /<button class="agentbridge-tab" id="tabConfig"[^>]*aria-selected="false"[^>]*tabindex="-1"/, after);
  assert.match(after, /<button class="agentbridge-tab active" id="tabSession"[^>]*aria-selected="true"[^>]*tabindex="0"/, after);
  // The two sections are switched the same way the tab click switches them, so the reader is
  // not left looking at a hidden panel and an empty one.
  assert.match(after, /<div id="configSection" style="display:none;">/, after);
  assert.match(after, /<div class="agentbridge-session-view" id="sessionSection">/, after);
  assert.match(after, /<details class="agentbridge-card agentbridge-advanced-card" id="advancedCard" open>/, after);
});

test("a language change while the panel is on the config tab leaves it there", async () => {
  const { view } = build();
  view.webview.receive({ type: "setLanguage", value: "zh-CN", advancedOpen: false, activeTab: "config" });
  await flushMicrotasks();

  const after = view.webview.html as string;
  assert.match(after, /<button class="agentbridge-tab active" id="tabConfig"/, after);
  assert.match(after, /<div id="configSection">/, after);
  assert.match(after, /id="sessionSection" style="display:none"/, after);
});

test("the panel tells the host which tab it is on when the language changes", () => {
  const { view } = build();
  const harness = executePanelHtml(view.webview.html as string);
  harness.dispatchMessage({ type: "status", status: status(), persistentMode: false, quickTunnelCopied: false });

  harness.element("tabSession").dispatch("click");
  assert.equal(harness.element("tabSession").classList.contains("active"), true);

  const select = harness.element("languageSelect");
  select.value = "zh-CN";
  select.dispatch("change");

  const message = harness.posted.find((entry) => entry.type === "setLanguage");
  assert.ok(message, `no language change was posted: ${JSON.stringify(harness.posted)}`);
  assert.equal(message.activeTab, "session");
});

test("the panel reports the config tab when it has not been switched away from", () => {
  const { view } = build();
  const harness = executePanelHtml(view.webview.html as string);
  harness.dispatchMessage({ type: "status", status: status(), persistentMode: false, quickTunnelCopied: false });

  const select = harness.element("languageSelect");
  select.value = "zh-CN";
  select.dispatch("change");

  const message = harness.posted.find((entry) => entry.type === "setLanguage");
  assert.ok(message, `no language change was posted: ${JSON.stringify(harness.posted)}`);
  assert.equal(message.activeTab, "config");
});
