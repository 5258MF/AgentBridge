import test from "node:test";
import assert from "node:assert/strict";
import {
  BridgePanelProvider,
  isOpenableExternalUrl,
  isValidQuickLinkUrl,
  normalizeQuickLinkUrl,
  readConfiguredQuickLinks,
} from "../src/extension/src/bridge-panel.js";
import { vscodeTest } from "./helpers/fake-vscode.js";
import { createFakeWebviewView, executePanelHtml, flushMicrotasks } from "./helpers/panel-harness.js";

function renderPanel(): { harness: ReturnType<typeof executePanelHtml>; html: string } {
  vscodeTest.reset();
  vscodeTest.setConfig("agentbridge.bridge.quickLinks", []);
  const provider = new BridgePanelProvider({
    getStatus: () => ({ state: "running", tunnelProvider: "cloudflare" }),
  } as any, Promise.resolve());
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view);
  const html = view.webview.html as string;
  return { harness: executePanelHtml(html), html };
}

function find(node: any, predicate: (candidate: any) => boolean): any {
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return undefined;
}

function findAll(node: any, predicate: (candidate: any) => boolean, out: any[] = []): any[] {
  if (predicate(node)) out.push(node);
  for (const child of node.children ?? []) findAll(child, predicate, out);
  return out;
}

test("More Sites offers Manus like the closed build did", () => {
  const { harness, html } = renderPanel();
  const start = html.indexOf('id="moreSitesGroup"');
  const end = html.indexOf('id="quickLinksGroup"');
  assert.ok(start > 0 && end > start, "the more-sites group must sit before the quick-link group");
  const group = html.slice(start, end);
  assert.match(group, /id="openManusButton">Open Manus</);
  assert.doesNotMatch(group, /shunova/i, "Shunova is no longer one of the built-in sites");

  harness.posted.length = 0;
  harness.element("openManusButton").dispatch("click");
  const urls = harness.posted.filter((message) => message.type === "openExternal").map((message) => message.url);
  assert.deepEqual(urls, ["https://manus.im/app"]);
});

test("quick links render as buttons at the top of the page", () => {
  const { harness } = renderPanel();
  harness.dispatchMessage({
    type: "quickLinksChanged",
    links: [
      { name: "Manus", url: "https://manus.im/app" },
      { name: "Example", url: "https://example.com/" },
    ],
  });
  harness.posted.length = 0;

  const group = harness.element("quickLinksGroup");
  assert.equal(group.hasAttribute("hidden"), false, "the button group must be visible");
  const buttons = findAll(group, (node) => node.tagName === "BUTTON");
  assert.deepEqual(buttons.map((button) => button.textContent), ["Manus", "Example"]);
  buttons[0]!.dispatch("click");
  const posted = harness.posted.at(-1);
  assert.equal(posted.type, "openExternal");
  assert.equal(posted.url, "https://manus.im/app");
});

test("an empty quick-link list hides the button row", () => {
  const { harness } = renderPanel();
  harness.dispatchMessage({ type: "quickLinksChanged", links: [] });
  assert.equal(harness.element("quickLinksGroup").hasAttribute("hidden"), true);
});

test("deleting a shortcut asks in place, because the webview has no window.confirm", () => {
  // window.confirm is a no-op in a webview: it answers undefined, so the old dialog silently
  // said no and the button looked dead. The row now swaps itself for a confirm/cancel pair.
  const { harness } = renderPanel();
  harness.dispatchMessage({
    type: "quickLinksChanged",
    links: [{ name: "Manus", url: "https://manus.im/app" }],
  });

  const list = harness.element("quickLinkList");
  const deleteButton = find(list, (node) => node.textContent === "Delete");
  assert.ok(deleteButton, "every row has a delete button");
  harness.posted.length = 0;
  deleteButton.dispatch("click");
  assert.equal(harness.posted.length, 0, "the first click must not delete anything");

  const confirmButton = find(harness.element("quickLinkList"), (node) => node.textContent === "Confirm");
  assert.ok(confirmButton, "the row offers a confirm button that says which shortcut it removes");
  confirmButton.dispatch("click");
  const posted = harness.posted.at(-1);
  assert.equal(posted.type, "removeQuickLink");
  assert.equal(posted.name, "Manus");
  assert.equal(posted.url, "https://manus.im/app");
});

test("cancelling a delete leaves the shortcut alone", () => {
  const { harness } = renderPanel();
  harness.dispatchMessage({
    type: "quickLinksChanged",
    links: [{ name: "Manus", url: "https://manus.im/app" }],
  });
  find(harness.element("quickLinkList"), (node) => node.textContent === "Delete").dispatch("click");
  harness.posted.length = 0;
  const cancelButton = find(harness.element("quickLinkList"), (node) => node.textContent === "Cancel");
  assert.ok(cancelButton, "the confirm state can be left");
  cancelButton.dispatch("click");
  assert.equal(harness.posted.length, 0);
  const buttons = findAll(harness.element("quickLinkList"), (node) => node.tagName === "BUTTON")
    .map((node) => node.textContent);
  assert.deepEqual(buttons, ["Open", "Edit", "Delete"], JSON.stringify(buttons));
});

test("editing a shortcut loads it into the form and saves it back", () => {
  const { harness } = renderPanel();
  harness.dispatchMessage({
    type: "quickLinksChanged",
    links: [{ name: "Manus", url: "https://manus.im/app" }],
  });
  find(harness.element("quickLinkList"), (node) => node.textContent === "Edit").dispatch("click");

  assert.equal(harness.element("quickLinkNameInput").value, "Manus");
  assert.equal(harness.element("quickLinkUrlInput").value, "https://manus.im/app");
  assert.equal(harness.element("quickLinkAddButton").textContent, "Save");
  assert.equal(harness.element("quickLinkEditHint").hasAttribute("hidden"), false);

  harness.posted.length = 0;
  harness.element("quickLinkUrlInput").value = "https://manus.im/home";
  harness.element("quickLinkAddButton").dispatch("click");
  const posted = harness.posted.at(-1);
  assert.equal(posted.type, "updateQuickLink");
  assert.equal(posted.name, "Manus");
  assert.equal(posted.url, "https://manus.im/app");
  assert.equal(posted.newUrl, "https://manus.im/home");

  harness.element("quickLinkCancelButton").dispatch("click");
  assert.equal(harness.element("quickLinkAddButton").textContent, "＋ Add");
  assert.equal(harness.element("quickLinkNameInput").value, "");
});

test("an edit may keep its own address, but not take another shortcut's", () => {
  const { harness } = renderPanel();
  harness.dispatchMessage({
    type: "quickLinksChanged",
    links: [
      { name: "Manus", url: "https://manus.im/app" },
      { name: "Example", url: "https://example.com/" },
    ],
  });
  const editButtons = findAll(harness.element("quickLinkList"), (node) => node.textContent === "Edit");
  editButtons[0]!.dispatch("click");
  // Same address, still the entry being edited: not a duplicate.
  harness.element("quickLinkNameInput").value = "Manus AI";
  harness.posted.length = 0;
  harness.element("quickLinkAddButton").dispatch("click");
  assert.equal(harness.posted.at(-1).type, "updateQuickLink");

  // Taking the other shortcut's address is.
  harness.element("quickLinkUrlInput").value = "https://example.com/";
  harness.posted.length = 0;
  harness.element("quickLinkAddButton").dispatch("click");
  assert.equal(harness.element("quickLinkMessage").textContent, "This address is already in the list.");
  assert.equal(harness.posted.length, 0);
});

test("a button that opens something says where it goes on hover", () => {
  // The label only names the site; the address is what a reader checks before clicking.
  const { harness } = renderPanel();
  assert.equal(harness.element("openManusButton").title, "https://manus.im/app");
  assert.equal(harness.element("openWorkBuddyButton").title, "https://www.workbuddy.cn/app");
  assert.equal(harness.element("openChatGptButton").title, "https://chatgpt.com/");
  harness.dispatchMessage({
    type: "quickLinksChanged",
    links: [{ name: "Manus", url: "https://manus.im/app" }],
  });
  const openInRow = find(harness.element("quickLinkList"), (node) => node.textContent === "Open");
  assert.equal(openInRow.title, "https://manus.im/app");
});

test("an empty list shows the placeholder instead of rows", () => {
  const { harness } = renderPanel();
  harness.dispatchMessage({ type: "quickLinksChanged", links: [] });
  const list = harness.element("quickLinkList");
  assert.equal(list.className, "agentbridge-quick-link-list empty");
  assert.equal(list.textContent, "No custom shortcuts yet.");
});

test("the form refuses an address that is not http(s) before posting", () => {
  const { harness } = renderPanel();
  const name = harness.element("quickLinkNameInput");
  const url = harness.element("quickLinkUrlInput");
  name.value = "Example";
  url.value = "ftp://example.com";
  harness.element("quickLinkAddButton").dispatch("click");
  assert.equal(harness.element("quickLinkMessage").textContent, "Enter a valid http:// or https:// address.");
  assert.equal(harness.posted.filter((message) => message.type === "addQuickLink").length, 0);

  url.value = "https://example.com";
  harness.element("quickLinkAddButton").dispatch("click");
  const posted = harness.posted.find((message) => message.type === "addQuickLink");
  assert.ok(posted, "a valid address must reach the host");
  assert.equal(posted.name, "Example");
  assert.equal(posted.url, "https://example.com");
});

test("the host stores an added link and echoes the new list", async () => {
  vscodeTest.reset();
  vscodeTest.setConfig("agentbridge.bridge.quickLinks", []);
  const updates: Array<{ key: string; value: unknown }> = [];
  vscodeTest.setUpdateHandler(async ({ key, value, apply }) => {
    updates.push({ key, value });
    apply();
  });
  const provider = new BridgePanelProvider({
    getStatus: () => ({ state: "running", tunnelProvider: "cloudflare" }),
  } as any, Promise.resolve());
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view);
  const harness = executePanelHtml(view.webview.html as string);

  view.webview.receive({ type: "addQuickLink", name: "Manus", url: "https://manus.im/app" });
  await flushMicrotasks();

  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.key, "agentbridge.bridge.quickLinks");
  assert.deepEqual(updates[0]!.value, [{ name: "Manus", url: "https://manus.im/app" }]);
  const changed = view.webview.posted.find((message: any) => message.type === "quickLinksChanged");
  assert.ok(changed, "the host must echo the new list");
  assert.deepEqual(Array.from(changed.links), [{ name: "Manus", url: "https://manus.im/app" }]);

  view.webview.posted.length = 0;
  view.webview.receive({ type: "addQuickLink", name: "Manus again", url: "https://MANUS.im/app" });
  await flushMicrotasks();
  assert.equal(updates.length, 1, "a duplicate address must be refused case-insensitively");
  assert.equal(view.webview.posted.filter((message: any) => message.type === "quickLinksChanged").length, 0);
});

test("the host replaces an edited shortcut in place", async () => {
  vscodeTest.reset();
  vscodeTest.setConfig("agentbridge.bridge.quickLinks", [
    { name: "Manus", url: "https://manus.im/app" },
    { name: "Example", url: "https://example.com/" },
  ]);
  const updates: Array<{ key: string; value: unknown }> = [];
  vscodeTest.setUpdateHandler(async ({ key, value, apply }) => {
    updates.push({ key, value });
    apply();
  });
  const provider = new BridgePanelProvider({
    getStatus: () => ({ state: "running", tunnelProvider: "cloudflare" }),
  } as any, Promise.resolve());
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view);

  // Renaming keeps the position: editing is not delete-then-append.
  view.webview.receive({
    type: "updateQuickLink",
    name: "Manus",
    url: "https://manus.im/app",
    newName: "Manus AI",
    newUrl: "https://manus.im/home",
  });
  await flushMicrotasks();
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0]!.value, [
    { name: "Manus AI", url: "https://manus.im/home" },
    { name: "Example", url: "https://example.com/" },
  ]);

  // Taking the other entry's address is a duplicate, checked case-insensitively.
  updates.length = 0;
  view.webview.receive({
    type: "updateQuickLink",
    name: "Manus AI",
    url: "https://manus.im/home",
    newName: "Copy",
    newUrl: "https://EXAMPLE.com/",
  });
  await flushMicrotasks();
  assert.equal(updates.length, 0, "an edit must not take another shortcut's address");

  // An entry that is no longer there is ignored rather than appended.
  view.webview.receive({
    type: "updateQuickLink",
    name: "Gone",
    url: "https://gone.example/",
    newName: "Gone",
    newUrl: "https://gone.example/",
  });
  await flushMicrotasks();
  assert.equal(updates.length, 0, "editing an entry that no longer exists must not add one");
});

test("a bare host is read as https and nothing else is rewritten", () => {
  assert.equal(normalizeQuickLinkUrl("example.com"), "https://example.com");
  assert.equal(normalizeQuickLinkUrl("  example.com/a/b  "), "https://example.com/a/b");
  assert.equal(normalizeQuickLinkUrl("example.com:8443"), "https://example.com:8443");
  assert.equal(normalizeQuickLinkUrl("http://example.com"), "http://example.com");
  assert.equal(normalizeQuickLinkUrl("HTTPS://example.com"), "HTTPS://example.com");
  assert.equal(normalizeQuickLinkUrl("ftp://example.com"), "ftp://example.com", "a scheme of its own is left for the validator");
  assert.equal(normalizeQuickLinkUrl("htps://example.com"), "htps://example.com", "a mistyped scheme must not get another one glued in front");
  assert.equal(normalizeQuickLinkUrl(""), "");
});

test("the form reads a scheme-less address as https and shows what it assumed", () => {
  const { harness } = renderPanel();
  const name = harness.element("quickLinkNameInput");
  const url = harness.element("quickLinkUrlInput");
  name.value = "Example";
  url.value = "example.com";
  harness.element("quickLinkAddButton").dispatch("click");

  const posted = harness.posted.find((message) => message.type === "addQuickLink");
  assert.ok(posted, "a bare host must reach the host instead of being refused");
  assert.equal(posted.url, "https://example.com");
  assert.equal(url.value, "https://example.com", "the form states the address it is about to save");
});

test("the form still refuses an address that carries a scheme of its own", () => {
  const { harness } = renderPanel();
  harness.element("quickLinkNameInput").value = "Example";
  harness.element("quickLinkUrlInput").value = "htps://example.com";
  harness.element("quickLinkAddButton").dispatch("click");
  assert.equal(harness.element("quickLinkMessage").textContent, "Enter a valid http:// or https:// address.");
  assert.equal(harness.posted.filter((message) => message.type === "addQuickLink").length, 0);
});

test("the host reads a bare host as https", async () => {
  vscodeTest.reset();
  vscodeTest.setConfig("agentbridge.bridge.quickLinks", []);
  const updates: Array<{ key: string; value: unknown }> = [];
  vscodeTest.setUpdateHandler(async ({ key, value, apply }) => {
    updates.push({ key, value });
    apply();
  });
  const provider = new BridgePanelProvider({
    getStatus: () => ({ state: "running", tunnelProvider: "cloudflare" }),
  } as any, Promise.resolve());
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view);

  view.webview.receive({ type: "addQuickLink", name: "Example", url: "example.com" });
  await flushMicrotasks();

  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0]!.value, [{ name: "Example", url: "https://example.com" }]);
});

test("a hand-edited shortcut without a scheme is kept rather than dropped", () => {
  vscodeTest.reset();
  vscodeTest.setConfig("agentbridge.bridge.quickLinks", [{ name: "Bare", url: "bare.example" }]);
  const provider = new BridgePanelProvider({
    getStatus: () => ({ state: "running", tunnelProvider: "cloudflare" }),
  } as any, Promise.resolve());
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view);

  const html = view.webview.html as string;
  assert.match(html, /"url":"https:\/\/bare\.example"/, "a settings.json entry without a scheme must still render");
});

test("only http and https are handed to the operating system", () => {
  // The webview is on the other side of a trust boundary and openExternal opens whatever it
  // is given, so a message carrying file:, vscode: or javascript: reached the user as a click
  // on a link - and it was not one. The scheme is what is checked, in the case URL reports.
  for (const url of ["https://example.com", "http://example.com", "HTTPS://EXAMPLE.COM", "https://example.com/a?b=c#d"]) {
    assert.equal(isOpenableExternalUrl(url), true, url);
  }
  for (const url of [
    "file:///C:/Windows/System32/calc.exe",
    "vscode://extension/agentbridge",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "mailto:someone@example.com",
    "example.com",
    "",
    "//example.com",
  ]) {
    assert.equal(isOpenableExternalUrl(url), false, url);
  }
});

test("the form and the host agree about what an address may contain", () => {
  // The host reads a regular expression whose \S refuses every whitespace character, while
  // the form only looked for charCode <= 32. U+00A0 and the other non-ASCII spaces therefore
  // passed the form and were thrown out by the host at save time: the two ends of the same
  // field disagreeing about one string, with the error arriving after the work was done.
  const { harness } = renderPanel();
  const name = harness.element("quickLinkNameInput");
  const url = harness.element("quickLinkUrlInput");
  name.value = "Example";
  url.value = "https://example.com/\u00a0x";
  harness.element("quickLinkAddButton").dispatch("click");
  assert.equal(harness.element("quickLinkMessage").textContent, "Enter a valid http:// or https:// address.");
  assert.equal(harness.posted.filter((message) => message.type === "addQuickLink").length, 0, "the form must refuse it too");
  assert.equal(isValidQuickLinkUrl("https://example.com/\u00a0x"), false, "and the host must agree");

  url.value = "https://example.com/x?y=1#z";
  harness.element("quickLinkAddButton").dispatch("click");
  assert.ok(harness.posted.find((message) => message.type === "addQuickLink"), "a real address still saves");
});

test("a colon is a port when it is followed by digits and a scheme when it is not", () => {
  // Reading every colon as a port turned javascript:alert(1) into https://javascript:alert(1),
  // which the validator then accepted as an ordinary https address - a shortcut that looks
  // like a link and is not one. A host with a port still has to keep working.
  assert.equal(normalizeQuickLinkUrl("example.com"), "https://example.com");
  assert.equal(normalizeQuickLinkUrl("example.com:8080/path"), "https://example.com:8080/path");
  assert.equal(normalizeQuickLinkUrl("javascript:alert(1)"), "javascript:alert(1)");
  assert.equal(normalizeQuickLinkUrl("htps://example.com"), "htps://example.com");
  assert.equal(normalizeQuickLinkUrl("https://example.com"), "https://example.com");
  assert.equal(isValidQuickLinkUrl(normalizeQuickLinkUrl("javascript:alert(1)")), false);
  assert.equal(isValidQuickLinkUrl(normalizeQuickLinkUrl("example.com:8080/path")), true);
});

test("a colon that is not a port is still part of the host when the host says so", () => {
  // Reading "no digits after the colon" as "a scheme of its own" closed the hole that was
  // https://javascript:alert(1), and it took two addresses with it that are not schemes at all:
  // credentials written in front of a host, and an IPv6 literal, every one of whose colons
  // belongs to the address rather than to a port. Both are read back now - the one by the "@"
  // after the colon, the other by the brackets around it - and the shortcut that was the reason
  // for the port test is still refused.
  assert.equal(normalizeQuickLinkUrl("user:pass@example.com"), "https://user:pass@example.com");
  assert.equal(normalizeQuickLinkUrl("user:pass@example.com/a?b=1"), "https://user:pass@example.com/a?b=1");
  assert.equal(normalizeQuickLinkUrl("[::1]"), "https://[::1]");
  assert.equal(normalizeQuickLinkUrl("[::1]:8080"), "https://[::1]:8080");
  assert.equal(normalizeQuickLinkUrl("[::1]/x"), "https://[::1]/x");
  assert.equal(normalizeQuickLinkUrl("https://[::1]:8080"), "https://[::1]:8080", "an address that already has a scheme keeps it");
  assert.equal(isValidQuickLinkUrl(normalizeQuickLinkUrl("user:pass@example.com")), true);
  assert.equal(isValidQuickLinkUrl(normalizeQuickLinkUrl("[::1]")), true);
  assert.equal(isValidQuickLinkUrl(normalizeQuickLinkUrl("[::1]:8080")), true);
  assert.equal(isValidQuickLinkUrl(normalizeQuickLinkUrl("[::1]/x")), true);
  assert.equal(normalizeQuickLinkUrl("javascript:alert(1)"), "javascript:alert(1)");
  assert.equal(isValidQuickLinkUrl(normalizeQuickLinkUrl("javascript:alert(1)")), false);
});

test("the form reads credentials and an IPv6 literal as https as well", () => {
  // The panel keeps its own copy of the normalizer, so a host that changed the way it reads one
  // is only half a fix while the form still refuses what the host accepts.
  const { harness } = renderPanel();
  const name = harness.element("quickLinkNameInput");
  const url = harness.element("quickLinkUrlInput");

  name.value = "Internal";
  url.value = "user:pass@example.com";
  harness.element("quickLinkAddButton").dispatch("click");
  const first = harness.posted.find((message) => message.type === "addQuickLink");
  assert.ok(first, "credentials in front of a host must not be read as a scheme");
  assert.equal(first.url, "https://user:pass@example.com");

  name.value = "Loopback";
  url.value = "[::1]:8080";
  harness.element("quickLinkAddButton").dispatch("click");
  const second = harness.posted.filter((message) => message.type === "addQuickLink")[1];
  assert.ok(second, "an IPv6 literal on a port must still save");
  assert.equal(second.url, "https://[::1]:8080");

  name.value = "Script";
  url.value = "javascript:alert(1)";
  harness.element("quickLinkAddButton").dispatch("click");
  assert.equal(
    harness.posted.filter((message) => message.type === "addQuickLink").length,
    2,
    "the shortcut stays refused",
  );
});

test("a hand-edited setting that is not a web address is dropped on load", async () => {
  // The comment promises that only well-formed entries are kept; this is what makes a
  // settings.json someone edited by hand unable to put a file: link on the panel.
  vscodeTest.reset();
  vscodeTest.setConfig("agentbridge.bridge.quickLinks", [
    { name: "Good", url: "https://example.com" },
    { name: "Local", url: "file:///etc/passwd" },
    { name: "Script", url: "javascript:alert(1)" },
    { name: "No scheme", url: "example.com" },
  ]);
  const kept = readConfiguredQuickLinks();
  assert.deepEqual(kept.map((link) => link.name), ["Good", "No scheme"]);
  assert.equal(kept[1]!.url, "https://example.com");
});
