import { EventEmitter } from "node:events";

type ResponseMode = "success" | "redirect" | "aborted" | "error" | "close" | "request-error" | "request-close" | "throw" | "end-throw";

class FakeIncomingMessage extends EventEmitter {
  statusCode = 200;
  complete = false;

  setEncoding(_encoding: string): this {
    return this;
  }

  resume(): this {
    this.complete = true;
    return this;
  }
}

class FakeClientRequest extends EventEmitter {
  destroyed = false;
  constructor(
    private readonly callback: (response: FakeIncomingMessage) => void,
    private readonly mode: ResponseMode,
  ) {
    super();
  }

  end(): void {
    if (this.mode === "end-throw") throw new Error("simulated request end failure");
    queueMicrotask(() => {
      if (this.mode === "request-error") {
        this.emit("error", new Error("simulated request error"));
        return;
      }
      if (this.mode === "request-close") {
        this.emit("close");
        return;
      }
      const response = new FakeIncomingMessage();
      if (this.mode === "redirect") response.statusCode = 302;
      this.callback(response);
      queueMicrotask(() => {
        if (this.mode === "success" || this.mode === "redirect") {
          response.emit("data", '{"ok":true}');
          response.complete = true;
          response.emit("end");
          response.emit("close");
        } else if (this.mode === "aborted") {
          response.emit("aborted");
        } else if (this.mode === "error") {
          response.emit("error", new Error("simulated response error"));
        } else {
          response.emit("close");
        }
      });
    });
  }

  destroy(): this {
    this.destroyed = true;
    destroyCount += 1;
    queueMicrotask(() => this.emit("close"));
    return this;
  }
}

let responseMode: ResponseMode = "success";
let requestCount = 0;
let destroyCount = 0;

export function request(
  _options: unknown,
  callback: (response: FakeIncomingMessage) => void,
): FakeClientRequest {
  requestCount += 1;
  if (responseMode === "throw") throw new Error("simulated synchronous request failure");
  return new FakeClientRequest(callback, responseMode);
}

export const httpsTest = {
  reset(): void {
    responseMode = "success";
    requestCount = 0;
    destroyCount = 0;
  },
  setResponseMode(mode: ResponseMode): void {
    responseMode = mode;
  },
  get requestCount(): number {
    return requestCount;
  },
  get destroyCount(): number {
    return destroyCount;
  },
};
