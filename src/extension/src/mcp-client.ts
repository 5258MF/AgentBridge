import { execFile } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "./mcp-config.js";
import { CancellableMcpHttpTransport } from "./mcp-http-transport.js";

export interface McpConnection {
  client: Client;
  transport: Transport;
  close(): Promise<void>;
}
export type McpConnectionFactory = (config: McpServerConfig, log: (message: string) => void) => McpConnection | Promise<McpConnection>;

/** The same SDK used by the public Bridge also owns the upstream MCP protocol. */
export const createMcpConnection: McpConnectionFactory = (config, log) => {
  const client = new Client({ name: "agentbridge-mcp-client", version: "0.1.16" }, { capabilities: { roots: {} } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: config.workspaceRoot ? [{ uri: pathToFileURL(config.workspaceRoot).href, name: path.basename(config.workspaceRoot) }] : [] }));
  const transport = config.type === "stdio"
    ? new StdioClientTransport({ command: config.command!, args: config.args, env: config.env, cwd: config.cwd, stderr: "pipe" })
    : new CancellableMcpHttpTransport(new URL(config.url!), config.headers, config.connectTimeoutMs);
  if (transport instanceof StdioClientTransport) {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let omitted = false;
    const consume = (text: string, end = false) => {
      const lines = text.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const part = lines[index]!;
        if (!omitted) {
          if (pending.length + part.length > 65_536) { pending = ""; omitted = true; }
          else pending += part;
        }
        if (index < lines.length - 1 || end) {
          if (omitted) log("stderr: [line omitted: exceeds 64 KiB]");
          else if (pending.trim()) log(`stderr: ${pending.trim()}`);
          pending = ""; omitted = false;
        }
      }
    };
    transport.stderr?.on("data", (chunk: unknown) => consume(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))));
    transport.stderr?.on("end", () => consume(decoder.end(), true));
  }
  const closeTransport = transport.close.bind(transport);
  let transportClosing: Promise<void> | undefined;
  // Client.connect also closes the transport on initialization failure. Own this
  // boundary so it cannot bypass session deletion or Windows process-tree cleanup.
  transport.close = () => transportClosing ??= (async () => {
        if (transport instanceof CancellableMcpHttpTransport) transport.beginClose();
        if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              transport.terminateSession().catch((error) => log(`Could not terminate remote MCP session: ${error instanceof Error ? error.message : String(error)}`)),
              new Promise<void>((resolve) => { timer = setTimeout(resolve, 3000); }),
            ]);
          } finally { if (timer) clearTimeout(timer); }
        }
        // Windows wrappers such as npx.cmd own descendants; stop the entire owned tree.
        const pid = transport instanceof StdioClientTransport ? transport.pid : null;
        if (process.platform === "win32" && pid) {
          await new Promise<void>((resolve) => execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 3000 }, () => resolve()));
        }
        await closeTransport();
      })();
  let closing: Promise<void> | undefined;
  return {
    client, transport,
    close() {
      return closing ??= (async () => {
        const attached = client.transport === transport;
        await client.close();
        // A factory can be retired before Client.connect attaches the transport.
        if (!attached) await transport.close();
      })();
    },
  };
};
