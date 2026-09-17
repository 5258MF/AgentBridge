import { EventEmitter } from "node:events";

let nextPort = 41000;
let autoCompleteListen = true;
let autoCompleteClose = true;
const servers: FakeHttpServer[] = [];

export class FakeHttpServer extends EventEmitter {
  listening = false;
  private port = 0;
  private closeCallback: (() => void) | undefined;

  constructor() {
    super();
    servers.push(this);
  }

  listen(port: number, _host: string): this {
    this.port = port || nextPort++;
    if (autoCompleteListen) queueMicrotask(() => this.completeListen());
    return this;
  }

  completeListen(): void {
    this.listening = true;
    this.emit("listening");
  }

  failListen(error: Error & { code?: string }): void {
    this.listening = false;
    this.emit("error", error);
  }

  address(): { port: number } {
    return { port: this.port };
  }

  close(callback?: () => void): this {
    this.listening = false;
    this.closeCallback = callback;
    if (autoCompleteClose) queueMicrotask(() => this.completeClose());
    return this;
  }

  closeAllConnections(): void {
    this.completeClose();
  }

  completeClose(): void {
    this.listening = false;
    const callback = this.closeCallback;
    this.closeCallback = undefined;
    callback?.();
  }
}

export function createServer(_handler?: unknown): FakeHttpServer {
  return new FakeHttpServer();
}

export const httpTest = {
  servers,
  reset(): void {
    nextPort = 41000;
    autoCompleteListen = true;
    autoCompleteClose = true;
    servers.length = 0;
  },
  setAutoCompleteClose(value: boolean): void {
    autoCompleteClose = value;
  },
  setAutoCompleteListen(value: boolean): void {
    autoCompleteListen = value;
  },
};
