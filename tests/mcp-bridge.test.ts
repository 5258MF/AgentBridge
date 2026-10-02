import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { BridgeManager } from "../src/extension/src/bridge-server.js";
import { BridgePanelProvider } from "../src/extension/src/bridge-panel.js";
import { MCP_SECRET_PREFIX } from "../src/extension/src/mcp-config.js";
import type { McpConnectionFactory } from "../src/extension/src/mcp-client.js";
import { BRIDGE_TOOL_DEFINITIONS } from "../src/extension/src/server-instructions.js";
import { vscodeTest, workspace, window } from "./helpers/fake-vscode.js";
import { httpTest } from "./helpers/fake-http.js";
import { createFakeWebviewView, executePanelHtml } from "./helpers/panel-harness.js";

const READ: Tool = {
  name: "read", description: "Read fixture data", inputSchema: { type: "object", properties: {} },
  outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
  annotations: { readOnlyHint: true }, _meta: { category: "fixture" },
};
const WRITE: Tool = { name: "write", inputSchema: { type: "object", properties: {} } };

async function waitUntil(predicate: () => boolean): Promise<void> {
  // Configuration saves now include a real Windows metadata-preserving replacement.
  for (let index = 0; index < 1200; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Bridge MCP operation did not settle");
}

function setup(t: test.TestContext) {
  vscodeTest.reset(); httpTest.reset();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-mcp-bridge-"));
  const home = path.join(root, "private-home");
  fs.mkdirSync(home);
  const configFile = path.join(root, ".agentbridge", "mcp.json");
  fs.mkdirSync(path.dirname(configFile));
  fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { docs: { command: "fixture" } } }));
  const previousFolders = workspace.workspaceFolders;
  const previousSmoke = process.env.AGENTBRIDGE_BRIDGE_SMOKE_LOCAL;
  workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  process.env.AGENTBRIDGE_BRIDGE_SMOKE_LOCAL = "1";
  const secrets = new Map<string, string>();
  const globalState = vscodeTest.createMemento();
  const context: any = {
    extensionMode: 2, extension: { packageJSON: { version: "0.1.16" } }, subscriptions: [],
    globalState, workspaceState: vscodeTest.createMemento(),
    secrets: { get: async (key: string) => secrets.get(key), store: async (key: string, value: string) => { secrets.set(key, value); } },
  };
  let tools = [READ, WRITE];
  const peers: Server[] = [];
  const calls: Array<{ name: string; args: unknown }> = [];
  const factory: McpConnectionFactory = async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const peer = new Server({ name: "docs", version: "1" }, { capabilities: { tools: { listChanged: true } }, instructions: "Fixture server: use these tools to inspect its own data." });
    peer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    peer.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      calls.push({ name: request.params.name, args: request.params.arguments });
      if (request.params.name === "write") return { isError: true, content: [{ type: "text", text: "Write rejected by the fixture" }] };
      return { content: [{ type: "text", text: "upstream result" }, { type: "image", data: "eA==", mimeType: "image/png" }, { type: "resource_link", name: "document", uri: "fixture://document" }], structuredContent: { value: 42 }, _meta: { forwarded: true } };
    });
    await peer.connect(serverTransport);
    peers.push(peer);
    const client = new Client({ name: "bridge-test", version: "1" }, { capabilities: {} });
    return { client, transport: clientTransport, close: async () => { await client.close(); await peer.close(); } };
  };
  const manager = new BridgeManager(context, { append() {}, appendLine() {} } as any, { invokeDirect: async () => ({ text: "", isError: false }) } as any, { mcpFactory: factory });
  (manager as any).agentsHomeDir = home;
  t.after(async () => {
    await manager.disposeAsync();
    for (const peer of peers) await peer.close();
    workspace.workspaceFolders = previousFolders;
    if (previousSmoke === undefined) delete process.env.AGENTBRIDGE_BRIDGE_SMOKE_LOCAL; else process.env.AGENTBRIDGE_BRIDGE_SMOKE_LOCAL = previousSmoke;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { manager, root, home, configFile, calls, peers, secrets, setTools(value: Tool[]) { tools = value; } };
}

async function start(h: ReturnType<typeof setup>): Promise<void> {
  await h.manager.initialize();
  assert.equal(h.peers.length, 0, "reading configuration alone does not launch external servers");
  await h.manager.startLocalSmoke();
  await (h.manager as any).externalMcp.waitForDiscovery();
}

test("the public MCP handler discovers external tools and preserves rich results and failure statistics", async (t) => {
  const h = setup(t);
  await start(h);
  const created = (h.manager as any).createSession((h.manager as any).httpServer, (h.manager as any).tunnelGeneration);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await created.server.connect(serverTransport);
  const client = new Client({ name: "web-ai-fixture", version: "1" }, { capabilities: {} });
  t.after(async () => { await client.close(); await created.server.close(); await created.transport.close(); });
  await client.connect(clientTransport);
  assert.equal(client.getServerCapabilities()?.tools?.listChanged, true);
  const list = await client.listTools();
  assert.equal(list.tools.length, BRIDGE_TOOL_DEFINITIONS.length + 2);
  const read = list.tools.find((tool) => tool.name === "mcp__docs__read")!;
  assert.deepEqual(read.annotations, READ.annotations);
  assert.deepEqual(read.outputSchema, READ.outputSchema);
  assert.deepEqual(read._meta, READ._meta);
  const result = await client.callTool({ name: read.name, arguments: { query: "example" } }) as CallToolResult;
  assert.deepEqual(result.content.map((item) => item.type), ["text", "image", "resource_link"]);
  assert.deepEqual(result.structuredContent, { value: 42 });
  assert.deepEqual(result._meta, { forwarded: true });
  assert.deepEqual(h.calls[0], { name: "read", args: { query: "example" } });
  const failure = await client.callTool({ name: "mcp__docs__write", arguments: {} });
  assert.equal(failure.isError, true);
  assert.equal(h.manager.getStatus().stats.failedToolCalls, 1);
  assert.equal(h.manager.getStatus().stats.completedToolCalls, 2);
  assert.equal(h.manager.getStatus().activities.at(-1)?.status, "error");
  h.manager.setReadOnlyMode(true);
  const blocked = await client.callTool({ name: "mcp__docs__write", arguments: {} }) as CallToolResult;
  assert.equal(blocked.isError, true);
  assert.match((blocked.content[0] as { text: string }).text, /READ_ONLY_MODE/);
  assert.equal(h.calls.length, 2, "Plan policy is enforced before upstream execution");
  const native = await client.callTool({ name: "get_todos", arguments: {} });
  assert.deepEqual(native.structuredContent, { todos: [] });
});

test("external instructions are delivered once per chat and changes notify downstream clients", async (t) => {
  const h = setup(t); await start(h);
  let notifications = 0;
  (h.manager as any).sessions.set("chat", {
    server: { sendToolListChanged: async () => { notifications += 1; }, close: async () => {} },
    transport: { close: async () => {} }, lastActivity: Date.now(), activeRequests: 0, activeStreams: 0,
    toldReadOnly: false, agentsMdBaselinePending: false, agentsMdSent: new Map(),
  });
  const call = () => (h.manager as any).handleToolCall("mcp__docs__read", {}, { sessionId: "chat" }) as Promise<CallToolResult>;
  const first = await call();
  assert.match((first.content[0] as { text: string }).text, /Fixture server: use these tools/);
  assert.deepEqual(first._meta, { forwarded: true });
  const second = await call();
  assert.equal((second.content[0] as { text: string }).text, "upstream result");
  h.setTools([READ]);
  await h.peers[0]!.sendToolListChanged();
  await waitUntil(() => h.manager.getStatus().toolCount === BRIDGE_TOOL_DEFINITIONS.length + 1);
  assert.equal(notifications, 1);
  h.manager.setReadOnlyMode(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifications, 1, "mode changes leave the tool list intact");
});

test("the MCP panel sends scoped config and server operations and recovers controls after completion", async (t) => {
  const h = setup(t); await start(h);
  const provider = new BridgePanelProvider(h.manager, Promise.resolve());
  const view = createFakeWebviewView(); provider.resolveWebviewView(view);
  const ui = executePanelHtml(view.webview.html);
  const status = () => ({ type: "status", status: h.manager.getStatus(), persistentMode: false, quickTunnelCopied: false });
  ui.dispatchMessage(status());
  ui.element("mcpWorkspaceConfigButton").click();
  assert.equal(JSON.stringify(ui.posted.at(-1)), JSON.stringify({ type: "openExternalMcpConfig", scope: "workspace" }));
  const row = ui.element("externalMcpList").children.at(-1)!;
  assert.equal(row.children[0]!.textContent, "docs");
  const controls = row.children.at(-1)!;
  controls.children[1]!.click();
  assert.equal(JSON.stringify(ui.posted.at(-1)), JSON.stringify({ type: "setExternalMcpEnabled", name: "docs", enabled: false }));
  assert.equal(ui.element("mcpReloadButton").disabled, true);
  view.webview.receive(ui.posted.at(-1));
  await waitUntil(() => view.webview.posted.some((message: any) => message.type === "operationFinished" && message.operation === "setExternalMcpEnabled"));
  const finished = view.webview.posted.findLast((message: any) => message.type === "operationFinished");
  assert.equal(finished.succeeded, true);
  assert.equal(h.manager.getStatus().externalMcp.servers[0]?.state, "disabled");
  ui.dispatchMessage(finished);
  assert.equal(ui.element("mcpReloadButton").disabled, false);
  const disabledRow = ui.element("externalMcpList").children.at(-1)!;
  assert.equal(disabledRow.children.at(-1)!.children[2]!.disabled, true);
  view.webview.receive({ type: "setExternalMcpEnabled", name: "docs", enabled: "true" });
  await waitUntil(() => view.webview.posted.some((message: any) => message.type === "operationFinished" && message.succeeded === false));
  assert.equal(h.manager.getStatus().externalMcp.servers[0]?.enabled, false);
});

test("config editing uses known paths and credentials use native password input and SecretStorage", async (t) => {
  const h = setup(t); await h.manager.initialize();
  assert.equal(await h.manager.externalMcpConfigurationPath("workspace", "docs"), h.configFile);
  const userFile = await h.manager.externalMcpConfigurationPath("user");
  assert.equal(userFile, path.join(h.home, ".agentbridge", "mcp.json"));
  assert.deepEqual(JSON.parse(fs.readFileSync(userFile, "utf8")), { mcpServers: {} });
  await assert.rejects(h.manager.externalMcpConfigurationPath("workspace", "../../outside"), /Unknown MCP server/);
  const originalInput = window.showInputBox;
  const inputs: any[] = [];
  const answers = [" docs_token ", "private-value"];
  (window as any).showInputBox = async (options: any) => { inputs.push(options); return answers.shift(); };
  t.after(() => { window.showInputBox = originalInput; });
  const provider = new BridgePanelProvider(h.manager, Promise.resolve());
  const view = createFakeWebviewView(); provider.resolveWebviewView(view);
  view.webview.receive({ type: "setExternalMcpCredential" });
  await waitUntil(() => view.webview.posted.some((message: any) => message.type === "operationFinished" && message.operation === "setExternalMcpCredential"));
  assert.equal(inputs[1]?.password, true);
  assert.equal(h.secrets.get(MCP_SECRET_PREFIX + "docs_token"), "private-value");
  assert.ok(!JSON.stringify(view.webview.posted).includes("private-value"));
  assert.equal(h.peers.length, 0, "saving credentials does not start a stopped Bridge");
});

test("the stdio form preserves argument boundaries, appends configuration and resets only after success", async (t) => {
  const h = setup(t); await h.manager.initialize();
  const provider = new BridgePanelProvider(h.manager, Promise.resolve());
  const view = createFakeWebviewView(); provider.resolveWebviewView(view);
  const ui = executePanelHtml(view.webview.html);
  ui.dispatchMessage({ type: "status", status: h.manager.getStatus(), persistentMode: false });
  assert.equal(ui.element("mcpAddServerForm").hidden, true);
  ui.element("mcpAddServerButton").click();
  view.webview.receive(ui.posted.at(-1));
  assert.equal(ui.element("mcpAddServerForm").hidden, false);
  assert.equal(ui.element("languageSelect").disabled, true);
  ui.element("mcpFormName").value = "local";
  ui.element("mcpFormCommand").value = "npx";
  ui.element("mcpFormArgs").value = "-y\n\npath with spaces\n--flag=value";
  ui.element("mcpFormEnv").value = "TOKEN=${secret:token}\nTEXT=a=b";
  ui.element("mcpFormCwd").value = "${workspaceFolder}/tools";
  ui.element("mcpFormTimeout").value = "120";
  ui.element("mcpAddServerForm").dispatch("submit");
  const request = ui.posted.at(-1);
  assert.equal(request.type, "addExternalMcpServer");
  assert.equal(request.scope, "workspace");
  assert.equal(ui.element("mcpFormName").disabled, true);
  ui.element("mcpAddServerForm").dispatch("submit");
  assert.equal(ui.posted.filter((message: any) => message.type === "addExternalMcpServer").length, 1);
  view.webview.receive(request);
  await waitUntil(() => view.webview.posted.some((message: any) => message.type === "operationFinished" && message.operation === "addExternalMcpServer"));
  const config = JSON.parse(fs.readFileSync(h.configFile, "utf8"));
  assert.deepEqual(config.mcpServers.docs, { command: "fixture" });
  assert.deepEqual(config.mcpServers.local.args, ["-y", "path with spaces", "--flag=value"]);
  assert.deepEqual(config.mcpServers.local.env, { TOKEN: "${secret:token}", TEXT: "a=b" });
  assert.equal(config.mcpServers.local.timeout, 120);
  assert.equal(h.peers.length, 0);
  ui.dispatchMessage({ type: "externalMcpServerSaved", requestId: "stale", name: "wrong" });
  assert.equal(ui.element("mcpAddServerForm").hidden, false);
  ui.dispatchMessage(view.webview.posted.find((message: any) => message.type === "externalMcpServerSaved"));
  ui.dispatchMessage(view.webview.posted.findLast((message: any) => message.type === "operationFinished"));
  assert.equal(ui.element("mcpAddServerForm").hidden, true);
  assert.equal(ui.element("mcpFormCommand").value, "");
  assert.equal(ui.element("mcpFormEnv").value, "");
  assert.equal(ui.element("mcpAddServerButton").disabled, false);
  assert.match(ui.element("mcpFormSavedStatus").textContent, /local/);
});

test("the HTTP form uses native secure input and saves only a credential reference in the selected scope", async (t) => {
  const h = setup(t); await h.manager.initialize();
  const originalInput = window.showInputBox;
  const inputs: any[] = [];
  const answers = ["remote_token", "private-value"];
  (window as any).showInputBox = async (options: any) => { inputs.push(options); return answers.shift(); };
  t.after(() => { window.showInputBox = originalInput; });
  const provider = new BridgePanelProvider(h.manager, Promise.resolve());
  const view = createFakeWebviewView(); provider.resolveWebviewView(view);
  const ui = executePanelHtml(view.webview.html);
  ui.dispatchMessage({ type: "status", status: h.manager.getStatus(), persistentMode: false });
  ui.element("mcpAddServerButton").click();
  ui.element("mcpFormName").value = "remote";
  ui.element("mcpFormScope").value = "user";
  ui.element("mcpFormTransport").value = "http";
  ui.element("mcpFormTransport").dispatch("change");
  ui.element("mcpFormCommand").value = "inactive-command";
  ui.element("mcpFormEnv").value = "INVALID-INACTIVE-LINE";
  ui.element("mcpFormUrl").value = "https://example.com/mcp";
  assert.equal(ui.element("mcpFormStdioFields").hidden, true);
  assert.equal(ui.element("mcpFormHttpFields").hidden, false);
  ui.element("mcpFormCredentialButton").click();
  view.webview.receive(ui.posted.at(-1));
  await waitUntil(() => view.webview.posted.some((message: any) => message.type === "operationFinished" && message.operation === "setExternalMcpCredential"));
  assert.equal(inputs[0]?.value, "remote_token");
  assert.equal(inputs[1]?.password, true);
  ui.dispatchMessage(view.webview.posted.find((message: any) => message.type === "externalMcpCredentialSaved"));
  ui.dispatchMessage(view.webview.posted.findLast((message: any) => message.type === "operationFinished"));
  assert.equal(ui.element("mcpFormHeaders").value, "Authorization: Bearer ${secret:remote_token}");
  ui.element("mcpFormHeaders").value += "\nX-Endpoint: https://example.com/a:b";
  ui.element("mcpAddServerForm").dispatch("submit");
  const request = ui.posted.at(-1);
  assert.equal(request.config.command, undefined);
  assert.equal(request.config.env, undefined);
  view.webview.receive(request);
  await waitUntil(() => view.webview.posted.some((message: any) => message.type === "externalMcpServerSaved"));
  const userFile = path.join(h.home, ".agentbridge", "mcp.json");
  const saved = JSON.parse(fs.readFileSync(userFile, "utf8"));
  assert.equal(saved.mcpServers.remote.headers.Authorization, "Bearer ${secret:remote_token}");
  assert.equal(saved.mcpServers.remote.headers["X-Endpoint"], "https://example.com/a:b");
  assert.ok(!fs.readFileSync(userFile, "utf8").includes("private-value"));
  assert.ok(!JSON.stringify(ui.posted).includes("private-value"));
  assert.ok(!JSON.stringify(view.webview.posted).includes("private-value"));
  assert.equal(h.secrets.get(MCP_SECRET_PREFIX + "remote_token"), "private-value");
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(h.configFile, "utf8")).mcpServers), ["docs"]);
});

test("duplicate names and unsaved editor changes preserve the file and keep a failed form editable", async (t) => {
  const h = setup(t); await h.manager.initialize();
  const before = fs.readFileSync(h.configFile, "utf8");
  const provider = new BridgePanelProvider(h.manager, Promise.resolve());
  const view = createFakeWebviewView(); provider.resolveWebviewView(view);
  const ui = executePanelHtml(view.webview.html);
  ui.dispatchMessage({ type: "status", status: h.manager.getStatus(), persistentMode: false });
  ui.element("mcpAddServerButton").click();
  ui.element("mcpFormName").value = "docs";
  ui.element("mcpFormCommand").value = "new-command";
  ui.element("mcpAddServerForm").dispatch("submit");
  view.webview.receive(ui.posted.at(-1));
  await waitUntil(() => view.webview.posted.some((message: any) => message.type === "operationFinished" && message.operation === "addExternalMcpServer"));
  ui.dispatchMessage(view.webview.posted.find((message: any) => message.type === "externalMcpServerSaveFailed"));
  ui.dispatchMessage(view.webview.posted.findLast((message: any) => message.type === "operationFinished"));
  assert.equal(ui.element("mcpAddServerForm").hidden, false);
  assert.equal(ui.element("mcpFormName").value, "docs");
  assert.equal(ui.element("mcpFormCommand").value, "new-command");
  assert.equal(ui.element("mcpFormName").disabled, false);
  assert.equal(ui.element("mcpFormError").hidden, false);
  assert.equal(fs.readFileSync(h.configFile, "utf8"), before);
  vscodeTest.textDocuments.push({ uri: { scheme: "file", fsPath: h.configFile, toString: () => h.configFile }, isDirty: true } as any);
  await assert.rejects(h.manager.addExternalMcpServer("workspace", "new", { command: "node" }), /unsaved edits/);
  assert.equal(fs.readFileSync(h.configFile, "utf8"), before);
});

test("the form rejects duplicate HTTP headers and bad timeouts before sending a save", async (t) => {
  const h = setup(t); await h.manager.initialize();
  const provider = new BridgePanelProvider(h.manager, Promise.resolve());
  const view = createFakeWebviewView(); provider.resolveWebviewView(view);
  const ui = executePanelHtml(view.webview.html);
  ui.dispatchMessage({ type: "status", status: h.manager.getStatus(), persistentMode: false });
  ui.element("mcpAddServerButton").click();
  ui.element("mcpFormName").value = "remote";
  ui.element("mcpFormTransport").value = "http";
  ui.element("mcpFormUrl").value = "https://example.com/mcp";
  ui.element("mcpFormHeaders").value = "Authorization: one\nauthorization: two";
  ui.element("mcpAddServerForm").dispatch("submit");
  assert.equal(ui.element("mcpFormError").hidden, false);
  assert.equal(ui.posted.some((message: any) => message.type === "addExternalMcpServer"), false);
  ui.element("mcpFormHeaders").value = "";
  ui.element("mcpFormTimeout").value = "0";
  ui.element("mcpAddServerForm").dispatch("submit");
  assert.equal(ui.posted.some((message: any) => message.type === "addExternalMcpServer"), false);
  ui.element("mcpFormCancelButton").click();
  assert.equal(ui.element("mcpAddServerForm").hidden, true);
  assert.equal(ui.element("mcpFormUrl").value, "");
  assert.equal(ui.element("languageSelect").disabled, false);
});

test("an external language change defers rendering until the MCP form closes", async (t) => {
  const h = setup(t); await h.manager.initialize();
  const provider = new BridgePanelProvider(h.manager, Promise.resolve());
  const view = createFakeWebviewView(); provider.resolveWebviewView(view);
  const before = view.webview.html;
  await (provider as any).handleMessage({ type: "externalMcpFormDirtyChanged", dirty: true }, view.webview);
  vscodeTest.setConfig("agentbridge.language", "zh-CN");
  vscodeTest.emitConfig("agentbridge.language");
  assert.equal(view.webview.html, before);
  await (provider as any).handleMessage({ type: "externalMcpFormDirtyChanged", dirty: false }, view.webview);
  assert.match(view.webview.html, /<html lang="zh-CN">/);
});

test("saving a server while running discovers it without restarting existing connections", async (t) => {
  const h = setup(t); await start(h);
  assert.equal(h.peers.length, 1);
  await h.manager.addExternalMcpServer("workspace", "new", { command: "fixture" });
  await (h.manager as any).externalMcp.waitForDiscovery();
  assert.equal(h.peers.length, 2);
  assert.equal(h.manager.getStatus().externalMcp.servers.find((server) => server.name === "new")?.state, "connected");
  assert.ok(h.manager.getStatus().toolNames.includes("mcp__new__read"));
});

test("late completion messages cannot unlock, cancel or replace an active form save", async (t) => {
  const h = setup(t); await h.manager.initialize();
  const provider = new BridgePanelProvider(h.manager, Promise.resolve());
  const view = createFakeWebviewView(); provider.resolveWebviewView(view);
  const ui = executePanelHtml(view.webview.html);
  const status = h.manager.getStatus();
  ui.dispatchMessage({ type: "status", status, persistentMode: false });
  ui.element("mcpAddServerButton").click();
  ui.element("mcpFormName").value = "pending";
  ui.element("mcpFormCommand").value = "node";
  ui.element("mcpAddServerForm").dispatch("submit");
  const request = ui.posted.at(-1);
  ui.dispatchMessage({ type: "operationFinished", operation: "setExternalMcpCredential", succeeded: true, status });
  ui.dispatchMessage({ type: "operationFinished", operation: "addExternalMcpServer", requestId: "old", succeeded: false, status });
  assert.equal(ui.element("mcpFormName").disabled, true);
  assert.equal(ui.element("mcpFormSaveButton").disabled, true);
  ui.element("mcpAddServerForm").dispatch("submit");
  ui.element("mcpFormCancelButton").click();
  assert.equal(ui.element("mcpAddServerForm").hidden, false);
  assert.equal(ui.posted.filter((message: any) => message.type === "addExternalMcpServer").length, 1);
  ui.dispatchMessage({ type: "externalMcpServerSaveFailed", requestId: request.requestId, detail: "Try again" });
  ui.dispatchMessage({ type: "operationFinished", operation: "addExternalMcpServer", requestId: request.requestId, succeeded: false, status });
  assert.equal(ui.element("mcpFormName").disabled, false);
  ui.element("mcpFormName").value = "retry";
  ui.element("mcpAddServerForm").dispatch("submit");
  assert.equal(ui.posted.filter((message: any) => message.type === "addExternalMcpServer").length, 2);
  const retried = ui.posted.at(-1);
  assert.notEqual(retried.requestId, request.requestId);
  ui.dispatchMessage({ type: "externalMcpServerSaved", requestId: request.requestId, name: "pending" });
  assert.equal(ui.element("mcpFormName").value, "retry");
  assert.equal(ui.element("mcpAddServerForm").hidden, false);
});

test("browser badInput is rejected while genuinely blank timeout fields retain defaults", async (t) => {
  const h = setup(t); await h.manager.initialize();
  const provider = new BridgePanelProvider(h.manager, Promise.resolve());
  const view = createFakeWebviewView(); provider.resolveWebviewView(view);
  const ui = executePanelHtml(view.webview.html);
  ui.dispatchMessage({ type: "status", status: h.manager.getStatus(), persistentMode: false });
  ui.element("mcpAddServerButton").click();
  ui.element("mcpFormName").value = "numbers";
  ui.element("mcpFormCommand").value = "node";
  ui.element("mcpFormTimeout").value = "";
  ui.element("mcpFormTimeout").validity.badInput = true;
  ui.element("mcpAddServerForm").dispatch("submit");
  assert.equal(ui.element("mcpFormError").hidden, false);
  assert.equal(ui.posted.some((message: any) => message.type === "addExternalMcpServer"), false);
  ui.element("mcpFormTimeout").validity.badInput = false;
  ui.element("mcpAddServerForm").dispatch("submit");
  assert.equal(ui.posted.at(-1).config.timeout, undefined);
});

test("successful save restores focus only once the adding button has been enabled", async (t) => {
  const h = setup(t); await h.manager.initialize();
  const provider = new BridgePanelProvider(h.manager, Promise.resolve());
  const view = createFakeWebviewView(); provider.resolveWebviewView(view);
  const ui = executePanelHtml(view.webview.html);
  const status = h.manager.getStatus();
  ui.dispatchMessage({ type: "status", status, persistentMode: false });
  ui.element("mcpAddServerButton").click();
  ui.element("mcpFormName").value = "focus";
  ui.element("mcpFormCommand").value = "node";
  ui.element("mcpFormSaveButton").focus();
  ui.element("mcpAddServerForm").dispatch("submit");
  const request = ui.posted.at(-1);
  ui.dispatchMessage({ type: "externalMcpServerSaved", requestId: request.requestId, name: "focus" });
  assert.equal(ui.element("mcpAddServerButton").disabled, true);
  assert.notEqual(ui.focusedId(), "mcpAddServerButton");
  ui.dispatchMessage({ type: "operationFinished", operation: "addExternalMcpServer", requestId: request.requestId, succeeded: true, status });
  assert.equal(ui.focusedId(), "mcpAddServerButton");
});

test("dirty configuration opened through a directory alias is protected", async (t) => {
  const h = setup(t); await h.manager.initialize();
  const alias = path.join(h.root, "config-alias");
  fs.symlinkSync(path.dirname(h.configFile), alias, process.platform === "win32" ? "junction" : "dir");
  const documentFile = path.join(alias, "mcp.json");
  vscodeTest.textDocuments.push({ uri: { scheme: "file", fsPath: documentFile, toString: () => documentFile }, isDirty: true } as any);
  const before = fs.readFileSync(h.configFile, "utf8");
  await assert.rejects(h.manager.addExternalMcpServer("workspace", "new", { command: "node" }), /unsaved edits/);
  assert.equal(fs.readFileSync(h.configFile, "utf8"), before);
});

test("the save limit reads current files rather than a stale server status", async (t) => {
  const h = setup(t); await h.manager.initialize();
  assert.equal(h.manager.getStatus().externalMcp.servers.length, 1);
  const userFile = path.join(h.home, ".agentbridge", "mcp.json");
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  fs.writeFileSync(userFile, JSON.stringify({ mcpServers: Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`s${index}`, { command: "node" }])) }));
  const before = fs.readFileSync(h.configFile, "utf8");
  await assert.rejects(h.manager.addExternalMcpServer("workspace", "overflow", { command: "node" }), /32 external MCP servers/);
  assert.equal(fs.readFileSync(h.configFile, "utf8"), before);
  await h.manager.addExternalMcpServer("workspace", "s0", { command: "workspace-override" });
  assert.equal(h.manager.getStatus().externalMcp.servers.length, 32);
  assert.equal(h.manager.getStatus().externalMcp.servers.find((server) => server.name === "s0")?.scope, "workspace");
});
