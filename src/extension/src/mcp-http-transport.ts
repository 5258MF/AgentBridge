import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

interface RequestLifetime { abort: AbortController; tokens: Set<string>; }

/** Request cancellation also covers SSE resumption without cancelling other calls. */
export class CancellableMcpHttpTransport extends StreamableHTTPClientTransport {
  private readonly pending = new Map<string, RequestLifetime>();
  private readonly tokens = new Map<string, RequestLifetime>();
  private readonly notifications: RequestLifetime = { abort: new AbortController(), tokens: new Set() };
  private closing = false;

  constructor(url: URL, headers: Record<string, string>, notificationTimeoutMs: number) {
    super(url, { requestInit: { headers }, fetch: (input, init) => this.fetchRequest(input, init, notificationTimeoutMs) });
  }

  private finish(key: string): void {
    const request = this.pending.get(key);
    if (!request) return;
    this.pending.delete(key);
    request.abort.abort();
    for (const token of request.tokens) if (this.tokens.get(token) === request) this.tokens.delete(token);
    request.tokens.clear();
  }

  private remember(request: RequestLifetime, token: string): void {
    if (this.closing || request.abort.signal.aborted || !token || token.includes("\0") || token.length > 4096) return;
    this.tokens.get(token)?.tokens.delete(token);
    this.tokens.set(token, request);
    request.tokens.delete(token);
    request.tokens.add(token);
    while (request.tokens.size > 1024) {
      const oldest = request.tokens.values().next().value!;
      request.tokens.delete(oldest);
      if (this.tokens.get(oldest) === request) this.tokens.delete(oldest);
    }
  }

  private async fetchRequest(input: Parameters<typeof fetch>[0], init: RequestInit | undefined, notificationTimeoutMs: number): Promise<Response> {
    let key: string | undefined;
    if (typeof init?.body === "string") {
      try {
        const message = JSON.parse(init.body);
        if (message.method && message.id !== undefined) key = JSON.stringify(message.id);
      } catch { /* The SDK owns payload validation. */ }
    }
    let request = key === undefined ? undefined : this.pending.get(key);
    if (init?.method === "GET") {
      const token = new Headers(init.headers).get("last-event-id");
      request = token ? this.tokens.get(token) : this.notifications;
      // A queued SDK reconnect for a cancelled/completed request must stay local.
      // 204 has no stream and stops further SDK reconnection attempts.
      if (this.closing || !request || request.abort.signal.aborted) return new Response(null, { status: 204 });
    }
    const signals = [init?.signal, request?.abort.signal].filter((signal): signal is AbortSignal => !!signal);
    if (!request && init?.method === "POST") signals.push(AbortSignal.timeout(notificationTimeoutMs));
    try {
      const response = await fetch(input, { ...init, redirect: "error", signal: signals.length ? AbortSignal.any(signals) : undefined });
      if (!request || !response.body) { if (key !== undefined) this.finish(key); return response; }
      const lifetime = request;
      const sse = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "text/event-stream";
      const decoder = new TextDecoder();
      let line = "";
      let omitted = false;
      const observe = (chunk: Uint8Array) => {
        for (const part of decoder.decode(chunk, { stream: true }).split(/(\r\n|\r|\n)/)) {
          if (/^[\r\n]+$/.test(part)) {
            if (!omitted && line.startsWith("id:")) this.remember(lifetime, line.slice(3).replace(/^ /, ""));
            line = ""; omitted = false;
          } else if (!omitted) {
            if (line.length + part.length > 8192) { line = ""; omitted = true; }
            else line += part;
          }
        }
      };
      const reader = response.body.getReader();
      const finishBody = () => { if (!sse && key !== undefined) this.finish(key); };
      const body = new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          try {
            const next = await reader.read();
            if (next.done) { finishBody(); controller.close(); }
            else { if (sse) observe(next.value); controller.enqueue(next.value); }
          } catch (error) {
            finishBody();
            if (lifetime.abort.signal.aborted) controller.close(); else controller.error(error);
          }
        },
        cancel: async (reason) => { finishBody(); await reader.cancel(reason); },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { if (key !== undefined) this.finish(key); throw error; }
  }

  override async start(): Promise<void> {
    const onmessage = this.onmessage;
    this.onmessage = (message) => {
      if (!("method" in message) && "id" in message) this.finish(JSON.stringify(message.id));
      onmessage?.(message);
    };
    await super.start();
  }

  override async send(message: JSONRPCMessage, options?: Parameters<StreamableHTTPClientTransport["send"]>[1]): Promise<void> {
    let key: string | undefined;
    if ("method" in message && "id" in message) {
      key = JSON.stringify(message.id);
      this.pending.set(key, { abort: new AbortController(), tokens: new Set() });
    } else if ("method" in message && message.method === "notifications/cancelled") this.finish(JSON.stringify(message.params?.requestId));
    try { await super.send(message, options); }
    catch (error) { if (key !== undefined) this.finish(key); throw error; }
  }

  beginClose(): void {
    this.closing = true;
    for (const key of this.pending.keys()) this.finish(key);
    this.notifications.abort.abort();
    this.tokens.clear();
    this.notifications.tokens.clear();
  }

  override async close(): Promise<void> { this.beginClose(); await super.close(); }
}
