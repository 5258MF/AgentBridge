import test from "node:test";
import assert from "node:assert/strict";
import { markerFromOwnShell } from "../src/extension/src/ide-tool-broker.js";

test("a marker from the shell the PTY spawned is honoured", () => {
  assert.equal(markerFromOwnShell(4242, "4242"), true);
});

test("a marker from a nested or remote shell is ignored", () => {
  // bash inside ssh, a container shell via docker exec, or any nested shell inherits the
  // per-prompt hook and writes markers through the same PTY. Honouring them would end the
  // outer command early and adopt the nested shell's cwd.
  assert.equal(markerFromOwnShell(4242, "9001"), false);
});

test("a marker from an older hook without a pid is accepted", () => {
  // A terminal VS Code restored from a previous session, or a shell started before this
  // build, emits markers with no pid. It cannot be identified either way, and rejecting it
  // would hang that command — so only a positively different process is refused.
  assert.equal(markerFromOwnShell(4242, undefined), true);
  assert.equal(markerFromOwnShell(4242, ""), true);
  assert.equal(markerFromOwnShell(4242, "not-a-pid"), true);
});

test("markers are accepted when the shell pid is unknown", () => {
  // Fails open on purpose: dropping every marker would hang each command outright, which is
  // a worse failure than the one this guard prevents.
  assert.equal(markerFromOwnShell(undefined, "9001"), true);
});

test("a shell pid of zero counts as unknown", () => {
  // node-pty reports pid 0 for a ConPTY session on Windows. It is finite, so it read as a real
  // pid, and since no marker can carry 0 every marker was refused: PTY mode could never reach
  // its first prompt on such a host, and every command waited out the eight-second timeout.
  assert.equal(markerFromOwnShell(0, "9001"), true);
  assert.equal(markerFromOwnShell(-1, "9001"), true);
  assert.equal(markerFromOwnShell(0, undefined), true);
});
