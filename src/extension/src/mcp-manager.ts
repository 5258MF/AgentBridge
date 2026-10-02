import { createHash } from "node:crypto";
import { CallToolResultSchema, ErrorCode, McpError, ToolListChangedNotificationSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpConnection, type McpConnection, type McpConnectionFactory } from "./mcp-client.js";
import { loadMcpConfiguration, resolveMcpServer, type McpConfigEntry, type McpConfigOptions, type McpPlanPolicy } from "./mcp-config.js";
import { ToolError } from "./tool-errors.js";

const MAX_DISCOVERY_PAGES = 32;
const MAX_DISCOVERED_TOOLS = 1024;
const MAX_INSTRUCTION_CHARS = 16_384;
const MAX_RECONNECT_ATTEMPTS = 5;
const ENABLED_STATE_KEY = "agentbridge.mcp.enabledOverrides";
export type McpConnectionState = "stopped" | "disabled" | "connecting" | "connected" | "reconnecting" | "error" | "invalid" | "untrusted";
export interface ExternalMcpServerStatus {
  name: string;
  source: string;
  scope: "user" | "workspace";
  transport?: "stdio" | "http";
  enabled: boolean;
  state: McpConnectionState;
  toolCount: number;
  planMode?: McpPlanPolicy;
  error?: string;
}
export interface ExternalMcpStatus {
  servers: ExternalMcpServerStatus[];
  errors: string[];
  configPaths: string[];
}
interface ToolRoute { definition: Tool; rawName: string; }
interface Slot {
  entry: McpConfigEntry;
  enabled: boolean;
  state: McpConnectionState;
  generation: number;
  connection?: McpConnection;
  abort?: AbortController;
  ready?: Promise<void>;
  syncing?: Promise<void>;
  syncRequested: boolean;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  attempts: number;
  tools: ToolRoute[];
  instructions: string;
  redact: (value: string) => string;
  error?: string;
}
export interface ExternalMcpManagerOptions {
  discovery(): McpConfigOptions;
  getSecret(key: string): Promise<string | undefined>;
  isTrusted(): boolean;
  state: { get<T>(key: string): T | undefined; update(key: string, value: unknown): PromiseLike<void> };
  onChange(): void;
  log(message: string): void;
  factory?: McpConnectionFactory;
  reconnectDelayMs?: number;
}

export function externalToolName(server: string, raw: string): string {
  const original = `mcp__${server}__${raw}`;
  const normalized = original.replace(/[^a-zA-Z0-9_]/g, "_");
  // Underscores adjacent to, or inside, the separator can make two server/tool
  // pairs produce the same readable name (a + b__c versus a__b + c).
  const ambiguous = server.includes("__") || server.endsWith("_") || raw.startsWith("_") || raw.includes("__");
  if (original === normalized && normalized.length <= 64 && !ambiguous) return normalized;
  const hash = createHash("sha256").update(JSON.stringify([server, raw])).digest("hex").slice(0, 12);
  return `${normalized.slice(0, 51)}_${hash}`;
}

function secretRedactor(secrets: string[]): (value: string) => string {
  const values = [...new Set(secrets.flatMap((value) => [value, ...value.split(/\r\n|\r|\n/).map((line) => line.trim())]))].filter(Boolean).sort((a, b) => b.length - a.length);
  const pattern = values.length ? new RegExp(values.map((value) => value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&")).join("|"), "g") : undefined;
  // One pass also prevents a short credential from matching the replacement marker.
  return (value) => (pattern ? value.replace(pattern, "[redacted]") : value).slice(0, 2000);
}

/** Bounds the entire operation, including helpers that ignore the SDK's abort signal. */
async function withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parent: AbortSignal | undefined, code: string): Promise<T> {
  if (parent?.aborted) throw parent.reason ?? new ToolError("ABORTED", "MCP operation was cancelled.");
  const abort = new AbortController();
  let rejectAbort!: (error: unknown) => void;
  const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    const reason = parent?.reason ?? new ToolError("ABORTED", "MCP operation was cancelled.");
    abort.abort(reason);
    rejectAbort(reason);
  };
  parent?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    const error = new ToolError(code, `MCP operation exceeded ${timeoutMs} ms.`, "Check the server or increase its configured timeout.");
    abort.abort(error);
    rejectAbort(error);
  }, timeoutMs);
  try { return await Promise.race([Promise.resolve().then(() => operation(abort.signal)), cancelled]); }
  finally { clearTimeout(timer); parent?.removeEventListener("abort", onAbort); }
}

export class ExternalMcpManager {
  private readonly slots = new Map<string, Slot>();
  private running = false;
  private disposed = false;
  private lifecycleGeneration = 0;
  private controlQueue: Promise<void> = Promise.resolve();
  private errors: string[] = [];
  private configPaths: string[] = [];
  private enabledOverrides: Record<string, boolean> = {};

  constructor(private readonly options: ExternalMcpManagerOptions) {
    const saved = options.state.get<unknown>(ENABLED_STATE_KEY);
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      this.enabledOverrides = Object.fromEntries(Object.entries(saved).filter(([, value]) => typeof value === "boolean"));
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.controlQueue.then(operation);
    this.controlQueue = result.catch(() => undefined);
    return result;
  }
  private eligible(slot: Slot): boolean {
    return !this.disposed && this.running && this.options.isTrusted() && slot.enabled && !!slot.entry.config && this.slots.get(slot.entry.name) === slot;
  }
  private enabledFor(entry: McpConfigEntry): boolean {
    if (!entry.config) return false;
    return Object.hasOwn(this.enabledOverrides, entry.name) ? this.enabledOverrides[entry.name]! : entry.config.enabled;
  }
  private idleState(entry: McpConfigEntry, enabled: boolean): McpConnectionState {
    return entry.error ? "invalid" : !enabled ? "disabled" : !this.options.isTrusted() ? "untrusted" : "stopped";
  }
  private current(slot: Slot, generation: number): boolean { return this.eligible(slot) && slot.generation === generation; }
  private redact(slot: Slot, value: string): string {
    return slot.redact(value);
  }
  private notify(): void { this.options.onChange(); }
  private report(slot: Slot, error: unknown): string {
    const text = this.redact(slot, error instanceof Error ? error.message : String(error));
    this.options.log(`[mcp:${slot.entry.name}] ${text}`);
    return text;
  }

  async reload(): Promise<void> {
    return this.enqueue(() => this.reloadNow());
  }
  private async reloadNow(): Promise<void> {
    if (this.disposed) return;
    const configuration = await loadMcpConfiguration(this.options.discovery());
    if (this.disposed) return;
    this.errors = configuration.errors;
    this.configPaths = configuration.paths;
    const incoming = new Map(configuration.entries.map((entry) => [entry.name, entry]));
    for (const [name, slot] of this.slots) {
      const entry = incoming.get(name);
      const enabled = entry ? this.enabledFor(entry) : false;
      if (entry && JSON.stringify(entry) === JSON.stringify(slot.entry) && enabled === slot.enabled) {
        incoming.delete(name);
        if (!this.options.isTrusted() && (slot.connection || slot.ready || slot.reconnectTimer)) {
          await this.retire(slot, true);
          slot.state = "untrusted";
        } else if (this.eligible(slot) && !slot.connection && !slot.ready && !slot.reconnectTimer) this.launch(slot);
        else if (!slot.connection && !slot.ready && !slot.reconnectTimer && !this.running) {
          slot.state = this.idleState(entry, enabled);
        }
        continue;
      }
      await this.retire(slot, true);
      this.slots.delete(name);
    }
    for (const entry of incoming.values()) {
      const enabled = this.enabledFor(entry);
      const slot: Slot = { entry, enabled, state: this.idleState(entry, enabled), generation: 0, attempts: 0, tools: [], instructions: "", redact: secretRedactor([]), syncRequested: false, error: entry.error };
      this.slots.set(entry.name, slot);
      if (this.eligible(slot)) this.launch(slot);
    }
    this.notify();
  }

  async start(): Promise<void> {
    if (this.disposed) throw new ToolError("MCP_STOPPED", "MCP connections have been disposed.");
    const generation = ++this.lifecycleGeneration;
    await this.enqueue(async () => {
      if (this.disposed || generation !== this.lifecycleGeneration) return;
      this.running = true;
      await this.reloadNow();
    });
  }
  async stop(): Promise<void> {
    this.lifecycleGeneration += 1;
    this.running = false;
    // Abort immediately, even if an earlier configuration reload is awaiting I/O.
    for (const slot of this.slots.values()) slot.abort?.abort(new ToolError("MCP_DISCONNECTED", "The Bridge stopped the MCP connection."));
    await this.enqueue(async () => {
      await Promise.all([...this.slots.values()].map(async (slot) => {
        await this.retire(slot, true);
        slot.state = this.idleState(slot.entry, slot.enabled);
        slot.attempts = 0;
        slot.error = slot.entry.error;
      }));
      this.notify();
    });
  }
  async dispose(): Promise<void> { this.disposed = true; await this.stop(); }

  private async retire(slot: Slot, clearTools: boolean): Promise<void> {
    slot.generation += 1;
    if (slot.reconnectTimer) clearTimeout(slot.reconnectTimer);
    slot.reconnectTimer = undefined;
    slot.syncing = undefined;
    slot.syncRequested = false;
    slot.abort?.abort(new ToolError("MCP_DISCONNECTED", "The MCP connection was closed."));
    const connection = slot.connection;
    slot.connection = undefined;
    if (clearTools) { slot.tools = []; slot.instructions = ""; }
    const redact = slot.redact;
    if (connection) await connection.close().catch((error) => { this.options.log(`[mcp:${slot.entry.name}] ${redact(error instanceof Error ? error.message : String(error))}`); });
  }
  private launch(slot: Slot): void {
    if (!this.eligible(slot) || slot.ready || slot.connection) return;
    const ready = this.connect(slot);
    slot.ready = ready;
    void ready.finally(() => { if (slot.ready === ready) slot.ready = undefined; }).catch(() => undefined);
  }
  private reconnectLater(slot: Slot, generation: number): void {
    if (!this.eligible(slot) || slot.generation !== generation || slot.reconnectTimer) return;
    if (slot.attempts >= MAX_RECONNECT_ATTEMPTS) { slot.state = "error"; this.notify(); return; }
    slot.state = "reconnecting";
    const delay = Math.min(30_000, (this.options.reconnectDelayMs ?? 1000) * 2 ** slot.attempts++);
    slot.reconnectTimer = setTimeout(() => {
      slot.reconnectTimer = undefined;
      this.launch(slot);
    }, delay);
    slot.reconnectTimer.unref?.();
    this.notify();
  }
  private async disconnectAndRetry(slot: Slot): Promise<void> {
    slot.state = "reconnecting";
    this.notify();
    const retired = this.retire(slot, false);
    const generation = slot.generation;
    await retired;
    this.reconnectLater(slot, generation);
  }

  private async connect(slot: Slot): Promise<void> {
    const config = slot.entry.config!;
    const generation = ++slot.generation;
    const abort = new AbortController();
    slot.abort = abort;
    slot.state = slot.attempts ? "reconnecting" : "connecting";
    slot.error = undefined;
    this.notify();
    try {
      await withDeadline(async (signal) => {
        const resolved = await resolveMcpServer(config, this.options.discovery().homeDir, this.options.getSecret);
        if (signal.aborted || !this.current(slot, generation)) return;
        const redact = secretRedactor(resolved.secrets);
        slot.redact = redact;
        const connection = await (this.options.factory ?? createMcpConnection)(resolved.config, (message) => this.options.log(`[mcp:${config.name}] ${redact(message)}`));
        if (signal.aborted || !this.current(slot, generation)) { await connection.close(); return; }
        slot.connection = connection;
        connection.client.onclose = () => {
          if (!this.current(slot, generation)) return;
          slot.error = "MCP connection closed.";
          void this.disconnectAndRetry(slot);
        };
        connection.client.onerror = (error) => {
          if (!this.current(slot, generation)) return;
          const message = this.report(slot, error);
          if (config.type === "http" && error instanceof StreamableHTTPError && error.code === 404) {
            slot.error = message;
            // Restore subsequent calls; the failed operation is never replayed.
            void this.disconnectAndRetry(slot);
          }
        };
        connection.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
          if (!this.current(slot, generation)) return;
          slot.syncRequested = true;
          return this.sync(slot, generation);
        });
        await connection.client.connect(connection.transport, { signal, timeout: config.connectTimeoutMs, maxTotalTimeout: config.connectTimeoutMs });
        const tools = await this.discover(slot, signal);
        if (signal.aborted || !this.current(slot, generation)) return;
        slot.tools = tools;
        slot.instructions = connection.client.getInstructions()?.slice(0, MAX_INSTRUCTION_CHARS) ?? "";
        slot.state = "connected";
        slot.attempts = 0;
        slot.error = undefined;
        this.notify();
        if (slot.syncRequested) void this.sync(slot, generation);
      }, config.connectTimeoutMs, abort.signal, "MCP_CONNECT_TIMEOUT");
    } catch (error) {
      if (!this.current(slot, generation)) return;
      slot.error = this.report(slot, error);
      await this.disconnectAndRetry(slot);
    }
  }

  private async discover(slot: Slot, signal: AbortSignal): Promise<ToolRoute[]> {
    const config = slot.entry.config!;
    const tools: ToolRoute[] = [];
    if (!slot.connection!.client.getServerCapabilities()?.tools) return tools;
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_DISCOVERY_PAGES; page += 1) {
      const result = await slot.connection!.client.listTools(cursor ? { cursor } : undefined, { signal, timeout: config.connectTimeoutMs, maxTotalTimeout: config.connectTimeoutMs });
      for (const tool of result.tools) {
        if (names.has(tool.name)) throw new Error("MCP server listed a duplicate tool name.");
        names.add(tool.name);
        if (names.size > MAX_DISCOVERED_TOOLS) throw new Error("MCP tool discovery exceeds 1024 tools.");
        if (config.tools && !config.tools.includes(tool.name)) continue;
        const definition: Tool = { ...tool, name: externalToolName(config.name, tool.name) };
        if (config.description) definition.description = `${config.description}\n\n${definition.description ?? ""}`;
        if (tools.some((route) => route.definition.name === definition.name)) throw new Error("MCP tool names collide after normalization.");
        tools.push({ definition, rawName: tool.name });
      }
      cursor = result.nextCursor;
      if (!cursor) return tools.sort((a, b) => a.definition.name.localeCompare(b.definition.name));
      if (cursors.has(cursor)) throw new Error("MCP tool discovery repeated a pagination cursor.");
      cursors.add(cursor);
    }
    throw new Error("MCP tool discovery exceeds 32 pages.");
  }
  private async sync(slot: Slot, generation: number): Promise<void> {
    if (!this.current(slot, generation) || slot.state !== "connected") return;
    if (slot.syncing) return slot.syncing;
    const operation = (async () => {
      do {
        slot.syncRequested = false;
        await withDeadline(async (signal) => {
          const tools = await this.discover(slot, signal);
          if (signal.aborted || !this.current(slot, generation)) return;
          slot.tools = tools;
          slot.error = undefined;
          this.notify();
        }, slot.entry.config!.connectTimeoutMs, slot.abort!.signal, "MCP_CONNECT_TIMEOUT");
      } while (slot.syncRequested && this.current(slot, generation));
    })().catch((error) => {
      if (this.current(slot, generation)) { slot.error = this.report(slot, error); this.notify(); }
    });
    slot.syncing = operation;
    try { await operation; } finally { if (slot.syncing === operation) slot.syncing = undefined; }
  }

  async waitForDiscovery(signal?: AbortSignal): Promise<void> {
    const ready = [...this.slots.values()].flatMap((slot) => slot.ready ? [slot.ready] : []);
    if (!ready.length) return;
    await withDeadline(async () => { await Promise.all(ready); }, 10_000, signal, "MCP_CONNECT_TIMEOUT").catch((error) => {
      if (signal?.aborted) throw error;
      // Native tools remain available while a slower upstream finishes in the background.
    });
  }
  getTools(): Tool[] { return [...this.slots.values()].filter((slot) => slot.enabled).flatMap((slot) => slot.tools.map((route) => route.definition)); }
  getStatus(): ExternalMcpStatus {
    return {
      configPaths: [...this.configPaths], errors: [...this.errors],
      servers: [...this.slots.values()].map((slot) => ({ name: slot.entry.name, source: slot.entry.source, scope: slot.entry.scope, transport: slot.entry.config?.type, enabled: slot.enabled, state: slot.state, toolCount: slot.tools.length, planMode: slot.entry.config?.planMode, error: slot.error })),
    };
  }
  private find(toolName: string): { slot: Slot; route: ToolRoute } | undefined {
    for (const slot of this.slots.values()) {
      const route = slot.tools.find((tool) => tool.definition.name === toolName);
      if (slot.enabled && route) return { slot, route };
    }
    return undefined;
  }
  hasTool(name: string): boolean { return !!this.find(name); }
  instructionsForTool(name: string): { server: string; key: string; text: string } | undefined {
    const found = this.find(name);
    if (!found?.slot.instructions.trim()) return undefined;
    return { server: found.slot.entry.name, key: createHash("sha256").update(found.slot.instructions).digest("hex"), text: found.slot.instructions };
  }
  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal | undefined, readOnly: boolean): Promise<CallToolResult> {
    const found = this.find(name);
    if (!found) throw new ToolError("UNKNOWN_TOOL", `Unknown external MCP tool: ${name}`, "Refresh the client's MCP tool list.");
    const { slot, route } = found;
    if (!this.options.isTrusted()) throw new ToolError("MCP_WORKSPACE_UNTRUSTED", "External MCP servers are unavailable in an untrusted workspace.");
    const policy = slot.entry.config!.planMode;
    if (readOnly && (policy === "disabled" || policy === "read-only" && route.definition.annotations?.readOnlyHint !== true)) throw new ToolError("READ_ONLY_MODE", "This external MCP tool is not allowed in Plan mode.", "Switch to Build mode or configure this server's planMode policy locally.");
    const connection = slot.connection;
    if (slot.state !== "connected" || !connection) throw new ToolError("MCP_DISCONNECTED", `MCP server ${slot.entry.name} is ${slot.state}.`, "Check its status in the AgentBridge panel and reconnect.");
    const abort = new AbortController();
    const onRequestAbort = () => abort.abort(new ToolError("ABORTED", "MCP tool call was cancelled."));
    const onConnectionAbort = () => abort.abort(new ToolError("MCP_DISCONNECTED", "The MCP connection was closed."));
    signal?.addEventListener("abort", onRequestAbort, { once: true });
    slot.abort?.signal.addEventListener("abort", onConnectionAbort, { once: true });
    if (signal?.aborted) onRequestAbort();
    if (slot.abort?.signal.aborted) onConnectionAbort();
    const lifetimeSignal = slot.abort?.signal;
    try {
      const result = await withDeadline((callSignal) => connection.client.callTool({ name: route.rawName, arguments: args }, CallToolResultSchema, { signal: callSignal, timeout: slot.entry.config!.timeoutMs, maxTotalTimeout: slot.entry.config!.timeoutMs, resetTimeoutOnProgress: false }), slot.entry.config!.timeoutMs, abort.signal, "MCP_TIMEOUT");
      return CallToolResultSchema.parse(result);
    } catch (error) {
      if (error instanceof ToolError) throw error;
      const code = error instanceof McpError && error.code === ErrorCode.RequestTimeout ? "MCP_TIMEOUT" : "MCP_CALL_FAILED";
      throw new ToolError(code, this.report(slot, error), "Inspect the server in the AgentBridge panel. Failed tool calls are not automatically retried.");
    } finally {
      signal?.removeEventListener("abort", onRequestAbort);
      lifetimeSignal?.removeEventListener("abort", onConnectionAbort);
    }
  }

  async reconnect(name: string): Promise<void> {
    return this.enqueue(async () => {
      const slot = this.slots.get(name);
      if (!slot?.entry.config) throw new ToolError("MCP_CONFIG_ERROR", "Unknown or invalid MCP server.");
      const ready = slot.ready;
      await this.retire(slot, false);
      await ready;
      slot.attempts = 0;
      slot.state = this.idleState(slot.entry, slot.enabled);
      if (this.eligible(slot)) this.launch(slot);
      this.notify();
    });
  }
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    await this.enqueue(async () => {
      if (!this.slots.get(name)?.entry.config) throw new ToolError("MCP_CONFIG_ERROR", "Unknown or invalid MCP server.");
      const previous = this.enabledOverrides;
      const next = { ...previous, [name]: enabled };
      try { await this.options.state.update(ENABLED_STATE_KEY, next); }
      catch (error) {
        await Promise.resolve(this.options.state.update(ENABLED_STATE_KEY, previous)).catch(() => undefined);
        throw new ToolError("MCP_CONFIG_SAVE_FAILED", "Could not save the server's enabled state.");
      }
      this.enabledOverrides = next;
    });
    await this.reload();
  }

  async credentialChanged(name: string): Promise<void> {
    for (const slot of this.slots.values()) {
      if (slot.entry.config && JSON.stringify(slot.entry.config).includes("${secret:" + name + "}")) await this.reconnect(slot.entry.name);
    }
  }
}
