import { randomUUID } from "node:crypto";
import { chmod, chown, link, lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { lock } from "proper-lockfile";
import { MAX_CONFIG_BYTES, parseMcpServer } from "./mcp-config.js";
import { replaceMcpConfiguration } from "./mcp-config-publish.js";

const writes = new Map<string, Promise<void>>();
interface Snapshot { text: string; mode: number; uid: number; gid: number; dev: number; ino: number; }
interface SaveOptions {
  mutexFile?: string;
  beforeCommit?(): Promise<void>;
  onCleanupError?(error: unknown): void;
}

/** Resolve directory aliases even when the configuration has not been created yet. */
export async function canonicalMcpConfigurationPath(file: string): Promise<string> {
  let current = path.resolve(file);
  const missing: string[] = [];
  for (;;) {
    try { return path.join(await realpath(current), ...missing.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(current) === current) throw error;
      missing.push(path.basename(current));
      current = path.dirname(current);
    }
  }
}

async function readSnapshot(file: string): Promise<Snapshot | undefined> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || info.nlink > 1) throw new Error("MCP configuration is a linked file. Edit its configuration directly to preserve the shared link.");
    if (!info.isFile()) throw new Error("MCP configuration must be a regular file.");
    if (info.size > MAX_CONFIG_BYTES) throw new Error("MCP configuration exceeds 1 MiB.");
    const text = await readFile(file, "utf8");
    if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) throw new Error("MCP configuration exceeds 1 MiB.");
    return { text, mode: info.mode & 0o7777, uid: info.uid, gid: info.gid, dev: info.dev, ino: info.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Add one server under a process-shared lock, preserving existing configuration. */
export async function addMcpServerConfiguration(file: string, name: string, config: unknown, assertEditable: () => void | Promise<void> = () => {}, options: SaveOptions = {}): Promise<void> {
  const parsed = parseMcpServer(name, config, file, "workspace");
  if (parsed.url && !parsed.url.includes("${")) {
    let url: URL;
    try { url = new URL(parsed.url); } catch { throw new Error("MCP URL must be a valid HTTP(S) address."); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("MCP URLs must use HTTP(S) without embedded credentials or fragments.");
  }
  try { if ((await lstat(file)).isSymbolicLink()) throw new Error("MCP configuration is a linked file. Edit its configuration directly to preserve the shared link."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const target = await canonicalMcpConfigurationPath(file);
  const mutex = await canonicalMcpConfigurationPath(options.mutexFile ?? file);
  const key = process.platform === "win32" ? mutex.toLowerCase() : mutex;
  const operation = (writes.get(key) ?? Promise.resolve()).then(async () => {
    await assertEditable();
    await mkdir(path.dirname(mutex), { recursive: true });
    let compromised: Error | undefined;
    const release = await lock(mutex, {
      realpath: false, stale: 10_000, update: 1_000,
      retries: { retries: 25, factor: 1, minTimeout: 200, maxTimeout: 200 },
      onCompromised(error) { compromised = error; },
    });
    let committed = false;
    let temporary: string | undefined;
    try {
      if (await canonicalMcpConfigurationPath(file) !== target) throw new Error("MCP configuration path changed while saving. Try again.");
      const snapshot = await readSnapshot(file);
      let document: Record<string, unknown> = { mcpServers: {} };
      if (snapshot) {
        let value: unknown;
        try { value = JSON.parse(snapshot.text.replace(/^\uFEFF/, "")); }
        catch { throw new Error("Invalid JSON; fix the MCP configuration file before adding a server."); }
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object with mcpServers.");
        document = value as Record<string, unknown>;
      }
      const servers = document.mcpServers;
      if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("mcpServers must be an object.");
      if (Object.hasOwn(servers, name)) throw new Error("A server with this name already exists in this file. Choose another name or edit its configuration.");
      if (Object.keys(servers).length >= 32) throw new Error("At most 32 MCP servers may be configured per file.");
      document.mcpServers = Object.fromEntries([...Object.entries(servers), [name, config]]);
      const eol = snapshot?.text.includes("\r\n") ? "\r\n" : "\n";
      const text = JSON.stringify(document, null, 2).replace(/\n/g, eol) + eol;
      if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) throw new Error("MCP configuration exceeds 1 MiB.");
      await mkdir(path.dirname(target), { recursive: true });
      await assertEditable();
      temporary = path.join(path.dirname(target), `.mcp-${randomUUID()}.tmp`);
      await writeFile(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
      const ensureUnchanged = async () => {
        if (JSON.stringify(await readSnapshot(file)) !== JSON.stringify(snapshot)) throw new Error("MCP configuration or permissions changed while saving. Try again.");
        if (await canonicalMcpConfigurationPath(file) !== target) throw new Error("MCP configuration path changed while saving. Try again.");
      };
      await ensureUnchanged();
      await options.beforeCommit?.();
      await assertEditable();
      await ensureUnchanged();
      if (compromised) throw new Error("The MCP configuration write lock was lost. Try again.");
      if (snapshot && process.platform !== "win32") {
        await chown(temporary, snapshot.uid, snapshot.gid);
        await chmod(temporary, snapshot.mode);
      }
      if (snapshot) {
        await replaceMcpConfiguration(temporary, target, text, options.onCleanupError);
      } else {
        // Publish a complete file without replacing a competing creation.
        try { await link(temporary, target); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("MCP configuration changed while saving. Try again.");
          if (["ENOTSUP", "EOPNOTSUPP", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new Error("This filesystem cannot create the configuration atomically. Open the configuration editor first, then try adding the server again.");
          throw error;
        }
      }
      committed = true;
    } finally {
      try {
        if (temporary) await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") {
            if (committed) options.onCleanupError?.(error);
            else throw error;
          }
        });
      } finally {
        await release().catch(error => {
          if (committed) options.onCleanupError?.(error);
          else if (!compromised) throw error;
        });
      }
    }
  });
  const settled = operation.catch(() => {});
  writes.set(key, settled);
  void settled.then(() => { if (writes.get(key) === settled) writes.delete(key); });
  return operation;
}
