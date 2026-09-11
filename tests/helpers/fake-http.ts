import { EventEmitter } from "node:events";

let nextPort = 41000;

class FakeHttpServer extends EventEmitter {
  listening = false;
  private port = 0;

  listen(port: number, _host: string): this {
    this.port = port || nextPort++;
    this.listening = true;
    queueMicrotask(() => this.emit("listening"));
    return this;
  }

  address(): { port: number } {
    return { port: this.port };
  }

  close(callback?: () => void): this {
    this.listening = false;
    queueMicrotask(() => callback?.());
    return this;
  }

  closeAllConnections(): void {}
}

export function createServer(_handler?: unknown): FakeHttpServer {
  return new FakeHttpServer();
}

export const httpTest = {
  reset(): void {
    nextPort = 41000;
  },
};
