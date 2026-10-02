import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const MCP_CONFIG_FILE = "mcp.json";
export const MCP_SECRET_PREFIX = "agentbridge.mcp.credential.";
const MAX_CONFIG_BYTES = 1024 * 1024;
const SERVER_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,31}$/;
const SECRET_NAME = /^[A-Za-z0-9_.-]{1,80}$/;

export type McpPlanPolicy = "read-only" | "all" | "disabled";
export interface McpServerConfig {
  name: string;
  source: string;
  scope: "user" | "workspace";
  workspaceRoot?: string;
  type: "stdio" | "http";
  enabled: boolean;
  timeoutMs: number;
  connectTimeoutMs: number;
  planMode: McpPlanPolicy;
  tools?: string[];
  description?: string;
  command?: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  url?: string;
  headers: Record<string, string>;
}
export interface McpConfigEntry {
  name: string;
  source: string;
  scope: "user" | "workspace";
  config?: McpServerConfig;
  error?: string;
}
export interface McpConfigOptions {
  workspaceRoots: string[];
  homeDir?: string;
}
export interface McpConfiguration {
  entries: McpConfigEntry[];
  errors: string[];
  paths: string[];
}

export function mcpConfigPaths(options: McpConfigOptions): string[] {
  return [
    ...(options.homeDir ? [path.join(options.homeDir, ".agentbridge", MCP_CONFIG_FILE)] : []),
    ...options.workspaceRoots.map((root) => path.join(root, ".agentbridge", MCP_CONFIG_FILE)),
  ];
}

function stringField(value: unknown, name: string, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 16_384) throw new Error(`${name} must be a non-empty string (at most 16384 characters).`);
  return value;
}
function stringList(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 1024 || value.some((item) => typeof item !== "string" || item.length > 16_384)) throw new Error(`${name} must be an array of strings (at most 1024 entries).`);
  return [...value];
}
function stringMap(value: unknown, name: string): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object of string values.`);
  const entries = Object.entries(value);
  if (entries.length > 256 || entries.some(([, item]) => typeof item !== "string" || item.length > 16_384)) throw new Error(`${name} must contain at most 256 string values.`);
  return Object.fromEntries(entries) as Record<string, string>;
}
function seconds(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback * 1000;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 3600) throw new Error(`${field} must be a number greater than 0 and at most 3600 seconds.`);
  return Math.ceil(value * 1000);
}

export function parseMcpServer(name: string, value: unknown, source: string, scope: McpConfigEntry["scope"], workspaceRoot?: string): McpServerConfig {
  if (!SERVER_NAME.test(name)) throw new Error("Server names must contain 1–32 letters, digits, underscores or hyphens.");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Server configuration must be an object.");
  const input = value as Record<string, unknown>;
  const allowed = new Set(["type", "command", "args", "env", "cwd", "url", "headers", "enabled", "timeout", "connectTimeout", "planMode", "tools", "description"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error("Unsupported configuration field; supported fields are type, command, args, env, cwd, url, headers, enabled, timeout, connectTimeout, planMode, tools and description.");
  if ((input.command !== undefined) === (input.url !== undefined)) throw new Error("Configure exactly one of command (stdio) or url (Streamable HTTP).");
  const type = input.command !== undefined ? "stdio" : "http";
  if (input.type !== undefined && input.type !== type && !(type === "http" && input.type === "streamable-http")) throw new Error("type must match command (stdio) or url (http/streamable-http); legacy SSE is not supported.");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("enabled must be a boolean.");
  if (input.planMode !== undefined && (typeof input.planMode !== "string" || !["read-only", "all", "disabled"].includes(input.planMode))) throw new Error("planMode must be read-only, all or disabled.");
  if ((type === "stdio" && input.headers !== undefined) || (type === "http" && [input.args, input.env, input.cwd].some((field) => field !== undefined))) throw new Error("Use args/env/cwd for stdio and headers for HTTP.");
  return {
    name, source, scope, workspaceRoot, type,
    enabled: input.enabled !== false,
    timeoutMs: seconds(input.timeout, 60, "timeout"),
    connectTimeoutMs: seconds(input.connectTimeout, 10, "connectTimeout"),
    planMode: (input.planMode ?? "read-only") as McpPlanPolicy,
    tools: stringList(input.tools, "tools"),
    description: stringField(input.description, "description", true),
    command: stringField(input.command, "command", true),
    args: stringList(input.args, "args") ?? [],
    env: stringMap(input.env, "env"),
    cwd: stringField(input.cwd, "cwd", true),
    url: stringField(input.url, "url", true),
    headers: stringMap(input.headers, "headers"),
  };
}

export async function loadMcpConfiguration(options: McpConfigOptions): Promise<McpConfiguration> {
  const entries = new Map<string, McpConfigEntry>();
  const errors: string[] = [];
  // First workspace folder wins within a multi-root workspace; any workspace wins over user.
  const sources = [
    ...(options.homeDir ? [{ file: path.join(options.homeDir, ".agentbridge", MCP_CONFIG_FILE), scope: "user" as const, root: options.workspaceRoots[0] }] : []),
    ...[...options.workspaceRoots].reverse().map((root) => ({ file: path.join(root, ".agentbridge", MCP_CONFIG_FILE), scope: "workspace" as const, root })),
  ];
  for (const { file, scope, root } of sources) {
    let input: Record<string, unknown>;
    try {
      if ((await stat(file)).size > MAX_CONFIG_BYTES) throw new Error("MCP configuration exceeds 1 MiB.");
      const text = await readFile(file, "utf8");
      if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) throw new Error("MCP configuration exceeds 1 MiB.");
      const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object with mcpServers.");
      const servers = (parsed as Record<string, unknown>).mcpServers;
      if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("mcpServers must be an object.");
      input = servers as Record<string, unknown>;
      if (Object.keys(input).length > 32) throw new Error("At most 32 MCP servers may be configured per file.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      // JSON parse errors can contain credential-bearing input; report their category only.
      errors.push(`${file}: ${error instanceof SyntaxError ? "Invalid JSON; check the configuration file." : error instanceof Error ? error.message : "Could not read configuration."}`);
      continue;
    }
    for (const [name, value] of Object.entries(input)) {
      const entry: McpConfigEntry = { name, source: file, scope };
      try { entry.config = parseMcpServer(name, value, file, scope, root); }
      catch (error) { entry.error = error instanceof Error ? error.message : "Invalid server configuration."; }
      entries.set(name, entry);
    }
  }
  const merged = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (merged.length > 32) errors.push("At most 32 external MCP servers are supported per Bridge; additional entries were skipped.");
  return { entries: merged.slice(0, 32), errors, paths: mcpConfigPaths(options) };
}

export async function resolveMcpServer(config: McpServerConfig, homeDir: string | undefined, getSecret: (key: string) => Promise<string | undefined>, environment: NodeJS.ProcessEnv = process.env): Promise<{ config: McpServerConfig; secrets: string[] }> {
  const secrets: string[] = [];
  const expand = async (value: string): Promise<string> => {
    const tokens = [...value.matchAll(/\$\{([^{}]+)\}/g)];
    let expanded = "";
    let offset = 0;
    for (const match of tokens) {
      const key = match[1]!;
      let replacement: string | undefined;
      if (key === "workspaceFolder") replacement = config.workspaceRoot;
      else if (key === "userHome") replacement = homeDir;
      else if (key.startsWith("secret:")) {
        const name = key.slice(7);
        if (!SECRET_NAME.test(name)) throw new Error("Invalid credential reference.");
        replacement = await getSecret(MCP_SECRET_PREFIX + name);
      } else {
        const name = key.startsWith("env:") ? key.slice(4) : key;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Invalid environment variable reference.");
        replacement = environment[name];
      }
      if (replacement === undefined) throw new Error(`Missing configuration variable: ${key}.`);
      if (key !== "workspaceFolder" && key !== "userHome" && replacement) secrets.push(replacement);
      expanded += value.slice(offset, match.index) + replacement;
      offset = match.index! + match[0].length;
    }
    return expanded + value.slice(offset);
  };
  const expandMap = async (map: Record<string, string>): Promise<Record<string, string>> => Object.fromEntries(await Promise.all(Object.entries(map).map(async ([key, value]) => [key, await expand(value)] as const)));
  const resolved = { ...config, args: await Promise.all(config.args.map(expand)), env: await expandMap(config.env), headers: await expandMap(config.headers) };
  for (const key of ["command", "cwd", "url"] as const) if (config[key] !== undefined) resolved[key] = await expand(config[key]!);
  const homePath = (value: string) => value.startsWith("~/") || value.startsWith("~\\") ? homeDir ? path.join(homeDir, value.slice(2)) : value : value;
  if (resolved.command) resolved.command = homePath(resolved.command);
  resolved.args = resolved.args.map(homePath);
  resolved.cwd = resolved.cwd ? path.resolve(config.workspaceRoot ?? homeDir ?? process.cwd(), homePath(resolved.cwd)) : config.workspaceRoot ?? homeDir ?? process.cwd();
  if (resolved.url) {
    const url = new URL(resolved.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("MCP URLs must use HTTP(S) without embedded credentials or fragments.");
    resolved.url = url.toString();
  }
  // Literal credentials are redacted too, without exposing the configuration in status.
  secrets.push(...Object.values(resolved.env), ...Object.values(resolved.headers));
  for (const [key, value] of Object.entries(resolved.headers)) {
    if (/authorization/i.test(key)) secrets.push(value.replace(/^(Bearer|Basic)\s+/i, ""));
  }
  if (resolved.url) secrets.push(resolved.url, ...new URL(resolved.url).searchParams.values());
  return { config: resolved, secrets };
}

export function validMcpSecretName(name: string): boolean { return SECRET_NAME.test(name); }
