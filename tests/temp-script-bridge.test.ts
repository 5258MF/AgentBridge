import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "./helpers/real-child-process.js";
import {
  isPowerShellKind,
  needsTempScript,
  tempScriptCommand,
  writeTempScript,
} from "../src/extension/src/ide-tool-broker.js";
import type { ShellChoice } from "../src/extension/src/ide-tool-broker.js";

function choice(kind: ShellChoice["kind"], executable: string): ShellChoice {
  return { kind, executable, description: executable, syntaxHint: "" };
}

function removeScript(script: string): void {
  fs.rmSync(script, { force: true });
  const directory = path.dirname(script);
  if (path.basename(directory).startsWith("agentbridge-run-")) fs.rmSync(directory, { recursive: true, force: true });
}

test("only commands that cannot survive the readline layer are bridged", () => {
  assert.equal(needsTempScript("Get-ChildItem"), false);
  assert.equal(needsTempScript("x".repeat(1024)), false);
  assert.equal(needsTempScript("x".repeat(1025)), true);
  assert.equal(needsTempScript("a\nb"), true);
  assert.equal(needsTempScript("a\r\nb"), true);
  assert.equal(needsTempScript("Write-Host 你好"), true);
});

test("isPowerShellKind follows the shell family rather than the platform", () => {
  assert.equal(isPowerShellKind("ps51"), true);
  assert.equal(isPowerShellKind("pwsh"), true);
  assert.equal(isPowerShellKind("bash"), false);
  assert.equal(isPowerShellKind("zsh"), false);
});

test("the bridged script is chosen by shell family, not by platform", () => {
  const written = [
    writeTempScript("t-ps51", "x", "ps51"),
    writeTempScript("t-pwsh", "x", "pwsh"),
    writeTempScript("t-bash", "x", "bash"),
    writeTempScript("t-zsh", "x", "zsh"),
  ];
  assert.equal(written[0]!.endsWith(".ps1"), true);
  assert.equal(written[1]!.endsWith(".ps1"), true);
  assert.equal(written[2]!.endsWith(".sh"), true);
  assert.equal(written[3]!.endsWith(".sh"), true);
  for (const script of written) removeScript(script);
});

test("a bridged script does not land where the next one can be guessed", () => {
  // The script used to sit at os.tmpdir()/agentbridge-run-<commandId>.(ps1|sh), and the
  // command id is a timestamp and a counter: anything on the machine could put a symlink or a
  // file at the next one and have the command's text written through it. Each script now gets
  // a directory mkdtemp creates, so the path is not knowable before it exists.
  const first = writeTempScript("same-id", "Write-Output one", "ps51");
  const second = writeTempScript("same-id", "Write-Output two", "ps51");
  try {
    assert.notEqual(first, second, "two commands with one id must not share a path");
    assert.notEqual(path.dirname(first), path.dirname(second), "two commands must not share a directory");
    for (const script of [first, second]) {
      const directory = path.dirname(script);
      assert.equal(path.dirname(directory), os.tmpdir(), script);
      assert.ok(path.basename(directory).startsWith("agentbridge-run-"), directory);
      assert.ok(path.basename(directory).length > "agentbridge-run-".length, "the directory name has a random suffix");
    }
    assert.equal(fs.readFileSync(first, "utf8").includes("one"), true);
    assert.equal(fs.readFileSync(second, "utf8").includes("two"), true);
  } finally {
    for (const script of [first, second]) removeScript(script);
  }
});

test("a bridged script is readable only by the account that owns it", () => {
  // A bridged command can carry a secret, and the PowerShell branch used to write with no mode
  // at all. Windows ignores the mode bits beyond the read-only one, so this reads them where
  // they mean something.
  if (process.platform === "win32") return;
  const ps = writeTempScript("mode-ps", "x", "ps51");
  const sh = writeTempScript("mode-sh", "x", "bash");
  try {
    assert.equal(fs.statSync(ps).mode & 0o777, 0o600, ps);
    assert.equal(fs.statSync(sh).mode & 0o777, 0o700, sh);
  } finally {
    removeScript(ps);
    removeScript(sh);
  }
});

test("the invocation runs the managed shell, not a hard-coded one", () => {
  const ps = tempScriptCommand("/tmp/s.ps1", choice("pwsh", "C:\\Program Files\\PowerShell\\7\\pwsh.exe"));
  assert.ok(ps.includes('"C:\\Program Files\\PowerShell\\7\\pwsh.exe"'), ps);
  assert.ok(ps.includes("-File"), ps);
  const sh = tempScriptCommand("/tmp/s.sh", choice("zsh", "/usr/local/bin/zsh"));
  assert.ok(sh.includes("/usr/local/bin/zsh"), sh);
  assert.equal(sh.includes("-File"), false, sh);
});

const powershell = process.platform === "win32"
  ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  : undefined;

function runScript(script: string): number {
  try {
    execFileSync(powershell!, ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
      stdio: "pipe",
    });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? -1;
  }
}

test("a managed shell path with quoting metacharacters cannot break out", () => {
  const nasty = "C:\\evil`\"path$(x)";
  const ps = tempScriptCommand("C:\\tmp\\s.ps1", choice("pwsh", nasty));
  assert.ok(ps.includes("``"), "backticks must be escaped");
  assert.ok(ps.includes('`"'), "embedded quotes must be escaped");
  const sh = tempScriptCommand("/tmp/s.sh", choice("bash", "/opt/we'ird/bin/sh"));
  assert.ok(sh.includes(`'\\''`), sh);
});

test("the Windows payload keeps its BOM, prelude and exit guard", { skip: !powershell }, () => {
  const script = writeTempScript("t-payload", "Write-Output 'hello'", "ps51");
  try {
    const raw = fs.readFileSync(script);
    assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = raw.toString("utf8");
    assert.ok(text.includes("[Console]::OutputEncoding"), text);
    assert.ok(text.includes("-ne 0"), "the guard must require a non-zero code");
    assert.ok(text.includes("Write-Output 'hello'"), text);
  } finally {
    removeScript(script);
  }
});

test("a failed native command propagates its exit code", { skip: !powershell }, () => {
  const script = writeTempScript("t-native", "cmd /c exit 42", "ps51");
  try {
    assert.equal(runScript(script), 42);
  } finally {
    removeScript(script);
  }
});

test("a failed cmdlet is not masked as exit 0", { skip: !powershell }, () => {
  const script = writeTempScript("t-cmdlet", "cmd /c exit 0\r\nGet-Item 'C:\\agentbridge-no-such-path'", "ps51");
  try {
    assert.equal(runScript(script), 1);
  } finally {
    removeScript(script);
  }
});

test("a later successful statement still exits 0", { skip: !powershell }, () => {
  const script = writeTempScript("t-later", "cmd /c exit 42\r\nWrite-Output 'done'", "ps51");
  try {
    assert.equal(runScript(script), 0);
  } finally {
    removeScript(script);
  }
});
