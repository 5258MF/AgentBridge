import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { isIPv4 } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, type CallToolResult, isInitializeRequest, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as vscode from "vscode";
import { invokeFileTool, isFileToolName } from "./file-tool-registry.js";
import { BRIDGE_EXCLUDED_TOOL_NAMES, getIdeToolDefinition } from "./ide-tool-definitions.js";
import { getManagedShellChoice } from "./ide-tool-broker.js";
import { managedShellExecutable, managedShellOverrideWarning } from "./ide-tool-broker.js";
import type { IdeToolBroker } from "./ide-tool-broker.js";
import { translate } from "./i18n.js";
import { formatSetTodosResult } from "./todo-format.js";
import { formatToolError, ToolError } from "./tool-errors.js";
import { asRecord, bridgePresentation, type BridgeActivity, type BridgeActivityPresentation, type BridgeTodo } from "./activity-presentation.js";
import { BoundedInMemoryEventStore, constantTimeStringEqual, readJsonBody, readTrustedBrowserOrigins, validateMcpOrigin, writeJsonError } from "./http-helpers.js";
import {
  BRIDGE_TOOL_DEFINITIONS,
  buildReadOnlySessionNotice,
  buildReadOnlyTransitionNotice,
  buildServerInstructions,
  MAX_TODOS,
  planModeBlockError,
  REPORT_PROGRESS_TOOL,
  SET_TODOS_TOOL,
} from "./server-instructions.js";
import {
  appendCloudflaredDiagnosticOutput,
  cloudflaredFirstQuicFailureAt,
  cloudflaredLogTail,
  cloudflaredPrecheckFailureKind,
  cloudflaredQuicDialFailures,
  cloudflaredQuicFailedBeforeRegistration,
  cloudflaredQuicUnstable,
  cloudflaredSawRegistration,
  createCloudflaredProcessDiagnostics,
  createRepeatedMessageThrottle,
  flushCloudflaredDiagnosticOutput,
  QUIC_UNSTABLE_DIAL_FAILURES,
  type CloudflaredPrecheckFailureKind,
  type CloudflaredProcessDiagnostics,
} from "./cloudflared-diagnostics.js";

const execFileAsync = promisify(execFile);
const t = translate;

function isPublicIpv4Address(value: string): boolean {
  if (!isIPv4(value)) return false;
  const [a, b, c] = value.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}
const ROUTE_TOKEN_SECRET = "agentbridge.bridge.routeToken";
const NGROK_DOMAIN_SETTING = "bridge.ngrokDomain";
const NGROK_DOMAIN_STATE_KEY = "agentbridge.bridge.ngrokDomain";
const CLOUDFLARE_NAMED_DOMAIN_SETTING = "bridge.cloudflareNamedDomain";
const CLOUDFLARE_NAMED_DOMAIN_STATE_KEY = "agentbridge.bridge.cloudflareNamedDomain";
const CLOUDFLARE_NAMED_TOKEN_SECRET = "agentbridge.bridge.cloudflareNamedTunnelToken";
const CLOUDFLARE_NAMED_LOCAL_PORT_SETTING = "bridge.cloudflareNamedLocalPort";
const TUNNEL_PROVIDER_SETTING = "bridge.tunnelProvider";
const TUNNEL_PROTOCOL_SETTING = "bridge.tunnelProtocol";
const MAX_ACTIVITY = 60;
/** Idle sessions are retained long enough for ChatGPT to pause and resume without being forced to reinitialize. */
const SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const SESSION_PRUNE_INTERVAL_MS = 60_000;
const MAX_SESSIONS = 64;
/** Explicitly pin transport behavior instead of depending on SDK defaults. */
const SESSION_KEEPALIVE_INTERVAL_MS = 15_000;
const SESSION_RETRY_INTERVAL_MS = 2_000;
const PUBLIC_HEALTH_STARTUP_TIMEOUT_MS = 60_000;
const PUBLIC_HEALTH_REQUEST_TIMEOUT_MS = 5_000;
const PUBLIC_HEALTH_LOG_THROTTLE_MS = 10_000;
const PUBLIC_HEALTH_MONITOR_INTERVAL_MS = 10_000;
const PUBLIC_HEALTH_MONITOR_BUDGET_MS = 8_000;
const PUBLIC_HEALTH_UNHEALTHY_FAILURES = 2;
const HTTP_SERVER_SHUTDOWN_TIMEOUT_MS = 3_000;
const CLOUDFLARED_PRECHECK_DETAIL_GRACE_MS = 100;
/** Grace after the first QUIC connection failure before the "QUIC unstable" early
 * abort fires. cloudflared's reconnect backoff (2s+4s) lands its third dial
 * attempt ~6s in, so the window deliberately outlives it: a transient network
 * recovers and registers inside the grace period — and any registration
 * immediately clears the unstable verdict — while genuinely UDP-hostile
 * networks keep failing and are self-healed at ~first-failure+10s instead of
 * burning the full 60s health budget. */
const QUIC_UNSTABLE_GRACE_MS = 10_000;
/** DoH endpoints used as a DNS fallback when the system resolver cannot
 * resolve the tunnel hostname (campus/corporate DNS often fails on
 * *.trycloudflare.com wildcard subdomains). Only the hostname is sent,
 * never the URL path, so the route token is not exposed. */
const PUBLIC_HEALTH_DOH_ENDPOINTS = [
  // Cloudflare's own resolver first: zero propagation lag for its own
  // *.trycloudflare.com zone, which third-party recursives may lag on.
  "https://cloudflare-dns.com/dns-query",
  "https://dns.alidns.com/resolve",
  "https://doh.pub/dns-query",
] as const;
const PUBLIC_HEALTH_DOH_CACHE_TTL_MS = 60_000;
/** Pinned Cloudflare anycast IPs serving *.trycloudflare.com, used only as a
 * last resort for Quick Tunnels when every DoH endpoint fails (e.g. the
 * account-less control plane lagging behind its own DNS record creation).
 * Cloudflare's edge routes by Host header and TLS stays validated against the
 * real hostname, so a stale IP fails safe. Two IPs to avoid a single point of
 * failure; values observed from historical successful resolutions. */
const PUBLIC_HEALTH_CF_ANYCAST_IPS = ["104.16.230.132", "104.16.231.132"] as const;
const TUNNEL_RESTART_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
const CLOUDFLARED_WINGET_PACKAGE = "Cloudflare.cloudflared";
const DEFAULT_CLOUDFLARE_NAMED_LOCAL_PORT = 48271;

export type BridgeTunnelProvider = "cloudflare" | "cloudflare-named" | "ngrok";
export type BridgePublicHealthState = "inactive" | "checking" | "healthy" | "unstable" | "unhealthy";

/** cloudflared transport protocol between the local daemon and Cloudflare's edge.
 * "auto" keeps cloudflared's own QUIC-first behavior; "quic"/"http2" pin the
 * transport explicitly via the --protocol CLI flag. */
export type BridgeTunnelProtocol = "auto" | "quic" | "http2";
export type CloudflaredInstaller = "winget" | "homebrew" | "manual";
export type CloudflaredInstallerAvailability = "unchecked" | "available" | "unavailable" | "manual-only";
export type CloudflaredInstallResultCode =
  | "success"
  | "installer-unavailable"
  | "permission-denied"
  | "cancelled"
  | "command-failed"
  | "verification-failed";

export interface CloudflaredInstallResult {
  readonly code: CloudflaredInstallResultCode;
  readonly installer: CloudflaredInstaller;
  readonly version?: string;
}

export interface BridgeStartOptions {
  readonly automaticCheck?: boolean;
}

export class CloudflaredInstallError extends Error {
  constructor(
    message: string,
    readonly result: CloudflaredInstallResult,
  ) {
    super(message);
    this.name = "CloudflaredInstallError";
  }
}

export class BridgeStartCancelledError extends Error {
  constructor() {
    super("Bridge start was cancelled by a newer lifecycle operation.");
    this.name = "BridgeStartCancelledError";
  }
}

/** Thrown out of waitForPublicHealth when cloudflared shows the "QUIC
 * unstable" signature (repeated live failures or a failed process exit,
 * always with zero registrations).
 * startTunnelOnce catches it once per bridge session and retries the tunnel
 * with an explicit http2 transport instead of burning the whole health budget. */
export class BridgeQuicUnstableError extends Error {
  constructor() {
    super("cloudflared could not sustain QUIC connections to the Cloudflare edge.");
    this.name = "BridgeQuicUnstableError";
  }
}

function platformCloudflaredInstaller(): CloudflaredInstaller {
  return process.platform === "win32" ? "winget" : process.platform === "darwin" ? "homebrew" : "manual";
}

function initialCloudflaredInstallerAvailability(): CloudflaredInstallerAvailability {
  return process.platform === "win32" || process.platform === "darwin" ? "unchecked" : "manual-only";
}

type ProcessExecutionError = Error & {
  code?: string | number;
  signal?: string;
  killed?: boolean;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

function processExecutionDetails(error: unknown): string {
  const details = error as ProcessExecutionError;
  return [details.message, String(details.stdout ?? "").trim(), String(details.stderr ?? "").trim()].filter(Boolean).join("\n");
}

function classifyCloudflaredInstallFailure(error: unknown): Exclude<CloudflaredInstallResultCode, "success" | "installer-unavailable" | "verification-failed"> {
  const details = error as ProcessExecutionError;
  const combined = processExecutionDetails(error).toLowerCase();
  const code = String(details.code ?? "").toLowerCase();
  const signal = String(details.signal ?? "").toUpperCase();
  if (code === "etimedout" || combined.includes("timed out") || (details.killed === true && signal === "SIGTERM")) {
    return "command-failed";
  }
  if (
    signal === "SIGINT"
    || signal === "SIGTERM"
    || code === "abort_err"
    || code === "1223"
    || combined.includes("0x800704c7")
    || /\b(cancelled|canceled|user declined)\b|已取消|取消安装/.test(combined)
  ) {
    return "cancelled";
  }
  if (
    code === "eacces"
    || code === "eperm"
    || /permission denied|access is denied|operation not permitted|administrator privileges|requires elevation|拒绝访问|权限不足|需要管理员权限/.test(combined)
  ) {
    return "permission-denied";
  }
  return "command-failed";
}


export interface BridgeStatus {
  readonly state: "stopped" | "starting" | "running" | "error";
  readonly transport: "streamable-http";
  readonly tunnelProvider: BridgeTunnelProvider;
  readonly domain: string;
  readonly configuredDomain: string;
  readonly configuredNamedDomain: string;
  readonly namedTunnelTokenConfigured: boolean;
  readonly namedTunnelLocalPort: number;
  readonly namedTunnelOriginUrl: string;
  readonly localUrl?: string;
  readonly publicUrl?: string;
  readonly localPort?: number;
  readonly tunnelChecking: boolean;
  readonly tunnelChecked: boolean;
  readonly cloudflaredInstalling: boolean;
  readonly cloudflaredInstaller: CloudflaredInstaller;
  readonly cloudflaredInstallerAvailability: CloudflaredInstallerAvailability;
  readonly lastCloudflaredInstallResult?: CloudflaredInstallResult;
  readonly tunnelInstalled?: boolean;
  readonly tunnelVersion?: string;
  readonly tunnelConfigValid?: boolean;
  readonly lastError?: string;
  readonly publicHealthState: BridgePublicHealthState;
  readonly publicHealthAvailable: boolean;
  readonly publicHealthAutomatic: boolean;
  readonly publicHealthChecking: boolean;
  readonly publicHealthFailureCount: number;
  readonly publicHealthLastCheckedAt?: string;
  readonly publicHealthLastSuccessAt?: string;
  readonly publicHealthError?: string;
  readonly toolNames: string[];
  readonly toolCount: number;
  readonly activeRequests: number;
  readonly connected: boolean;
  readonly revision: number;
  readonly stats: {
    readonly toolCalls: number;
    readonly completedToolCalls: number;
    readonly failedToolCalls: number;
    readonly averageDurationMs: number;
    readonly successRate: number;
    readonly lastTool?: string;
    readonly lastToolAt?: string;
  };
  readonly todos: BridgeTodo[];
  readonly activities: BridgeActivity[];
  readonly sessionCount: number;
  readonly sessions: ReadonlyArray<{
    readonly sessionId: string;
    readonly lastActivity: string;
    readonly activeRequests: number;
    readonly activeStreams: number;
  }>;
  /**
   * The shell executable that the next set of AgentBridge managed terminals
   * will spawn. Reflects the effective choice after applying override config
   * and any hard fallback. Used by the panel to surface the current shell to
   * the user via the "管理 Shell" entry in the advanced card.
   */
  readonly managedShellPath: string;
  /**
   * Non-null when the user-configured override in
   * `agentbridge.bridge.managedShell.{windows,unix}` could not be applied
   * (missing path, non-launchable binary, etc). AgentBridge silently fell
   * back to the default shell; the panel shows the warning in red so the
   * user knows the override is inert and can correct it.
   */
   readonly managedShellOverrideWarning: string | null;
  /**
   * How external URL clicks in the AgentBridge panel are routed.
   * - "auto": ChatGPT/arena.ai → VS Code Simple Browser; others → OS default browser
   * - "all": every external URL → VS Code Simple Browser (Cloudflare/ngrok OAuth may break in iframe)
   * - "external": every external URL → OS default browser (legacy fallback)
   * Set by `agentbridge.bridge.openInternalBrowser`; read fresh by the panel and the openExternal
   * handler at request time — no cache, so changes apply immediately without `onDidChangeConfiguration`.
   */
  readonly openInternalBrowser: "auto" | "all" | "external";
  /**
   * cloudflared ↔ Cloudflare edge transport protocol, read fresh from
   * `agentbridge.bridge.tunnelProtocol` on every getStatus() call (same
   * no-cache pattern as openInternalBrowser). Rendered by the panel's
   * Tunnel Transport radio group in the advanced settings card.
   */
  readonly tunnelProtocol: "auto" | "quic" | "http2";
  /**
   * When true, tools that modify the local environment (apply_patch,
   * run_command, send_command_input, terminate_command) are hidden from
   * tools/list and hard-blocked at call time. Backed by
   * `agentbridge.bridge.readOnlyMode` (application scope so workspace
   * settings cannot override it).
   */
  readonly readOnlyMode: boolean;
}


interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
  activeRequests: number;
  activeStreams: number;
  /**
   * Read-only state the model was last told about: the mode baked into this session's
   * instructions, then updated whenever a transition notice is delivered in a tool result.
   */
  toldReadOnly?: boolean;
  /**
   * True for a session created while read-only mode was active, until its first tool call.
   * That call repeats the read-only guidance in its result, because clients may not show
   * server instructions to the model (for example after reconnecting mid-conversation).
   */
  firstCallReminderPending?: boolean;
}


function normalizeHttpsHostname(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`${label} is not a valid hostname.`);
  }
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS.`);
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password || url.port) {
    throw new Error(`Enter only the ${label.toLowerCase()}, without a path, query, port, username, or password.`);
  }
  return url.hostname.toLowerCase();
}

function normalizeNgrokDomain(value: string): string {
  return normalizeHttpsHostname(value, "ngrok reserved domain");
}

function normalizeCloudflareNamedDomain(value: string): string {
  return normalizeHttpsHostname(value, "Cloudflare Named Tunnel hostname");
}

function normalizeNamedTunnelLocalPort(value: number): number {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error("Cloudflare Named Tunnel local port must be an integer from 1024 to 65535.");
  }
  return value;
}


function cancellationFromAbortSignal(signal: AbortSignal | undefined): { token?: vscode.CancellationToken; dispose(): void } {
  if (!signal) return { token: undefined, dispose: () => undefined };
  const source = new vscode.CancellationTokenSource();
  const listener = () => source.cancel();
  if (signal.aborted) source.cancel();
  else signal.addEventListener("abort", listener, { once: true });
  return {
    token: source.token,
    dispose: () => {
      signal.removeEventListener("abort", listener);
      source.dispose();
    },
  };
}

export class BridgeManager implements vscode.Disposable {
  private state: BridgeStatus["state"] = "stopped";
  private tunnelProvider: BridgeTunnelProvider = "cloudflare";
  /** Sticky http2 fallback: while the setting remains "auto", a QUIC-unstable
   * tunnel and its automatic reconnects use http2 until the next manual start.
   * A newly selected explicit protocol always takes precedence. */
  private tunnelTransportFallback: BridgeTunnelProtocol | undefined;
  /** Children already handed to killTunnelProcess. The guard must be a
   * WeakSet rather than child.killed alone: taskkill terminates the process
   * externally, so child.killed stays false and cannot prevent duplicate
   * taskkill runs on the same (dead) PID. */
  private readonly killRequested = new WeakSet<ChildProcessWithoutNullStreams>();
  private domain = "";
  private configuredDomain = "";
  private configuredNamedDomain = "";
  private namedTunnelToken = "";
  private namedTunnelLocalPort = DEFAULT_CLOUDFLARE_NAMED_LOCAL_PORT;
  private routeToken = "";
  private readOnlyMode = false;
  private readonly sessions = new Map<string, McpSession>();
  private pendingInitializations = 0;
  private httpServer: HttpServer | undefined;
  private tunnelProcess: ChildProcessWithoutNullStreams | undefined;
  private localPort: number | undefined;
  private lastError: string | undefined;
  private tunnelInstalled: boolean | undefined;
  private tunnelVersion: string | undefined;
  private tunnelConfigValid: boolean | undefined;
  private cloudflaredExecutable = "cloudflared";
  private cloudflaredInstaller: CloudflaredInstaller = platformCloudflaredInstaller();
  private cloudflaredInstallerAvailability: CloudflaredInstallerAvailability = initialCloudflaredInstallerAvailability();
  private cloudflaredInstallerExecutable: string | undefined;
  private lastCloudflaredInstallResult: CloudflaredInstallResult | undefined;
  private tunnelChecked = false;
  private activeRequests = 0;
  private readonly activities: BridgeActivity[] = [];
  private todos: BridgeTodo[] = [];
  private nextActivityId = 1;
  private revision = 0;
  private toolCalls = 0;
  private completedToolCalls = 0;
  private failedToolCalls = 0;
  private totalToolDurationMs = 0;
  private lastTool: string | undefined;
  private lastToolAt: string | undefined;
  private startPromise: Promise<BridgeStatus> | undefined;
  private startPromiseGeneration: number | undefined;
  private stopPromise: Promise<void> | undefined;
  private stopMarkStoppedRequested = false;
  private tunnelCheckPromise: Promise<BridgeStatus> | undefined;
  private tunnelCheckPromiseGeneration: number | undefined;
  private tunnelCheckAbort: AbortController | undefined;
  private installCloudflaredPromise: Promise<BridgeStatus> | undefined;
  private sessionPruneTimer: ReturnType<typeof setInterval> | undefined;
  private tunnelRecoveryPromise: Promise<void> | undefined;
  private tunnelRecoveryGeneration: number | undefined;
  private tunnelRecoveryAbort: AbortController | undefined;
  private publicHealthState: BridgePublicHealthState = "inactive";
  private publicHealthChecking = false;
  private publicHealthFailureCount = 0;
  private publicHealthLastCheckedAt: number | undefined;
  private publicHealthLastSuccessAt: number | undefined;
  private publicHealthError: string | undefined;
  private publicHealthMonitorTimer: ReturnType<typeof setTimeout> | undefined;
  private publicHealthMonitorTimerGeneration: number | undefined;
  private publicHealthMonitorPromise: Promise<void> | undefined;
  private publicHealthMonitorPromiseGeneration: number | undefined;
  private publicHealthMonitorAbort: AbortController | undefined;
  private tunnelGeneration = 0;
  private stoppingResources = false;
  private disposed = false;
  private readonly cloudflaredProcessDiagnostics = new WeakMap<ChildProcessWithoutNullStreams, CloudflaredProcessDiagnostics>();
  private readonly tunnelProcessLifecycles = new WeakMap<ChildProcessWithoutNullStreams, {
    readonly closed: Promise<void>;
    readonly exitSignal: AbortSignal;
    readonly abort: () => void;
    isClosed: boolean;
  }>();
  private readonly httpServerClosePromises = new WeakMap<HttpServer, Promise<void>>();
  private readonly httpServersThatListened = new WeakSet<HttpServer>();
  private readonly httpServersThatFailedToListen = new WeakSet<HttpServer>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly ideToolBroker: IdeToolBroker,
  ) {}

  private isTunnelProcessAlive(): boolean {
    const child = this.tunnelProcess;
    if (!child || child.exitCode !== null || child.signalCode !== null) return false;
    return this.tunnelProcessLifecycles.get(child)?.isClosed !== true;
  }

  async initialize(): Promise<void> {
    this.routeToken = await this.context.secrets.get(ROUTE_TOKEN_SECRET) ?? "";
    if (!this.routeToken) {
      this.routeToken = randomBytes(16).toString("hex");
      await this.context.secrets.store(ROUTE_TOKEN_SECRET, this.routeToken);
    }
    this.tunnelProvider = this.readTunnelProvider();
    this.readOnlyMode = this.readReadOnlyMode();
    this.namedTunnelToken = await this.context.secrets.get(CLOUDFLARE_NAMED_TOKEN_SECRET) ?? "";
    this.namedTunnelLocalPort = this.readNamedTunnelLocalPort();
    await this.restorePersistedDomain();
    await this.restorePersistedNamedDomain();
    this.domain = this.configuredDomainForProvider(this.tunnelProvider);
  }

  getStatus(): BridgeStatus {
    if (
      this.state !== "running"
      && this.state !== "starting"
      && !this.tunnelCheckPromise
      && !this.installCloudflaredPromise
    ) {
      const previousProvider = this.tunnelProvider;
      const previousNamedDomain = this.configuredNamedDomain;
      const previousNamedLocalPort = this.namedTunnelLocalPort;
      this.tunnelProvider = this.readTunnelProvider();
      this.restoreConfiguredDomain();
      this.restoreConfiguredNamedDomain();
      this.namedTunnelLocalPort = this.readNamedTunnelLocalPort();
      this.domain = this.configuredDomainForProvider(this.tunnelProvider);
      const providerChanged = previousProvider !== this.tunnelProvider;
      const namedConfigurationChanged = this.tunnelProvider === "cloudflare-named"
        && (previousNamedDomain !== this.configuredNamedDomain || previousNamedLocalPort !== this.namedTunnelLocalPort);
      if (providerChanged || namedConfigurationChanged) {
        this.tunnelChecked = false;
        this.tunnelInstalled = providerChanged ? undefined : this.tunnelInstalled;
        this.tunnelVersion = providerChanged ? undefined : this.tunnelVersion;
        this.tunnelConfigValid = undefined;
        this.lastError = undefined;
      }
    }
    const localUrl = this.localPort && this.routeToken ? `http://127.0.0.1:${this.localPort}/mcp/${this.routeToken}` : undefined;
    const publicUrl = this.domain && this.routeToken ? `https://${this.domain}/mcp/${this.routeToken}` : undefined;
    const visibleToolNames = BRIDGE_TOOL_DEFINITIONS.map((tool) => tool.name);
    return {
      state: this.state,
      transport: "streamable-http",
      tunnelProvider: this.tunnelProvider,
      domain: this.domain,
      configuredDomain: this.configuredDomain,
      configuredNamedDomain: this.configuredNamedDomain,
      namedTunnelTokenConfigured: Boolean(this.namedTunnelToken),
      namedTunnelLocalPort: this.namedTunnelLocalPort,
      namedTunnelOriginUrl: `http://127.0.0.1:${this.namedTunnelLocalPort}`,
      localUrl,
      publicUrl,
      localPort: this.localPort,
      tunnelChecking: Boolean(this.tunnelCheckPromise),
      tunnelChecked: this.tunnelChecked,
      cloudflaredInstalling: Boolean(this.installCloudflaredPromise),
      cloudflaredInstaller: this.cloudflaredInstaller,
      cloudflaredInstallerAvailability: this.cloudflaredInstallerAvailability,
      lastCloudflaredInstallResult: this.lastCloudflaredInstallResult,
      tunnelInstalled: this.tunnelInstalled,
      tunnelVersion: this.tunnelVersion,
      tunnelConfigValid: this.tunnelConfigValid,
      lastError: this.lastError,
      publicHealthState: this.publicHealthState,
      publicHealthAvailable: !this.disposed && !this.stoppingResources && this.state === "running" && this.isTunnelProcessAlive() && Boolean(this.domain),
      publicHealthAutomatic: !this.disposed && !this.stoppingResources && this.state === "running" && this.tunnelProvider !== "ngrok" && this.isTunnelProcessAlive() && Boolean(this.domain),
      publicHealthChecking: this.publicHealthChecking,
      publicHealthFailureCount: this.publicHealthFailureCount,
      publicHealthLastCheckedAt: this.publicHealthLastCheckedAt !== undefined ? new Date(this.publicHealthLastCheckedAt).toISOString() : undefined,
      publicHealthLastSuccessAt: this.publicHealthLastSuccessAt !== undefined ? new Date(this.publicHealthLastSuccessAt).toISOString() : undefined,
      publicHealthError: this.publicHealthError,
      toolNames: visibleToolNames,
      toolCount: visibleToolNames.length,
      activeRequests: this.activeRequests,
      connected: this.sessions.size > 0,
      revision: this.revision,
      stats: {
        toolCalls: this.toolCalls,
        completedToolCalls: this.completedToolCalls,
        failedToolCalls: this.failedToolCalls,
        averageDurationMs: this.completedToolCalls > 0 ? Math.round(this.totalToolDurationMs / this.completedToolCalls) : 0,
        successRate: this.completedToolCalls > 0 ? ((this.completedToolCalls - this.failedToolCalls) / this.completedToolCalls) * 100 : 100,
        lastTool: this.lastTool,
        lastToolAt: this.lastToolAt,
      },
      todos: this.todos.map((todo) => ({ ...todo })),
      activities: this.activities.slice(-MAX_ACTIVITY),
      sessionCount: this.sessions.size,
      sessions: Array.from(this.sessions.entries()).map(([sessionId, session]) => ({
        sessionId,
        lastActivity: new Date(session.lastActivity).toISOString(),
        activeRequests: session.activeRequests,
        activeStreams: session.activeStreams,
      })),
      managedShellPath: managedShellExecutable(),
      managedShellOverrideWarning: managedShellOverrideWarning(),
      openInternalBrowser: vscode.workspace.getConfiguration("agentbridge.bridge").get<"auto" | "all" | "external">("openInternalBrowser", "auto"),
      tunnelProtocol: this.readTunnelProtocol(),
      readOnlyMode: this.readOnlyMode,
    };
  }

  private readConfiguredDomain(): string {
    return vscode.workspace.getConfiguration("agentbridge").get<string>(NGROK_DOMAIN_SETTING, "").trim();
  }

  private readConfiguredNamedDomain(): string {
    return vscode.workspace.getConfiguration("agentbridge").get<string>(CLOUDFLARE_NAMED_DOMAIN_SETTING, "").trim();
  }

  private readNamedTunnelLocalPort(): number {
    const value = vscode.workspace.getConfiguration("agentbridge").get<number>(CLOUDFLARE_NAMED_LOCAL_PORT_SETTING, DEFAULT_CLOUDFLARE_NAMED_LOCAL_PORT);
    try {
      return normalizeNamedTunnelLocalPort(value);
    } catch {
      return DEFAULT_CLOUDFLARE_NAMED_LOCAL_PORT;
    }
  }

  private configuredDomainForProvider(provider: BridgeTunnelProvider): string {
    return provider === "ngrok" ? this.configuredDomain : provider === "cloudflare-named" ? this.configuredNamedDomain : "";
  }

  private readTunnelProvider(): BridgeTunnelProvider {
    const provider = vscode.workspace.getConfiguration("agentbridge").get<BridgeTunnelProvider>(TUNNEL_PROVIDER_SETTING, "cloudflare");
    return provider === "ngrok" || provider === "cloudflare-named" ? provider : "cloudflare";
  }

  /** Read the configured cloudflared transport protocol. Unknown values are
   * clamped to "auto" so a hand-edited settings.json can never break spawns. */
  private readTunnelProtocol(): BridgeTunnelProtocol {
    const protocol = vscode.workspace.getConfiguration("agentbridge").get<BridgeTunnelProtocol>(TUNNEL_PROTOCOL_SETTING, "auto");
    return protocol === "quic" || protocol === "http2" ? protocol : "auto";
  }

  private readReadOnlyMode(): boolean {
    return vscode.workspace.getConfiguration("agentbridge.bridge").get<boolean>("readOnlyMode", false);
  }

  /**
   * Every Bridge start begins in Build mode (read-only off), the mode the user most likely
   * expects from a fresh connection. Only start() reaches this (Start button, persistent auto-start, command);
   * automatic tunnel recovery restarts the tunnel directly and keeps the current mode.
   */
  private async resetToBuildModeForStart(): Promise<void> {
    if (!this.readOnlyMode && !this.readReadOnlyMode()) return;
    this.setReadOnlyMode(false);
    try {
      await vscode.workspace.getConfiguration("agentbridge.bridge").update("readOnlyMode", false, vscode.ConfigurationTarget.Global);
    } catch (error) {
      this.output.appendLine(`[bridge] could not persist Build mode on start: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.output.appendLine("[bridge] start: Build mode (read-only off)");
  }

  /**
   * Hot-apply Plan mode (read-only mode) without restarting the Bridge. tools/list is the same
   * in both modes; the call-time checks in executeToolCall enforce the mode, and each session's
   * next tool result carries a one-time notice (takeReadOnlyTransitionNotice), so switching is
   * safe at any time and clients never need to refresh their tool list.
   */
  setReadOnlyMode(enabled: boolean): void {
    // Both the panel handler and the configuration listener call this for one toggle;
    // the repeat is a no-op so it does not log twice.
    if (this.readOnlyMode === enabled) return;
    this.readOnlyMode = enabled;
    this.output.appendLine(`[bridge] read-only mode ${enabled ? "enabled" : "disabled"}`);
  }

  private readPersistedDomain(): string {
    return this.context.globalState.get<string>(NGROK_DOMAIN_STATE_KEY, "").trim();
  }

  private readPersistedNamedDomain(): string {
    return this.context.globalState.get<string>(CLOUDFLARE_NAMED_DOMAIN_STATE_KEY, "").trim();
  }

  /**
   * Restore the Bridge domain from either VS Code configuration or the extension's own
   * persistent memento. The memento is intentionally a second source of truth because
   * carrier/user-data migrations can temporarily present an empty configuration value on
   * startup. Whichever store still has the domain repairs the other one.
   */
  private async restorePersistedDomain(): Promise<void> {
    const configured = this.readConfiguredDomain();
    const persisted = this.readPersistedDomain();
    const candidate = configured || persisted;
    if (!candidate) return;

    this.configuredDomain = normalizeNgrokDomain(candidate);
    if (persisted !== this.configuredDomain) {
      await this.context.globalState.update(NGROK_DOMAIN_STATE_KEY, this.configuredDomain);
    }
    if (configured !== this.configuredDomain) {
      try {
        await vscode.workspace.getConfiguration("agentbridge").update(NGROK_DOMAIN_SETTING, this.configuredDomain, vscode.ConfigurationTarget.Global);
      } catch (error) {
        this.output.appendLine(`[bridge] could not repair ngrok domain setting: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private restoreConfiguredDomain(): void {
    const candidate = this.readConfiguredDomain() || this.readPersistedDomain();
    if (!candidate) return;
    try {
      this.configuredDomain = normalizeNgrokDomain(candidate);
    } catch {
      // Keep the last known-good in-memory value. Invalid external settings should not erase it.
    }
  }

  private async persistDomain(domain: string): Promise<void> {
    this.configuredDomain = normalizeNgrokDomain(domain);
    if (this.tunnelProvider === "ngrok") this.domain = this.configuredDomain;

    // Persist to the extension memento first so a configuration write failure cannot make the
    // domain disappear after a restart.
    await this.context.globalState.update(NGROK_DOMAIN_STATE_KEY, this.configuredDomain);
    try {
      await vscode.workspace.getConfiguration("agentbridge").update(NGROK_DOMAIN_SETTING, this.configuredDomain, vscode.ConfigurationTarget.Global);
    } catch (error) {
      this.output.appendLine(`[bridge] ngrok domain saved to extension state, but settings.json update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async configure(domain: string): Promise<BridgeStatus> {
    if (this.tunnelCheckPromise) throw new Error(t("tunnelCheckBusy"));
    if (this.state === "running" || this.state === "starting") {
      throw new Error("Stop the Bridge before changing its ngrok domain.");
    }
    await this.persistDomain(domain);
    this.tunnelChecked = false;
    this.lastError = undefined;
    return this.getStatus();
  }

  private async restorePersistedNamedDomain(): Promise<void> {
    const configured = this.readConfiguredNamedDomain();
    const persisted = this.readPersistedNamedDomain();
    const candidate = configured || persisted;
    if (!candidate) return;

    this.configuredNamedDomain = normalizeCloudflareNamedDomain(candidate);
    if (persisted !== this.configuredNamedDomain) {
      await this.context.globalState.update(CLOUDFLARE_NAMED_DOMAIN_STATE_KEY, this.configuredNamedDomain);
    }
    if (configured !== this.configuredNamedDomain) {
      try {
        await vscode.workspace.getConfiguration("agentbridge").update(CLOUDFLARE_NAMED_DOMAIN_SETTING, this.configuredNamedDomain, vscode.ConfigurationTarget.Global);
      } catch (error) {
        this.output.appendLine(`[bridge] could not repair Cloudflare Named Tunnel hostname setting: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private restoreConfiguredNamedDomain(): void {
    const candidate = this.readConfiguredNamedDomain() || this.readPersistedNamedDomain();
    if (!candidate) return;
    try {
      this.configuredNamedDomain = normalizeCloudflareNamedDomain(candidate);
    } catch {
      // Keep the last known-good in-memory value. Invalid external settings should not erase it.
    }
  }

  async configureNamedTunnel(input: { domain: string; token?: string; localPort: number }): Promise<BridgeStatus> {
    if (this.tunnelCheckPromise) throw new Error(t("tunnelCheckBusy"));
    if (this.state === "running" || this.state === "starting") {
      throw new Error("Stop the Bridge before changing its Cloudflare Named Tunnel configuration.");
    }
    const domain = normalizeCloudflareNamedDomain(input.domain);
    const localPort = normalizeNamedTunnelLocalPort(input.localPort);
    const token = input.token?.trim();
    if (token !== undefined && !token) throw new Error("Cloudflare Tunnel Token cannot be empty.");

    this.configuredNamedDomain = domain;
    this.namedTunnelLocalPort = localPort;
    await this.context.globalState.update(CLOUDFLARE_NAMED_DOMAIN_STATE_KEY, domain);
    await vscode.workspace.getConfiguration("agentbridge").update(CLOUDFLARE_NAMED_DOMAIN_SETTING, domain, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration("agentbridge").update(CLOUDFLARE_NAMED_LOCAL_PORT_SETTING, localPort, vscode.ConfigurationTarget.Global);
    if (token !== undefined) {
      this.namedTunnelToken = token;
      await this.context.secrets.store(CLOUDFLARE_NAMED_TOKEN_SECRET, token);
    }
    if (this.tunnelProvider === "cloudflare-named") this.domain = domain;
    this.tunnelChecked = false;
    this.tunnelConfigValid = undefined;
    this.lastError = undefined;
    return this.getStatus();
  }

  async clearNamedTunnelToken(): Promise<BridgeStatus> {
    if (this.tunnelCheckPromise) throw new Error(t("tunnelCheckBusy"));
    if (this.state === "running" || this.state === "starting") {
      throw new Error("Stop the Bridge before clearing its Cloudflare Tunnel Token.");
    }
    this.namedTunnelToken = "";
    await this.context.secrets.delete(CLOUDFLARE_NAMED_TOKEN_SECRET);
    this.tunnelChecked = false;
    this.tunnelConfigValid = false;
    this.lastError = "Cloudflare Named Tunnel Token is not configured.";
    return this.getStatus();
  }

  async setTunnelProvider(provider: string): Promise<BridgeStatus> {
    if (this.installCloudflaredPromise) {
      throw new Error(t("cloudflaredInstallBusy"));
    }
    if (this.tunnelCheckPromise) throw new Error(t("tunnelCheckBusy"));
    if (this.state === "running" || this.state === "starting") {
      throw new Error("Stop the Bridge before changing its tunnel provider.");
    }
    if (provider !== "cloudflare" && provider !== "cloudflare-named" && provider !== "ngrok") {
      throw new Error("Bridge tunnel provider must be cloudflare, cloudflare-named, or ngrok.");
    }
    this.tunnelProvider = provider;
    this.domain = this.configuredDomainForProvider(provider);
    this.tunnelChecked = false;
    this.tunnelInstalled = undefined;
    this.tunnelVersion = undefined;
    this.tunnelConfigValid = undefined;
    this.lastError = undefined;
    await vscode.workspace.getConfiguration("agentbridge").update(TUNNEL_PROVIDER_SETTING, provider, vscode.ConfigurationTarget.Global);
    return this.getStatus();
  }

  async rotateEndpoint(): Promise<BridgeStatus> {
    if (this.state === "running" || this.state === "starting") {
      throw new Error("Stop the Bridge before rotating its endpoint URL.");
    }
    this.routeToken = randomBytes(16).toString("hex");
    await this.context.secrets.store(ROUTE_TOKEN_SECRET, this.routeToken);
    return this.getStatus();
  }

  async checkTunnel(): Promise<BridgeStatus> {
    if (this.disposed) throw new BridgeStartCancelledError();
    return this.checkTunnelInternal(false);
  }

  private async checkTunnelInternal(allowDuringStart: boolean): Promise<BridgeStatus> {
    if (this.disposed) throw new BridgeStartCancelledError();
    if (this.state === "running" || (this.state === "starting" && !allowDuringStart)) {
      throw new Error(t("stopBeforeTunnelCheck"));
    }
    if (this.installCloudflaredPromise) throw new Error(t("cloudflaredInstallBusy"));
    const generation = this.tunnelGeneration;
    if (this.tunnelCheckPromise) {
      if (this.tunnelCheckPromiseGeneration === generation) return this.tunnelCheckPromise;
      await this.tunnelCheckPromise.catch(() => undefined);
      if (generation !== this.tunnelGeneration || this.stoppingResources) throw new BridgeStartCancelledError();
    }
    if (!allowDuringStart) {
      this.tunnelProvider = this.readTunnelProvider();
      this.getStatus();
    }
    const checkedProvider = this.tunnelProvider;
    const checkedNamedDomain = this.configuredNamedDomain;
    const checkedNamedLocalPort = this.namedTunnelLocalPort;
    this.tunnelChecked = false;
    const checkAbort = new AbortController();
    this.tunnelCheckAbort = checkAbort;
    const check = this.tunnelProvider === "ngrok"
      ? this.checkNgrokInternal(checkAbort.signal)
      : this.tunnelProvider === "cloudflare-named"
        ? this.checkNamedTunnel(!allowDuringStart, checkAbort.signal)
        : this.checkCloudflared(checkAbort.signal);
    let trackedCheck!: Promise<BridgeStatus>;
    trackedCheck = (async () => {
      try {
        await check;
        if (generation === this.tunnelGeneration && !this.stoppingResources) {
          if (this.state !== "running" && this.state !== "starting") this.getStatus();
          this.tunnelChecked = this.tunnelProvider === checkedProvider
            && (checkedProvider !== "cloudflare-named"
              || (this.configuredNamedDomain === checkedNamedDomain && this.namedTunnelLocalPort === checkedNamedLocalPort));
        }
      } finally {
        if (this.tunnelCheckPromise === trackedCheck) {
          this.tunnelCheckPromise = undefined;
          this.tunnelCheckPromiseGeneration = undefined;
        }
        if (this.tunnelCheckAbort === checkAbort) this.tunnelCheckAbort = undefined;
      }
      return this.getStatus();
    })();
    this.tunnelCheckPromise = trackedCheck;
    this.tunnelCheckPromiseGeneration = generation;
    return trackedCheck;
  }

  async checkNgrok(): Promise<BridgeStatus> {
    if (this.readTunnelProvider() !== "ngrok") throw new Error(t("selectNgrokBeforeCheck"));
    return this.checkTunnel();
  }

  private async checkNgrokInternal(signal?: AbortSignal): Promise<BridgeStatus> {
    if (signal?.aborted) throw new BridgeStartCancelledError();
    try {
      const version = await execFileAsync("ngrok", ["version"], { windowsHide: true, timeout: 10_000, signal });
      this.tunnelInstalled = true;
      this.tunnelVersion = String(version.stdout || version.stderr).trim().split(/\r?\n/)[0] || "ngrok";
    } catch (error) {
      if (signal?.aborted) throw new BridgeStartCancelledError();
      this.tunnelInstalled = false;
      this.tunnelConfigValid = false;
      this.tunnelVersion = undefined;
      this.lastError = `ngrok was not found: ${error instanceof Error ? error.message : String(error)}`;
      return this.getStatus();
    }

    try {
      await execFileAsync("ngrok", ["config", "check"], { windowsHide: true, timeout: 10_000, signal });
      this.tunnelConfigValid = true;
      this.lastError = undefined;
    } catch (error) {
      if (signal?.aborted) throw new BridgeStartCancelledError();
      this.tunnelConfigValid = false;
      this.lastError = `ngrok config check failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    return this.getStatus();
  }

  private async refreshCloudflaredInstallerAvailability(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new BridgeStartCancelledError();
    this.cloudflaredInstaller = platformCloudflaredInstaller();
    this.cloudflaredInstallerExecutable = undefined;
    if (process.platform === "win32") {
      try {
        await execFileAsync("winget", ["--version"], { windowsHide: true, timeout: 10_000, signal });
        this.cloudflaredInstallerAvailability = "available";
        this.cloudflaredInstallerExecutable = "winget";
      } catch {
        if (signal?.aborted) throw new BridgeStartCancelledError();
        this.cloudflaredInstallerAvailability = "unavailable";
      }
      return;
    }
    if (process.platform === "darwin") {
      for (const candidate of ["brew", "/opt/homebrew/bin/brew", "/usr/local/bin/brew"]) {
        try {
          await execFileAsync(candidate, ["--version"], { timeout: 10_000, signal });
          this.cloudflaredInstallerAvailability = "available";
          this.cloudflaredInstallerExecutable = candidate;
          return;
        } catch {
          if (signal?.aborted) throw new BridgeStartCancelledError();
          // Try the next standard Homebrew location.
        }
      }
      this.cloudflaredInstallerAvailability = "unavailable";
      return;
    }
    this.cloudflaredInstallerAvailability = "manual-only";
  }

  private async checkCloudflared(signal?: AbortSignal): Promise<BridgeStatus> {
    if (signal?.aborted) throw new BridgeStartCancelledError();
    let lastError: unknown;
    for (const executable of this.cloudflaredExecutableCandidates()) {
      try {
        const version = await execFileAsync(executable, ["--version"], { windowsHide: true, timeout: 10_000, signal });
        this.cloudflaredExecutable = executable;
        this.tunnelInstalled = true;
        this.tunnelVersion = String(version.stdout || version.stderr).trim().split(/\r?\n/)[0] || "cloudflared";
        this.tunnelConfigValid = true;
        this.lastError = undefined;
        return this.getStatus();
      } catch (error) {
        if (signal?.aborted) throw new BridgeStartCancelledError();
        lastError = error;
      }
    }
    this.tunnelInstalled = false;
    this.tunnelConfigValid = false;
    this.tunnelVersion = undefined;
    await this.refreshCloudflaredInstallerAvailability(signal);
    this.lastError = `cloudflared was not found: ${lastError instanceof Error ? lastError.message : String(lastError ?? "not installed")}`;
    return this.getStatus();
  }

  private async checkNamedTunnel(refreshConfiguration = true, signal?: AbortSignal): Promise<BridgeStatus> {
    await this.checkCloudflared(signal);
    if (signal?.aborted) throw new BridgeStartCancelledError();
    if (!this.tunnelInstalled) return this.getStatus();

    if (refreshConfiguration) {
      this.namedTunnelToken = await this.context.secrets.get(CLOUDFLARE_NAMED_TOKEN_SECRET) ?? "";
      if (signal?.aborted) throw new BridgeStartCancelledError();
      this.restoreConfiguredNamedDomain();
      this.namedTunnelLocalPort = this.readNamedTunnelLocalPort();
      this.domain = this.configuredNamedDomain;
    }

    if (!this.namedTunnelToken) {
      this.tunnelConfigValid = false;
      this.lastError = "Cloudflare Named Tunnel Token is not configured.";
      return this.getStatus();
    }
    if (!this.configuredNamedDomain) {
      this.tunnelConfigValid = false;
      this.lastError = "Cloudflare Named Tunnel hostname is not configured.";
      return this.getStatus();
    }
    try {
      this.namedTunnelLocalPort = normalizeNamedTunnelLocalPort(this.namedTunnelLocalPort);
    } catch (error) {
      this.tunnelConfigValid = false;
      this.lastError = error instanceof Error ? error.message : String(error);
      return this.getStatus();
    }

    this.tunnelConfigValid = true;
    this.lastError = undefined;
    return this.getStatus();
  }

  private cloudflaredExecutableCandidates(): string[] {
    const candidates = [this.cloudflaredExecutable, "cloudflared"];
    if (process.platform === "win32") {
      if (process.env.LOCALAPPDATA) {
        candidates.push(path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "cloudflared.exe"));
        candidates.push(path.join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "cloudflared.exe"));
      }
      if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, "cloudflared", "cloudflared.exe"));
      if (process.env["ProgramFiles(x86)"]) candidates.push(path.join(process.env["ProgramFiles(x86)"]!, "cloudflared", "cloudflared.exe"));
    } else if (process.platform === "darwin") {
      candidates.push("/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared");
    } else if (process.platform === "linux") {
      candidates.push("/usr/bin/cloudflared", "/usr/local/bin/cloudflared");
    }
    return [...new Set(candidates.filter(Boolean))];
  }

  private failCloudflaredInstall(code: Exclude<CloudflaredInstallResultCode, "success">, message: string): never {
    const result: CloudflaredInstallResult = { code, installer: this.cloudflaredInstaller };
    this.lastCloudflaredInstallResult = result;
    this.lastError = message;
    this.output.appendLine(`[bridge] cloudflared install result (${code}): ${message}`);
    throw new CloudflaredInstallError(message, result);
  }

  async installCloudflared(): Promise<BridgeStatus> {
    if (this.disposed) throw new BridgeStartCancelledError();
    if (this.installCloudflaredPromise) return this.installCloudflaredPromise;
    const installation = this.installCloudflaredInternal();
    this.installCloudflaredPromise = (async () => {
      try {
        await installation;
      } finally {
        this.installCloudflaredPromise = undefined;
      }
      return this.getStatus();
    })();
    return this.installCloudflaredPromise;
  }

  private async installCloudflaredInternal(): Promise<BridgeStatus> {
    if (this.tunnelCheckPromise) throw new Error(t("tunnelCheckBusy"));
    if (this.startPromise || this.state === "running" || this.state === "starting") {
      throw new Error(t("stopBeforeCloudflaredInstall"));
    }
    this.tunnelProvider = this.readTunnelProvider();
    if (this.tunnelProvider !== "cloudflare" && this.tunnelProvider !== "cloudflare-named") {
      throw new Error(t("selectCloudflareBeforeInstall"));
    }
    this.lastCloudflaredInstallResult = undefined;
    const existing = await this.checkCloudflared();
    this.tunnelChecked = true;
    if (existing.tunnelInstalled) {
      const status = this.tunnelProvider === "cloudflare-named" ? await this.checkNamedTunnel() : existing;
      this.lastCloudflaredInstallResult = {
        code: "success",
        installer: this.cloudflaredInstaller,
        version: status.tunnelVersion,
      };
      return status;
    }

    if (this.cloudflaredInstallerAvailability !== "available" || !this.cloudflaredInstallerExecutable) {
      const message = this.cloudflaredInstaller === "winget"
        ? t("wingetNotFound")
        : this.cloudflaredInstaller === "homebrew"
          ? t("homebrewNotFound")
          : t("cloudflaredAutoInstallUnavailable");
      this.failCloudflaredInstall("installer-unavailable", message);
    }

    try {
      if (process.platform === "win32") {
        this.output.appendLine(`[bridge] installing cloudflared with Winget package ${CLOUDFLARED_WINGET_PACKAGE}...`);
        const result = await execFileAsync(this.cloudflaredInstallerExecutable, [
          "install",
          "--id", CLOUDFLARED_WINGET_PACKAGE,
          "--exact",
          "--source", "winget",
          "--silent",
          "--disable-interactivity",
          "--accept-package-agreements",
          "--accept-source-agreements",
        ], {
          windowsHide: false,
          timeout: 10 * 60 * 1000,
          maxBuffer: 2 * 1024 * 1024,
        });
        const output = [result.stdout, result.stderr].map((value) => String(value ?? "").trim()).filter(Boolean).join("\n");
        if (output) this.output.appendLine(`[winget] ${output}`);
      } else if (process.platform === "darwin") {
        this.output.appendLine(`[bridge] installing cloudflared with Homebrew (${this.cloudflaredInstallerExecutable})...`);
        const result = await execFileAsync(this.cloudflaredInstallerExecutable, ["install", "cloudflared"], {
          timeout: 15 * 60 * 1000,
          maxBuffer: 2 * 1024 * 1024,
        });
        const output = [result.stdout, result.stderr].map((value) => String(value ?? "").trim()).filter(Boolean).join("\n");
        if (output) this.output.appendLine(`[brew] ${output}`);
      } else {
        this.failCloudflaredInstall("installer-unavailable", t("cloudflaredAutoInstallUnavailable"));
      }
    } catch (error) {
      if (error instanceof CloudflaredInstallError) throw error;
      const outcome = classifyCloudflaredInstallFailure(error);
      const details = processExecutionDetails(error);
      const message = outcome === "cancelled"
        ? t("cloudflaredInstallCancelled")
        : outcome === "permission-denied"
          ? t("cloudflaredInstallPermissionDenied", details)
          : t("cloudflaredInstallCommandFailed", details);
      this.failCloudflaredInstall(outcome, message);
    }

    const installed = await this.checkCloudflared();
    if (!installed.tunnelInstalled) {
      this.tunnelChecked = true;
      this.failCloudflaredInstall("verification-failed", t("cloudflaredInstallVerificationFailed"));
    }
    this.output.appendLine(`[bridge] cloudflared installation verified: ${installed.tunnelVersion ?? "installed"}`);
    const status = this.tunnelProvider === "cloudflare-named" ? await this.checkNamedTunnel() : installed;
    this.tunnelChecked = true;
    this.lastCloudflaredInstallResult = {
      code: "success",
      installer: this.cloudflaredInstaller,
      version: status.tunnelVersion,
    };
    return status;
  }

  async start(domain?: string, options: BridgeStartOptions = {}): Promise<BridgeStatus> {
    if (this.disposed) throw new BridgeStartCancelledError();
    if (this.installCloudflaredPromise) {
      throw new Error(t("cloudflaredInstallBusy"));
    }
    // A Stop request keeps the externally visible state as running until its
    // resources have actually closed. Wait for that transaction before using
    // the state or generation, otherwise Start can report the stale running
    // snapshot and then be silently undone by the finishing Stop.
    if (this.stopPromise) await this.stopPromise;
    if (this.disposed) throw new BridgeStartCancelledError();
    if (this.stoppingResources) throw new BridgeStartCancelledError();
    if (this.state === "running") return this.getStatus();
    if (this.startPromise && this.startPromiseGeneration === this.tunnelGeneration) return this.startPromise;
    const generation = this.tunnelGeneration;
    // Refresh stopped-state settings before enforcing the manual check gate so an
    // external settings.json change cannot reuse a check from the old provider/configuration.
    this.getStatus();
    const isCloudflare = this.tunnelProvider === "cloudflare" || this.tunnelProvider === "cloudflare-named";
    if (options.automaticCheck) {
      let tunnel: BridgeStatus;
      try {
        tunnel = await this.checkTunnel();
      } catch (error) {
        if (error instanceof BridgeStartCancelledError || generation !== this.tunnelGeneration || this.stoppingResources || this.disposed) {
          return this.getStatus();
        }
        throw error;
      }
      if (generation !== this.tunnelGeneration || this.stoppingResources) return this.getStatus();
      if (tunnel.tunnelInstalled !== true || tunnel.tunnelConfigValid !== true) {
        this.state = "stopped";
        throw new Error(this.lastError ?? `${this.tunnelProvider} tunnel check did not pass.`);
      }
      // Another caller may have started the Bridge while this caller awaited the
      // shared check Promise.
      const current = this.getStatus();
      if (current.state === "running") return current;
      if (this.startPromise && this.startPromiseGeneration === this.tunnelGeneration) return this.startPromise;
    } else if (isCloudflare) {
      if (this.tunnelCheckPromise) throw new Error(t("tunnelCheckBusy"));
      if (!this.tunnelChecked) throw new Error(t("checkCloudflareBeforeStart"));
      if (this.tunnelInstalled !== true || this.tunnelConfigValid !== true) {
        throw new Error(t("cloudflareCheckNotReady"));
      }
    }
    // During automatic tunnel recovery the local HTTP/MCP runtime is intentionally kept alive.
    // A manual Start click must not create a second listener/tunnel while that recovery owns it.
    if (this.state === "starting" && this.httpServer) return this.getStatus();
    const startOperation = this.startInternal(domain, generation);
    this.startPromise = startOperation;
    this.startPromiseGeneration = generation;
    try {
      return await startOperation;
    } finally {
      if (this.startPromise === startOperation) {
        this.startPromise = undefined;
        this.startPromiseGeneration = undefined;
      }
    }
  }

  /** Development-only transport smoke: opens the exact local Streamable HTTP MCP server without a public tunnel. */
  async startLocalSmoke(): Promise<BridgeStatus> {
    if (this.context.extensionMode !== vscode.ExtensionMode.Development || process.env.AGENTBRIDGE_BRIDGE_SMOKE_LOCAL !== "1") {
      throw new Error("Local Bridge smoke mode is available only in an Extension Development Host with AGENTBRIDGE_BRIDGE_SMOKE_LOCAL=1.");
    }
    if (this.disposed) throw new BridgeStartCancelledError();
    if (this.stopPromise) await this.stopPromise;
    if (this.disposed || this.stoppingResources) throw new BridgeStartCancelledError();
    if (this.state === "running") return this.getStatus();
    if (this.startPromise && this.startPromiseGeneration === this.tunnelGeneration) return this.startPromise;
    if (this.state === "starting" || this.tunnelCheckPromise) throw new BridgeStartCancelledError();
    const generation = this.tunnelGeneration;
    const startOperation = this.startLocalSmokeInternal(generation);
    this.startPromise = startOperation;
    this.startPromiseGeneration = generation;
    try {
      return await startOperation;
    } finally {
      if (this.startPromise === startOperation) {
        this.startPromise = undefined;
        this.startPromiseGeneration = undefined;
      }
    }
  }

  private async startLocalSmokeInternal(generation: number): Promise<BridgeStatus> {
    this.state = "starting";
    this.lastError = undefined;
    try {
      if (!this.routeToken) await this.initialize();
      this.assertStartGeneration(generation);
      if (!vscode.workspace.workspaceFolders?.length) throw new Error("Open a workspace folder before starting the Bridge smoke server.");
      await this.startHttpServer();
      this.assertStartGeneration(generation);
      this.state = "running";
      this.output.appendLine(`[bridge-smoke] local Streamable HTTP server running on 127.0.0.1:${this.localPort}`);
      return this.getStatus();
    } catch (error) {
      if (error instanceof BridgeStartCancelledError || generation !== this.tunnelGeneration || this.disposed) {
        await this.stopPromise?.catch(() => undefined);
        return this.getStatus();
      }
      this.lastError = error instanceof Error ? error.message : String(error);
      this.state = "error";
      await this.stopResources(false);
      throw error;
    }
  }

  private async startInternal(domain: string | undefined, generation: number): Promise<BridgeStatus> {
    this.assertStartGeneration(generation);
    this.state = "starting";
    this.lastError = undefined;
    this.markPublicHealthChecking();
    // A manual start re-opens the QUIC door: the sticky http2 fallback only
    // applies within a single start-to-stop lifecycle.
    this.tunnelTransportFallback = undefined;
    try {
      if (!this.routeToken) {
        await this.initialize();
        this.assertStartGeneration(generation);
      }
      this.tunnelProvider = this.readTunnelProvider();
      if (this.tunnelProvider === "ngrok") {
        const resolvedDomain = domain ?? (this.configuredDomain || this.readConfiguredDomain() || this.readPersistedDomain());
        await this.persistDomain(resolvedDomain);
        this.assertStartGeneration(generation);
      } else if (this.tunnelProvider === "cloudflare-named") {
        this.namedTunnelToken = await this.context.secrets.get(CLOUDFLARE_NAMED_TOKEN_SECRET) ?? "";
        this.assertStartGeneration(generation);
        this.restoreConfiguredNamedDomain();
        this.namedTunnelLocalPort = this.readNamedTunnelLocalPort();
        this.domain = this.configuredNamedDomain;
      } else {
        this.domain = "";
      }

      const folders = vscode.workspace.workspaceFolders;
      if (!folders?.length) throw new Error("Open a workspace folder before starting the Bridge.");

      await this.resetToBuildModeForStart();
      this.assertStartGeneration(generation);

      const tunnel = await this.checkTunnelInternal(true);
      this.assertStartGeneration(generation);
      if (!tunnel.tunnelInstalled) throw new Error(this.lastError ?? `${this.tunnelProvider} tunnel client is not installed.`);
      if (!tunnel.tunnelConfigValid) throw new Error(this.lastError ?? `${this.tunnelProvider} tunnel configuration is invalid.`);

      await this.startHttpServer();
      this.assertStartGeneration(generation);
      await this.startTunnelOnce(generation);
      this.assertStartGeneration(generation);
      if (!this.isTunnelProcessAlive()) throw new Error(`${this.tunnelProvider} tunnel closed before startup completed.`);

      this.state = "running";
      this.schedulePublicHealthMonitor(generation);
      this.output.appendLine(`[bridge] running ${this.publicEndpointLogUrl()} -> 127.0.0.1:${this.localPort}`);
      return this.getStatus();
    } catch (error) {
      if (error instanceof BridgeStartCancelledError || generation !== this.tunnelGeneration) {
        await this.stopPromise?.catch(() => undefined);
        return this.getStatus();
      }
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.state = "error";
      await this.stopResources(false);
      throw error;
    }
  }

  private async startHttpServer(): Promise<void> {
    const endpointPath = `/mcp/${this.routeToken}`;
    const healthPath = `/healthz/${this.routeToken}`;
    const ownerGeneration = this.tunnelGeneration;
    const server = createHttpServer((request, response) => {
      void this.handleHttpRequest(server, ownerGeneration, endpointPath, healthPath, request, response).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.output.appendLine(`[bridge] HTTP error: ${message}`);
        writeJsonError(response, 500, message);
      });
    });
    this.httpServer = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error & { code?: string }) => {
        this.httpServersThatFailedToListen.add(server);
        server.off("listening", onListening);
        if (this.tunnelProvider === "cloudflare-named" && error.code === "EADDRINUSE") {
          reject(new Error(`Cloudflare Named Tunnel local port ${this.namedTunnelLocalPort} is already in use. Choose another port and update the Cloudflare published application Service URL.`));
          return;
        }
        reject(error);
      };
      const onListening = () => {
        this.httpServersThatListened.add(server);
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.tunnelProvider === "cloudflare-named" ? this.namedTunnelLocalPort : 0, "127.0.0.1");
    });
    if (this.httpServer !== server) {
      await this.closeHttpServer(server);
      throw new BridgeStartCancelledError();
    }
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Bridge local HTTP server did not expose a TCP port.");
    this.localPort = address.port;
    this.sessionPruneTimer = setInterval(() => this.pruneSessions(), SESSION_PRUNE_INTERVAL_MS);
    this.sessionPruneTimer.unref?.();
  }

  private closeHttpServer(server: HttpServer): Promise<void> {
    const existing = this.httpServerClosePromises.get(server);
    if (existing) return existing;
    const closing = new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        server.off("listening", onListening);
        server.off("error", onError);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        cleanup();
        resolve();
      };
      const closeNow = () => {
        cleanup();
        try {
          server.close(finish);
        } catch {
          finish();
        }
      };
      const onListening = () => closeNow();
      const onError = () => finish();
      timer = setTimeout(() => {
        try {
          server.closeAllConnections();
        } catch {
          // Best effort before the bounded shutdown finishes.
        }
        if (server.listening) {
          try {
            server.close(() => undefined);
          } catch {
            // Already closed.
          }
        } else {
          cleanup();
          server.once("listening", () => {
            try {
              server.closeAllConnections();
              server.close(() => undefined);
            } catch {
              // A late listen may already have been closed by its owner.
            }
          });
        }
        finish();
      }, HTTP_SERVER_SHUTDOWN_TIMEOUT_MS);
      timer.unref?.();
      if (server.listening) closeNow();
      else if (this.httpServersThatListened.has(server) || this.httpServersThatFailedToListen.has(server)) finish();
      else {
        server.once("listening", onListening);
        server.once("error", onError);
      }
    });
    this.httpServerClosePromises.set(server, closing);
    return closing;
  }

  /** Terminate a cloudflared/ngrok tunnel child. Windows routes through
   * taskkill /T /F so users launching cloudflared via a wrapper script
   * (.cmd/.bat) do not leave orphaned grandchildren behind; taskkill failures
   * fall back to a direct kill. Other platforms kill directly. */
  private async killTunnelProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
    this.tunnelProcessLifecycles.get(child)?.abort();
    if (child.killed || this.killRequested.has(child)) return;
    // Mark synchronously, before the first await, so a second fire-and-forget
    // caller can never slip past the guard while taskkill is in flight.
    this.killRequested.add(child);
    if (process.platform === "win32" && child.pid) {
      try {
        await execFileAsync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 });
        return;
      } catch {
        // Process already gone or taskkill unavailable — fall through.
        if (child.killed || child.exitCode !== null || child.signalCode !== null) return;
      }
    }
    if (!child.killed && child.exitCode === null && child.signalCode === null) child.kill();
  }

  private async terminateTunnelProcess(child: ChildProcessWithoutNullStreams, timeoutMs = 2_000): Promise<boolean> {
    const lifecycle = this.tunnelProcessLifecycles.get(child);
    if (lifecycle?.isClosed) return true;
    lifecycle?.abort();
    if (child.exitCode === null && child.signalCode === null) {
      void this.killTunnelProcess(child).catch(() => undefined);
    }
    const closed = await this.waitForTunnelProcessClose(child, timeoutMs);
    if (!closed) {
      try {
        child.kill(process.platform === "win32" ? undefined : "SIGKILL");
      } catch {
        // Best effort after the bounded close wait.
      }
    }
    return closed;
  }

  private async waitForTunnelProcessClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    const closed = this.tunnelProcessLifecycles.get(child)?.closed;
    if (!closed) return false;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (didClose: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(didClose);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      void closed.then(() => finish(true));
    });
  }

  private startTunnelProcess(protocolOverride?: BridgeTunnelProtocol): ChildProcessWithoutNullStreams {
    if (!this.localPort) throw new Error("Bridge local HTTP port is unavailable.");
    const isCloudflare = this.tunnelProvider === "cloudflare" || this.tunnelProvider === "cloudflare-named";
    const command = isCloudflare ? this.cloudflaredExecutable : "ngrok";
    const commandLabel = isCloudflare ? "cloudflared" : "ngrok";
    // "auto" keeps cloudflared's own QUIC-first behavior: the flag is omitted so
    // the spawned command line stays byte-identical to pre-setting releases.
    const protocol = protocolOverride ?? this.readTunnelProtocol();
    const protocolArgs = isCloudflare && protocol !== "auto" ? ["--protocol", protocol] : [];
    const args = this.tunnelProvider === "cloudflare"
      ? ["tunnel", ...protocolArgs, "--url", `http://127.0.0.1:${this.localPort}`]
      : this.tunnelProvider === "cloudflare-named"
        ? ["tunnel", "run", ...protocolArgs]
        : ["http", String(this.localPort), "--url", `https://${this.configuredDomain}`, "--log=stdout", "--log-format=json"];
    if (protocolArgs.length) this.output.appendLine(`[bridge] tunnel transport protocol: ${protocol}`);
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.tunnelProvider === "cloudflare-named"
        ? { ...process.env, TUNNEL_TOKEN: this.namedTunnelToken }
        : process.env,
    });
    this.tunnelProcess = child;
    const exitAbort = new AbortController();
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const lifecycle = {
      closed,
      exitSignal: exitAbort.signal,
      abort: () => exitAbort.abort(),
      isClosed: false,
    };
    this.tunnelProcessLifecycles.set(child, lifecycle);
    const diagnostics = isCloudflare ? createCloudflaredProcessDiagnostics(protocol) : undefined;
    if (diagnostics) this.cloudflaredProcessDiagnostics.set(child, diagnostics);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const pendingSecretPrefixes: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
    const redactTunnelChunk = (stream: "stdout" | "stderr", chunk: unknown): string => {
      const text = `${pendingSecretPrefixes[stream]}${String(chunk)}`;
      const token = this.routeToken;
      if (!token) {
        pendingSecretPrefixes[stream] = "";
        return text;
      }

      let safeText = "";
      let cursor = 0;
      while (cursor + token.length <= text.length) {
        if (text.startsWith(token, cursor)) {
          safeText += "<redacted>";
          cursor += token.length;
          continue;
        }
        safeText += text[cursor];
        cursor += 1;
      }

      const remainder = text.slice(cursor);
      let holdLength = 0;
      for (let length = Math.min(token.length - 1, remainder.length); length > 0; length -= 1) {
        if (token.startsWith(remainder.slice(-length))) {
          holdLength = length;
          break;
        }
      }
      safeText += holdLength > 0 ? remainder.slice(0, -holdLength) : remainder;
      pendingSecretPrefixes[stream] = holdLength > 0 ? remainder.slice(-holdLength) : "";
      return safeText;
    };
    const appendTunnelChunk = (stream: "stdout" | "stderr", chunk: unknown): void => {
      const safeText = redactTunnelChunk(stream, chunk);
      if (!safeText) return;
      this.output.append(`[${commandLabel}] ${safeText}`);
      if (diagnostics) appendCloudflaredDiagnosticOutput(diagnostics, stream, safeText);
    };
    const flushTunnelChunk = (stream: "stdout" | "stderr"): void => {
      const pending = pendingSecretPrefixes[stream];
      if (!pending) return;
      pendingSecretPrefixes[stream] = "";
      const safeText = this.routeToken.startsWith(pending) ? "<redacted>" : this.redactRouteToken(pending);
      this.output.append(`[${commandLabel}] ${safeText}`);
      if (diagnostics) appendCloudflaredDiagnosticOutput(diagnostics, stream, safeText);
    };
    child.stdout.on("data", (chunk) => {
      appendTunnelChunk("stdout", chunk);
    });
    child.stderr.on("data", (chunk) => {
      appendTunnelChunk("stderr", chunk);
    });
    child.once("exit", () => exitAbort.abort());
    child.once("close", () => {
      exitAbort.abort();
      flushTunnelChunk("stdout");
      flushTunnelChunk("stderr");
      if (diagnostics) {
        flushCloudflaredDiagnosticOutput(diagnostics, "stdout");
        flushCloudflaredDiagnosticOutput(diagnostics, "stderr");
      }
      // Diagnostics live in a WeakMap and disappear with the child object.
      // Keep them available after close so startup can classify an early exit.
      lifecycle.isClosed = true;
      resolveClosed();
      if (this.tunnelProcess === child && !this.stoppingResources && this.httpServer && this.state === "running") {
        const message = `${commandLabel} closed unexpectedly without an exit event; reconnecting without stopping the local MCP server.`;
        this.output.appendLine(`[bridge] ${message}`);
        this.lastError = message;
        if (this.tunnelProvider === "cloudflare") this.domain = "";
        this.markPublicHealthChecking();
        this.state = "starting";
        this.revision += 1;
        this.tunnelProcess = undefined;
        this.beginTunnelRecovery();
      }
    });
    child.on("error", (error) => {
      lifecycle.abort();
      this.output.appendLine(`[${commandLabel}] process error: ${error.message}`);
      if (this.tunnelProcess !== child) return;
      this.lastError = error.message;
      if (!this.stoppingResources && this.httpServer && this.state === "running") {
        const generation = this.tunnelGeneration;
        if (this.tunnelProvider === "cloudflare") this.domain = "";
        this.markPublicHealthChecking();
        this.state = "starting";
        this.revision += 1;
        void this.terminateTunnelProcess(child).then(() => {
          if (this.tunnelProcess === child) this.tunnelProcess = undefined;
          if (this.stoppingResources || !this.httpServer || generation !== this.tunnelGeneration || this.state !== "starting") return;
          this.beginTunnelRecovery();
        });
      }
    });
    child.on("exit", (code, signal) => {
      if (this.tunnelProcess !== child) return;
      const generation = this.tunnelGeneration;
      if (!this.stoppingResources && this.httpServer && this.state === "running") {
        const message = `${commandLabel} exited unexpectedly (code=${String(code)}, signal=${String(signal)}); reconnecting without stopping the local MCP server.`;
        this.output.appendLine(`[bridge] ${message}`);
        this.lastError = message;
        if (this.tunnelProvider === "cloudflare") this.domain = "";
        this.markPublicHealthChecking();
        this.state = "starting";
        this.revision += 1;
        void this.waitForTunnelProcessClose(child, 2_000).then(() => {
          if (this.tunnelProcess === child) this.tunnelProcess = undefined;
          if (this.stoppingResources || !this.httpServer || generation !== this.tunnelGeneration || this.state !== "starting") return;
          this.beginTunnelRecovery();
        });
      }
    });
    return child;
  }

  private async waitForTunnelStartup(child: ChildProcessWithoutNullStreams, expectedGeneration?: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let output = "";
      let startupTimer: ReturnType<typeof setTimeout> | undefined;
      let precheckDetailTimer: ReturnType<typeof setTimeout> | undefined;
      let exitDrainTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (startupTimer) clearTimeout(startupTimer);
        if (precheckDetailTimer) clearTimeout(precheckDetailTimer);
        if (exitDrainTimer) clearTimeout(exitDrainTimer);
        child.off("exit", onExit);
        child.off("close", onExit);
        child.off("error", onError);
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error); else resolve();
      };
      const handlePrecheckFailure = (allowDetailGrace: boolean): boolean => {
        const failure = this.cloudflaredPrecheckFailure(child);
        if (!failure) return false;
        if (allowDetailGrace && failure.kind === "generic") {
          if (!precheckDetailTimer) {
            precheckDetailTimer = setTimeout(() => {
              precheckDetailTimer = undefined;
              const completedFailure = this.cloudflaredPrecheckFailure(child);
              if (completedFailure) finish(completedFailure.error);
            }, CLOUDFLARED_PRECHECK_DETAIL_GRACE_MS);
          }
          return true;
        }
        finish(failure.error);
        return true;
      };
      const classifyExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (handlePrecheckFailure(false)) return;
        if (this.tunnelProvider === "cloudflare" || this.tunnelProvider === "cloudflare-named") {
          finish(this.cloudflaredExitBeforeHealthError(child));
          return;
        }
        const detail = output.trim().slice(-4_000);
        finish(new Error(`${this.tunnelProvider} tunnel exited during startup (code=${String(code)}, signal=${String(signal)}).${detail ? ` ${detail}` : ""}`));
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (exitDrainTimer) {
          clearTimeout(exitDrainTimer);
          exitDrainTimer = undefined;
          classifyExit(code, signal);
          return;
        }
        // Give stdout/stderr a short bounded window to drain. close normally
        // arrives first and contains the final unterminated diagnostic line;
        // the timer prevents inherited pipes from delaying startup failure.
        exitDrainTimer = setTimeout(() => {
          exitDrainTimer = undefined;
          classifyExit(code, signal);
        }, CLOUDFLARED_PRECHECK_DETAIL_GRACE_MS);
      };
      const onError = (error: Error) => finish(this.cloudflaredPrecheckError(child) ?? error);
      const onData = (chunk: Buffer | string) => {
        output = `${output}${String(chunk)}`.slice(-16_000);
        if (handlePrecheckFailure(true)) return;
        const lower = output.toLowerCase();
        if (this.tunnelProvider === "cloudflare") {
          const matches = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/ig);
          const tunnelUrl = matches?.find((candidate) => new URL(candidate).hostname.toLowerCase() !== "api.trycloudflare.com");
          if (tunnelUrl) {
            if (this.tunnelProcess !== child || this.stoppingResources || (expectedGeneration !== undefined && expectedGeneration !== this.tunnelGeneration)) {
              finish(new BridgeStartCancelledError());
              return;
            }
            this.domain = new URL(tunnelUrl).hostname.toLowerCase();
            this.revision += 1;
            finish();
          }
          return;
        }
        if (this.tunnelProvider === "cloudflare-named") {
          if (lower.includes("invalid tunnel token") || lower.includes("failed to parse token") || lower.includes("authentication failed") || lower.includes("unauthorized")) {
            finish(new Error(`Cloudflare Named Tunnel authentication failed. Rotate or recopy the Tunnel Token. ${output.trim().slice(-4_000)}`));
            return;
          }
          if (
            lower.includes("registered tunnel connection")
            || lower.includes("connection registered")
            || /\bconnection\s+\S+\s+registered\b/i.test(output)
            || lower.includes("initial protocol")
          ) {
            finish();
          }
          return;
        }
        if (lower.includes('"msg":"started tunnel"') && lower.includes(this.configuredDomain.toLowerCase())) {
          finish();
          return;
        }
        if (lower.includes("err_ngrok_") || lower.includes("endpoint is already online") || lower.includes("failed to start tunnel")) {
          finish(new Error(`ngrok failed to establish the reserved domain. ${output.trim().slice(-4_000)}`));
        }
      };
      child.once("exit", onExit);
      child.once("close", onExit);
      child.once("error", onError);
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      // Public HTTPS health is the source of truth. Quick Tunnel must emit its generated hostname;
      // Named Tunnel and ngrok log wording can vary between releases.
      startupTimer = setTimeout(() => {
        if (handlePrecheckFailure(false)) return;
        if (this.tunnelProvider === "cloudflare") {
          finish(new Error(`cloudflared did not provide a trycloudflare.com URL. ${output.trim().slice(-4_000)}`));
        } else {
          finish();
        }
      }, 45_000);
    });
  }

  private publicHealthUrl(): string {
    return `https://${this.domain}/healthz/${this.routeToken}`;
  }

  private redactRouteToken(value: string): string {
    return this.routeToken ? value.split(this.routeToken).join("<redacted>") : value;
  }

  private publicEndpointLogUrl(): string {
    const publicUrl = this.getStatus().publicUrl;
    return publicUrl ? this.redactRouteToken(publicUrl) : "<unavailable>";
  }

  private publicHealthLogUrl(): string {
    return this.redactRouteToken(this.publicHealthUrl());
  }

  private cancelPublicHealthMonitor(): void {
    if (this.publicHealthMonitorTimer) {
      clearTimeout(this.publicHealthMonitorTimer);
      this.publicHealthMonitorTimer = undefined;
      this.publicHealthMonitorTimerGeneration = undefined;
    }
    this.publicHealthMonitorAbort?.abort();
    this.publicHealthMonitorAbort = undefined;
    // Detach an aborted operation immediately. Its identity-guarded finally may
    // still run later, but it must not block or clear a newer Bridge generation.
    this.publicHealthMonitorPromise = undefined;
    this.publicHealthMonitorPromiseGeneration = undefined;
    this.publicHealthChecking = false;
  }

  private markPublicHealthChecking(): void {
    this.cancelPublicHealthMonitor();
    this.publicHealthState = "checking";
    this.publicHealthChecking = false;
    this.publicHealthFailureCount = 0;
    this.publicHealthError = undefined;
  }

  private resetPublicHealthMonitor(): void {
    this.cancelPublicHealthMonitor();
    this.publicHealthState = "inactive";
    this.publicHealthChecking = false;
    this.publicHealthFailureCount = 0;
    this.publicHealthLastCheckedAt = undefined;
    this.publicHealthLastSuccessAt = undefined;
    this.publicHealthError = undefined;
  }

  private recordPublicHealthSuccess(): void {
    const recovered = this.publicHealthState === "unstable" || this.publicHealthState === "unhealthy";
    const now = Date.now();
    this.publicHealthState = "healthy";
    this.publicHealthFailureCount = 0;
    this.publicHealthLastCheckedAt = now;
    this.publicHealthLastSuccessAt = now;
    this.publicHealthError = undefined;
    if (recovered) this.output.appendLine(`[bridge] ${t("publicHealthMonitorRecovered")}`);
  }

  private recordPublicHealthFailure(message: string): void {
    const previousState = this.publicHealthState;
    this.publicHealthFailureCount += 1;
    this.publicHealthLastCheckedAt = Date.now();
    this.publicHealthError = this.redactRouteToken(message);
    this.publicHealthState = this.publicHealthFailureCount >= PUBLIC_HEALTH_UNHEALTHY_FAILURES ? "unhealthy" : "unstable";
    if (this.publicHealthState !== previousState) {
      this.output.appendLine(`[bridge] ${this.publicHealthState === "unhealthy"
        ? t("publicHealthMonitorUnhealthy", this.publicHealthError)
        : t("publicHealthMonitorUnstable", this.publicHealthError)}`);
    }
  }

  private schedulePublicHealthMonitor(generation: number): void {
    // Reject stale generations before touching the shared timer: an old check
    // may settle after Stop -> Start and must not cancel the new Bridge timer.
    if (this.stoppingResources || this.state !== "running" || !this.httpServer || !this.isTunnelProcessAlive() || generation !== this.tunnelGeneration) return;
    // ngrok counts every public health request against its HTTP/S request quota.
    // Keep its verified startup result and manual Check now action, but do not
    // consume the user's quota with an idle background poll.
    if (this.tunnelProvider === "ngrok") return;
    if (this.publicHealthMonitorTimer) clearTimeout(this.publicHealthMonitorTimer);
    const timer = setTimeout(() => {
      if (this.publicHealthMonitorTimer !== timer || this.publicHealthMonitorTimerGeneration !== generation) return;
      this.publicHealthMonitorTimer = undefined;
      this.publicHealthMonitorTimerGeneration = undefined;
      void this.runPublicHealthMonitorCheck(generation).catch((error) => {
        if (!this.stoppingResources && this.state === "running" && generation === this.tunnelGeneration) {
          this.recordPublicHealthFailure(error instanceof Error ? error.message : String(error));
        }
      }).finally(() => {
        this.schedulePublicHealthMonitor(generation);
      });
    }, PUBLIC_HEALTH_MONITOR_INTERVAL_MS);
    this.publicHealthMonitorTimer = timer;
    this.publicHealthMonitorTimerGeneration = generation;
    timer.unref?.();
  }

  private async runPublicHealthMonitorCheck(generation: number): Promise<void> {
    if (this.publicHealthMonitorPromise && this.publicHealthMonitorPromiseGeneration === generation) return this.publicHealthMonitorPromise;
    if (this.stoppingResources || this.state !== "running" || !this.httpServer || !this.isTunnelProcessAlive() || !this.domain || generation !== this.tunnelGeneration) return;
    const abort = new AbortController();
    this.publicHealthMonitorAbort = abort;
    this.publicHealthChecking = true;
    const operation = (async () => {
      let failureMessage = t("publicHealthMonitorUnknownFailure");
      type HealthOutcome = { kind: "result"; healthy: boolean } | { kind: "error"; error: unknown } | { kind: "timeout" };
      let resolveBudget!: (outcome: HealthOutcome) => void;
      let budgetDidExpire = false;
      const budgetDeadline = Date.now() + PUBLIC_HEALTH_MONITOR_BUDGET_MS;
      const budgetExpired = new Promise<HealthOutcome>((resolve) => { resolveBudget = resolve; });
      const budgetTimer = setTimeout(() => {
        budgetDidExpire = true;
        abort.abort();
        resolveBudget({ kind: "timeout" });
      }, PUBLIC_HEALTH_MONITOR_BUDGET_MS);
      budgetTimer.unref?.();
      const requestOutcome = this.requestPublicHealth((message) => {
        if (failureMessage === t("publicHealthMonitorUnknownFailure")) failureMessage = message;
      }, abort.signal).then<HealthOutcome, HealthOutcome>(
        (healthy) => ({ kind: "result", healthy }),
        (error) => ({ kind: "error", error }),
      );
      let outcome = await Promise.race([requestOutcome, budgetExpired]);
      clearTimeout(budgetTimer);
      if (budgetDidExpire || Date.now() >= budgetDeadline) outcome = { kind: "timeout" };
      if (outcome.kind === "timeout") {
        failureMessage = t("publicHealthMonitorBudgetExceeded", Math.round(PUBLIC_HEALTH_MONITOR_BUDGET_MS / 1_000));
      } else if (outcome.kind === "error") {
        failureMessage = this.redactRouteToken(outcome.error instanceof Error ? outcome.error.message : String(outcome.error));
      }
      if ((abort.signal.aborted && outcome.kind !== "timeout") || this.stoppingResources || this.state !== "running" || !this.httpServer || generation !== this.tunnelGeneration) return;
      if (outcome.kind === "result" && outcome.healthy) this.recordPublicHealthSuccess();
      else this.recordPublicHealthFailure(failureMessage);
    })();
    this.publicHealthMonitorPromise = operation;
    this.publicHealthMonitorPromiseGeneration = generation;
    try {
      await operation;
    } finally {
      if (this.publicHealthMonitorPromise === operation) {
        this.publicHealthMonitorPromise = undefined;
        this.publicHealthMonitorPromiseGeneration = undefined;
        this.publicHealthChecking = false;
      }
      if (this.publicHealthMonitorAbort === abort) this.publicHealthMonitorAbort = undefined;
    }
  }

  async checkPublicHealth(): Promise<BridgeStatus> {
    if (this.state !== "running" || !this.httpServer || !this.isTunnelProcessAlive() || !this.domain) {
      throw new Error(t("publicHealthCheckRequiresRunning"));
    }
    await this.runPublicHealthMonitorCheck(this.tunnelGeneration);
    return this.getStatus();
  }

  private cloudflaredPrecheckFailure(
    child: ChildProcessWithoutNullStreams,
  ): { kind: CloudflaredPrecheckFailureKind; error: Error } | undefined {
    const kind = cloudflaredPrecheckFailureKind(this.cloudflaredProcessDiagnostics.get(child));
    if (kind === "both-transports") return { kind, error: new Error(t("cloudflarePrecheckBothTransportsFailed")) };
    if (kind === "dns") return { kind, error: new Error(t("cloudflarePrecheckDnsFailed")) };
    if (kind === "generic") return { kind, error: new Error(t("cloudflarePrecheckFailed")) };
    return undefined;
  }

  private cloudflaredExitBeforeHealthError(child: ChildProcessWithoutNullStreams): Error {
    const precheckError = this.cloudflaredPrecheckError(child);
    if (precheckError) return precheckError;
    const diagnostics = this.cloudflaredProcessDiagnostics.get(child);
    const configuredProtocol = this.readTunnelProtocol();
    const allowQuicFallback = !this.stoppingResources
      && !this.tunnelTransportFallback
      // An auto-started QUIC process may fail after another window changes the
      // setting to explicit HTTP/2. Preserve explicit QUIC, but let the HTTP/2
      // choice enter the same replacement path as the automatic fallback.
      && configuredProtocol !== "quic";
    if (allowQuicFallback && cloudflaredQuicFailedBeforeRegistration(diagnostics)) {
      return new BridgeQuicUnstableError();
    }
    return new Error(t("cloudflareTunnelExitedBeforeHealth", cloudflaredLogTail(diagnostics, 200) || t("unknown")));
  }

  private cloudflaredPrecheckError(child: ChildProcessWithoutNullStreams): Error | undefined {
    return this.cloudflaredPrecheckFailure(child)?.error;
  }

  private createPublicHealthLogThrottle(): { report: (message: string) => void; flush: () => void } {
    const throttle = createRepeatedMessageThrottle(PUBLIC_HEALTH_LOG_THROTTLE_MS);
    const emit = (message: string) => this.output.appendLine(`[bridge] ${this.redactRouteToken(message)}`);
    const report = (message: string) => {
      const emission = throttle.report(message);
      if (!emission) return;
      emit(emission.suppressed > 0
        ? t("publicHealthRepeatedFailures", emission.message, emission.suppressed)
        : emission.message);
    };
    const flush = () => {
      for (const emission of throttle.flush()) {
        emit(t("publicHealthRepeatedFailures", emission.message, emission.suppressed));
      }
    };
    return { report, flush };
  }

  private createPublicHealthAbortController(externalSignal?: AbortSignal): { signal: AbortSignal; abort: () => void; dispose: () => void } {
    const controller = new AbortController();
    const abortFromExternal = () => controller.abort();
    if (externalSignal?.aborted) abortFromExternal();
    else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
    const timer = setTimeout(() => controller.abort(), PUBLIC_HEALTH_REQUEST_TIMEOUT_MS);
    return {
      signal: controller.signal,
      abort: () => controller.abort(),
      dispose: () => {
        clearTimeout(timer);
        externalSignal?.removeEventListener("abort", abortFromExternal);
      },
    };
  }

  private async runWithHardAbort<T>(operation: () => PromiseLike<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw new Error("Public health request was aborted.");
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => finish(() => reject(new Error("Public health request was aborted.")));
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        void Promise.resolve(operation()).then(
          (value) => finish(() => resolve(value)),
          (error) => finish(() => reject(error)),
        );
      } catch (error) {
        finish(() => reject(error));
      }
    });
  }

  private async fetchWithHardAbort(input: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    return this.runWithHardAbort(() => fetch(input, { ...init, signal }), signal);
  }

  private async waitForPublicHealthRetry(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, 750);
      signal?.addEventListener("abort", finish, { once: true });
      if (signal?.aborted) finish();
    });
  }

  private async requestPublicHealth(reportFailure: (message: string) => void, signal?: AbortSignal): Promise<boolean> {
    const requestAbort = this.createPublicHealthAbortController(signal);
    try {
      const response = await this.fetchWithHardAbort(this.publicHealthUrl(), {
        method: "GET",
        cache: "no-store",
        redirect: "manual",
        headers: this.tunnelProvider === "ngrok" ? { "ngrok-skip-browser-warning": "true" } : undefined,
      }, requestAbort.signal);
      if (!response.ok) {
        reportFailure(t("publicHealthSystemHttpFailure", response.status));
        // Releasing an error body is best-effort. Awaiting a misbehaving stream
        // here would defeat the monitor's overall time budget.
        requestAbort.abort();
        void response.body?.cancel().catch(() => undefined);
        return false;
      }
      const payload = await this.runWithHardAbort(() => response.json(), requestAbort.signal).catch(() => undefined) as { ok?: unknown } | undefined;
      if (payload?.ok !== true) {
        reportFailure(t("publicHealthSystemPayloadFailure", JSON.stringify(payload)));
      }
      return payload?.ok === true;
    } catch (error) {
      if (signal?.aborted) return false;
      const reason = error instanceof Error ? error.message : String(error);
      reportFailure(t("publicHealthSystemError", this.redactRouteToken(reason)));
      const ok = await this.requestPublicHealthViaDoh(reportFailure, signal);
      if (signal?.aborted) return false;
      reportFailure(t("publicHealthDohResult", ok));
      return ok;
    } finally {
      requestAbort.dispose();
    }
  }

  private assertStartGeneration(generation: number): void {
    if (generation !== this.tunnelGeneration || this.stoppingResources || this.disposed) {
      throw new BridgeStartCancelledError();
    }
  }

  /** Resolve the tunnel hostname through DoH and retry the health request
   * against the resolved IP. Fallback for networks whose DNS cannot resolve
   * *.trycloudflare.com wildcard subdomains (e.g. campus/corporate DNS). If
   * every DoH endpoint fails on a Quick Tunnel hostname (including the window
   * where Cloudflare's control plane has not yet published the DNS record),
   * retries against pinned Cloudflare anycast IPs. Uses node:https directly
   * with SNI + Host headers so TLS verification still runs against the real
   * hostname either way. */
  private async requestPublicHealthViaDoh(reportFailure: (message: string) => void, signal?: AbortSignal): Promise<boolean> {
    const hostname = this.domain;
    if (!hostname || signal?.aborted) return false;
    const ip = await this.resolveHostViaDoh(hostname, signal);
    if (signal?.aborted) return false;
    if (ip) {
      reportFailure(`DoH fallback: ${hostname} -> ${ip}, sending direct health request...`);
      if (await this.sendPublicHealthRequest(hostname, ip, reportFailure, signal)) return true;
      if (signal?.aborted) return false;
      if (this.dohCache.hostname === hostname && this.dohCache.ip === ip) {
        this.dohCache = { hostname: "", ip: "", at: 0, generation: -1 };
      }
      const refreshedIp = await this.resolveHostViaDoh(hostname, signal, true);
      if (refreshedIp && refreshedIp !== ip) {
        reportFailure(`DoH fallback: refreshed ${hostname} -> ${refreshedIp}, retrying direct health request...`);
        return this.sendPublicHealthRequest(hostname, refreshedIp, reportFailure, signal);
      }
      return false;
    }
    if (this.tunnelProvider !== "cloudflare" || !hostname.endsWith(".trycloudflare.com")) {
      reportFailure(`DoH fallback: could not resolve ${hostname} via any DoH endpoint`);
      return false;
    }
    for (const anycastIp of PUBLIC_HEALTH_CF_ANYCAST_IPS) {
      if (signal?.aborted) return false;
      reportFailure(`DoH fallback exhausted, trying pinned Cloudflare anycast for *.trycloudflare.com: ${anycastIp}`);
      if (await this.sendPublicHealthRequest(hostname, anycastIp, reportFailure, signal)) return true;
    }
    reportFailure(`DoH fallback: pinned anycast health checks failed for ${hostname}`);
    return false;
  }

  /** Send one health request straight to an IP while keeping TLS verification
   * and routing anchored to the real hostname (SNI servername + Host header). */
  private async sendPublicHealthRequest(
    hostname: string,
    ip: string,
    reportFailure: (message: string) => void,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const { request } = await import("node:https");
    return await new Promise<boolean>((resolve) => {
      const requestAbort = this.createPublicHealthAbortController(signal);
      let settled = false;
      const onAbort = () => finish(false);
      const finish = (healthy: boolean) => {
        if (settled) return;
        settled = true;
        requestAbort.signal.removeEventListener("abort", onAbort);
        requestAbort.dispose();
        resolve(healthy);
      };
      if (requestAbort.signal.aborted) {
        finish(false);
        return;
      }
      requestAbort.signal.addEventListener("abort", onAbort, { once: true });
      let responseReceived = false;
      let req: ReturnType<typeof request>;
      try {
        req = request(
          {
            hostname: ip,
            port: 443,
            servername: hostname,
            path: `/healthz/${this.routeToken}`,
            method: "GET",
            headers: {
              Host: hostname,
              ...(this.tunnelProvider === "ngrok" ? { "ngrok-skip-browser-warning": "true" } : {}),
            },
            signal: requestAbort.signal,
          },
          (response) => {
            responseReceived = true;
            let body = "";
            const failResponse = (reason: string) => {
              if (settled) return;
              if (!signal?.aborted) reportFailure(`DoH fallback: direct response ${reason}`);
              finish(false);
            };
            response.once("aborted", () => failResponse("aborted"));
            response.once("error", (error) => failResponse(`error: ${error instanceof Error ? error.message : String(error)}`));
            response.once("close", () => {
              if (!response.complete) failResponse("closed before completion");
            });
            if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
              reportFailure(`DoH fallback: direct request got HTTP ${response.statusCode ?? "none"}`);
              requestAbort.abort();
              req.destroy();
              response.resume();
              finish(false);
              return;
            }
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => (body += chunk));
            response.on("end", () => {
              try {
                const payload = JSON.parse(body) as { ok?: unknown } | undefined;
                finish(payload?.ok === true);
              } catch {
                finish(false);
              }
            });
          },
        );
      } catch (error) {
        if (!signal?.aborted) {
          reportFailure(`DoH fallback: direct request error: ${error instanceof Error ? error.message : String(error)}`);
        }
        finish(false);
        return;
      }
      req.on("error", (error) => {
        if (settled) return;
        if (!signal?.aborted) {
          reportFailure(`DoH fallback: direct request error: ${error instanceof Error ? error.message : String(error)}`);
        }
        finish(false);
      });
      req.once("close", () => {
        if (!settled && !responseReceived) {
          if (!signal?.aborted) reportFailure("DoH fallback: direct request closed before receiving a response");
          finish(false);
        }
      });
      try {
        req.end();
      } catch (error) {
        if (!signal?.aborted) {
          reportFailure(`DoH fallback: direct request error: ${error instanceof Error ? error.message : String(error)}`);
        }
        finish(false);
      }
    });
  }

  /** Ask a DoH endpoint for an A record of the given hostname. Caches the
   * result briefly to avoid hammering the DoH server during startup retries. */
  private async resolveHostViaDoh(hostname: string, signal?: AbortSignal, bypassCache = false): Promise<string | null> {
    const lookupGeneration = this.tunnelGeneration;
    if (!bypassCache && this.dohCache.hostname === hostname && this.dohCache.generation === lookupGeneration && Date.now() - this.dohCache.at < PUBLIC_HEALTH_DOH_CACHE_TTL_MS) {
      return this.dohCache.ip;
    }
    for (const endpoint of PUBLIC_HEALTH_DOH_ENDPOINTS) {
      if (signal?.aborted) return null;
      const requestAbort = this.createPublicHealthAbortController(signal);
      try {
        const url = `${endpoint}?name=${encodeURIComponent(hostname)}&type=A&rand=${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const response = await this.fetchWithHardAbort(url, {
          cache: "no-store",
          redirect: "manual",
          headers: endpoint.includes("dns-query") ? { accept: "application/dns-json" } : undefined,
        }, requestAbort.signal);
        if (!response.ok) {
          requestAbort.abort();
          void response.body?.cancel().catch(() => undefined);
          continue;
        }
        const payload = await this.runWithHardAbort(() => response.json(), requestAbort.signal) as { Answer?: Array<{ type: number; data: string }> };
        const record = payload.Answer?.find((answer) => answer.type === 1 && isPublicIpv4Address(answer.data));
        if (record?.data) {
          if (signal?.aborted || lookupGeneration !== this.tunnelGeneration) return null;
          this.dohCache = { hostname, ip: record.data, at: Date.now(), generation: lookupGeneration };
          return record.data;
        }
      } catch {
        // try the next DoH endpoint
      } finally {
        requestAbort.dispose();
      }
    }
    return null;
  }

  private dohCache: { hostname: string; ip: string; at: number; generation: number } = { hostname: "", ip: "", at: 0, generation: -1 };

  private async waitForPublicHealth(child: ChildProcessWithoutNullStreams): Promise<void> {
    const deadline = Date.now() + PUBLIC_HEALTH_STARTUP_TIMEOUT_MS;
    const isCloudflare = this.tunnelProvider === "cloudflare" || this.tunnelProvider === "cloudflare-named";
    const logThrottle = isCloudflare ? this.createPublicHealthLogThrottle() : undefined;
    const reportFailure = logThrottle?.report ?? ((message: string) => this.output.appendLine(`[bridge] ${this.redactRouteToken(message)}`));
    const precheckAbort = new AbortController();
    const processExitSignal = this.tunnelProcessLifecycles.get(child)?.exitSignal;
    const abortForProcessExit = () => precheckAbort.abort();
    if (processExitSignal?.aborted) abortForProcessExit();
    else processExitSignal?.addEventListener("abort", abortForProcessExit, { once: true });
    let observedPrecheckError: Error | undefined;
    let precheckDetailTimer: ReturnType<typeof setTimeout> | undefined;
    const abortWithPrecheckFailure = (error: Error) => {
      observedPrecheckError = error;
      precheckAbort.abort();
    };
    const onCloudflaredData = () => {
      const failure = this.cloudflaredPrecheckFailure(child);
      if (!failure) return;
      if (failure.kind !== "generic") {
        if (precheckDetailTimer) clearTimeout(precheckDetailTimer);
        precheckDetailTimer = undefined;
        abortWithPrecheckFailure(failure.error);
        return;
      }
      if (!precheckDetailTimer) {
        precheckDetailTimer = setTimeout(() => {
          precheckDetailTimer = undefined;
          const completedFailure = this.cloudflaredPrecheckFailure(child);
          if (completedFailure) abortWithPrecheckFailure(completedFailure.error);
        }, CLOUDFLARED_PRECHECK_DETAIL_GRACE_MS);
      }
    };
    if (isCloudflare) {
      child.stdout.on("data", onCloudflaredData);
      child.stderr.on("data", onCloudflaredData);
      onCloudflaredData();
    }
    try {
      const assertTunnelAvailable = async (): Promise<void> => {
        const processLifecycle = this.tunnelProcessLifecycles.get(child);
        if (processLifecycle?.exitSignal.aborted && child.exitCode === null && child.signalCode === null && !processLifecycle.isClosed) {
          throw new Error(this.lastError ?? `${this.tunnelProvider} tunnel process became unavailable during startup.`);
        }
        if (child.exitCode !== null || child.signalCode !== null || processLifecycle?.isClosed) {
          // exit precedes close; briefly allow both output streams and a final
          // unterminated diagnostic line to drain before classifying the exit.
          await this.waitForTunnelProcessClose(child, CLOUDFLARED_PRECHECK_DETAIL_GRACE_MS);
          if (isCloudflare) throw observedPrecheckError ?? this.cloudflaredExitBeforeHealthError(child);
          throw new Error(`${this.tunnelProvider} tunnel exited before the public Bridge health endpoint became reachable.`);
        }
        if (this.tunnelProcess !== child) {
          throw new Error(`${this.tunnelProvider} tunnel changed before the public Bridge health endpoint became reachable.`);
        }
      };
      // Only "auto" (cloudflared's own QUIC-first choice) is eligible for the
      // early abort + http2 fallback; an explicit quic/http2 choice is honored.
      const allowQuicFallback = isCloudflare && !this.tunnelTransportFallback && this.readTunnelProtocol() === "auto";
      while (Date.now() < deadline) {
        await assertTunnelAvailable();
        const precheckError = observedPrecheckError;
        if (precheckError) throw precheckError;
        if (allowQuicFallback) {
          const diagnostics = this.cloudflaredProcessDiagnostics.get(child);
          const firstQuicFailureAt = cloudflaredFirstQuicFailureAt(diagnostics);
          if (cloudflaredQuicUnstable(diagnostics) && firstQuicFailureAt !== undefined && Date.now() - firstQuicFailureAt >= QUIC_UNSTABLE_GRACE_MS) {
            throw new BridgeQuicUnstableError();
          }
        }
        const healthy = await this.requestPublicHealth(reportFailure, precheckAbort.signal);
        await assertTunnelAvailable();
        const postRequestPrecheckError = observedPrecheckError;
        if (postRequestPrecheckError) throw postRequestPrecheckError;
        if (healthy) {
          const pendingFailure = this.cloudflaredPrecheckFailure(child);
          if (!pendingFailure) return;
          if (pendingFailure.kind !== "generic") throw pendingFailure.error;
          await new Promise<void>((resolve) => setTimeout(resolve, CLOUDFLARED_PRECHECK_DETAIL_GRACE_MS));
          const completedFailure = observedPrecheckError ?? this.cloudflaredPrecheckError(child);
          if (completedFailure) throw completedFailure;
          return;
        }
        await this.waitForPublicHealthRetry(precheckAbort.signal);
      }
      const precheckError = observedPrecheckError ?? this.cloudflaredPrecheckError(child);
      if (precheckError) throw precheckError;
      const diagnostics = this.cloudflaredProcessDiagnostics.get(child);
      if (this.tunnelProvider === "cloudflare-named" && cloudflaredSawRegistration(diagnostics)) {
        throw new Error(t("namedTunnelIngressHealthFailed", this.publicHealthLogUrl(), this.configuredNamedDomain, this.namedTunnelLocalPort));
      }
      if (!cloudflaredSawRegistration(diagnostics) && cloudflaredQuicDialFailures(diagnostics) >= QUIC_UNSTABLE_DIAL_FAILURES) {
        throw new Error(t("tunnelNeverRegisteredQuicError", cloudflaredQuicDialFailures(diagnostics), cloudflaredLogTail(diagnostics, 200)));
      }
      if (this.tunnelProvider === "cloudflare-named") {
        throw new Error(t("tunnelNeverRegisteredError", cloudflaredLogTail(diagnostics, 200)));
      }
      throw new Error(t("publicHealthTimeout", Math.round(PUBLIC_HEALTH_STARTUP_TIMEOUT_MS / 1000), this.publicHealthLogUrl()));
    } finally {
      if (isCloudflare) {
        child.stdout.off("data", onCloudflaredData);
        child.stderr.off("data", onCloudflaredData);
      }
      processExitSignal?.removeEventListener("abort", abortForProcessExit);
      if (precheckDetailTimer) clearTimeout(precheckDetailTimer);
      logThrottle?.flush();
    }
  }

  private async startTunnelOnce(expectedGeneration?: number): Promise<void> {
    const configuredProtocol = this.readTunnelProtocol();
    const protocolOverride = configuredProtocol === "auto" ? this.tunnelTransportFallback : configuredProtocol;
    await this.startTunnelOnceWithProtocol(expectedGeneration, protocolOverride);
  }

  private async startTunnelOnceWithProtocol(expectedGeneration: number | undefined, protocolOverride: BridgeTunnelProtocol | undefined): Promise<void> {
    if (expectedGeneration !== undefined) this.assertStartGeneration(expectedGeneration);
    const child = this.startTunnelProcess(protocolOverride);
    try {
      try {
        await this.waitForTunnelStartup(child, expectedGeneration);
        await this.waitForPublicHealth(child);
      } catch (error) {
        // One self-heal attempt per bridge session: when "auto" QUIC proves
        // unstable (repeated edge dial failures, zero registrations), restart
        // the tunnel with an explicit http2 transport instead of failing.
        // Precheck failures and ordinary timeouts propagate unchanged.
        if (!(error instanceof BridgeQuicUnstableError) || this.tunnelTransportFallback) throw error;
        const currentProtocol = this.readTunnelProtocol();
        if (currentProtocol === "quic") throw error;
        if (expectedGeneration !== undefined) this.assertStartGeneration(expectedGeneration);
        // Do not spawn the replacement merely because kill() returned: on POSIX
        // that only means a signal was sent, and Node may not have observed
        // exit/close yet. Prefer the real close event, bounded to two seconds.
        await this.terminateTunnelProcess(child);
        this.tunnelProcess = undefined;
        // Closing the old connector can take long enough for the user or another
        // window to change the setting. Re-read it immediately before spawning so
        // an automatic fallback never overrides a newer explicit QUIC choice.
        const replacementProtocol = this.readTunnelProtocol();
        if (replacementProtocol === "quic") throw error;
        if (replacementProtocol === "auto") {
          this.tunnelTransportFallback = "http2";
          this.output.appendLine("[bridge] QUIC transport unstable; restarting tunnel with --protocol http2.");
          void vscode.window.showInformationMessage(t("quicFallbackNotice")).then(undefined, () => undefined);
        } else {
          this.output.appendLine(`[bridge] ${t("tunnelProtocolChangedToHttp2")}`);
        }
        await this.startTunnelOnceWithProtocol(expectedGeneration, "http2");
        return;
      }
      if (expectedGeneration !== undefined) this.assertStartGeneration(expectedGeneration);
      if (this.tunnelProcess !== child) throw new Error(`${this.tunnelProvider} tunnel changed before health verification completed.`);
      this.recordPublicHealthSuccess();
      this.output.appendLine(`[bridge] public health verified: ${this.publicHealthLogUrl()}`);
    } catch (error) {
      if (this.tunnelProcess === child) this.tunnelProcess = undefined;
      await this.terminateTunnelProcess(child);
      throw error;
    }
  }

  private beginTunnelRecovery(): void {
    if (this.stoppingResources || !this.httpServer) return;
    if (this.tunnelRecoveryPromise && this.tunnelRecoveryGeneration === this.tunnelGeneration) return;
    const generation = this.tunnelGeneration;
    this.tunnelRecoveryAbort?.abort();
    const recoveryAbort = new AbortController();
    this.tunnelRecoveryAbort = recoveryAbort;
    const recovery = (async () => {
      let attempt = 0;
      while (!recoveryAbort.signal.aborted && !this.stoppingResources && this.httpServer && generation === this.tunnelGeneration) {
        const delayMs = TUNNEL_RESTART_BACKOFF_MS[Math.min(attempt, TUNNEL_RESTART_BACKOFF_MS.length - 1)];
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            recoveryAbort.signal.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, delayMs);
          timer.unref?.();
          recoveryAbort.signal.addEventListener("abort", finish, { once: true });
          if (recoveryAbort.signal.aborted) finish();
        });
        if (recoveryAbort.signal.aborted || this.stoppingResources || !this.httpServer || generation !== this.tunnelGeneration) return;
        try {
          this.output.appendLine(`[bridge] ${this.tunnelProvider} reconnect attempt ${attempt + 1}...`);
          await this.startTunnelOnce(generation);
          if (generation !== this.tunnelGeneration || this.stoppingResources) return;
          this.state = "running";
          this.lastError = undefined;
          this.revision += 1;
          this.schedulePublicHealthMonitor(generation);
          this.output.appendLine(`[bridge] ${this.tunnelProvider} tunnel recovered: ${this.publicEndpointLogUrl()}`);
          return;
        } catch (error) {
          if (generation !== this.tunnelGeneration || this.stoppingResources || !this.httpServer) return;
          this.lastError = error instanceof Error ? error.message : String(error);
          this.output.appendLine(`[bridge] ${this.tunnelProvider} reconnect attempt ${attempt + 1} failed: ${this.lastError}`);
          attempt += 1;
        }
      }
    });
    let trackedRecovery!: Promise<void>;
    trackedRecovery = recovery().finally(() => {
      if (this.tunnelRecoveryPromise === trackedRecovery) {
        this.tunnelRecoveryPromise = undefined;
        this.tunnelRecoveryGeneration = undefined;
      }
      if (this.tunnelRecoveryAbort === recoveryAbort) this.tunnelRecoveryAbort = undefined;
    });
    this.tunnelRecoveryGeneration = generation;
    this.tunnelRecoveryPromise = trackedRecovery;
  }

  private async handleHttpRequest(ownerServer: HttpServer, ownerGeneration: number, endpointPath: string, healthPath: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (this.stoppingResources || this.disposed || this.httpServer !== ownerServer || this.tunnelGeneration !== ownerGeneration) {
      response.setHeader("Cache-Control", "no-store");
      writeJsonError(response, 503, "Bridge is stopping.");
      return;
    }
    if (constantTimeStringEqual(url.pathname, healthPath)) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        writeJsonError(response, 405, "Method not allowed.");
        return;
      }
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.writeHead(200);
      if (request.method !== "HEAD") {
        response.end(JSON.stringify({ ok: true, name: "agentbridge", sessions: this.sessions.size }));
      } else {
        response.end();
      }
      return;
    }
    if (!constantTimeStringEqual(url.pathname, endpointPath)) {
      writeJsonError(response, 404, "Not found");
      return;
    }

    const originValidation = validateMcpOrigin(
      request,
      ["127.0.0.1", "localhost", "[::1]", this.domain].filter(Boolean),
      readTrustedBrowserOrigins(),
    );
    if (!originValidation.allowed) {
      const rejectedOrigin = this.redactRouteToken(String(request.headers.origin ?? "<missing>")).replace(/[\r\n]+/g, " ");
      this.output.appendLine(`[security] rejected MCP Origin: ${rejectedOrigin}`);
      response.setHeader("Cache-Control", "no-store");
      writeJsonError(response, 403, "Forbidden Origin.");
      return;
    }
    if (originValidation.origin) {
      response.setHeader("Access-Control-Allow-Origin", originValidation.origin);
      response.setHeader("Vary", "Origin");
    }
    response.setHeader("Access-Control-Allow-Headers", "content-type, accept, mcp-session-id, mcp-protocol-version, mcp-method, mcp-name, last-event-id, authorization");
    response.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
    response.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }

    // Route to existing session by mcp-session-id header
    const sessionId = request.headers["mcp-session-id"] as string | undefined;

    if (request.method === "POST") {
      const body = await readJsonBody(request);
      await this.handlePost(ownerServer, ownerGeneration, request, response, body, sessionId);
      return;
    }

    if (request.method === "GET") {
      await this.handleGet(request, response, sessionId);
      return;
    }

    if (request.method === "DELETE") {
      await this.handleDelete(request, response, sessionId);
      return;
    }

    writeJsonError(response, 405, "Method not allowed.");
  }

  private async handlePost(ownerServer: HttpServer, ownerGeneration: number, request: IncomingMessage, response: ServerResponse, body: unknown, sessionId: string | undefined): Promise<void> {
    // Reading the request body above is asynchronous. Stop followed by Start may
    // replace the listener while an old POST is still being parsed, so recheck
    // ownership before it can touch current sessions or admission counters.
    if (this.stoppingResources || this.disposed || this.httpServer !== ownerServer || this.tunnelGeneration !== ownerGeneration) {
      writeJsonError(response, 503, "Bridge is stopping.");
      return;
    }
    // If sessionId is provided, route to existing session
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        writeJsonError(response, 404, "Session not found. The MCP session may have expired.");
        return;
      }
      session.lastActivity = Date.now();
      session.activeRequests += 1;
      this.activeRequests += 1;
      try {
        await session.transport.handleRequest(request, response, body);
      } finally {
        session.activeRequests = Math.max(0, session.activeRequests - 1);
        session.lastActivity = Date.now();
        this.activeRequests = Math.max(0, this.activeRequests - 1);
      }
      return;
    }

    if (!isInitializeRequest(body)) {
      writeJsonError(response, 400, "Bad Request: a POST without Mcp-Session-Id must be an MCP initialize request.");
      return;
    }
    this.makeRoomForSession();
    if (this.sessions.size + this.pendingInitializations >= MAX_SESSIONS) {
      writeJsonError(response, 503, "Bridge session capacity reached. Close an existing MCP session and retry.");
      return;
    }

    // No session ID: validated initialization request. Create a new session.
    this.pendingInitializations += 1;
    let reservationActive = true;
    const releaseInitializationReservation = () => {
      if (!reservationActive) return;
      reservationActive = false;
      if (this.httpServer === ownerServer && this.tunnelGeneration === ownerGeneration) {
        this.pendingInitializations = Math.max(0, this.pendingInitializations - 1);
      }
    };
    this.activeRequests += 1;
    let transport: StreamableHTTPServerTransport | undefined;
    try {
      const created = this.createSession(ownerServer, ownerGeneration, releaseInitializationReservation);
      transport = created.transport;
      const server = created.server;
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      // If session creation failed during initialization, clean up
      const newSessionId = transport?.sessionId;
      if (newSessionId) this.destroySession(newSessionId);
      throw error;
    } finally {
      releaseInitializationReservation();
      this.activeRequests = Math.max(0, this.activeRequests - 1);
    }
  }

  private async handleGet(request: IncomingMessage, response: ServerResponse, sessionId: string | undefined): Promise<void> {
    if (this.tunnelProvider === "cloudflare") {
      response.setHeader("Allow", "POST, DELETE, OPTIONS");
      writeJsonError(response, 405, "Standalone SSE is disabled for Cloudflare Quick Tunnel; use Streamable HTTP POST responses.");
      return;
    }
    if (!sessionId) {
      writeJsonError(response, 400, "Bad Request: Mcp-Session-Id header is required for GET requests.");
      return;
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      writeJsonError(response, 404, "Session not found. The MCP session may have expired.");
      return;
    }
    session.lastActivity = Date.now();
    session.activeStreams += 1;
    let released = false;
    const releaseStream = () => {
      if (released) return;
      released = true;
      session.activeStreams = Math.max(0, session.activeStreams - 1);
      session.lastActivity = Date.now();
    };
    response.once("close", releaseStream);
    try {
      await session.transport.handleRequest(request, response);
    } finally {
      response.off("close", releaseStream);
      releaseStream();
    }
  }

  private async handleDelete(request: IncomingMessage, response: ServerResponse, sessionId: string | undefined): Promise<void> {
    if (!sessionId) {
      writeJsonError(response, 400, "Bad Request: Mcp-Session-Id header is required for DELETE requests.");
      return;
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      writeJsonError(response, 404, "Session not found.");
      return;
    }
    await session.transport.handleRequest(request, response);
    this.destroySession(sessionId);
  }

  private createSession(ownerServer: HttpServer, ownerGeneration: number, onSessionInitialized?: () => void): { transport: StreamableHTTPServerTransport; server: McpServer } {
    const instructions = buildServerInstructions(this.readOnlyMode);
    const instructionsReadOnly = this.readOnlyMode;
    const packageVersion = String(this.context.extension.packageJSON.version ?? "").trim() || "0.0.0";
    const server = new McpServer(
      { name: "agentbridge", version: packageVersion },
      { capabilities: { tools: {}, logging: {} }, instructions },
    );
    let transport!: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: this.tunnelProvider === "cloudflare",
      eventStore: new BoundedInMemoryEventStore(),
      keepAliveMs: SESSION_KEEPALIVE_INTERVAL_MS,
      retryInterval: SESSION_RETRY_INTERVAL_MS,
      onsessioninitialized: async (sid) => {
        onSessionInitialized?.();
        if (this.stoppingResources || this.disposed || this.httpServer !== ownerServer || this.tunnelGeneration !== ownerGeneration) {
          await Promise.allSettled([transport.close(), server.close()]);
          return;
        }
        this.sessions.set(sid, {
          transport,
          server,
          lastActivity: Date.now(),
          activeRequests: 0,
          activeStreams: 0,
          toldReadOnly: instructionsReadOnly,
          firstCallReminderPending: instructionsReadOnly,
        });
        this.revision += 1;
        this.output.appendLine(`[bridge] new MCP session: ${sid}`);
      },
      onsessionclosed: (sid) => {
        this.destroySession(sid);
      },
    });

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const shell = getManagedShellChoice();
      return {
        // The same list in Plan and Build mode; see setReadOnlyMode.
        tools: BRIDGE_TOOL_DEFINITIONS
          .map((tool) => ({
            name: tool.name,
            description: tool.description
              .replace("${RUNTIME_SHELL_DESCRIPTION}", shell.description)
              .replace("${RUNTIME_SHELL_SYNTAX_HINT}", shell.syntaxHint),
            inputSchema: tool.inputSchema,
          })),
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const toolName = request.params.name;
      const result = await this.handleToolCall(toolName, request.params.arguments ?? {}, { signal: extra.signal, sessionId: transport.sessionId ?? undefined });
      return {
        content: result.content,
        isError: result.isError,
        structuredContent: result.structuredContent as Record<string, unknown> | undefined,
      } as CallToolResult;
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) this.destroySession(sid);
    };

    return { transport, server };
  }

  /**
   * Run a tool call and, when read-only mode changed since this session was last told,
   * prefix the result with a one-time notice. Tool results are the only per-turn channel an
   * MCP server has: instructions are fixed at initialize and many clients ignore list_changed.
   */
  private async handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
    extra: { signal?: AbortSignal; sessionId?: string },
  ): Promise<{ content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError?: boolean; structuredContent?: Record<string, unknown> }> {
    const notice = this.takeReadOnlyTransitionNotice(extra.sessionId);
    const result = await this.executeToolCall(toolName, args, extra);
    if (!notice) return result;
    const [first, ...rest] = result.content;
    const content = first?.type === "text"
      ? [{ type: "text" as const, text: `${notice}\n\n${first.text}` }, ...rest]
      : [{ type: "text" as const, text: notice }, ...result.content];
    return { ...result, content };
  }

  /**
   * Return the notice owed to a session, if any:
   * - a transition notice, at most once per actual change since the model was last told
   *   (a toggle that ends where the model was last told owes nothing);
   * - otherwise, on the first tool call of a session created in read-only mode, a reminder
   *   that read-only mode is ON, since the model may never have seen the instructions.
   */
  private takeReadOnlyTransitionNotice(sessionId: string | undefined): string | undefined {
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session || typeof session.toldReadOnly !== "boolean") return undefined;
    const firstCallReminder = session.firstCallReminderPending === true;
    session.firstCallReminderPending = false;
    if (session.toldReadOnly !== this.readOnlyMode) {
      session.toldReadOnly = this.readOnlyMode;
      return buildReadOnlyTransitionNotice(this.readOnlyMode);
    }
    return firstCallReminder && this.readOnlyMode ? buildReadOnlySessionNotice() : undefined;
  }

  private async executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    extra: { signal?: AbortSignal; sessionId?: string },
  ): Promise<{ content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError?: boolean; structuredContent?: Record<string, unknown> }> {
    const planModeBlock = this.readOnlyMode ? planModeBlockError(toolName, args) : undefined;
    if (planModeBlock) {
      const activityId = this.pushActivity({
        tool: toolName,
        status: "running",
        presentation: bridgePresentation(toolName, args),
        sessionId: extra.sessionId,
      });
      this.finishActivity(activityId, "error", 0, planModeBlock, bridgePresentation(toolName, args, planModeBlock, undefined, true));
      return {
        content: [{ type: "text" as const, text: planModeBlock }],
        isError: true,
      };
    }
    if (toolName === SET_TODOS_TOOL.name || toolName === REPORT_PROGRESS_TOOL.name) {
      // Validation failures must come back as tool errors (isError) the model can correct,
      // not escape as JSON-RPC protocol errors.
      try {
        return toolName === SET_TODOS_TOOL.name
          ? this.handleSetTodos(args)
          : this.handleReportProgress(args, extra.sessionId);
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: formatToolError(error, "INVALID_ARGUMENT") }] };
      }
    }

    const activityId = this.pushActivity({
      tool: toolName,
      status: "running",
      presentation: bridgePresentation(toolName, args),
      sessionId: extra.sessionId,
    });
    const startedAt = Date.now();
    try {
      if (isFileToolName(toolName)) {
        const result = await invokeFileTool(toolName, args, {
          workspaceRoots: this.workspaceRoots(),
          signal: extra.signal,
        });
        this.finishActivity(
          activityId,
          "completed",
          Date.now() - startedAt,
          undefined,
          bridgePresentation(toolName, args, result.text, result.structuredContent as Record<string, unknown>),
        );
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
          { type: "text" as const, text: result.text },
        ];
        if (result.images) {
          for (const img of result.images) {
            content.push({ type: "image" as const, data: img.base64, mimeType: img.mimeType });
          }
        }
        return {
          content,
          structuredContent: result.structuredContent as Record<string, unknown>,
        };
      }

      if (BRIDGE_EXCLUDED_TOOL_NAMES.has(toolName)) {
        throw new ToolError("UNKNOWN_TOOL", `The ${toolName} tool is not available in Bridge mode.`);
      }

      const definition = getIdeToolDefinition(toolName);
      if (definition) {
        const cancellation = cancellationFromAbortSignal(extra.signal);
        try {
          const result = await this.ideToolBroker.invokeDirect(toolName, asRecord(args), cancellation.token);
          this.finishActivity(
            activityId,
            result.isError ? "error" : "completed",
            Date.now() - startedAt,
            result.isError ? result.text : undefined,
            bridgePresentation(toolName, args, result.text, undefined, result.isError),
          );
          return {
            isError: result.isError || undefined,
            content: [{ type: "text" as const, text: result.text }],
          };
        } finally {
          cancellation.dispose();
        }
      }

      throw new ToolError(
        "UNKNOWN_TOOL",
        `Unknown Bridge tool: ${toolName}`,
        "Refresh the tool list (tools/list); ChatGPT Connectors need Settings → Connectors → Refresh after AgentBridge updates.",
      );
    } catch (error) {
      const message = formatToolError(error);
      this.finishActivity(activityId, "error", Date.now() - startedAt, message, bridgePresentation(toolName, args, message, undefined, true));
      return {
        isError: true,
        content: [{ type: "text" as const, text: message }],
      };
    }
  }

  private isSessionActive(session: McpSession): boolean {
    return session.activeRequests > 0 || session.activeStreams > 0;
  }

  private pruneSessions(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (!this.isSessionActive(session) && now - session.lastActivity >= SESSION_IDLE_TIMEOUT_MS) {
        this.destroySession(sessionId);
      }
    }
    this.trimInactiveSessions(MAX_SESSIONS);
  }

  private makeRoomForSession(): void {
    this.trimInactiveSessions(Math.max(0, MAX_SESSIONS - this.pendingInitializations - 1));
  }

  private trimInactiveSessions(maxSize: number): void {
    while (this.sessions.size > maxSize) {
      const oldestInactive = [...this.sessions.entries()]
        .filter(([, session]) => !this.isSessionActive(session))
        .sort((a, b) => a[1].lastActivity - b[1].lastActivity)[0];
      if (!oldestInactive) return;
      this.destroySession(oldestInactive[0]);
    }
  }

  public destroySession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.revision += 1;
    void session.server.close().catch(() => undefined);
    this.output.appendLine(`[bridge] session destroyed: ${sessionId}`);
  }

  public clearIdleSessions(): number {
    let cleared = 0;
    for (const [sessionId, session] of [...this.sessions.entries()]) {
      if (this.isSessionActive(session)) continue;
      this.destroySession(sessionId);
      cleared += 1;
    }
    return cleared;
  }

  public clearActivityHistory(): number {
    let cleared = 0;
    for (let index = this.activities.length - 1; index >= 0; index -= 1) {
      if (this.activities[index].status === "running") continue;
      this.activities.splice(index, 1);
      cleared += 1;
    }
    if (cleared > 0) this.revision += 1;
    return cleared;
  }

  private handleReportProgress(value: unknown, sessionId?: string): { content: Array<{ type: "text"; text: string }> } {
    const input = asRecord(value);
    const message = typeof input.message === "string" ? input.message.trim() : "";
    if (!message) throw new Error("report_progress.message must be a non-empty string.");
    if (message.length > 2_000) throw new Error("report_progress.message must be at most 2000 characters.");
    const phase = typeof input.phase === "string" ? input.phase.trim().slice(0, 160) : undefined;
    let percent: number | undefined;
    if (input.percent !== undefined) {
      if (!Number.isInteger(input.percent) || Number(input.percent) < 0 || Number(input.percent) > 100) {
        throw new Error("report_progress.percent must be an integer from 0 to 100.");
      }
      percent = Number(input.percent);
    }
    const requestedTodoId = typeof input.todo_id === "string" ? input.todo_id.trim() : "";
    let linkedTodo: BridgeTodo | undefined;
    if (requestedTodoId) {
      linkedTodo = this.todos.find((todo) => todo.id === requestedTodoId);
      if (!linkedTodo) throw new Error(`report_progress.todo_id does not match a current todo: ${requestedTodoId}`);
    } else {
      linkedTodo = this.todos.find((todo) => todo.status === "in_progress");
    }
    this.pushActivity({
      tool: REPORT_PROGRESS_TOOL.name,
      status: "progress",
      message,
      phase,
      percent,
      todoId: linkedTodo?.id,
      todoTitle: linkedTodo?.title,
      sessionId,
    });
    this.output.appendLine(`[bridge-progress]${linkedTodo ? ` [${linkedTodo.id}]` : ""}${phase ? ` ${phase}:` : ""} ${message}${percent !== undefined ? ` (${percent}%)` : ""}`);
    return { content: [{ type: "text", text: linkedTodo ? `Progress reported to AgentBridge for todo ${linkedTodo.id}.` : "Progress reported to AgentBridge." }] };
  }

  private handleSetTodos(value: unknown): { content: Array<{ type: "text"; text: string }> } {
    const input = asRecord(value);
    if (!Array.isArray(input.todos)) throw new Error("set_todos.todos must be an array.");
    if (input.todos.length > MAX_TODOS) throw new Error(`set_todos.todos must contain at most ${MAX_TODOS} items.`);

    const seen = new Set<string>();
    const todos: BridgeTodo[] = input.todos.map((raw, index) => {
      const item = asRecord(raw);
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const title = typeof item.title === "string" ? item.title.trim() : "";
      const status = item.status;
      if (!id || id.length > 80) throw new Error(`set_todos.todos[${index}].id must be 1-80 characters.`);
      if (seen.has(id)) throw new Error(`set_todos.todos contains duplicate id: ${id}`);
      seen.add(id);
      if (!title || title.length > 400) throw new Error(`set_todos.todos[${index}].title must be 1-400 characters.`);
      if (status !== "pending" && status !== "in_progress" && status !== "completed") {
        throw new Error(`set_todos.todos[${index}].status must be pending, in_progress, or completed.`);
      }
      return { id, title, status };
    });

    if (todos.filter((todo) => todo.status === "in_progress").length > 1) {
      throw new Error("set_todos supports at most one in_progress todo.");
    }

    this.todos = todos;
    this.revision += 1;
    const completed = todos.filter((todo) => todo.status === "completed").length;
    const current = todos.find((todo) => todo.status === "in_progress");
    this.output.appendLine(todos.length
      ? `[bridge-todos] ${completed}/${todos.length} completed${current ? ` · current: [${current.id}] ${current.title}` : ""}`
      : "[bridge-todos] cleared");
    return { content: [{ type: "text", text: formatSetTodosResult(todos) }] };
  }

  private workspaceRoots(): string[] {
    const roots = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
    if (!roots.length) throw new ToolError("NO_WORKSPACE", "No workspace folder is open.", "Ask the user to open a folder in VS Code.");
    return roots;
  }

  private pushActivity(input: Omit<BridgeActivity, "id" | "at">): number {
    const at = new Date().toISOString();
    const item: BridgeActivity = {
      id: this.nextActivityId++,
      at,
      ...input,
    };
    this.activities.push(item);
    if (this.activities.length > MAX_ACTIVITY) this.activities.splice(0, this.activities.length - MAX_ACTIVITY);
    if (input.status !== "progress") {
      this.toolCalls += 1;
      this.lastTool = input.tool;
      this.lastToolAt = at;
    }
    this.revision += 1;
    return item.id;
  }

  private finishActivity(
    id: number,
    status: "completed" | "error",
    durationMs: number,
    message?: string,
    presentation?: BridgeActivityPresentation,
  ): void {
    const index = this.activities.findIndex((item) => item.id === id);
    if (index < 0) return;
    const current = this.activities[index];
    if (current.status === "running") {
      this.completedToolCalls += 1;
      this.totalToolDurationMs += durationMs;
      if (status === "error") this.failedToolCalls += 1;
    }
    this.activities[index] = { ...current, status, durationMs, message: message ?? current.message, presentation: presentation ?? current.presentation };
    this.revision += 1;
  }

  async stop(): Promise<BridgeStatus> {
    await this.stopResources(true);
    return this.getStatus();
  }

  private async stopResources(markStopped: boolean): Promise<void> {
    if (markStopped) this.stopMarkStoppedRequested = true;
    if (this.stopPromise) {
      await this.stopPromise;
      return;
    }
    let stopOperation!: Promise<void>;
    stopOperation = (async () => {
      try {
        await this.performStopResources();
        if (this.stopMarkStoppedRequested) {
          this.state = "stopped";
          this.lastError = undefined;
          this.output.appendLine("[bridge] stopped");
        }
      } finally {
        this.stoppingResources = false;
      }
    })();
    this.stopPromise = stopOperation;
    try {
      await stopOperation;
    } finally {
      if (this.stopPromise === stopOperation) {
        this.stopPromise = undefined;
        this.stopMarkStoppedRequested = false;
      }
    }
  }

  private async performStopResources(): Promise<void> {
    this.stoppingResources = true;
    this.tunnelGeneration += 1;
    this.resetPublicHealthMonitor();
    this.tunnelRecoveryAbort?.abort();
    this.tunnelRecoveryAbort = undefined;
    const tunnelCheck = this.tunnelCheckPromise;
    this.tunnelCheckAbort?.abort();
    if (tunnelCheck) await tunnelCheck.catch(() => undefined);
    if (this.sessionPruneTimer) {
      clearInterval(this.sessionPruneTimer);
      this.sessionPruneTimer = undefined;
    }

    // Tear down all active sessions
    for (const sid of [...this.sessions.keys()]) this.destroySession(sid);

    const tunnel = this.tunnelProcess;
    this.tunnelProcess = undefined;
    if (tunnel) {
      await this.terminateTunnelProcess(tunnel);
    }

    this.activeRequests = 0;

    const server = this.httpServer;
    this.httpServer = undefined;
    if (server) await this.closeHttpServer(server);
    // An initialization that was already inside the MCP SDK may settle while
    // the tunnel/server are closing. Sweep again after the listener is closed;
    // onsessioninitialized also rejects late arrivals below.
    for (const sid of [...this.sessions.keys()]) this.destroySession(sid);
    this.pendingInitializations = 0;
    this.activeRequests = 0;
    this.localPort = undefined;
    if (this.tunnelProvider === "cloudflare") this.domain = "";
  }

  async disposeAsync(): Promise<void> {
    this.disposed = true;
    await this.stopResources(true);
  }

  dispose(): void {
    this.disposed = true;
    void this.stopResources(true);
  }
}

