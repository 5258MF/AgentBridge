import { EventEmitter } from "node:events";

class FakeStream extends EventEmitter {
  setEncoding(): this {
    return this;
  }
}

export class FakeChildProcess extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly stdin = new FakeStream();
  readonly pid: number;
  killed = false;
  killCalls = 0;
  autoExitOnKill = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(pid: number, readonly command: string, readonly args: readonly string[]) {
    super();
    this.pid = pid;
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.killCalls += 1;
    this.killed = true;
    if (this.autoExitOnKill && this.exitCode === null && this.signalCode === null) {
      const normalizedSignal = typeof signal === "string" ? signal : "SIGTERM";
      queueMicrotask(() => this.emitExit(null, normalizedSignal));
    }
    return true;
  }

  emitStdout(text: string): void {
    this.stdout.emit("data", text);
  }

  emitStderr(text: string): void {
    this.stderr.emit("data", text);
  }

  emitExit(code: number | null = 1, signal: NodeJS.Signals | null = null): void {
    this.emitExitOnly(code, signal);
    this.emitClose(code, signal);
  }

  emitExitOnly(code: number | null = 1, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  emitClose(code: number | null = this.exitCode, signal: NodeJS.Signals | null = this.signalCode): void {
    this.emit("close", code, signal);
  }

  emitProcessError(error: Error): void {
    this.emit("error", error);
  }
}

let nextPid = 5000;
const spawned: FakeChildProcess[] = [];
type ExecResult = { stdout?: string; stderr?: string; error?: Error };
let execHandler: ((command: string, args: readonly string[]) => ExecResult | Promise<ExecResult>) | undefined;

export const childProcessTest = {
  spawned,
  reset(): void {
    spawned.length = 0;
    nextPid = 5000;
    execHandler = undefined;
  },
  setExecHandler(handler: typeof execHandler): void {
    execHandler = handler;
  },
};

export function spawn(command: string, args: readonly string[] = []): FakeChildProcess {
  const child = new FakeChildProcess(nextPid++, command, [...args]);
  spawned.push(child);
  return child;
}

export function execFile(command: string, argsOrCallback?: unknown, optionsOrCallback?: unknown, maybeCallback?: unknown): void {
  const args = Array.isArray(argsOrCallback) ? argsOrCallback.map(String) : [];
  const options = [optionsOrCallback, argsOrCallback].find((value) => value && typeof value === "object" && !Array.isArray(value)) as { signal?: AbortSignal } | undefined;
  const callback = [maybeCallback, optionsOrCallback, argsOrCallback].find((value) => typeof value === "function") as
    | ((error: Error | null, stdout?: string, stderr?: string) => void)
    | undefined;
  if (!callback) throw new Error("fake execFile requires a callback");
  queueMicrotask(() => {
    let settled = false;
    const finish = (error: Error | null, result: ExecResult = {}) => {
      if (settled) return;
      settled = true;
      options?.signal?.removeEventListener("abort", onAbort);
      callback(error, result.stdout ?? "", result.stderr ?? "");
    };
    const onAbort = () => {
      const error = new Error("The operation was aborted.");
      error.name = "AbortError";
      finish(error);
    };
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    if (options?.signal?.aborted) {
      onAbort();
      return;
    }
    void Promise.resolve(execHandler?.(command, args) ?? defaultExec(command, args)).then(
      (result) => finish(result.error ?? null, result),
      (error) => finish(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

function defaultExec(command: string, args: readonly string[]): { stdout?: string; stderr?: string; error?: Error } {
  const lower = command.toLowerCase();
  if (lower.includes("ngrok") && args[0] === "version") return { stdout: "ngrok version 3.99.0\n" };
  if (lower.includes("ngrok") && args[0] === "config" && args[1] === "check") return { stdout: "Valid configuration file\n" };
  if (lower.includes("cloudflared") && args.includes("--version")) return { stdout: "cloudflared version 2099.1.0\n" };
  if (lower.includes("taskkill")) {
    const pidIndex = args.findIndex((value) => value.toUpperCase() === "/PID");
    const pid = pidIndex >= 0 ? Number(args[pidIndex + 1]) : Number.NaN;
    const child = spawned.find((candidate) => candidate.pid === pid);
    if (child) {
      child.killed = true;
      if (child.autoExitOnKill && child.exitCode === null && child.signalCode === null) {
        queueMicrotask(() => child.emitExit(null, "SIGTERM"));
      }
    }
    return { stdout: "SUCCESS\n" };
  }
  return { stdout: "ok\n" };
}
