import assert from "node:assert/strict";
import test from "node:test";
import { ManagedCommandPseudoterminal, TerminalCommandManager } from "../src/extension/src/ide-tool-broker.js";
import { vscodeTest } from "./helpers/fake-vscode.js";

type ExitEvent = { exitCode: number; signal?: number };

class FakeNodePtyProcess {
  readonly pid = 4242;
  readonly process = "fake-shell";
  killCount = 0;
  initialData = "";
  readonly writes: string[] = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: ExitEvent) => void>();

  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    if (this.initialData) queueMicrotask(() => {
      if (this.dataListeners.has(listener)) listener(this.initialData);
    });
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: ExitEvent) => void) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(): void {}

  kill(): void {
    this.killCount += 1;
  }

  emitData(data: string): void {
    for (const listener of [...this.dataListeners]) listener(data);
  }

  emitExit(exitCode: number): void {
    for (const listener of [...this.exitListeners]) listener({ exitCode });
  }

  captureExitListeners(): Array<(event: ExitEvent) => void> {
    return [...this.exitListeners];
  }
}

function promptMarker(managed: ManagedCommandPseudoterminal, cwd: string, sequence = 1, exitCode = 0): string {
  const token = (managed as any).protocolToken as string;
  const encodedCwd = Buffer.from(cwd, "utf8").toString("base64");
  return `\u001b]633;AgentBridge;${token};${sequence};${exitCode};${encodedCwd}\u0007`;
}

function makeManaged(cwd = process.cwd()): { managed: ManagedCommandPseudoterminal; process: FakeNodePtyProcess } {
  const process = new FakeNodePtyProcess();
  const managed = new ManagedCommandPseudoterminal(cwd, () => ({
    spawn: () => process,
  } as any));
  process.initialData = promptMarker(managed, cwd);
  return { managed, process };
}

async function startManaged(managed: ManagedCommandPseudoterminal): Promise<void> {
  managed.open(undefined);
  await managed.ensureStarted();
}

function commandIdFrom(text: string): string {
  const match = text.match(/^command_id: (.+)$/m);
  assert.ok(match, `missing command id in result:\n${text}`);
  return match[1];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("hard-stop atomically detaches the PTY so repeated close/dispose cannot double-kill", async () => {
  vscodeTest.reset();
  const { managed, process } = makeManaged();
  await startManaged(managed);

  let commandExitCount = 0;
  await managed.run("Start-Sleep -Seconds 300", {
    onOutput() {},
    onExit() { commandExitCount += 1; },
  });
  const queuedExitCallbacks = process.captureExitListeners();
  assert.equal(queuedExitCallbacks.length, 1);

  managed.terminateActiveProcess();
  managed.terminateActiveProcess();
  managed.close();
  managed.dispose();

  assert.equal(process.killCount, 1, "the same node-pty process must be killed at most once");
  assert.equal((managed as any).activePty, undefined);

  queuedExitCallbacks[0]({ exitCode: 1 });
  await delay(120);
  assert.equal(commandExitCount, 0, "a stale PTY exit must not finish the explicit hard-stop path again");
});

test("terminate_command marks the command killed, removes the old slot, and the next run gets a new terminal", async () => {
  vscodeTest.reset();
  const created: Array<{ managed: ManagedCommandPseudoterminal; process: FakeNodePtyProcess }> = [];
  const manager = new TerminalCommandManager((cwd) => {
    const pair = makeManaged(cwd);
    created.push(pair);
    return pair.managed;
  });

  try {
    const first = await manager.run({ command: "Start-Sleep -Seconds 300", background: true });
    const firstId = commandIdFrom(first);
    assert.match(first, /^terminal_id: terminal_1$/m);
    assert.match(first, /^status: running$/m);

    const terminated = manager.terminate({ command_id: firstId });
    assert.match(terminated, /^status: killed$/m);
    assert.equal(created[0].process.killCount, 1);
    assert.equal(((manager as any).slots as Map<string, unknown>).size, 0, "the dying terminal slot must be retired before reuse");
    assert.equal(((manager as any).states as Map<string, any>).get(firstId)?.status, "killed");

    const second = await manager.run({ command: "Write-Output 'after-hard-stop'", background: true });
    assert.equal(created.length, 2, "the next command must create a fresh managed PTY");
    assert.match(second, /^terminal_id: terminal_2$/m);
    assert.match(second, /^terminal_reused: false$/m);
    assert.match(second, /^status: running$/m);
  } finally {
    manager.dispose();
  }
});

test("natural PTY exit still flushes final output and completes the command exactly once", async () => {
  vscodeTest.reset();
  const { managed, process } = makeManaged();
  await startManaged(managed);

  const output: string[] = [];
  const exitCodes: Array<number | null> = [];
  await managed.run("Write-Output 'tail'", {
    onOutput(text) { output.push(text); },
    onExit(code) { exitCodes.push(code); },
  });

  process.emitData("Write-Output 'tail'\r\ntail\r\n");
  process.emitExit(0);
  await delay(130);

  assert.match(output.join(""), /tail/);
  assert.deepEqual(exitCodes, [0]);
  assert.equal(process.killCount, 0, "natural exit must not be converted into a hard kill");
  assert.equal((managed as any).activePty, undefined);

  process.emitExit(0);
  await delay(120);
  assert.deepEqual(exitCodes, [0], "natural exit completion must not run twice");
  managed.dispose();
  assert.equal(process.killCount, 0);
});
