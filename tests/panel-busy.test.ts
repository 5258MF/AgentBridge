import test from "node:test";
import assert from "node:assert/strict";
import {
  BUSY_PANEL_MESSAGE_TYPES,
  BridgePanelProvider,
  INSTALL_CLOUDFLARED_MESSAGE_TYPE,
} from "../src/extension/src/bridge-panel.js";
import { vscodeTest } from "./helpers/fake-vscode.js";
import { createFakeWebviewView } from "./helpers/panel-harness.js";

function render(): string {
  vscodeTest.reset();
  const provider = new BridgePanelProvider({
    getStatus: () => ({ state: "stopped", tunnelProvider: "cloudflare" }),
  } as any, Promise.resolve());
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view);
  return view.webview.html as string;
}

/**
 * The message type each "busy = true" in the webview ends up posting.
 *
 * The panel disables its controls when an operation starts and re-enables them when the host
 * replies. The host only replies to a type it knows about, so the two lists have to agree -
 * and they live in the same file without anything keeping them together.
 */
function busyOperations(html: string): string[] {
  const types: string[] = [];
  const pattern = /busy = true;[\s\S]{0,200}?vscode\.postMessage\(\{\s*type:\s*'([A-Za-z]+)'/g;
  for (const match of html.matchAll(pattern)) types.push(match[1]!);
  return [...new Set(types)].sort();
}

test("every operation that disables the panel is one the host answers", () => {
  const operations = busyOperations(render());
  assert.ok(operations.length >= 8, `expected the webview's busy operations, found ${operations.join(", ")}`);
  for (const type of operations) {
    assert.ok(
      BUSY_PANEL_MESSAGE_TYPES.has(type) || type === INSTALL_CLOUDFLARED_MESSAGE_TYPE,
      `the panel goes busy on "${type}" but the host never sends an operation-finished reply for it, ` +
        "so the controls would stay disabled until the panel is reloaded.",
    );
  }
});

test("the host answers a language change even when it does not rebuild the panel", async () => {
  // setLanguage is the one busy operation that can finish without a rebuild: an unchanged
  // preference returns early, and the webview waits for the reply to re-enable its controls.
  vscodeTest.reset();
  vscodeTest.setConfig("agentbridge.language", "en");
  const provider = new BridgePanelProvider({
    getStatus: () => ({ state: "stopped", tunnelProvider: "cloudflare" }),
  } as any, Promise.resolve());
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view);

  view.webview.receive({ type: "setLanguage", value: "en", advancedOpen: false, activeTab: "config" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const finished = view.webview.posted.find((message: any) => message.type === "operationFinished");
  assert.ok(finished, `no reply was posted: ${JSON.stringify(view.webview.posted)}`);
  assert.equal(finished.operation, "setLanguage");
});
