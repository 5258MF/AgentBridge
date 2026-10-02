import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";
import { ExternalMcpManager } from "../src/extension/src/mcp-manager.js";
import { vscodeTest } from "./helpers/fake-vscode.js";

const fixtureFile = path.join(process.cwd(), "tests", "fixtures", "mcp-upstream.cjs");
const sdk = path.join(process.cwd(), "node_modules", "@modelcontextprotocol", "sdk", "dist", "cjs");
// The other tests intentionally replace child_process; these peers exercise the real transports.
const spawn: typeof import("node:child_process").spawn = createRequire(path.join(process.cwd(), "package.json"))("node:child_process").spawn;

function setup(t: test.TestContext, config: unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-mcp-transport-"));
  fs.mkdirSync(path.join(root, ".agentbridge"));
  fs.writeFileSync(path.join(root, ".agentbridge", "mcp.json"), JSON.stringify({ mcpServers: { fixture: config } }));
  const logs: string[] = [];
  const manager = new ExternalMcpManager({ discovery: () => ({ workspaceRoots: [root] }), getSecret: async () => undefined, isTrusted: () => true, state: vscodeTest.createMemento(), onChange() {}, log(message) { logs.push(message); }, reconnectDelayMs: 10 });
  t.after(async () => { await manager.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { manager, root, logs };
}

async function httpPeer(t: test.TestContext, mode = "http"): Promise<number> {
  const child = spawn(process.execPath, [fixtureFile, sdk, mode], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  t.after(async () => {
    if (child.exitCode !== null) return;
    const closed = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.stdin!.end();
    const timer = setTimeout(() => child.kill(), 3000);
    try { await closed; } finally { clearTimeout(timer); }
  });
  return new Promise<number>((resolve, reject) => {
    let pending = "";
    // Loading the real SDK can be slow on a cold Windows filesystem while the
    // full suite and reviewers compete for CPU. This is only fixture startup.
    const timer = setTimeout(() => reject(new Error("HTTP fixture did not start")), 12_000);
    const fail = (error: Error) => { clearTimeout(timer); reject(error); };
    child.once("error", fail);
    child.once("exit", () => fail(new Error("HTTP fixture exited before startup")));
    child.stdout!.on("data", (data) => {
      pending += String(data);
      if (!pending.includes("\n")) return;
      clearTimeout(timer);
      resolve(Number(JSON.parse(pending.split("\n")[0]!).port));
    });
  });
}

test("real stdio MCP starts with resolved environment and workspace cwd, answers roots, and stops", { timeout: 20_000 }, async (t) => {
  const h = setup(t, { command: process.execPath, args: [fixtureFile, sdk], env: { MCP_FIXTURE_VALUE: "fixture-value" } });
  await h.manager.start(); await h.manager.waitForDiscovery();
  assert.equal(h.manager.getStatus().servers[0]?.state, "connected", h.manager.getStatus().servers[0]?.error);
  const result = await h.manager.callTool("mcp__fixture__inspect", { query: "test" }, undefined, true);
  assert.equal(result.structuredContent?.cwd, h.root);
  assert.equal(result.structuredContent?.variable, "fixture-value");
  assert.deepEqual(result.structuredContent?.args, { query: "test" });
  assert.deepEqual(result.structuredContent?.roots, [{ uri: pathToFileURL(h.root).href, name: path.basename(h.root) }]);
  assert.deepEqual(result._meta, { fixture: true });
  await h.manager.stop();
  assert.equal(h.manager.getStatus().servers[0]?.state, "stopped");
});

test("real Streamable HTTP MCP forwards configured authorization and tool results", { timeout: 20_000 }, async (t) => {
  const port = await httpPeer(t);
  const h = setup(t, { url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: "Bearer fixture-token" } });
  await h.manager.start(); await h.manager.waitForDiscovery();
  assert.equal(h.manager.getStatus().servers[0]?.state, "connected");
  const result = await h.manager.callTool("mcp__fixture__inspect", { query: "http" }, undefined, false);
  assert.equal(result.structuredContent?.name, "inspect");
  assert.deepEqual(result.structuredContent?.args, { query: "http" });
  assert.deepEqual(result._meta, { fixture: true });
});

async function stats(port: number): Promise<{ active: number; deletes: number; initializes: number; openCalls: number; toolCalls: number; resumeGets: number; redirectHits: number }> {
  const response = await fetch(`http://127.0.0.1:${port}/stats`, { headers: { Authorization: "Bearer fixture-token" } });
  return response.json() as Promise<{ active: number; deletes: number; initializes: number; openCalls: number; toolCalls: number; resumeGets: number; redirectHits: number }>;
}

test("stopping a stateful HTTP MCP terminates the owned remote session", { timeout: 20_000 }, async (t) => {
  const port = await httpPeer(t, "http-stateful");
  const h = setup(t, { url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: "Bearer fixture-token" } });
  await h.manager.start(); await h.manager.waitForDiscovery();
  assert.equal(h.manager.getStatus().servers[0]?.state, "connected", h.manager.getStatus().servers[0]?.error);
  assert.equal((await stats(port)).active, 1);
  await h.manager.stop();
  assert.equal((await stats(port)).active, 0, "Stop should release the remote MCP session");
  assert.equal((await stats(port)).deletes, 1);
});

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let index = 0; index < 300; index += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Real MCP transport did not settle");
}

test("expired HTTP sessions reconnect for future calls without replaying the failed tool", { timeout: 20_000 }, async (t) => {
  const port = await httpPeer(t, "http-stateful");
  const h = setup(t, { url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: "Bearer fixture-token" } });
  await h.manager.start(); await h.manager.waitForDiscovery();
  await h.manager.callTool("mcp__fixture__inspect", {}, undefined, false);
  const response = await fetch(`http://127.0.0.1:${port}/expire`, { headers: { Authorization: "Bearer fixture-token" } });
  await response.text();
  await assert.rejects(h.manager.callTool("mcp__fixture__inspect", {}, undefined, false));
  await waitUntil(async () => (await stats(port)).initializes >= 2 && h.manager.getStatus().servers[0]?.state === "connected");
  assert.equal((await stats(port)).toolCalls, 1, "the failed tool was not replayed");
  await h.manager.callTool("mcp__fixture__inspect", {}, undefined, false);
  assert.equal((await stats(port)).toolCalls, 2);
});

for (const mode of ["http-stateful", "http-stateful-sse"]) {
test(`HTTP ${mode} timeout and cancellation release their streams while other calls remain usable`, { timeout: 20_000 }, async (t) => {
  const port = await httpPeer(t, mode);
  const h = setup(t, { url: `http://127.0.0.1:${port}/mcp`, timeout: 0.2, headers: { Authorization: "Bearer fixture-token" } });
  await h.manager.start(); await h.manager.waitForDiscovery();
  await assert.rejects(h.manager.callTool("mcp__fixture__inspect", { hang: true }, undefined, false), { code: "MCP_TIMEOUT" });
  await waitUntil(async () => (await stats(port)).openCalls === 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await stats(port)).resumeGets, 0, "cancelled SSE requests must not reopen through resumption");
  const abort = new AbortController();
  const cancelled = assert.rejects(h.manager.callTool("mcp__fixture__inspect", { hang: true }, abort.signal, false), { code: "ABORTED" });
  await waitUntil(async () => (await stats(port)).openCalls === 1);
  const other = await h.manager.callTool("mcp__fixture__inspect", { query: "parallel" }, undefined, false);
  assert.equal(other.structuredContent?.name, "inspect");
  abort.abort(); await cancelled;
  await waitUntil(async () => (await stats(port)).openCalls === 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await stats(port)).resumeGets, 0);
  assert.equal((await stats(port)).initializes, 1, "cancellation keeps the shared connection");
  assert.equal(h.manager.getStatus().servers[0]?.state, "connected");
});
}

test("HTTP Stop tolerates unsupported session deletion and bounds a hanging DELETE", { timeout: 40_000 }, async (t) => {
  for (const mode of ["http-stateful-no-delete", "http-stateful-hang-delete"]) {
    const port = await httpPeer(t, mode);
    const h = setup(t, { url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: "Bearer fixture-token" } });
    await h.manager.start(); await h.manager.waitForDiscovery();
    const started = performance.now();
    await h.manager.stop();
    assert.ok(performance.now() - started < 6000, "an unresponsive DELETE must not block Stop indefinitely");
    assert.equal(h.manager.getStatus().servers[0]?.state, "stopped");
  }
});

test("stdio stderr buffers UTF-8 and credentials split across chunks before redaction", { timeout: 20_000 }, async (t) => {
  const token = "隐私-private-token";
  const h = setup(t, { command: process.execPath, args: [fixtureFile, sdk], env: { MCP_FIXTURE_VALUE: token } });
  await h.manager.start(); await h.manager.waitForDiscovery();
  await h.manager.callTool("mcp__fixture__inspect", { emitStderr: true }, undefined, false);
  await waitUntil(() => h.logs.some((message) => message.includes("stderr:")));
  assert.ok(h.logs.some((message) => message.includes("[redacted]")));
  assert.ok(!h.logs.join("\n").includes("private-token"));
  assert.ok(!h.logs.join("\n").includes("隐私"));
});

test("multi-line credentials are redacted when stdio splits them into log lines", { timeout: 20_000 }, async (t) => {
  const h = setup(t, { command: process.execPath, args: [fixtureFile, sdk], env: { MCP_FIXTURE_VALUE: "FIRST_PRIVATE_LINE\nSECOND_PRIVATE_LINE" } });
  await h.manager.start(); await h.manager.waitForDiscovery();
  await h.manager.callTool("mcp__fixture__inspect", { emitStderr: true }, undefined, false);
  await waitUntil(() => h.logs.filter((message) => message.includes("stderr:")).length === 2);
  assert.ok(!h.logs.join("\n").includes("FIRST_PRIVATE_LINE"));
  assert.ok(!h.logs.join("\n").includes("SECOND_PRIVATE_LINE"));
});

test("active SSE requests still resume their results without rerunning the tool", { timeout: 20_000 }, async (t) => {
  const port = await httpPeer(t, "http-stateful-sse");
  const h = setup(t, { url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: "Bearer fixture-token" } });
  await h.manager.start(); await h.manager.waitForDiscovery();
  const result = await h.manager.callTool("mcp__fixture__inspect", { resume: true }, undefined, false);
  assert.equal(result.structuredContent?.name, "inspect");
  assert.ok((await stats(port)).resumeGets > 0);
  assert.equal((await stats(port)).toolCalls, 1);
});

test("SDK initialization failure and Stop release sessions opened before initialize completed", { timeout: 40_000 }, async (t) => {
  for (const stopEarly of [false, true]) {
    const port = await httpPeer(t, "http-stateful-partial-init");
    const h = setup(t, { url: `http://127.0.0.1:${port}/mcp`, connectTimeout: 0.2, headers: { Authorization: "Bearer fixture-token" } });
    await h.manager.start();
    if (stopEarly) await waitUntil(() => !!(h.manager as any).slots.get("fixture")?.connection?.transport.sessionId);
    else await h.manager.waitForDiscovery();
    await h.manager.stop();
    assert.equal((await stats(port)).active, 0);
    assert.ok((await stats(port)).deletes >= 1);
  }
});

test("MCP redirects cannot forward custom credential headers to a different address", { timeout: 20_000 }, async (t) => {
  const port = await httpPeer(t, "http-redirect");
  const h = setup(t, { url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: "Bearer fixture-token", "X-API-Key": "redirect-private-token" } });
  await h.manager.start(); await h.manager.waitForDiscovery(); await h.manager.stop();
  assert.equal((await stats(port)).redirectHits, 0);
});
