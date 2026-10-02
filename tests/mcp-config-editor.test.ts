import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { addMcpServerConfiguration } from "../src/extension/src/mcp-config-editor.js";

function setup(t: test.TestContext) {
  const parent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "agentbridge-config-editor-"));
  t.after(() => {
    if (path.dirname(path.resolve(root)) !== parent) throw new Error("Unexpected temporary directory.");
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(root, ".agentbridge", "mcp.json");
  const write = (text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  return { root, file, write, read: () => fs.readFileSync(file, "utf8") };
}

test("adding a server preserves existing entries, top-level data, BOM input and CRLF style", async (t) => {
  const h = setup(t);
  const original = { mcpServers: { old: { command: "node", env: { TOKEN: "${secret:old}" } } }, metadata: { owner: "user" } };
  h.write("\uFEFF" + JSON.stringify(original, null, 2).replace(/\n/g, "\r\n") + "\r\n");
  await addMcpServerConfiguration(h.file, "new", { command: "npx", args: ["-y", "path with spaces"] });
  const saved = JSON.parse(h.read());
  assert.deepEqual(saved.mcpServers.old, original.mcpServers.old);
  assert.deepEqual(saved.metadata, original.metadata);
  assert.deepEqual(saved.mcpServers.new.args, ["-y", "path with spaces"]);
  assert.equal(h.read().replace(/\r\n/g, "").includes("\n"), false);
});

test("adding to a missing file creates only the requested server and handles special object keys", async (t) => {
  const h = setup(t);
  await addMcpServerConfiguration(h.file, "__proto__", { url: "https://example.com/mcp" });
  const saved = JSON.parse(h.read());
  assert.deepEqual(Object.keys(saved.mcpServers), ["__proto__"]);
  assert.equal(saved.mcpServers.__proto__.url, "https://example.com/mcp");
  const before = h.read();
  await assert.rejects(addMcpServerConfiguration(h.file, "__proto__", { command: "node" }), /already exists/);
  assert.equal(h.read(), before);
});

test("invalid JSON and invalid mcpServers remain untouched and parse errors do not disclose source text", async (t) => {
  const h = setup(t);
  for (const text of ['{"mcpServers":{"token":"private-value",', '{"mcpServers":[]}', '{"other":{}}']) {
    h.write(text);
    await assert.rejects(addMcpServerConfiguration(h.file, "new", { command: "node" }), (error: Error) => {
      assert.ok(!error.message.includes("private-value"));
      return true;
    });
    assert.equal(h.read(), text);
  }
});

test("invalid server settings and unsafe literal URLs do not create or mutate files", async (t) => {
  const h = setup(t);
  const invalid = [
    { command: "" }, { command: "node", url: "https://example.com" },
    { command: "node", timeout: 0 }, { command: "node", headers: {} },
    { url: "not-a-url" }, { url: "file:///tmp/test" }, { url: "https://user:private-value@example.com/mcp" },
    { url: "https://example.com/mcp#fragment" },
  ];
  for (const config of invalid) {
    await assert.rejects(addMcpServerConfiguration(h.file, "new", config));
    assert.equal(fs.existsSync(path.dirname(h.file)), false);
  }
  await assert.rejects(addMcpServerConfiguration(h.file, "../../outside", { command: "node" }));
  assert.equal(fs.existsSync(path.dirname(h.file)), false);
});

test("parallel additions are merged and a rejected addition does not block later writes", async (t) => {
  const h = setup(t);
  await addMcpServerConfiguration(h.file, "old", { command: "node" });
  const results = await Promise.allSettled([
    addMcpServerConfiguration(h.file, "first", { command: "node" }),
    addMcpServerConfiguration(h.file, "old", { command: "changed" }),
    addMcpServerConfiguration(h.file, "second", { url: "https://example.com/mcp" }),
  ]);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected", "fulfilled"]);
  // Simultaneous helper calls may finish path resolution in either order; neither addition may be lost.
  assert.deepEqual(Object.keys(JSON.parse(h.read()).mcpServers).sort(), ["first", "old", "second"]);
  assert.equal(JSON.parse(h.read()).mcpServers.old.command, "node");
});

test("configuration capacity and byte limits fail without changing existing content", async (t) => {
  const h = setup(t);
  const full = JSON.stringify({ mcpServers: Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`s${index}`, { command: "node" }])) });
  h.write(full);
  await assert.rejects(addMcpServerConfiguration(h.file, "new", { command: "node" }), /32/);
  assert.equal(h.read(), full);
  const tooLarge = JSON.stringify({ mcpServers: {}, metadata: "x".repeat(1024 * 1024) });
  h.write(tooLarge);
  await assert.rejects(addMcpServerConfiguration(h.file, "new", { command: "node" }), /1 MiB/);
  assert.equal(h.read(), tooLarge);
});

test("a detected concurrent file change is preserved and temporary output is cleaned up", async (t) => {
  const h = setup(t);
  h.write('{"mcpServers":{}}');
  const external = '{"mcpServers":{"external":{"command":"node"}}}';
  let checks = 0;
  await assert.rejects(addMcpServerConfiguration(h.file, "new", { command: "node" }, () => {
    if (++checks === 2) h.write(external);
  }), /changed while saving/);
  assert.equal(h.read(), external);
  assert.deepEqual(fs.readdirSync(path.dirname(h.file)), ["mcp.json"]);
});

test("an editor becoming dirty before commit prevents replacement and leaves no temporary file", async (t) => {
  const h = setup(t);
  const before = '{"mcpServers":{}}';
  h.write(before);
  let checks = 0;
  await assert.rejects(addMcpServerConfiguration(h.file, "new", { command: "node" }, () => {
    if (++checks === 3) throw new Error("unsaved edits");
  }), /unsaved edits/);
  assert.equal(h.read(), before);
  assert.deepEqual(fs.readdirSync(path.dirname(h.file)), ["mcp.json"]);
});

test("separate writer processes merge their additions without losing entries", { timeout: 30_000 }, async (t) => {
  const h = setup(t);
  h.write('{"mcpServers":{"old":{"command":"node"}}}');
  const worker = path.join(__dirname, "mcp-config-writer.cjs");
  const run = (prefix: string) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [worker, h.file, prefix], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(error)));
  });
  await Promise.all([run("a"), run("b")]);
  assert.deepEqual(Object.keys(JSON.parse(h.read()).mcpServers).sort(), ["a0", "a1", "a2", "b0", "b1", "b2", "old"]);
  assert.deepEqual(fs.readdirSync(path.dirname(h.file)), ["mcp.json"]);
});

test("a hard-linked configuration is rejected without breaking shared storage", async (t) => {
  const h = setup(t);
  h.write('{"mcpServers":{}}');
  const alias = path.join(h.root, "shared.json");
  fs.linkSync(h.file, alias);
  await assert.rejects(addMcpServerConfiguration(h.file, "new", { command: "node" }), /linked file/);
  assert.equal(fs.statSync(h.file).nlink, 2);
  assert.equal(h.read(), fs.readFileSync(alias, "utf8"));
  assert.deepEqual(JSON.parse(h.read()), { mcpServers: {} });
});

test("a symbolic configuration is rejected and its target remains untouched", async (t) => {
  const h = setup(t);
  h.write('{"mcpServers":{}}');
  const alias = path.join(h.root, "symbolic.json");
  try { fs.symlinkSync(h.file, alias, "file"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("File symlinks are unavailable for this account."); return; } throw error; }
  await assert.rejects(addMcpServerConfiguration(alias, "new", { command: "node" }), /linked file/);
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(h.read()), { mcpServers: {} });
});

test("a partial first write leaves no configuration and the same draft can be retried", async (t) => {
  const h = setup(t);
  const promises = require("node:fs/promises") as typeof import("node:fs/promises");
  const original = promises.writeFile;
  let fail = true;
  (promises as any).writeFile = async (...args: any[]) => {
    if (fail && String(args[0]).endsWith(".tmp")) {
      fail = false;
      await (original as any)(args[0], "{", args[2]);
      throw Object.assign(new Error("Fixture disk full"), { code: "ENOSPC" });
    }
    return (original as any)(...args);
  };
  try {
    await assert.rejects(addMcpServerConfiguration(h.file, "new", { command: "node" }), /disk full/);
    assert.equal(fs.existsSync(h.file), false);
    assert.deepEqual(fs.readdirSync(path.dirname(h.file)), []);
    await addMcpServerConfiguration(h.file, "new", { command: "node" });
    assert.equal(JSON.parse(h.read()).mcpServers.new.command, "node");
  } finally { (promises as any).writeFile = original; }
});

test("POSIX permission bits survive a restrictive umask", { skip: process.platform === "win32" }, async (t) => {
  const h = setup(t);
  h.write('{"mcpServers":{}}');
  fs.chmodSync(h.file, 0o660);
  const previous = process.umask(0o022);
  try { await addMcpServerConfiguration(h.file, "new", { command: "node" }); }
  finally { process.umask(previous); }
  assert.equal(fs.statSync(h.file).mode & 0o777, 0o660);
});

test("Windows replacement preserves a protected DACL", { skip: process.platform !== "win32" }, async (t) => {
  const h = setup(t);
  h.write('{"mcpServers":{}}');
  const ps = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const literal = "'" + h.file.replace(/'/g, "''") + "'";
  const acl = (setup: boolean) => execFileSync(ps, ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; $value=[System.IO.File]::GetAccessControl(${literal}); ${setup ? `$value.SetAccessRuleProtection($true,$true); [System.IO.File]::SetAccessControl(${literal},$value); $value=[System.IO.File]::GetAccessControl(${literal});` : ""} $value.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access);`], { windowsHide: true, encoding: "utf8" }).trim();
  const before = acl(true);
  await addMcpServerConfiguration(h.file, "new", { command: "node" });
  assert.equal(acl(false), before);
});

test("a final capacity check cannot overwrite an external edit made during that check", async (t) => {
  const h = setup(t);
  h.write('{"mcpServers":{}}');
  const external = '{"mcpServers":{"external":{"command":"node"}}}';
  await assert.rejects(addMcpServerConfiguration(h.file, "new", { command: "node" }, () => {}, { beforeCommit: async () => { h.write(external); } }), /changed while saving/);
  assert.equal(h.read(), external);
});
