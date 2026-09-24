// HTTP plumbing for the MCP endpoint: request body parsing, JSON error responses, browser Origin
// checks, and the bounded event store used for SSE resumption.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EventStore } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import * as vscode from "vscode";

const TRUSTED_BROWSER_ORIGINS_SETTING = "bridge.trustedBrowserOrigins";
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const SESSION_EVENT_STORE_LIMIT = 512;
// Replay only matters when a response stream drops mid-delivery. Idle sessions keep this buffer
// until they expire, so it is kept small: 64 sessions x 2 MiB bounds the worst case at 128 MiB.
export const SESSION_EVENT_STORE_MAX_BYTES = 2 * 1024 * 1024;

export class BoundedInMemoryEventStore implements EventStore {
  private readonly events = new Map<string, { streamId: string; message: JSONRPCMessage; sizeBytes: number }>();
  private readonly order: string[] = [];
  private sequence = 0;
  private totalBytes = 0;

  constructor(
    private readonly limit = SESSION_EVENT_STORE_LIMIT,
    private readonly maxBytes = SESSION_EVENT_STORE_MAX_BYTES,
  ) {}

  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const eventId = `${Date.now().toString(36)}-${(++this.sequence).toString(36)}-${randomUUID()}`;
    const sizeBytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    this.events.set(eventId, { streamId, message, sizeBytes });
    this.order.push(eventId);
    this.totalBytes += sizeBytes;
    // An individual event larger than the byte budget is still assigned an id for the live
    // response, but is evicted immediately and therefore cannot be replayed after disconnect.
    while (this.order.length > this.limit || this.totalBytes > this.maxBytes) {
      const oldest = this.order.shift();
      if (!oldest) break;
      const removed = this.events.get(oldest);
      if (removed) this.totalBytes = Math.max(0, this.totalBytes - removed.sizeBytes);
      this.events.delete(oldest);
    }
    return eventId;
  }

  async getStreamIdForEventId(eventId: string): Promise<string | undefined> {
    return this.events.get(eventId)?.streamId;
  }

  async replayEventsAfter(lastEventId: string, { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> }): Promise<string> {
    const previous = this.events.get(lastEventId);
    // The SDK validates the cursor with getStreamIdForEventId() immediately before replay,
    // but another request can still evict that event while the await continuation is queued.
    // Fail the resume instead of returning an empty stream id, which the SDK would otherwise
    // register as a resumable "ghost" stream that can never receive the intended events.
    if (!previous) throw new Error("MCP replay cursor expired before replay could begin.");
    let found = false;
    for (const eventId of this.order) {
      if (eventId === lastEventId) {
        found = true;
        continue;
      }
      if (!found) continue;
      const event = this.events.get(eventId);
      if (event?.streamId === previous.streamId) {
        await send(eventId, event.message);
      }
    }
    return previous.streamId;
  }
}

export function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_REQUEST_BYTES) {
        reject(new Error(`MCP request body exceeds ${MAX_REQUEST_BYTES} bytes.`));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("MCP request body is not valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

export function writeJsonError(response: ServerResponse, statusCode: number, message: string): void {
  if (response.headersSent) return;
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({
    jsonrpc: "2.0",
    error: { code: statusCode === 404 ? -32004 : -32000, message },
    id: null,
  }));
}

/**
 * Constant-time string comparison for secret-bearing values such as route-token paths.
 * Both sides are hashed to fixed-length SHA-256 digests first, so timingSafeEqual never
 * throws on length mismatch and the comparison time does not leak the secret's length.
 */
export function constantTimeStringEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}

export function normalizeTrustedBrowserOrigin(value: string): string | undefined {
  const candidate = value.trim();
  if (!candidate || candidate.includes("*") || candidate.includes("?") || candidate.includes("#")) return undefined;

  try {
    const origin = new URL(candidate);
    if (origin.username || origin.password || origin.search || origin.hash) return undefined;
    if (origin.pathname && origin.pathname !== "/") return undefined;
    if (!origin.hostname) return undefined;

    if (origin.protocol === "http:" || origin.protocol === "https:") {
      return candidate === origin.origin ? origin.origin : undefined;
    }
    if (origin.protocol === "chrome-extension:" || origin.protocol === "moz-extension:") {
      if (origin.port) return undefined;
      const normalized = `${origin.protocol}//${origin.hostname.toLowerCase()}`;
      return candidate === normalized ? normalized : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function readTrustedBrowserOrigins(): string[] {
  const configured = vscode.workspace.getConfiguration("agentbridge").get<unknown>(TRUSTED_BROWSER_ORIGINS_SETTING, []);
  if (!Array.isArray(configured)) return [];

  const trustedOrigins: string[] = [];
  for (const value of configured) {
    if (typeof value !== "string") continue;
    const normalized = normalizeTrustedBrowserOrigin(value);
    if (normalized && !trustedOrigins.includes(normalized)) trustedOrigins.push(normalized);
  }
  return trustedOrigins;
}

export function validateMcpOrigin(
  request: IncomingMessage,
  allowedHostnames: readonly string[],
  trustedOrigins: readonly string[],
): { allowed: true; origin?: string } | { allowed: false } {
  const originHeader = request.headers.origin;
  if (!originHeader) return { allowed: true };

  try {
    const normalizedOrigin = normalizeTrustedBrowserOrigin(originHeader);
    if (!normalizedOrigin) return { allowed: false };
    const origin = new URL(normalizedOrigin);
    const normalizedHostname = origin.hostname.toLowerCase();
    const allowedBuiltInOrigin = (origin.protocol === "http:" || origin.protocol === "https:")
      && allowedHostnames.some((hostname) => hostname.toLowerCase() === normalizedHostname);
    if (!allowedBuiltInOrigin && !trustedOrigins.includes(normalizedOrigin)) return { allowed: false };
    return { allowed: true, origin: normalizedOrigin };
  } catch {
    return { allowed: false };
  }
}
