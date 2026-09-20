import assert from "node:assert/strict";
import test from "node:test";
import { childProcessTest } from "./helpers/fake-child-process.js";
import { describeShellChoice, inferShellKindFromPath, sanityCheckManagedShellPath } from "../src/extension/src/ide-tool-broker.js";

test("a Windows bash or zsh override keeps its own family", () => {
  // Git Bash ships an absolute bash.exe, and the managed shell resolution used to route every
  // unrecognised Windows name through the PowerShell description, which then spawned bash with
  // -NoLogo -NoProfile -Command.
  const cases: Array<[string, string]> = [
    ["C:\\Program Files\\Git\\bin\\bash.exe", "bash"],
    ["C:\\Program Files\\Git\\usr\\bin\\zsh.exe", "zsh"],
  ];
  for (const [executable, kind] of cases) {
    assert.equal(inferShellKindFromPath(executable, "ps51"), kind, executable);
    const choice = describeShellChoice(inferShellKindFromPath(executable, "ps51"), executable);
    assert.equal(choice.kind, kind);
    assert.equal(choice.executable, executable);
    assert.match(choice.syntaxHint, new RegExp(kind, "i"));
  }
});

test("the PowerShell families are still described from their own name", () => {
  const ps51 = describeShellChoice(inferShellKindFromPath("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "bash"), "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(ps51.kind, "ps51");
  assert.match(ps51.syntaxHint, /5\.1/);
  const pwsh = describeShellChoice(inferShellKindFromPath("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "bash"), "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  assert.equal(pwsh.kind, "pwsh");
  assert.match(pwsh.syntaxHint, /7/);
});

test("the launch probe uses the shell's own argument syntax", async () => {
  // A single -NoProfile -Command probe made every bash/zsh path on Windows fail the panel's
  // check, so a valid Git Bash shell could never be saved.
  const cases: Array<[string, string[]]> = [
    ["C:\\Program Files\\Git\\bin\\bash.exe", ["-c", "exit 0"]],
    ["C:\\Windows\\System32\\cmd.exe", ["/c", "exit 0"]],
    ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-NoProfile", "-Command", "exit 0"]],
    ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", ["-NoProfile", "-Command", "exit 0"]],
  ];
  for (const [executable, args] of cases) {
    childProcessTest.reset();
    const pending = sanityCheckManagedShellPath(executable);
    const child = childProcessTest.spawned.at(-1);
    assert.ok(child, executable);
    assert.deepEqual([...child.args], args, executable);
    child.emitExit(0);
    assert.equal(await pending, true, executable);
  }
});
