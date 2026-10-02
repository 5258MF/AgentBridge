import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { ExternalMcpManager } from "../src/extension/src/mcp-manager.js";
import type { McpConnectionFactory } from "../src/extension/src/mcp-client.js";
import { vscodeTest } from "./helpers/fake-vscode.js";
import { deferred } from "./helpers/panel-harness.js";

const READ: Tool = { name: "read", description: "Read data", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } };
const WRITE: Tool = { name: "write", description: "Write data", inputSchema: { type: "object", properties: {} } };

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("MCP condition did not settle");
}

function harness(t: test.TestContext, config: Record<string, unknown> = { docs: { command: "node" } }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-mcp-manager-"));
  const file = path.join(root, ".agentbridge", "mcp.json");
  fs.mkdirSync(path.dirname(file));
  const save = (servers: Record<string, unknown>) => fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }));
  save(config);
  const servers: Server[] = [];
  const calls: Array<{ name: string; args: unknown }> = [];
  const log: string[] = [];
  const state = vscodeTest.createMemento();
  let tools = [READ, WRITE];
  let trusted = true;
  let changes = 0;
  let connects = 0;
  let closes = 0;
  let call: (name: string, args: unknown, signal: AbortSignal) => Promise<CallToolResult> = async () => ({ content: [{ type: "text", text: "ok" }], structuredContent: { value: 1 } });
  let list: (cursor?: string) => Promise<{ tools: Tool[]; nextCursor?: string }> = async () => ({ tools });
  let beforeFactory: () => Promise<void> = async () => {};
  let beforeClose: () => Promise<void> = async () => {};
  let secret: (key: string) => Promise<string | undefined> = async () => undefined;
  const factory: McpConnectionFactory = async () => {
    connects += 1;
    await beforeFactory();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "upstream", version: "1" }, { capabilities: { tools: { listChanged: true } }, instructions: "Use this server's documented tools." });
    server.setRequestHandler(ListToolsRequestSchema, async (request) => list(request.params?.cursor));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      calls.push({ name: request.params.name, args: request.params.arguments });
      return call(request.params.name, request.params.arguments, extra.signal);
    });
    await server.connect(serverTransport);
    servers.push(server);
    const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
    let closed = false;
    return { client, transport: clientTransport, close: async () => {
      if (closed) return;
      closed = true;
      closes += 1;
      await beforeClose();
      await client.close();
      await server.close();
    } };
  };
  const manager = new ExternalMcpManager({
    discovery: () => ({ workspaceRoots: [root] }), state,
    getSecret: (key) => secret(key), isTrusted: () => trusted,
    onChange: () => { changes += 1; }, log: (message) => log.push(message),
    factory, reconnectDelayMs: 5,
  });
  t.after(async () => { await manager.dispose(); for (const server of servers) await server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return {
    manager, save, state, calls, servers, log, root, file,
    get connects() { return connects; }, get closes() { return closes; }, get changes() { return changes; },
    setTools(value: Tool[]) { tools = value; }, setTrusted(value: boolean) { trusted = value; },
    setCall(value: typeof call) { call = value; }, setList(value: typeof list) { list = value; },
    setBeforeFactory(value: typeof beforeFactory) { beforeFactory = value; },
    setBeforeClose(value: typeof beforeClose) { beforeClose = value; },
    setSecret(value: typeof secret) { secret = value; },
  };
}

test("MCP discovery exposes namespaced tools and forwards raw names, arguments and rich results", async (t) => {
  const h = harness(t);
  h.setCall(async () => ({ content: [
    { type: "text", text: "result" },
    { type: "image", data: "eA==", mimeType: "image/png" },
    { type: "resource_link", name: "document", uri: "test://document" },
  ], structuredContent: { value: 1 }, _meta: { upstream: true } }));
  await h.manager.reload();
  assert.equal(h.connects, 0, "configuration loading does not spawn a process before Bridge Start");
  await h.manager.start();
  await h.manager.waitForDiscovery();
  assert.deepEqual(h.manager.getTools().map((tool) => tool.name), ["mcp__docs__read", "mcp__docs__write"]);
  const result = await h.manager.callTool("mcp__docs__read", { query: "value" }, undefined, false);
  assert.deepEqual(h.calls, [{ name: "read", args: { query: "value" } }]);
  assert.deepEqual(result.structuredContent, { value: 1 });
  assert.deepEqual(result.content.map((item) => item.type), ["text", "image", "resource_link"]);
  assert.deepEqual(result._meta, { upstream: true });
  assert.equal(h.manager.getStatus().servers[0]?.state, "connected");
});

test("Plan mode applies read-only, all and disabled policies at call time", async (t) => {
  const h = harness(t);
  await h.manager.start(); await h.manager.waitForDiscovery();
  await h.manager.callTool("mcp__docs__read", {}, undefined, true);
  await assert.rejects(h.manager.callTool("mcp__docs__write", {}, undefined, true), { code: "READ_ONLY_MODE" });
  assert.equal(h.calls.length, 1);
  h.save({ docs: { command: "node", planMode: "all" } });
  await h.manager.reload(); await h.manager.waitForDiscovery();
  await h.manager.callTool("mcp__docs__write", {}, undefined, true);
  h.save({ docs: { command: "node", planMode: "disabled" } });
  await h.manager.reload(); await h.manager.waitForDiscovery();
  await assert.rejects(h.manager.callTool("mcp__docs__read", {}, undefined, true), { code: "READ_ONLY_MODE" });
  await h.manager.callTool("mcp__docs__write", {}, undefined, false);
});

test("MCP tool errors are preserved and mutations are never automatically retried", async (t) => {
  const h = harness(t);
  h.setCall(async () => ({ isError: true, content: [{ type: "text", text: "Mutation refused" }] }));
  await h.manager.start(); await h.manager.waitForDiscovery();
  const result = await h.manager.callTool("mcp__docs__write", {}, undefined, false);
  assert.equal(result.isError, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.manager.getStatus().servers[0]?.state, "connected");
});

test("MCP timeouts and caller cancellation abort upstream execution", async (t) => {
  const h = harness(t, { docs: { command: "node", timeout: 0.05 } });
  let upstreamAborted = 0;
  h.setCall(async (_name, _args, signal) => new Promise((resolve) => {
    signal.addEventListener("abort", () => { upstreamAborted += 1; resolve({ content: [] }); }, { once: true });
  }));
  await h.manager.start(); await h.manager.waitForDiscovery();
  await assert.rejects(h.manager.callTool("mcp__docs__write", {}, undefined, false), { code: "MCP_TIMEOUT" });
  await waitUntil(() => upstreamAborted === 1);
  const abort = new AbortController();
  const cancelled = assert.rejects(h.manager.callTool("mcp__docs__read", {}, abort.signal, false), { code: "ABORTED" });
  await waitUntil(() => h.calls.length === 2);
  abort.abort();
  await cancelled;
  await waitUntil(() => upstreamAborted === 2);
});

test("changed tool lists are replaced atomically and failed refresh preserves the old list", async (t) => {
  const h = harness(t);
  await h.manager.start(); await h.manager.waitForDiscovery();
  h.setTools([READ]);
  await h.servers[0]!.sendToolListChanged();
  await waitUntil(() => h.manager.getTools().length === 1);
  h.setList(async () => ({ tools: [WRITE, WRITE] }));
  await h.servers[0]!.sendToolListChanged();
  await waitUntil(() => !!h.manager.getStatus().servers[0]?.error);
  assert.deepEqual(h.manager.getTools().map((tool) => tool.name), ["mcp__docs__read"]);
});

test("a notification during an in-flight refresh schedules a second refresh", async (t) => {
  const h = harness(t);
  await h.manager.start(); await h.manager.waitForDiscovery();
  const firstStarted = deferred<void>();
  const finishFirst = deferred<void>();
  let lists = 0;
  h.setList(async () => {
    lists += 1;
    if (lists === 1) { firstStarted.resolve(); await finishFirst.promise; return { tools: [READ] }; }
    return { tools: [WRITE] };
  });
  await h.servers[0]!.sendToolListChanged();
  await firstStarted.promise;
  await h.servers[0]!.sendToolListChanged();
  finishFirst.resolve();
  await waitUntil(() => h.manager.getTools()[0]?.name === "mcp__docs__write");
  assert.equal(lists, 2);
});

test("MCP pagination detects repeated cursors and handles tool allowlists", async (t) => {
  const h = harness(t, { docs: { command: "node", tools: ["write"] } });
  h.setList(async (cursor) => cursor ? { tools: [WRITE] } : { tools: [READ], nextCursor: "next" });
  await h.manager.start(); await h.manager.waitForDiscovery();
  assert.deepEqual(h.manager.getTools().map((tool) => tool.name), ["mcp__docs__write"]);
  h.setList(async () => ({ tools: [], nextCursor: "same" }));
  await h.servers[0]!.sendToolListChanged();
  await waitUntil(() => !!h.manager.getStatus().servers[0]?.error);
  assert.match(h.manager.getStatus().servers[0]!.error!, /repeated.*cursor/);
  assert.equal(h.manager.getTools().length, 1);
});

test("disconnect reconnects while Stop prevents delayed attempts from reviving a server", async (t) => {
  const h = harness(t);
  await h.manager.start(); await h.manager.waitForDiscovery();
  await h.servers[0]!.close();
  await waitUntil(() => h.connects === 2 && h.manager.getStatus().servers[0]?.state === "connected");
  await h.manager.stop();
  assert.equal(h.manager.getTools().length, 0);
  assert.equal(h.manager.getStatus().servers[0]?.state, "stopped");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(h.connects, 2);
});

test("a Stop immediately after queued Start prevents any upstream launch", async (t) => {
  const h = harness(t);
  const starting = h.manager.start();
  const stopping = h.manager.stop();
  await Promise.all([starting, stopping]);
  assert.equal(h.connects, 0);
  assert.equal(h.manager.getTools().length, 0);
});

test("a late transport factory is closed after Stop and cannot publish tools", async (t) => {
  const h = harness(t);
  const factoryStarted = deferred<void>();
  const release = deferred<void>();
  h.setBeforeFactory(async () => { factoryStarted.resolve(); await release.promise; });
  await h.manager.start();
  await factoryStarted.promise;
  await h.manager.stop();
  release.resolve();
  await waitUntil(() => h.closes === 1);
  assert.equal(h.manager.getTools().length, 0);
  assert.equal(h.manager.getStatus().servers[0]?.state, "stopped");
});

test("server enabled overrides persist per workspace and failed writes preserve the previous state", async (t) => {
  const h = harness(t);
  await h.manager.start(); await h.manager.waitForDiscovery();
  await h.manager.setEnabled("docs", false);
  assert.equal(h.manager.getStatus().servers[0]?.state, "disabled");
  assert.equal(h.manager.getTools().length, 0);
  const save = h.state.update;
  h.state.update = async (key, value) => { await save(key, value); throw new Error("Save failed after cache mutation"); };
  await assert.rejects(h.manager.setEnabled("docs", true), { code: "MCP_CONFIG_SAVE_FAILED" });
  assert.equal(h.manager.getStatus().servers[0]?.enabled, false);
  assert.deepEqual(h.state.get("agentbridge.mcp.enabledOverrides"), { docs: false });
  h.state.update = save;
  await h.manager.setEnabled("docs", true); await h.manager.waitForDiscovery();
  assert.equal(h.manager.getStatus().servers[0]?.state, "connected");
});

test("untrusted workspaces cannot start MCP servers; trust grant activates them", async (t) => {
  const h = harness(t);
  h.setTrusted(false);
  await h.manager.start();
  assert.equal(h.connects, 0);
  assert.equal(h.manager.getStatus().servers[0]?.state, "untrusted");
  h.setTrusted(true);
  await h.manager.reload(); await h.manager.waitForDiscovery();
  assert.equal(h.manager.getStatus().servers[0]?.state, "connected");
});

test("connection errors redact literal credentials and configuration status omits auth fields", async (t) => {
  const h = harness(t, { docs: { url: "https://example.com/mcp", headers: { Authorization: "Bearer private-token-value" } } });
  h.setList(async () => { throw new Error("Authentication failed: private-token-value"); });
  await h.manager.start(); await h.manager.waitForDiscovery();
  assert.ok(!JSON.stringify(h.manager.getStatus()).includes("private-token-value"));
  assert.ok(!h.log.join("\n").includes("private-token-value"));
  assert.match(h.manager.getStatus().servers[0]!.error!, /redacted/);
});

test("special object property names do not override configured server enable state", async (t) => {
  const config = Object.fromEntries(["constructor", "__proto__", "toString"].map((name) => [name, { command: "node", enabled: false }]));
  const h = harness(t, config);
  await h.manager.start();
  assert.equal(h.connects, 0);
  assert.ok(h.manager.getStatus().servers.every((server) => server.enabled === false && server.state === "disabled"));
  await h.manager.setEnabled("constructor", true); await h.manager.waitForDiscovery();
  assert.equal(h.connects, 1);
  assert.equal(h.manager.getStatus().servers.find((server) => server.name === "constructor")?.state, "connected");
  assert.equal(h.manager.getStatus().servers.find((server) => server.name === "__proto__")?.enabled, false);
});

test("trust changes while stopped refresh status without starting a connection", async (t) => {
  const h = harness(t);
  h.setTrusted(false);
  await h.manager.reload();
  assert.equal(h.manager.getStatus().servers[0]?.state, "untrusted");
  await h.manager.reconnect("docs");
  assert.equal(h.manager.getStatus().servers[0]?.state, "untrusted");
  h.setTrusted(true);
  await h.manager.reload();
  assert.equal(h.manager.getStatus().servers[0]?.state, "stopped");
  assert.equal(h.connects, 0);
});

test("short credentials and regex punctuation are redacted in one pass", async (t) => {
  const h = harness(t, { docs: { command: "node", env: { TOKEN: "${secret:token}", LITERAL: "a+b", SHORT: "a" } } });
  h.setSecret(async () => "abc");
  h.setCall(async () => { throw new Error("Authentication rejected: abc / a+b / a"); });
  await h.manager.start(); await h.manager.waitForDiscovery();
  await assert.rejects(h.manager.callTool("mcp__docs__read", {}, undefined, false), (error: any) => {
    assert.ok(!error.message.includes("abc") && !error.message.includes("a+b"));
    assert.ok(error.message.includes("[redacted]"));
    assert.ok(!error.message.includes("[[redacted]"));
    return true;
  });
  assert.ok(!h.log.join("\n").includes("abc") && !h.log.join("\n").includes("a+b"));
});

test("a stale credential lookup cannot replace the current connection's redactor", async (t) => {
  const h = harness(t, { docs: { command: "node", env: { TOKEN: "${secret:token}" } } });
  const entered = deferred<void>();
  const oldValue = deferred<string>();
  let reads = 0;
  h.setSecret(async () => { if (++reads === 1) { entered.resolve(); return oldValue.promise; } return "current-private-token"; });
  await h.manager.start(); await entered.promise;
  await h.manager.stop();
  await h.manager.start(); await h.manager.waitForDiscovery();
  try {
    oldValue.resolve("previous-private-token");
    await new Promise((resolve) => setTimeout(resolve, 15));
    h.setCall(async () => { throw new Error("Rejected current-private-token"); });
    await assert.rejects(h.manager.callTool("mcp__docs__read", {}, undefined, false), (error: any) => {
      assert.ok(!error.message.includes("current-private-token")); return true;
    });
    assert.ok(!h.log.join("\n").includes("current-private-token"));
  } finally { oldValue.resolve("previous-private-token"); }
});

test("manual reconnect during failure cleanup cannot schedule a second live connection", async (t) => {
  const h = harness(t);
  const closing = deferred<void>();
  const release = deferred<void>();
  h.setList(async () => { throw new Error("Discovery failed"); });
  h.setBeforeClose(async () => { closing.resolve(); await release.promise; });
  await h.manager.start(); await closing.promise;
  const reconnect = h.manager.reconnect("docs");
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.setList(async () => ({ tools: [READ] }));
    h.setBeforeClose(async () => {});
    release.resolve();
    await reconnect; await h.manager.waitForDiscovery();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(h.connects, 2, "one failed connection and one replacement");
    assert.equal(h.manager.getStatus().servers[0]?.state, "connected");
    await h.manager.stop();
    assert.equal(h.closes, 2, "both owned connections have been closed");
  } finally { release.resolve(); }
});
