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
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(pid: number, readonly command: string, readonly args: readonly string[]) {
    super();
    this.pid = pid;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  emitStdout(text: string): void {
    this.stdout.emit("data", text);
  }

  emitStderr(text: string): void {
    this.stderr.emit("data", text);
  }

  emitExit(code: number | null = 1, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }

  emitProcessError(error: Error): void {
    this.emit("error", error);
  }
}

let nextPid = 5000;
const spawned: FakeChildProcess[] = [];
let execHandler: ((command: string, args: readonly string[]) => { stdout?: string; stderr?: string; error?: Error }) | undefined;

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
  const callback = [maybeCallback, optionsOrCallback, argsOrCallback].find((value) => typeof value === "function") as
    | ((error: Error | null, stdout?: string, stderr?: string) => void)
    | undefined;
  if (!callback) throw new Error("fake execFile requires a callback");
  queueMicrotask(() => {
    const result = execHandler?.(command, args) ?? defaultExec(command, args);
    if (result.error) callback(result.error, result.stdout ?? "", result.stderr ?? "");
    else callback(null, result.stdout ?? "", result.stderr ?? "");
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
    if (child) child.killed = true;
    return { stdout: "SUCCESS\n" };
  }
  return { stdout: "ok\n" };
}
