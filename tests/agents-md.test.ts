import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  agentsFileKey,
  detectAgentsChanges,
  directoryAgentsFiles,
  discoverAgentsFiles,
  markAgentsSent,
  MAX_AGENTS_MD_BYTES,
  projectDirectories,
  renderAgentsChanges,
  renderAgentsFiles,
} from "../src/extension/src/agents-md.js";
import { BridgeManager } from "../src/extension/src/bridge-server.js";
import { buildServerInstructions } from "../src/extension/src/server-instructions.js";
import { vscodeTest, workspace } from "./helpers/fake-vscode.js";

function tempDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-agents-")));
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** repo/.git, repo/AGENTS.md, repo/sub/AGENTS.md, repo/sub/ws/AGENTS.md, plus a home with ~/.agents/AGENTS.md. */
function fixture() {
  const base = tempDir();
  const repo = path.join(base, "repo");
  const ws = path.join(repo, "sub", "ws");
  const home = path.join(base, "home");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  write(path.join(base, "AGENTS.md"), "outside the repository");
  write(path.join(repo, "AGENTS.md"), "repo rules");
  write(path.join(repo, "sub", "AGENTS.md"), "\uFEFFsub rules\r\n");
  write(path.join(ws, "AGENTS.md"), "workspace rules");
  write(path.join(home, ".agents", "AGENTS.md"), "user rules");
  return { base, repo, ws, home };
}

test("baseline: ~/.agents/AGENTS.md, then git root down to the workspace folder", () => {
  const { base, repo, ws, home } = fixture();
  assert.deepEqual(projectDirectories(ws), [repo, path.join(repo, "sub"), ws]);
  const files = discoverAgentsFiles({ workspaceRoots: [ws], homeDir: home });
  assert.deepEqual(files.map((file) => [file.scope, file.content]), [
    ["user", "user rules"],
    ["project", "repo rules"],
    ["project", "sub rules"],
    ["project", "workspace rules"],
  ]);
  assert.ok(!files.some((file) => file.path === path.join(base, "AGENTS.md")), "nothing above the repository root");

  // Outside a repository only the folder itself counts, even if a parent has an AGENTS.md.
  const loose = path.join(base, "loose");
  write(path.join(loose, "AGENTS.md"), "loose rules");
  assert.deepEqual(projectDirectories(loose), [loose]);
  assert.deepEqual(discoverAgentsFiles({ workspaceRoots: [loose] }).map((file) => file.content), ["loose rules"]);

  // Empty files, missing files, and a repeated folder add nothing.
  write(path.join(loose, "AGENTS.md"), "  \n");
  assert.deepEqual(discoverAgentsFiles({ workspaceRoots: [loose, loose], homeDir: path.join(base, "nobody") }), []);
});

test("directory files: subfolders of the workspace, broad to specific, once", () => {
  const { ws } = fixture();
  write(path.join(ws, "pkg", "AGENTS.md"), "pkg rules");
  write(path.join(ws, "pkg", "a", "AGENTS.md"), "pkg/a rules");
  write(path.join(ws, "pkg", "a", "file.ts"), "");
  write(path.join(ws, "other", "file.ts"), "");

  const found = directoryAgentsFiles(["pkg/a/file.ts", "other/file.ts", "AGENTS.md"], [ws], new Set());
  assert.deepEqual(found.map((file) => file.content), ["pkg rules", "pkg/a rules"], "the workspace folder's own file is part of the baseline, not repeated");
  assert.ok(found.every((file) => file.scope === "directory"));

  const sent = new Set([agentsFileKey(path.join(ws, "pkg", "AGENTS.md"))]);
  assert.deepEqual(directoryAgentsFiles([path.join(ws, "pkg", "a", "file.ts")], [ws], sent).map((file) => file.content), ["pkg/a rules"]);
  assert.deepEqual(directoryAgentsFiles(["../outside.ts", "/elsewhere/x.ts"], [ws], new Set()), []);
  // A new file in a folder that does not exist yet resolves to nothing rather than guessing.
  assert.deepEqual(directoryAgentsFiles(["missing/dir/x.ts"], [ws], new Set()), []);
});

test("rendering keeps the most specific files within the budget", () => {
  const file = (name: string, size: number) => ({ path: `/r/${name}/AGENTS.md`, content: name[0].repeat(size), scope: "project" as const });
  const small = renderAgentsFiles([file("a", 10), file("b", 10)], "baseline");
  assert.ok(small);
  assert.match(small.text, /^AGENTS\.md instructions for this workspace\. Follow them\./);
  assert.match(small.text, /--- AGENTS\.md: \/r\/a\/AGENTS\.md ---\naaaaaaaaaa\n--- END AGENTS\.md ---\n\n--- AGENTS\.md: \/r\/b\/AGENTS\.md ---/);
  assert.equal(renderAgentsFiles([], "baseline"), undefined);

  const dropped = renderAgentsFiles([file("a", 20_000), file("b", 20_000)], "baseline");
  assert.ok(dropped && Buffer.byteLength(dropped.text) <= MAX_AGENTS_MD_BYTES);
  assert.deepEqual(dropped.included.map((item) => item.path), ["/r/b/AGENTS.md"], "the broader file goes first");
  assert.match(dropped.text, /Omitted to stay within 32 KB: \/r\/a\/AGENTS\.md\.$/);

  const cut = renderAgentsFiles([file("c", 50_000)], "directory");
  assert.ok(cut && Buffer.byteLength(cut.text) <= MAX_AGENTS_MD_BYTES);
  assert.match(cut.text, /^\[AgentBridge\] AGENTS\.md from a folder you just worked in\./);
  assert.match(cut.text, /\[\.\.\. cut off: this AGENTS\.md is longer than 32 KB\]\n--- END AGENTS\.md ---$/);

  const multibyte = renderAgentsFiles([{ path: "/r/AGENTS.md", content: "规则".repeat(20_000), scope: "project" }], "baseline", 1000);
  assert.ok(multibyte && Buffer.byteLength(multibyte.text) <= 1000);
  assert.ok(!multibyte.text.includes("\uFFFD"), "no split characters");
});

function makeManager(home: string): BridgeManager {
  vscodeTest.reset();
  const globalState = new Map<string, unknown>();
  const context: any = {
    extensionMode: 1,
    extension: { packageJSON: { version: "0.1.14" } },
    subscriptions: [],
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
    globalState: {
      get: <T>(key: string, fallback?: T) => (globalState.has(key) ? globalState.get(key) : fallback) as T,
      update: async (key: string, value: unknown) => { globalState.set(key, value); },
    },
  };
  const output = { append() {}, appendLine() {} } as any;
  const broker = { invokeDirect: async () => ({ text: "", isError: false }), dispose() {} } as any;
  const manager = new BridgeManager(context, output, broker);
  (manager as any).agentsHomeDir = home;
  return manager;
}

function session(): Record<string, unknown> {
  return { lastActivity: Date.now(), activeRequests: 0, activeStreams: 0, toldReadOnly: false, firstCallReminderPending: false, agentsMdBaselinePending: true, agentsMdSent: new Map() };
}

test("server instructions end with the AGENTS.md baseline", async () => {
  const { ws, home } = fixture();
  const originalFolders = workspace.workspaceFolders;
  workspace.workspaceFolders = [{ uri: { fsPath: ws } }];
  try {
    const manager = makeManager(home);
    const { server, transport } = (manager as any).createSession({}, 0);
    const instructions = (server as any)._instructions as string;
    assert.ok(instructions.startsWith(`${buildServerInstructions(false)}\n\nAGENTS.md instructions for this workspace.`));
    assert.ok(instructions.indexOf("user rules") < instructions.indexOf("repo rules"));
    assert.ok(instructions.indexOf("repo rules") < instructions.indexOf("workspace rules"));
    await Promise.allSettled([transport.close(), server.close()]);

    const empty = makeManager(path.join(ws, "no-home"));
    workspace.workspaceFolders = [{ uri: { fsPath: tempDir() } }];
    const bare = (empty as any).createSession({}, 0);
    assert.equal((bare.server as any)._instructions, buildServerInstructions(false), "no AGENTS.md, no change");
    await Promise.allSettled([bare.transport.close(), bare.server.close()]);
  } finally {
    workspace.workspaceFolders = originalFolders;
  }
});

test("first tool result repeats the baseline; a subfolder AGENTS.md rides once on read_files and apply_patch", async () => {
  const { ws, home } = fixture();
  write(path.join(ws, "pkg", "AGENTS.md"), "pkg rules");
  write(path.join(ws, "pkg", "file.ts"), "export const a = 1;\n");
  write(path.join(ws, "lib", "AGENTS.md"), "lib rules");
  write(path.join(ws, "top.ts"), "top\n");
  const originalFolders = workspace.workspaceFolders;
  workspace.workspaceFolders = [{ uri: { fsPath: ws } }];
  try {
    const manager = makeManager(home);
    const sessions = (manager as any).sessions as Map<string, Record<string, unknown>>;
    sessions.set("s1", session());
    const call = (tool: string, args: Record<string, unknown>, sessionId = "s1") => (manager as any).handleToolCall(tool, args, { sessionId });

    // Edit ~/.agents/AGENTS.md after initialize: the first result reads it afresh.
    write(path.join(home, ".agents", "AGENTS.md"), "user rules v2");
    const first = await call("read_files", { files: [{ path: "top.ts" }] });
    const firstText = first.content[0].text as string;
    assert.ok(firstText.startsWith("[AgentBridge] AGENTS.md instructions for this workspace."));
    assert.match(firstText, /user rules v2[\s\S]*repo rules[\s\S]*sub rules[\s\S]*workspace rules[\s\S]*--- END AGENTS\.md ---\n\nThe result of this call follows\.\n\n/);
    assert.equal(first.content.length, 1, "top.ts is in the workspace folder itself: no directory notice");

    const second = await call("read_files", { files: [{ path: "pkg/file.ts" }] });
    assert.ok(!(second.content[0].text as string).includes("AGENTS.md instructions"), "the baseline is sent once");
    assert.equal(second.content.length, 2);
    assert.match(second.content[1].text, /^\[AgentBridge\] AGENTS\.md from a folder you just worked in\.[\s\S]*pkg rules/);

    const third = await call("read_files", { files: [{ path: "pkg/file.ts" }] });
    assert.equal(third.content.length, 1, "each directory file is sent once per session");

    const failed = await call("read_files", { files: [{ path: "lib/missing.ts" }] });
    assert.ok(!failed.content.some((item: any) => /lib rules/.test(item.text ?? "")), "failed reads do not count");

    const patched = await call("apply_patch", { patch: "*** Begin Patch\n*** Add File: lib/new.ts\n+x\n*** End Patch" });
    assert.equal(patched.isError, undefined);
    assert.match(patched.content[patched.content.length - 1].text, /lib rules/);

    // A new session starts over, and the Plan mode reminder follows the baseline.
    manager.setReadOnlyMode(true);
    sessions.set("s2", { ...session(), toldReadOnly: true, firstCallReminderPending: true });
    const planned = await call("read_files", { files: [{ path: "top.ts" }] }, "s2");
    const plannedText = planned.content[0].text as string;
    assert.ok(plannedText.startsWith("[AgentBridge] AGENTS.md instructions"));
    assert.match(plannedText, /--- END AGENTS\.md ---\n\n\[AgentBridge notice\] This connection is in Plan mode/);
    assert.equal(plannedText.match(/The result of this call follows\./g)?.length, 1);
  } finally {
    workspace.workspaceFolders = originalFolders;
  }
});

test("change detection: edited, new, deleted, and emptied files", () => {
  const { ws, home, repo } = fixture();
  write(path.join(ws, "pkg", "AGENTS.md"), "pkg rules");
  const sent = new Map();
  markAgentsSent(sent, discoverAgentsFiles({ workspaceRoots: [ws], homeDir: home }));
  markAgentsSent(sent, directoryAgentsFiles(["pkg/AGENTS.md"], [ws], sent));
  const now = () => detectAgentsChanges(sent, discoverAgentsFiles({ workspaceRoots: [ws], homeDir: home }));
  assert.deepEqual(now(), { updated: [], removed: [] }, "nothing changed");

  write(path.join(home, ".agents", "AGENTS.md"), "user rules v2");
  write(path.join(ws, "pkg", "AGENTS.md"), "pkg rules v2");
  fs.rmSync(path.join(repo, "sub", "AGENTS.md"));
  const changes = now();
  assert.deepEqual(changes.updated.map((file) => file.content), ["user rules v2", "pkg rules v2"]);
  assert.deepEqual(changes.removed, [path.join(repo, "sub", "AGENTS.md")]);
  const text = renderAgentsChanges(changes);
  assert.ok(text);
  assert.match(text, /^\[AgentBridge\] AGENTS\.md changed since it was sent to you\./);
  assert.match(text, /user rules v2[\s\S]*pkg rules v2/);
  assert.match(text, /No longer applies \(deleted or emptied\), so ignore its earlier instructions: .*sub.AGENTS\.md\.$/);

  // Emptying a directory file counts as removal; a removal alone still renders.
  write(path.join(ws, "pkg", "AGENTS.md"), " ");
  const emptied = detectAgentsChanges(new Map([...sent].filter(([, file]) => file.scope === "directory")), []);
  assert.deepEqual(emptied.removed, [path.join(ws, "pkg", "AGENTS.md")]);
  assert.match(renderAgentsChanges(emptied) ?? "", /^\[AgentBridge\] AGENTS\.md changed[\s\S]*No longer applies/);
  assert.equal(renderAgentsChanges({ updated: [], removed: [] }), undefined);
});

test("mid-session: AGENTS.md changes reach the next tool result once; the model's own edits are not echoed", async () => {
  const { ws, home } = fixture();
  write(path.join(ws, "top.ts"), "top\n");
  const originalFolders = workspace.workspaceFolders;
  workspace.workspaceFolders = [{ uri: { fsPath: ws } }];
  try {
    const manager = makeManager(home);
    const sessions = (manager as any).sessions as Map<string, Record<string, unknown>>;
    sessions.set("s1", session());
    const call = (tool: string, args: Record<string, unknown>) => (manager as any).handleToolCall(tool, args, { sessionId: "s1" });
    const text = (result: any) => result.content.map((item: any) => item.text ?? "").join("\n");

    await call("read_files", { files: [{ path: "top.ts" }] }); // baseline
    assert.ok(!text(await call("read_files", { files: [{ path: "top.ts", start_line: 1, end_line: 1 }] })).includes("AGENTS.md changed"), "no change, no notice");

    write(path.join(ws, "AGENTS.md"), "workspace rules v2: do not touch tests");
    const changed = await call("read_files", { files: [{ path: "top.ts", start_line: 1, end_line: 2 }] });
    assert.match(changed.content[0].text, /^\[AgentBridge\] AGENTS\.md changed since it was sent to you\.[\s\S]*workspace rules v2: do not touch tests[\s\S]*The result of this call follows\.\n\n/);
    assert.ok(!text(changed).includes("repo rules"), "only the changed file is resent");
    assert.ok(!text(await call("read_files", { files: [{ path: "top.ts", start_line: 1, end_line: 3 }] })).includes("AGENTS.md changed"), "sent once");

    // A new AGENTS.md in the home folder is reported too.
    fs.rmSync(path.join(home, ".agents", "AGENTS.md"));
    const removed = await call("read_files", { files: [{ path: "top.ts", start_line: 1, end_line: 4 }] });
    assert.match(removed.content[0].text, /No longer applies[^\n]*\.agents.AGENTS\.md/);
    write(path.join(home, ".agents", "AGENTS.md"), "user rules again");
    assert.match((await call("read_files", { files: [{ path: "top.ts", start_line: 1, end_line: 5 }] })).content[0].text, /user rules again/);

    // The model edits the workspace AGENTS.md itself: no echo on the next call.
    const patched = await call("apply_patch", { patch: "*** Begin Patch\n*** Update File: AGENTS.md\n@@\n-workspace rules v2: do not touch tests\n+workspace rules v3\n*** End Patch" });
    assert.equal(patched.isError, undefined, text(patched));
    assert.ok(!text(await call("read_files", { files: [{ path: "top.ts", start_line: 1, end_line: 6 }] })).includes("AGENTS.md changed"), "the model's own edit is not echoed");
  } finally {
    workspace.workspaceFolders = originalFolders;
  }
});

test("repeated identical calls earn reminders at 3, 5, and 8; anything different resets the count", async () => {
  const { ws } = fixture();
  write(path.join(ws, "top.ts"), "top\n");
  const originalFolders = workspace.workspaceFolders;
  workspace.workspaceFolders = [{ uri: { fsPath: ws } }];
  try {
    const manager = makeManager(path.join(ws, "no-home"));
    let commandStatus = "running";
    (manager as any).ideToolBroker = { invokeDirect: async () => ({ text: `command_id: cmd_1\nstatus: ${commandStatus}`, isError: false }), dispose() {} };
    const sessions = (manager as any).sessions as Map<string, Record<string, unknown>>;
    sessions.set("s1", { ...session(), agentsMdBaselinePending: false });
    const call = (tool: string, args: Record<string, unknown>) => (manager as any).handleToolCall(tool, args, { sessionId: "s1" });
    const reminder = (result: any) => result.content.map((item: any) => item.text ?? "").find((item: string) => item.startsWith("[AgentBridge notice] You have now called"));

    const seen: Array<string | undefined> = [];
    for (let index = 1; index <= 9; index += 1) seen.push(reminder(await call("read_files", { files: [{ end_line: 5, path: "top.ts" }] })));
    assert.deepEqual(seen.map((item, index) => (item ? index + 1 : 0)).filter(Boolean), [3, 5, 8]);
    assert.equal(seen[2], "[AgentBridge notice] You have now called read_files 3 times in a row with identical arguments. Check whether the previous results changed. If they did not, repeating the call will not help: change your approach, or stop and tell the user what is blocking you.");

    // Same arguments in a different key order still count; a different call resets.
    await call("read_files", { files: [{ path: "top.ts", start_line: 1, end_line: 7 }] });
    await call("read_files", { files: [{ path: "top.ts", end_line: 5 }] });
    await call("read_files", { files: [{ end_line: 5, path: "top.ts" }] });
    assert.ok(reminder(await call("read_files", { files: [{ path: "top.ts", end_line: 5 }] })), "third in a row after the reset");

    // Failed calls count too: that is the typical loop.
    for (let index = 1; index <= 2; index += 1) await call("read_files", { files: [{ path: "missing.ts" }] });
    assert.ok(reminder(await call("read_files", { files: [{ path: "missing.ts" }] })));

    // Waiting on a running command is exempt; polling a finished one is not.
    for (let index = 1; index <= 4; index += 1) assert.equal(reminder(await call("get_command_output", { command_id: "cmd_1" })), undefined);
    commandStatus = "completed";
    assert.ok(reminder(await call("get_command_output", { command_id: "cmd_1" })), "5th identical call, command finished");
  } finally {
    workspace.workspaceFolders = originalFolders;
  }
});
