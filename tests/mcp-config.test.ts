import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { loadMcpConfiguration, MCP_SECRET_PREFIX, parseMcpServer, resolveMcpServer } from "../src/extension/src/mcp-config.js";
import { externalToolName } from "../src/extension/src/mcp-manager.js";

function fixture(t: test.TestContext) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-mcp-config-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, "home");
  const a = path.join(base, "a");
  const b = path.join(base, "b");
  for (const root of [home, a, b]) fs.mkdirSync(path.join(root, ".agentbridge"), { recursive: true });
  const write = (root: string, servers: unknown) => fs.writeFileSync(path.join(root, ".agentbridge", "mcp.json"), JSON.stringify({ mcpServers: servers }));
  return { home, a, b, write };
}

test("MCP workspace entries override user entries and first workspace folder wins", async (t) => {
  const f = fixture(t);
  f.write(f.home, { docs: { url: "https://example.com/user" }, global: { command: "node" } });
  f.write(f.a, { docs: { url: "https://example.com/a" }, local: { command: "node", enabled: false } });
  f.write(f.b, { docs: { url: "https://example.com/b" } });
  const result = await loadMcpConfiguration({ homeDir: f.home, workspaceRoots: [f.a, f.b] });
  assert.deepEqual(result.errors, []);
  assert.equal(result.entries.find((entry) => entry.name === "docs")?.config?.url, "https://example.com/a");
  assert.equal(result.entries.find((entry) => entry.name === "docs")?.scope, "workspace");
  assert.equal(result.entries.find((entry) => entry.name === "global")?.scope, "user");
  assert.equal(result.entries.find((entry) => entry.name === "local")?.config?.enabled, false);
});

test("malformed JSON and invalid servers do not prevent unrelated MCP entries", async (t) => {
  const f = fixture(t);
  f.write(f.home, { shared: { command: "node" }, unrelated: { url: "https://example.com/mcp" } });
  f.write(f.a, { shared: { command: "node", url: "https://example.com/mcp" } });
  fs.writeFileSync(path.join(f.b, ".agentbridge", "mcp.json"), '{"mcpServers": {"secret": "private-credential-do-not-print"');
  const result = await loadMcpConfiguration({ homeDir: f.home, workspaceRoots: [f.a, f.b] });
  assert.ok(result.entries.find((entry) => entry.name === "shared")?.error);
  assert.ok(result.entries.find((entry) => entry.name === "unrelated")?.config);
  assert.match(result.errors[0]!, /Invalid JSON/);
  assert.ok(!JSON.stringify(result.errors).includes("private-credential"));
});

test("MCP configuration validates transports, booleans, policies and timeouts", () => {
  for (const invalid of [
    { type: "sse", url: "https://example.com" },
    { command: "node", enabled: "false" },
    { url: "https://example.com", timeout: 0 },
    { url: "https://example.com", connectTimeout: Infinity },
    { command: "node", planMode: "write" },
    { command: "node", planMode: ["all"] },
    { command: "node", args: [1] },
    { command: "node", headers: {} },
    { url: "https://example.com", cwd: "." },
    { url: "https://example.com", oauth: {} },
  ]) assert.throws(() => parseMcpServer("server", invalid, "/config", "user"));
  const http = parseMcpServer("server", { type: "streamable-http", url: "https://example.com/mcp", timeout: 0.1, tools: [] }, "/config", "user");
  assert.equal(http.timeoutMs, 100);
  assert.equal(http.connectTimeoutMs, 10_000);
  assert.equal(http.planMode, "read-only");
  assert.deepEqual(http.tools, []);
});

test("MCP variables resolve credentials and paths without evaluating opaque values", async () => {
  const root = path.resolve("project");
  const home = path.resolve("user-home");
  const key = "opaque-${secret:token}";
  const config = parseMcpServer("local", {
    command: "node", args: ["${workspaceFolder}", "${userHome}", "${TOKEN}:${TOKEN}"],
    env: { KEY: "${secret:token}-${secret:token}" }, cwd: "subdir",
  }, "/config", "workspace", root);
  const resolved = await resolveMcpServer(config, home, async (name) => name === MCP_SECRET_PREFIX + "token" ? key : undefined, { TOKEN: "env-${TOKEN}" });
  assert.deepEqual(resolved.config.args, [root, home, "env-${TOKEN}:env-${TOKEN}"]);
  assert.equal(resolved.config.env.KEY, key + "-" + key);
  assert.equal(resolved.config.cwd, path.join(root, "subdir"));
  assert.ok(resolved.secrets.includes(key));
  assert.equal(config.env.KEY, "${secret:token}-${secret:token}");
});

test("missing variables and URL credentials are rejected while literal auth is available for redaction", async () => {
  const missing = parseMcpServer("remote", { url: "${env:UNSET}" }, "/config", "user");
  await assert.rejects(resolveMcpServer(missing, undefined, async () => undefined, {}), /Missing configuration variable/);
  const invalid = parseMcpServer("remote", { url: "https://user:password@example.com/mcp" }, "/config", "user");
  await assert.rejects(resolveMcpServer(invalid, undefined, async () => undefined), /without embedded credentials/);
  const config = parseMcpServer("remote", { url: "https://example.com/mcp?key=query-secret", headers: { Authorization: "Bearer literal-secret" } }, "/config", "user");
  const resolved = await resolveMcpServer(config, undefined, async () => undefined);
  assert.ok(resolved.secrets.includes("literal-secret"));
  assert.ok(resolved.secrets.includes("query-secret"));
});

test("external MCP tool names are stable, bounded and preserve distinct identities", () => {
  assert.equal(externalToolName("docs", "search"), "mcp__docs__search");
  assert.notEqual(externalToolName("a-b", "search"), externalToolName("a_b", "search"));
  assert.notEqual(externalToolName("docs", "a-b"), externalToolName("docs", "a_b"));
  assert.notEqual(externalToolName("a", "b__c"), externalToolName("a__b", "c"));
  assert.notEqual(externalToolName("a_", "b"), externalToolName("a", "_b"));
  const long = externalToolName("docs", "x".repeat(200));
  assert.equal(long, externalToolName("docs", "x".repeat(200)));
  assert.ok(long.length <= 64);
  assert.match(long, /^[A-Za-z0-9_]+$/);
});

test("the editor schema rejects blank fields and invalid transport combinations", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "mcp-config.schema.json"), "utf8"));
  const validate = new AjvJsonSchemaValidator().getValidator(schema);
  for (const server of [
    { command: "   " }, { url: "\t\n" }, { command: "node", cwd: " " },
    { command: "node", description: " " }, { command: "node", headers: {} },
    { url: "https://example.com/mcp", args: [] }, { command: "node", type: "http" },
    { command: "node", url: "https://example.com/mcp" },
  ]) {
    assert.equal(validate({ mcpServers: { fixture: server } }).valid, false);
    assert.throws(() => parseMcpServer("fixture", server, "/config", "user"));
  }
  for (const server of [{ command: "node", args: [] }, { type: "streamable-http", url: "https://example.com/mcp", headers: {} }]) {
    assert.equal(validate({ mcpServers: { fixture: server } }).valid, true);
    assert.doesNotThrow(() => parseMcpServer("fixture", server, "/config", "user"));
  }
});
