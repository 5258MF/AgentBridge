import test from "node:test";
import assert from "node:assert/strict";
import { BridgePanelProvider } from "../src/extension/src/bridge-panel.js";
import { vscodeTest } from "./helpers/fake-vscode.js";
import { createFakeWebviewView, executePanelHtml } from "./helpers/panel-harness.js";

function status(): Record<string, unknown> {
  return {
    state: "stopped",
    tunnelProvider: "cloudflare-named",
    tunnelInstalled: true,
    tunnelConfigValid: true,
    tunnelChecked: true,
    namedTunnelTokenConfigured: true,
    configuredNamedDomain: "bridge.example.com",
  };
}

function build(): ReturnType<typeof executePanelHtml> {
  vscodeTest.reset();
  const provider = new BridgePanelProvider({ getStatus: () => status() } as any, Promise.resolve());
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view);
  const harness = executePanelHtml(view.webview.html as string);
  harness.dispatchMessage({ type: "status", status: status(), persistentMode: false, quickTunnelCopied: false });
  return harness;
}

function posted(harness: any, type: string): unknown[] {
  return harness.posted.filter((message: any) => message.type === type);
}

test("clearing the tunnel token asks in place instead of through window.confirm", () => {
  const harness = build();
  const clear = harness.element("clearNamedTunnelTokenButton");
  assert.equal(clear.disabled, false, "a configured token must offer a way to clear it");
  assert.equal(harness.element("clearTokenConfirm").hasAttribute("hidden"), true, "the question starts hidden");

  harness.posted.length = 0;
  clear.dispatch("click");
  assert.deepEqual(posted(harness, "clearNamedTunnelToken"), [], "the first press only asks");
  assert.equal(harness.element("clearTokenConfirm").hasAttribute("hidden"), false, "the question is shown");
  assert.equal(clear.hasAttribute("hidden"), true, "the button that armed it steps aside");

  harness.element("clearTokenCancelButton").dispatch("click");
  assert.deepEqual(posted(harness, "clearNamedTunnelToken"), [], "cancelling posts nothing");
  assert.equal(harness.element("clearTokenConfirm").hasAttribute("hidden"), true);
  assert.equal(clear.hasAttribute("hidden"), false, "the clear button comes back");

  clear.dispatch("click");
  harness.element("clearTokenConfirmButton").dispatch("click");
  assert.equal(posted(harness, "clearNamedTunnelToken").length, 1, "confirming posts exactly once");
  assert.equal(harness.element("clearTokenConfirm").hasAttribute("hidden"), true, "and the question goes away");
});

test("a language change refused for unsaved work says so on the page", () => {
  const harness = build();
  // Typing into the named tunnel fields marks them dirty, which is what blocks the switch.
  harness.element("namedDomainInput").value = "other.example.com";
  harness.element("namedDomainInput").dispatch("input");

  const select = harness.element("languageSelect");
  select.value = "zh-CN";
  select.dispatch("change");

  assert.deepEqual(posted(harness, "setLanguage"), [], "the switch must not be sent while work is unsaved");
  assert.equal(select.value, "auto", "the select goes back to the language in force");
  const node = harness.element("languageStatus");
  assert.equal(node.hasAttribute("hidden"), false, "the reason is shown rather than alerted");
  assert.match(node.textContent, /Named Tunnel/);
});
