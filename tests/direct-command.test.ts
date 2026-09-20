import assert from "node:assert/strict";
import test from "node:test";
import { childProcessTest } from "./helpers/fake-child-process.js";
import {
  directCommandArgv,
  TerminalCommandManager,
} from "../src/extension/src/ide-tool-broker.js";
import type { ShellChoice } from "../src/extension/src/ide-tool-broker.js";
import { vscodeTest } from "./helpers/fake-vscode.js";

/**
 * Execution mode "direct" runs the command as a one-shot child process, so none of the PTY
 * machinery is involved and none of the PTY tests reach it. Everything here is driven through
 * the same public entry point the tool uses, with the child process supplied by the harness.
 */
function manager(): TerminalCommandManager {
  // A direct command consumes no terminal slot, so the factory must never be called; throwing
  // is the point, because it would mean the run had fallen back to the PTY path.
  return new TerminalCommandManager(() => {
    throw new Error("a direct command must not acquire a managed terminal");
  });
}

function field(text: string, name: string): string {
  const match = text.match(new RegExp(`^${name}: (.+)$`, "m"));
  assert.ok(match, `missing ${name} in result:\n${text}`);
  return match[1]!;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function direct(command: string, timeoutMs = 5_000): Promise<string> {
  return manager().run({ command, background: false, timeout_ms: timeoutMs, execution: "direct" });
}

function commandIds(commands: TerminalCommandManager): string[] {
  return [...(commands as unknown as { states: Map<string, unknown> }).states.keys()];
}

test("a direct command reports the child's exit code and output", async () => {
  vscodeTest.reset();
  childProcessTest.reset();
  const pending = direct("echo hi");
  await delay(0);

  const child = childProcessTest.spawned.at(-1);
  assert.ok(child, "the command must be spawned as a child process");
  child.emitStdout("hi\n");
  child.emitExit(0);

  const result = await pending;
  assert.equal(field(result, "execution"), "direct");
  assert.equal(field(result, "status"), "completed");
  assert.equal(field(result, "exit_code"), "0");
  assert.match(result, /hi/);
});

test("a direct command reports a negative PowerShell exit as a signed code", async () => {
  // PowerShell hands `exit -1` back as an unsigned 32-bit value, which would otherwise be
  // shown to callers as 4294967295.
  vscodeTest.reset();
  childProcessTest.reset();
  const pending = direct("exit -1");
  await delay(0);

  childProcessTest.spawned.at(-1)!.emitExit(0xffffffff);

  const result = await pending;
  assert.equal(field(result, "status"), "failed");
  assert.equal(field(result, "exit_code"), "-1");
});

test("a terminated direct command kills the child and settles as killed", async () => {
  vscodeTest.reset();
  childProcessTest.reset();
  const commands = manager();
  const pending = commands.run({
    command: "Start-Sleep -Seconds 300",
    background: false,
    timeout_ms: 5_000,
    execution: "direct",
  });
  await delay(0);

  const child = childProcessTest.spawned.at(-1)!;
  const ids = commandIds(commands);
  assert.equal(ids.length, 1, "the running command must be the only state");

  const terminated = commands.terminate({ command_id: ids[0]! });
  assert.equal(field(terminated, "status"), "killed");
  assert.equal(child.killed, true, "the child process must actually be killed");

  const result = await pending;
  assert.equal(field(result, "status"), "killed");
  assert.equal(field(result, "exit_code"), "null");
});

test("concurrent direct commands are capped", async () => {
  vscodeTest.reset();
  childProcessTest.reset();
  const commands = manager();
  const started: Array<Promise<string>> = [];
  for (let index = 0; index < 8; index += 1) {
    started.push(commands.run({ command: `sleep ${index}`, background: false, timeout_ms: 5_000, execution: "direct" }));
  }
  await delay(0);
  assert.equal(childProcessTest.spawned.length, 8);

  await assert.rejects(
    () => commands.run({ command: "sleep 9", background: false, timeout_ms: 5_000, execution: "direct" }),
    /Too many concurrent direct commands/,
  );

  for (const child of childProcessTest.spawned) {
    child.emitStdout("done\n");
    child.emitExit(0);
  }
  await Promise.all(started);
});

test("a direct command that never started reports no exit code", async () => {
  // When the executable does not exist, Windows fires 'error' and then 'close' with -4058.
  // That is not an exit status at all, it is the spawn failure already written to the
  // command's own output.
  vscodeTest.reset();
  childProcessTest.reset();
  const pending = manager().run({
    command: "definitely-not-a-real-program",
    background: false,
    timeout_ms: 5_000,
    execution: "direct",
  });
  await delay(0);

  const child = childProcessTest.spawned.at(-1)!;
  child.emitProcessError(new Error("spawn definitely-not-a-real-program ENOENT"));
  child.emitExit(-4058);

  const result = await pending;
  assert.equal(field(result, "status"), "failed");
  assert.equal(field(result, "exit_code"), "null");
  assert.match(result, /failed to start the direct command/);
});

test("a direct run hands each shell the switch it understands", () => {
  // cmd was handed -c, which is a POSIX switch: it has no -c at all, so every direct command
  // on a cmd-managed host was passed an argument the shell reported as an error instead of a
  // command. /d /s /c is the shape that neither runs an AutoRun entry nor re-quotes the text.
  const shell = (kind: ShellChoice["kind"]): ShellChoice => ({ kind, executable: kind, description: kind, syntaxHint: "" });
  assert.deepEqual(directCommandArgv(shell("cmd"), "echo hi"), ["/d", "/s", "/c", "echo hi"]);
  for (const kind of ["bash", "zsh", "sh", "fish"] as const) {
    assert.deepEqual(directCommandArgv(shell(kind), "echo hi"), ["-c", "echo hi"], kind);
  }
});
