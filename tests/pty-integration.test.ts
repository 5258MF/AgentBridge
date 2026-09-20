import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "./helpers/real-child-process.js";
import { writeTempScript, removeTempScript } from "../src/extension/src/ide-tool-broker.js";

/**
 * Integration coverage for the parts of the shell bridge that only a real shell can settle.
 *
 * The unit tests drive the broker with a fake child process, which is the right thing for
 * logic but cannot answer the questions this file exists for: does a script written by
 * writeTempScript survive a real readline, does a non-ASCII payload come back intact through
 * the console code page, does a nested shell hand back an exit code the outer one reports,
 * and does the native-exit guard still propagate a failure instead of masking it.
 *
 * Opt in with AGENTBRIDGE_PTY_INTEGRATION=1. Shells that are not installed are skipped, so
 * the file is safe to run anywhere; it just covers less there.
 */
const enabled = process.env.AGENTBRIDGE_PTY_INTEGRATION === "1";

type ShellKind = "ps51" | "pwsh" | "cmd" | "bash" | "zsh" | "sh" | "fish";

interface RealShell {
  kind: ShellKind;
  executable: string;
  label: string;
}

/**
 * Whether "bash" on PATH is the WSL launcher rather than a shell.
 *
 * On Windows it often is: C:\Windows\System32\bash.exe starts WSL instead of being a POSIX
 * shell, so it is a different world from the Git Bash the extension targets, and launching it
 * may be blocked outright by policy. Resolved by reading PATH, never by running anything.
 */
function isWslLauncher(executable: string): boolean {
  if (process.platform !== "win32" || path.isAbsolute(executable)) return false;
  const system32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32").toLowerCase();
  const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, executable + extension);
      if (fs.existsSync(candidate)) return path.dirname(candidate).toLowerCase() === system32;
    }
  }
  return false;
}

function candidateShells(): RealShell[] {
  const found: RealShell[] = [];
  // "bash" resolves to WSL on some Windows setups, which is a different POSIX world from the
  // Git Bash the extension actually targets. Let the caller name the shell under test.
  const candidates: RealShell[] = [
    { kind: "bash", executable: process.env.AGENTBRIDGE_PTY_BASH || "bash", label: "bash" },
    { kind: "pwsh", executable: process.env.AGENTBRIDGE_PTY_PWSH || "pwsh", label: "PowerShell 7" },
  ];
  for (const shell of candidates) {
    if (isWslLauncher(shell.executable)) continue;
    try {
      execFileSync(shell.executable, shell.kind === "pwsh" ? ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"] : ["-c", "echo ok"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      });
      found.push(shell);
    } catch {
      // Not installed, or not usable here: skip rather than fail the suite.
    }
  }
  return found;
}

interface RunResult {
  status: number;
  stdout: string;
}

function runScript(shell: RealShell, command: string): RunResult {
  const id = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const scriptPath = writeTempScript(id, command, shell.kind);
  try {
    const args = shell.kind === "pwsh"
      ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath]
      : [scriptPath];
    try {
      const stdout = execFileSync(shell.executable, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      });
      return { status: 0, stdout: stdout ?? "" };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string };
      return { status: typeof failure.status === "number" ? failure.status : -1, stdout: failure.stdout ?? "" };
    }
  } finally {
    removeTempScript(scriptPath);
  }
}

const out = (text: string): string => text.replace(/\r\n/g, "\n");

const shells = enabled ? candidateShells() : [];

test("a bridged script reports the command's own exit code", { skip: !enabled || shells.length === 0 }, () => {
  for (const shell of shells) {
    const payload = shell.kind === "pwsh" ? "exit 7" : "exit 7";
    const result = runScript(shell, payload);
    assert.equal(result.status, 7, `${shell.label}: expected exit 7, got ${result.status}`);
  }
});

test("a failed command on the last line is not masked by the exit guard", { skip: !enabled || shells.length === 0 }, () => {
  for (const shell of shells) {
    // The guard exists for the case where the *final* statement failed: powershell -File
    // otherwise exits 0 and the failure disappears. A successful statement after the
    // failure is a different command and is allowed to end the script successfully.
    if (shell.kind === "pwsh") {
      const result = runScript(shell, "Write-Output 'before'\ncmd /c exit 9");
      assert.equal(result.status, 9, `PowerShell 7: expected 9, got ${result.status}`);
      continue;
    }
    const result = runScript(shell, "echo before\nfalse");
    assert.notEqual(result.status, 0, `bash: a failed last command must not exit 0`);
  }
});

test("non-ASCII text survives the bridge byte for byte", { skip: !enabled || shells.length === 0 }, () => {
  const payload = "你好 κόσμος — ünïcödé ✓";
  for (const shell of shells) {
    const echo = shell.kind === "pwsh" ? `Write-Output '${payload}'` : `echo '${payload}'`;
    const result = runScript(shell, echo);
    assert.match(out(result.stdout), /你好 κόσμος — ünïcödé ✓/, `${shell.label}: ${JSON.stringify(result.stdout)}`);
  }
});

test("a multi-line command runs every line, in order", { skip: !enabled || shells.length === 0 }, () => {
  for (const shell of shells) {
    const payload = shell.kind === "pwsh"
      ? "Write-Output 'one'\nWrite-Output 'two'\nWrite-Output 'three'"
      : "echo one\necho two\necho three";
    const result = runScript(shell, payload);
    assert.equal(out(result.stdout).trim(), "one\ntwo\nthree", `${shell.label}: ${JSON.stringify(result.stdout)}`);
  }
});

test("a nested shell hands its exit code to the outer one", { skip: !enabled || shells.length === 0 }, () => {
  for (const shell of shells) {
    if (shell.kind === "pwsh") {
      const result = runScript(shell, "pwsh -NoProfile -Command 'exit 5'");
      assert.equal(result.status, 5, `PowerShell 7: expected 5, got ${result.status}`);
      continue;
    }
    const result = runScript(shell, "bash -c 'echo inner; exit 5'");
    assert.match(out(result.stdout), /inner/, `bash: ${JSON.stringify(result.stdout)}`);
    assert.equal(result.status, 5, `bash: expected 5, got ${result.status}`);
  }
});

test("a script written into a path with spaces still runs", { skip: !enabled || shells.length === 0 }, () => {
  // writeTempScript writes into os.tmpdir(); on Windows that is under a user profile whose
  // path can contain spaces, and an unquoted invocation would hand the shell two arguments.
  const temp = os.tmpdir();
  assert.equal(fs.existsSync(temp), true);
  for (const shell of shells) {
    const payload = shell.kind === "pwsh" ? "Write-Output 'spaced'" : "echo spaced";
    const result = runScript(shell, payload);
    assert.match(out(result.stdout), /spaced/, `${shell.label}: ${JSON.stringify(result.stdout)}`);
    if (/\s/.test(temp)) {
      assert.equal(result.status, 0, `${shell.label}: a spaced temp path must not break the invocation`);
    }
  }
});

test("the temp script is removed after the run", { skip: !enabled || shells.length === 0 }, async () => {
  const shell = shells[0]!;
  const id = `leftover-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const scriptPath = writeTempScript(id, shell.kind === "pwsh" ? "Write-Output 'x'" : "echo x", shell.kind);
  assert.equal(fs.existsSync(scriptPath), true, "the script must exist before it is removed");
  assert.equal(path.basename(path.dirname(scriptPath)).startsWith("agentbridge-run-"), true);
  removeTempScript(scriptPath);
  // Removal is fire-and-forget with one delayed retry, so it is not synchronous.
  for (let waited = 0; waited < 3_000 && fs.existsSync(scriptPath); waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(fs.existsSync(scriptPath), false, "removeTempScript must delete the script");
});
