import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { COMMON_EXCLUDE_GLOBS, excludeDirectoryNames } from "./find-files.js";
import { boundedInteger, boundedNotes, describeValue } from "./bounded-integer.js";
import { canonicalWorkspaceRoots, defaultWorkspaceRoot, isInsideAnyRoot, isInsideAnyWorkspaceRoot, isInsideRoot, workspaceRootHolding, workspaceRoots } from "./workspace-roots.js";
import { getIdeToolDefinition } from "./ide-tool-definitions.js";
import { invokeLspTool } from "./lsp-tool.js";
import { translate } from "./i18n.js";
const t = translate;
const MAX_CAPTURED_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_COMPLETED_STATES = 32;
const DEFAULT_OUTPUT_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_IDLE_TERMINALS = 4;
const MAX_TOTAL_TERMINALS = 8;

/** Direct commands own no terminal, so the pool ceiling above never applies to them. */
const MAX_CONCURRENT_DIRECT_COMMANDS = 8;
const PTY_EXIT_DATA_FLUSH_MS = 100;
const COMMAND_ECHO_TIMEOUT_MS = 3000;
const MAX_ECHO_HUNT_BYTES = 1024 * 1024;
const MANAGED_TERMINAL_NAME = /^AgentBridge · \d+$/;
/** Shell kinds with a per-prompt hook that can emit the OSC 633 protocol marker. */
const RUN_COMMAND_SHELLS: ReadonlySet<ShellChoice["kind"]> = new Set(["ps51", "pwsh", "bash", "zsh"]);

interface TerminalSlot {
  id: string;
  terminal: vscode.Terminal;
  pty: ManagedCommandPseudoterminal;
  initialCwd: string;
  busyCommandId?: string;
  closed: boolean;
  /**
   * A slot whose shell never reported ready. Its terminal is left on screen so whatever the
   * shell printed can be read, and the slot is never handed out again - but it is still a slot,
   * so the terminal can be opened and the pool can reclaim it.
   */
  broken?: boolean;
  lastUsedAt: number;
}

/** Most worth keeping first: a working terminal before a broken one, then the most recently used. */
function byLeastUseful(a: TerminalSlot, b: TerminalSlot): number {
  return Number(Boolean(a.broken)) - Number(Boolean(b.broken)) || b.lastUsedAt - a.lastUsedAt;
}

interface CommandState {
  id: string;
  /** PTY execution kind. Null for "direct" one-shot child processes, which own no terminal. */
  terminal: vscode.Terminal | null;
  terminalId: string;
  terminalName: string;
  terminalReused: boolean;
  /** Terminal slot for PTY commands; absent for "direct" child processes. */
  slot?: TerminalSlot;
  execution: "pty" | "direct";
  command: string;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  background: boolean;
  status: "running" | "completed" | "failed" | "killed";
  exitCode: number | null;
  // Captured output as a chunk list. outputChunkStarts[i] is the absolute output offset of
  // outputChunks[i]'s first byte, letting readOutput binary-search straight to the chunk
  // holding a requested offset. outputChunkHead marks the first live chunk and outputHeadSkip
  // the offset within it (not an absolute output offset); trimming drops whole chunks so
  // appends stay amortized O(1) under sustained output.
  outputChunks: Buffer[];
  outputChunkStarts: number[];
  outputChunkHead: number;
  outputHeadSkip: number;
  retainedOutputBytes: number;
  outputStartOffset: number;
  totalOutputBytes: number;
  ansiPending: string;
  /** Temp script the command was bridged through, unlinked once the command finishes. */
  tempScriptPath?: string;
  /** Live child process for "direct" commands, kept so terminate() can kill it. */
  child?: ChildProcess;
  done: Promise<void>;
  resolveDone(): void;
}

interface ManagedShellSpec {
  executable: string;
  args: string[];
  env?: Record<string, string>;
  description: string;
  syntaxHint: string;
  /** Directory created for zsh ZDOTDIR injection; the pseudoterminal removes it on dispose. */
  tempDir?: string;
}

/**
 * Pure shell choice with no protocolToken embedding, cached per-broker.
 * Decouples "which shell kind" (depends only on platform + config) from
 * "build PTY spawn args" (depends on per-PTY protocol token). Cache layer
 * lets configureManagedShell message invalidate after a config change so
 * next McpServer session / PTY spawn sees the new shell kind.
 */
export interface ShellChoice {
  readonly kind: "ps51" | "pwsh" | "cmd" | "bash" | "zsh" | "sh" | "fish";
  readonly executable: string;
  readonly description: string;
  readonly syntaxHint: string;
}

let cachedShellChoice: ShellChoice | null = null;
let cachedShellWarning: string | null = null;

const MANAGED_SHELL_WINDOWS_SETTING = "managedShell.windows";
const MANAGED_SHELL_UNIX_SETTING = "managedShell.unix";

/**
 * Evict the oldest finished command states until at most `cap` finished entries remain.
 * Running states — including in-flight background commands, whose `status` stays "running"
 * until they finish — are never evicted.
 *
 * Eviction follows completion order, not Map insertion order. Insertion order is start
 * order, and the two disagree whenever a long-running background command settles after a
 * burst of short ones: pruning by start order would then evict that background command from
 * inside its own finishState, so `run_command` would hand the agent a command_id that
 * `get_command_output` no longer knows about. Completion order makes the command that just
 * settled the newest finished entry and therefore the last one at risk.
 */
export function pruneFinishedCommandStates(states: Map<string, CommandState>, cap: number): void {
  const finished: Array<[string, number]> = [];
  for (const [id, state] of states) {
    if (state.status === "running") continue;
    finished.push([id, state.endedAt ?? state.startedAt]);
  }
  if (finished.length <= cap) return;
  finished.sort((left, right) => left[1] - right[1]);
  const excess = finished.length - cap;
  for (let index = 0; index < excess; index++) {
    states.delete(finished[index]![0]);
  }
}

function resolveOverrideManagedShell(): string {
  const section = process.platform === "win32" ? MANAGED_SHELL_WINDOWS_SETTING : MANAGED_SHELL_UNIX_SETTING;
  return vscode.workspace.getConfiguration("agentbridge.bridge").get<string>(section, "").trim();
}

function lookupOnPathEnv(name: string): string | null {
  const pathEnv = process.env.PATH;
  if (!pathEnv) return null;
  const ext = process.platform === "win32" ? process.env.PATHEXT ?? ".EXE;.CMD;.BAT" : "";
  const exts = ext ? ext.split(path.delimiter).filter(Boolean) : [""];
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const e of exts) {
      const candidate = path.join(dir, e === "" ? name : name + e);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch { /* ignore */ }
    }
  }
  return null;
}

/**
 * Infer the shell family from a file name. The fallback only applies when the name carries no
 * known shell stem, so a renamed PowerShell is treated as PowerShell rather than as bash.
 */
export function inferShellKindFromPath(executable: string, fallback: ShellChoice["kind"]): ShellChoice["kind"] {
  const base = path.basename(executable).toLowerCase();
  const stem = base.replace(/\.(exe|bat|cmd)$/i, "");
  if (stem === "pwsh") return "pwsh";
  if (stem === "powershell") return "ps51";
  if (stem === "cmd") return "cmd";
  if (stem === "bash") return "bash";
  if (stem === "zsh") return "zsh";
  if (stem === "fish") return "fish";
  if (stem === "sh") return "sh";
  return fallback;
}

function describePwshShell(executable: string): ShellChoice {
  return {
    kind: "pwsh",
    executable,
    description: "long-lived PowerShell 7+ (pwsh.exe) with -NoProfile per terminal slot",
    syntaxHint: "Prefer PowerShell 7+ syntax; you may use && and || as pipeline chain operators, ternary conditionals ( cond ? a : b ), null-coalescing assignment ??=, Get-Uptime, Get-Date -AsUTC.",
  };
}

function describePs51Shell(executable: string): ShellChoice {
  return {
    kind: "ps51",
    executable,
    description: "long-lived system Windows PowerShell 5.1 (powershell.exe) with -NoProfile per terminal slot",
    syntaxHint: "Prefer Windows PowerShell 5.1 syntax; avoid PowerShell 7+-only operators (&& and ||, ternary, ??=, Get-Uptime). Use semicolons ; to sequence commands and $LASTEXITCODE for native exit handling.",
  };
}

function describeCmdShell(executable: string): ShellChoice {
  return {
    kind: "cmd",
    executable,
    description: "long-lived Windows Command Prompt (cmd.exe /K) per terminal slot",
    syntaxHint: "Prefer cmd.exe syntax: %VAR% for environment variables (no $VAR), & for sequential commands, && and || for conditional, REM or :: for comments; no pipelines, no here-strings.",
  };
}

function describePosixShell(executable: string, kind: "bash" | "zsh" | "sh" | "fish"): ShellChoice {
  const syntaxByKind: Record<typeof kind, string> = {
    bash: "Prefer POSIX bash syntax; you may use && / || / pipelines, $VAR, export. Avoid Bash-only syntax if running under generic sh.",
    zsh: "Prefer zsh syntax; you may use && / || / pipelines, $VAR, export, zsh arrays, glob qualifiers.",
    sh: "Prefer POSIX sh syntax (subset of bash); you may use && / || / pipelines, $VAR, export. Avoid Bash-only syntax.",
    fish: "Prefer fish syntax; use && / || / pipelines, $VAR, set -x VAR value. Avoid Bash-style arrays and subshells.",
  };
  return {
    kind,
    executable,
    description: `long-lived native PTY with ${path.basename(executable)} (-noprofile -i) per terminal slot`,
    syntaxHint: syntaxByKind[kind],
  };
}

/**
 * Describe a shell from its family. Kept separate from the resolvers so the mapping from a
 * file name to a description has one definition, shared by every platform branch.
 */
export function describeShellChoice(kind: ShellChoice["kind"], executable: string): ShellChoice {
  switch (kind) {
    case "pwsh": return describePwshShell(executable);
    case "ps51": return describePs51Shell(executable);
    case "cmd": return describeCmdShell(executable);
    default: return describePosixShell(executable, kind);
  }
}

function resolveManagedShellChoice(): ShellChoice {
  const override = resolveOverrideManagedShell();
  if (override === "") {
    // defaults below
  } else if (process.platform === "win32") {
    if (!path.isAbsolute(override)) {
      throw new Error(t("managedShellWindowsNeedsAbsolutePath", override));
    }
    if (!fs.existsSync(override)) {
      throw new Error(t("managedShellWindowsNotFound", override));
    }
    // Git Bash and MSYS zsh are absolute .exe paths like any Windows shell, so the POSIX
    // families have to be recognised here too: falling through to PowerShell would spawn them
    // with -NoLogo -NoProfile -Command, which none of them understands.
    const kind = inferShellKindFromPath(override, "ps51");
    if (kind === "pwsh" || kind === "ps51" || kind === "cmd" || kind === "bash" || kind === "zsh") {
      return describeShellChoice(kind, override);
    }
    throw new Error(t("managedShellWindowsUnsupported", override));
  } else {
    const resolved = path.isAbsolute(override) ? override : lookupOnPathEnv(override);
    if (resolved === null) {
      throw new Error(t("managedShellUnixNotOnPath", override));
    }
    if (path.isAbsolute(override) && !fs.existsSync(override)) {
      throw new Error(t("managedShellUnixNotFound", override));
    }
    const kind = inferShellKindFromPath(resolved, "bash");
    if (kind === "bash" || kind === "zsh" || kind === "sh" || kind === "fish") {
      return describePosixShell(resolved, kind);
    }
    // Windows-kind path on POSIX — unlikely; fall back to bash description
    return describePosixShell(resolved, "bash");
  }

  // defaults: Windows PowerShell 5.1, POSIX /bin/bash then /bin/sh
  if (process.platform === "win32") {
    const windowsRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
    const executable = path.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (!fs.existsSync(executable)) {
      throw new Error(t("managedShellWindowsDefaultMissing", executable));
    }
    return describePs51Shell(executable);
  }
  if (fs.existsSync("/bin/bash")) return describePosixShell("/bin/bash", "bash");
  if (fs.existsSync("/bin/sh")) return describePosixShell("/bin/sh", "sh");
  throw new Error(t("managedShellUnixDefaultMissing"));
}

export function getManagedShellChoice(): ShellChoice {
  if (cachedShellChoice) return cachedShellChoice;
  try {
    cachedShellChoice = resolveManagedShellChoice();
    cachedShellWarning = null;
  } catch (error) {
    cachedShellWarning = error instanceof Error ? error.message : String(error);
    // Hard fallback: skip override and try defaults directly without try/catch.
    cachedShellChoice = resolveManagedShellChoiceHardFallback();
  }
  return cachedShellChoice;
}

function resolveManagedShellChoiceHardFallback(): ShellChoice {
  if (process.platform === "win32") {
    const windowsRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
    const executable = path.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return describePs51Shell(executable);
  }
  if (fs.existsSync("/bin/bash")) return describePosixShell("/bin/bash", "bash");
  return describePosixShell("/bin/sh", "sh");
}

export function invalidateManagedShellCache(): void {
  cachedShellChoice = null;
  cachedShellWarning = null;
}

export function managedShellExecutable(): string {
  return getManagedShellChoice().executable;
}

export function managedShellOverrideWarning(): string | null {
  return cachedShellWarning;
}

/**
 * Sanity check whether an absolute shell path is actually launchable with
 * -NoProfile -Command "exit 0" (PowerShell), /c "exit 0" (cmd) or -c "exit 0"
 * (POSIX shells). Returns false on non-zero exit or timeout error. Caller (panel)
 * uses this before writing the config so invalid paths never silently fall back at
 * Bridge Start time.
 *
 * The probe arguments follow the shell family, not the platform: on Windows a Git Bash
 * bash.exe still has to be probed as bash, because PowerShell's -NoProfile/-Command pair
 * is not a bash option and makes every otherwise valid bash path fail the check.
 */
export function sanityCheckManagedShellPath(candidatePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const kind = inferShellKindFromPath(candidatePath, process.platform === "win32" ? "ps51" : "bash");
    const args =
      kind === "cmd" ? ["/c", "exit 0"]
        : kind === "bash" || kind === "zsh" || kind === "sh" || kind === "fish" ? ["-c", "exit 0"]
          : ["-NoProfile", "-Command", "exit 0"];
    const options = process.platform === "win32" ? { windowsHide: true, timeout: 2000 } : { timeout: 2000 };
    const child = spawn(candidatePath, args, options);
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

interface NodePtyDisposable {
  dispose(): void;
}

interface NodePtyProcess {
  readonly pid: number;
  readonly process: string;
  onData(listener: (data: string) => void): NodePtyDisposable;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): NodePtyDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cwd: string;
      env: Record<string, string>;
      cols: number;
      rows: number;
    },
  ): NodePtyProcess;
}

let nodePtyModule: NodePtyModule | undefined;

function getNodePty(): NodePtyModule {
  if (nodePtyModule) return nodePtyModule;

  const candidates = [
    path.join(vscode.env.appRoot, "node_modules.asar", "node-pty"),
    path.join(vscode.env.appRoot, "node_modules", "node-pty"),
  ];
  let lastError: unknown;
  for (const modulePath of candidates) {
    try {
      if (!fs.existsSync(modulePath)) continue;
      const loaded = require(modulePath) as Partial<NodePtyModule>;
      if (typeof loaded.spawn !== "function") throw new Error("module does not export spawn()");
      nodePtyModule = loaded as NodePtyModule;
      return nodePtyModule;
    } catch (error) {
      lastError = error;
    }
  }

  const detail = lastError instanceof Error ? ` ${lastError.message}` : "";
  throw new Error(`AgentBridge could not load the bundled node-pty runtime from ${vscode.env.appRoot}.${detail}`);
}

function managedShellSpec(protocolToken: string): ManagedShellSpec {
  const choice = getManagedShellChoice();
  const markerPrefix = `\u001b]633;AgentBridge;${protocolToken};`;
  switch (choice.kind) {
    case "ps51":
    case "pwsh": {
      const initializePrompt = [
        "$global:__AgentBridgePromptSequence = 0",
        "$global:LASTEXITCODE = 0",
        "function global:prompt {",
        "  $agentBridgeSuccess = $?",
        "  $agentBridgeNativeExit = $global:LASTEXITCODE",
        "  if ($agentBridgeSuccess) { $agentBridgeExit = 0 } elseif (($null -ne $agentBridgeNativeExit) -and ([int]$agentBridgeNativeExit -ne 0)) { $agentBridgeExit = [int]$agentBridgeNativeExit } else { $agentBridgeExit = 1 }",
        "  $global:LASTEXITCODE = 0",
        "  $global:__AgentBridgePromptSequence++",
        "  $agentBridgeCwd = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Location).Path))",
        `  [Console]::Write("${markerPrefix}$global:__AgentBridgePromptSequence;$agentBridgeExit;$agentBridgeCwd;$PID\u0007")`,
        "  \"PS $($executionContext.SessionState.Path.CurrentLocation)> \"",
        "}",
      ].join("; ");
      return {
        executable: choice.executable,
        args: [
          "-NoLogo",
          "-NoProfile",
          "-NoExit",
          "-ExecutionPolicy", "Bypass",
          "-Command",
          `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; ${initializePrompt}`,
        ],
        description: choice.description,
        syntaxHint: choice.syntaxHint,
      };
    }
    case "bash": {
      const promptCommand = [
        "__agentbridge_ec=$?",
        "__agentbridge_seq=$((${__agentbridge_seq:-0}+1))",
        "__agentbridge_cwd=$(printf '%s' \"$PWD\" | base64 | tr -d '\\r\\n')",
        `printf '\\033]633;AgentBridge;${protocolToken};%s;%s;%s;%s\\007' \"$__agentbridge_seq\" \"$__agentbridge_ec\" \"$__agentbridge_cwd\" \"$$\"`,
      ].join("; ");
      return {
        executable: choice.executable,
        args: ["--noprofile", "--norc", "-i"],
        env: {
          PROMPT_COMMAND: promptCommand,
          PS1: "$ ",
        },
        description: choice.description,
        syntaxHint: choice.syntaxHint,
      };
    }
    case "zsh": {
      // zsh has no PROMPT_COMMAND; the per-prompt hook is `precmd`, which must be defined
      // from a startup file. Point ZDOTDIR at a generated temp dir so zsh sources our
      // .zshrc (and only ours — user rc files under $ZDOTDIR are isolated automatically).
      // The marker payload order (seq;ec;cwd;pid) must match handleProtocolMarker's split().
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-zsh-"));
      const zshrc = [
        "PROMPT='$ '",
        "__agentbridge_seq=0",
        "precmd() {",
        "  __agentbridge_ec=$?",
        "  __agentbridge_seq=$((__agentbridge_seq + 1))",
        "  __agentbridge_cwd=$(printf '%s' \"$PWD\" | base64 | tr -d '\\r\\n')",
        `  printf '\\033]633;AgentBridge;${protocolToken};%s;%s;%s;%s\\007' \"$__agentbridge_seq\" \"$__agentbridge_ec\" \"$__agentbridge_cwd\" \"$$\"`,
        "}",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(tempDir, ".zshrc"), zshrc, "utf8");
      return {
        executable: choice.executable,
        args: ["-i"],
        env: { ZDOTDIR: tempDir },
        tempDir,
        description: choice.description,
        syntaxHint: choice.syntaxHint,
      };
    }
    default:
      // Unreachable via run_command: TerminalCommandManager.run() rejects unsupported
      // shells before any PTY is spawned. Kept as defense in depth for exhaustive match.
      throw new Error(
        `Managed shell "${choice.description}" does not support the AgentBridge prompt protocol.`,
      );
  }
}

function managedProcessEnvironment(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  // This process is intentionally independent from VS Code's terminal shell-integration
  // injection. In particular, do not leak an outer terminal's integration markers into it.
  delete env.VSCODE_INJECTION;
  delete env.VSCODE_NONCE;
  delete env.VSCODE_SHELL_INTEGRATION;
  delete env.PROMPT_COMMAND;
  delete env.PS1;
  delete env.ENV;
  delete env.BASH_ENV;
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.AGENTBRIDGE_AGENT_TERMINAL = "1";
  if (process.platform === "win32") {
    // Prefer the bundled PSReadLine over the Windows in-box 2.0.0, whose negative
    // cursor-position handling produces ConPTY rendering artifacts. ConsoleHost resolves
    // PSReadLine through PSModulePath and the first entry wins; the vendor payload contains
    // only PSReadLine, so nothing else is shadowed.
    const vendorModules = bundledModulesDir();
    if (vendorModules) env.PSModulePath = `${vendorModules};${env.PSModulePath ?? ""}`;
  }
  return env;
}

let cachedBundledModulesDir: string | undefined | null;

/**
 * The PowerShell modules shipped under the extension's vendor/ directory. Resolved relative to
 * the compiled bundle first (dist/..) and then relative to the installed extension layout.
 * Returns undefined when the payload is absent, so the shell silently falls back to the
 * in-box PSReadLine instead of failing to start.
 */
function bundledModulesDir(): string | undefined {
  if (cachedBundledModulesDir === null) return undefined;
  if (cachedBundledModulesDir) return cachedBundledModulesDir;
  const candidates = [
    path.join(__dirname, "..", "vendor"),
    path.join(vscode.env.appRoot, "extensions", "agentbridge", "vendor"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "PSReadLine", "PSReadLine.psd1"))) {
      cachedBundledModulesDir = dir;
      return dir;
    }
  }
  cachedBundledModulesDir = null;
  return undefined;
}

/**
 * Whether the text carries a raw control character (C0 or DEL), i.e. a keystroke rather than
 * printable input. Those are never echoed back byte-for-byte, so they cannot anchor the echo
 * gate.
 */
function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export class ManagedCommandPseudoterminal implements vscode.Pseudoterminal, vscode.Disposable {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writeEmitter.event;
  private readonly closeEmitter = new vscode.EventEmitter<void | number>();
  readonly onDidClose = this.closeEmitter.event;
  private readonly protocolToken = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  private readonly protocolPrefix = `\u001b]633;AgentBridge;${this.protocolToken};`;
  private readonly openPromise: Promise<void>;
  private resolveOpen!: () => void;
  private startPromise: Promise<void> | undefined;
  private ready = false;
  private readyResolver: (() => void) | undefined;
  private readyRejecter: ((error: Error) => void) | undefined;
  private protocolBuffer = "";
  // Echo gate state. The shell renders the typed command (and agent-sent input) back into the
  // PTY output stream (PSReadLine/Readline/tty echo), and ConPTY can deliver that rendering
  // late, interleaved with stale prompts, full-screen redraws (chat capture resizes the PTY
  // before each command) and cooked-echo/PSReadLine redraw races. The gate consumes the echo
  // so none of it leaks into the terminal display or the captured tool result.
  private echoExpectation = "";
  private echoMatchIndex = 0;
  private echoGateActive = false;
  private echoHuntBytesRemaining = 0;
  private echoHuntDiscardAll = false;
  private echoHuntingPromptLine = false;
  private echoTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
  private activePty: NodePtyProcess | undefined;
  /** Pid of the shell this PTY spawned, used to tell its markers from a nested shell's. */
  private shellPid: number | undefined;
  private activePtyDataSubscription: NodePtyDisposable | undefined;
  private activePtyExitSubscription: NodePtyDisposable | undefined;
  private activeCommand: {
    sequence: number;
    finishing?: boolean;
    finishExitCode?: number | null;
    finishTimer?: ReturnType<typeof setTimeout>;
    onOutput(text: string): void;
    onExit(code: number | null): void;
  } | undefined;
  private nextCommandSequence = 1;
  private currentCwdValue: string;
  private cols = 80;
  private rows = 24;
  private disposed = false;
  private tempDir: string | undefined;

  constructor(
    private readonly initialCwd: string,
    private readonly loadNodePty: () => NodePtyModule = getNodePty,
  ) {
    this.currentCwdValue = initialCwd;
    this.openPromise = new Promise<void>((resolve) => { this.resolveOpen = resolve; });
  }

  get currentCwd(): string {
    return this.currentCwdValue;
  }

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    if (initialDimensions) {
      this.cols = Math.max(1, initialDimensions.columns);
      this.rows = Math.max(1, initialDimensions.rows);
    }
    this.resolveOpen();
  }

  close(): void {
    this.dispose();
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.cols = Math.max(1, dimensions.columns);
    this.rows = Math.max(1, dimensions.rows);
    if (!this.activePty) return;
    try {
      this.activePty.resize(this.cols, this.rows);
    } catch {
      // A PTY may exit between the dimensions event and resize().
    }
  }

  handleInput(data: string): void {
    if (!this.activePty) return;
    this.activePty.write(data);
  }

  writeDisplay(text: string): void {
    if (!this.disposed) this.writeEmitter.fire(text);
  }

  sendInput(text: string, appendNewline: boolean): void {
    if (!this.activePty) {
      throw new Error("The AgentBridge managed PTY is not accepting input.");
    }
    // Interactive programs (REPLs, prompts) echo agent-typed input back into the PTY stream;
    // consume that echo so it never pollutes the captured tool result. handleInput() (user
    // keystrokes) stays ungated on purpose: its echo is the visible feedback in the view.
    //
    // A terminal never echoes a control character as the byte that was sent: Ctrl+C comes
    // back as "^C" or an equivalent escape sequence, never as ETX. Gating on the raw byte
    // therefore keeps the gate closed until the timeout while discarding everything the
    // interrupt produced — and send_command_input is the documented cooperative interrupt,
    // so the agent would conclude the command ignored it and escalate to terminate_command.
    if (hasControlCharacter(text)) {
      this.resetEchoGate();
    } else {
      this.echoExpectation = text.replace(/[\r\n]+/g, "");
      this.echoMatchIndex = 0;
      this.echoHuntBytesRemaining = MAX_ECHO_HUNT_BYTES;
      // Discard everything (bounded) until the echo anchor: a REPL may render its prompt
      // (">>> ") plus stale redraw content in the same chunk that precedes the echo.
      this.echoHuntDiscardAll = true;
      this.echoHuntingPromptLine = false;
      this.echoGateActive = true;
      this.armEchoTimeout();
    }
    this.activePty.write(appendNewline ? `${text}\r` : text);
  }

  async ensureStarted(): Promise<void> {
    if (!this.startPromise) this.startPromise = this.startPersistentShell();
    return this.startPromise;
  }

  async run(
    command: string,
    handlers: {
      onOutput(text: string): void;
      onExit(code: number | null): void;
    },
  ): Promise<void> {
    await this.ensureStarted();
    if (this.disposed) throw new Error("The AgentBridge managed terminal is closed.");
    if (!this.activePty) throw new Error("The AgentBridge managed PTY shell is not running.");
    if (this.activeCommand) throw new Error("The AgentBridge managed terminal is already running a command.");
    const sequence = this.nextCommandSequence++;
    this.activeCommand = { sequence, ...handlers };
    this.writeDisplay(`${command.replace(/\r?\n/g, "\r\n")}\r\n`);
    const normalizedCommand = command.replace(/[\r\n]+/g, "");
    // Arm the echo gate BEFORE writing: every byte that arrives from the PTY after the write
    // is either the echo (consume it) or noise that precedes it (stale prompt, resize redraw);
    // the timeout bounds how long the gate may stay closed when no echo ever renders.
    this.echoExpectation = normalizedCommand;
    this.echoMatchIndex = 0;
    this.echoHuntBytesRemaining = MAX_ECHO_HUNT_BYTES;
    // Discard everything (bounded) until the echo anchor for every run: a resize redraws the
    // whole screen, and a previous command's restore-resize redraw can be delivered late
    // into the next command's gate window (background snapshots showed the previous commands'
    // full history). Hunting discards that noise and keeps only the echo.
    this.echoHuntDiscardAll = true;
    this.echoHuntingPromptLine = false;
    this.echoGateActive = true;
    this.armEchoTimeout();
    try {
      // Type the command exactly as a user would. No protocol prefix is written into the
      // input stream: the shell's echo of the typed line is consumed by the echo gate in
      // emitPtyData(), so the terminal view, the shell history, and error source lines never
      // show protocol scaffolding.
      this.activePty.write(`${command}\r`);
    } catch (error) {
      this.activeCommand = undefined;
      this.resetEchoGate();
      this.restoreDisplayDimensions();
      throw error;
    }
  }

  private restoreDisplayDimensions(): void {
    if (!this.activePty) return;
    try {
      this.activePty.resize(this.cols, this.rows);
    } catch {
      // The PTY may have exited while the command was completing.
    }
  }

  private async startPersistentShell(): Promise<void> {
    await this.openPromise;
    if (this.disposed) throw new Error("The AgentBridge managed terminal is closed.");
    const shell = managedShellSpec(this.protocolToken);
    this.tempDir = shell.tempDir;
    const env = { ...managedProcessEnvironment(), ...shell.env };
    let ptyProcess: ReturnType<NodePtyModule["spawn"]>;
    try {
      ptyProcess = this.loadNodePty().spawn(shell.executable, shell.args, {
        name: process.platform === "win32" ? "cmd" : "xterm-256color",
        cwd: this.initialCwd,
        env,
        cols: this.cols,
        rows: this.rows,
      });
    } catch (error) {
      if (this.tempDir) {
        try {
          fs.rmSync(this.tempDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup of the zsh ZDOTDIR scratch dir.
        }
        this.tempDir = undefined;
      }
      throw error;
    }
    this.shellPid = ptyProcess.pid;
    this.activePty = ptyProcess;

    this.activePtyDataSubscription = ptyProcess.onData((data) => {
      this.handlePtyData(data);
    });
    this.activePtyExitSubscription = ptyProcess.onExit((event) => {
      setTimeout(() => {
        // terminateActiveProcess() atomically detaches a killed PTY before calling kill().
        // A node-pty exit event may already be queued at that point; never let a stale event
        // finish/clear the command state that now belongs to the explicit hard-stop path.
        if (this.activePty !== ptyProcess) return;
        this.activePty = undefined;
        const activeCommand = this.activeCommand;
        this.activeCommand = undefined;
        if (activeCommand?.finishTimer) {
          clearTimeout(activeCommand.finishTimer);
          activeCommand.finishTimer = undefined;
        }
        if (!this.ready) {
          this.readyRejecter?.(new Error(`AgentBridge managed PTY shell exited before its first prompt (exit_code=${event.exitCode}).`));
        }
        activeCommand?.onExit(event.exitCode);
        this.disposeActivePtySubscriptions();
        if (!this.disposed) this.closeEmitter.fire(event.exitCode >= 0 ? event.exitCode : 1);
      }, PTY_EXIT_DATA_FLUSH_MS);
    });

    if (!this.ready) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.ready) return;
          reject(new Error("AgentBridge managed PTY shell did not reach its first prompt within 8 seconds."));
        }, 8_000);
        const finish = (fn: () => void) => () => {
          clearTimeout(timer);
          fn();
        };
        this.readyResolver = finish(resolve);
        this.readyRejecter = (error) => finish(() => reject(error))();
      });
    }
  }

  private handlePtyData(data: string): void {
    this.protocolBuffer += data;
    while (this.protocolBuffer) {
      const markerStart = this.protocolBuffer.indexOf(this.protocolPrefix);
      if (markerStart < 0) {
        const keep = this.protocolPrefixOverlap(this.protocolBuffer);
        const visible = this.protocolBuffer.slice(0, this.protocolBuffer.length - keep);
        if (visible) this.emitPtyData(visible);
        this.protocolBuffer = keep ? this.protocolBuffer.slice(-keep) : "";
        return;
      }

      if (markerStart > 0) this.emitPtyData(this.protocolBuffer.slice(0, markerStart));
      const markerEnd = this.protocolBuffer.indexOf("\u0007", markerStart + this.protocolPrefix.length);
      if (markerEnd < 0) {
        this.protocolBuffer = this.protocolBuffer.slice(markerStart);
        return;
      }

      const payload = this.protocolBuffer.slice(markerStart + this.protocolPrefix.length, markerEnd);
      this.protocolBuffer = this.protocolBuffer.slice(markerEnd + 1);
      this.handleProtocolMarker(payload);
    }
  }

  private protocolPrefixOverlap(value: string): number {
    const max = Math.min(value.length, this.protocolPrefix.length - 1);
    for (let length = max; length > 0; length--) {
      if (this.protocolPrefix.startsWith(value.slice(-length))) return length;
    }
    return 0;
  }

  private emitPtyData(data: string): void {
    if (this.activeCommand && this.echoGateActive) {
      const rest = this.consumeCommandEcho(data);
      if (rest === null) return;
      this.echoGateActive = false;
      if (this.echoTimeoutTimer) {
        clearTimeout(this.echoTimeoutTimer);
        this.echoTimeoutTimer = undefined;
      }
      data = rest;
    }
    this.writeDisplay(data);
    if (!this.activeCommand) return;
    if (this.activeCommand.finishing) {
      this.activeCommand.onOutput(this.stripPromptText(data));
      return;
    }
    this.activeCommand.onOutput(data);
  }

  /**
   * Consume the shell's rendering of the typed command or agent-sent input. PSReadLine,
   * Readline and tty drivers echo the text back into the PTY output, and ConPTY can deliver
   * that rendering late, preceded by stale prompt text, full-screen redraws (a PTY resize
   * re-renders the whole screen) and cooked-echo fragments
   * (the classic "p<BS>python" race between the console echo and PSReadLine's redraw).
   *
   * The gate therefore does not require the echo to start at the first byte: it hunts for the
   * echo text while discarding known noise (prompt lines, blank lines, ANSI sequences,
   * backspaces; in chat mode everything up to the echo anchor because a resize redraw can
   * re-render arbitrary previous output), matches the text tolerantly (skipping the same
   * control noise, undoing backspace erasures, restarting after carriage-return redraws), and
   * after the full echo swallows only the line-accept newline plus redraw noise — any ordinary
   * byte opens the gate so real program output is never consumed. Hunting is bounded by
   * MAX_ECHO_HUNT_BYTES and by COMMAND_ECHO_TIMEOUT_MS.
   */
  private consumeCommandEcho(data: string): string | null {
    const expectation = this.echoExpectation;
    let index = 0;
    while (index < data.length) {
      const ch = data[index];

      // Line terminators: line wrapping and line acceptance.
      if (ch === "\r" || ch === "\n") { index++; continue; }
      // ANSI sequences: cursor moves, clear-line, bracket-paste markers, redraws.
      const ansi = ansiEscapeLength(data, index);
      if (ansi > 0) { index += ansi; continue; }
      // Backspace: erases the previously rendered character; undo one matched character.
      if (ch === "\b") {
        index++;
        if (this.echoMatchIndex > 0) this.echoMatchIndex--;
        continue;
      }

      if (this.echoMatchIndex === 0) {
        if (this.echoHuntDiscardAll) {
          // Chat capture resized the PTY; ConPTY re-renders the previous screen before the
          // echo. Discard everything (bounded) until the echo anchor shows up.
          if (this.echoHuntBytesRemaining <= 0) {
            this.resetEchoGate();
            return data.slice(index);
          }
          this.echoHuntBytesRemaining--;
          if (ch === expectation[0]) {
            this.echoMatchIndex++;
            index++;
            continue;
          }
          index++;
          continue;
        }
        // Hunting: skip known noise, then require the echo anchor.
        if (this.echoHuntBytesRemaining <= 0) {
          this.resetEchoGate();
          return data.slice(index);
        }
        this.echoHuntBytesRemaining--;
        if (ch === " " || ch === "\t" || ch === "\u0007") { index++; continue; }
        if (this.echoHuntingPromptLine) {
          // The previous chunk ended inside a "PS ..." prompt line; skip to its newline.
          let cursor = index;
          while (cursor < data.length && data[cursor] !== "\r" && data[cursor] !== "\n") cursor++;
          if (cursor < data.length) this.echoHuntingPromptLine = false;
          index = cursor;
          continue;
        }
        const promptLength = promptTextLength(data, index);
        if (promptLength === -1) {
          // "PS ..." prompt line continues in a later chunk.
          this.echoHuntingPromptLine = true;
          return null;
        }
        if (promptLength > 0) { index += promptLength; continue; }
        if (ch !== expectation[0]) {
          // Not the echo and not noise: the echo already ended or never rendered.
          this.resetEchoGate();
          return data.slice(index);
        }
        this.echoMatchIndex++;
        index++;
        continue;
      }

      // Matching the echo text. A carriage return mid-line means the shell redrew the whole
      // line from column 0.
      if (ch === "\r") { this.echoMatchIndex = 0; index++; continue; }
      if (this.echoMatchIndex >= expectation.length) break;
      if (ch !== expectation[this.echoMatchIndex]) {
        // False anchor (e.g. redraw content that coincidentally matched the prefix): resume
        // hunting from the mismatch instead of opening the gate.
        this.echoMatchIndex = 0;
        continue;
      }
      this.echoMatchIndex++;
      index++;
    }

    if (this.echoMatchIndex >= expectation.length) {
      // The full echo was consumed; swallow only the line-accept newline and trailing redraw
      // noise. Any ordinary byte is real program output and opens the gate.
      while (index < data.length) {
        const ch = data[index];
        if (ch === "\r" || ch === "\n") { index++; continue; }
        const ansi = ansiEscapeLength(data, index);
        if (ansi > 0) { index += ansi; continue; }
        if (ch === "\b") { index++; continue; }
        break;
      }
      this.resetEchoGate();
      return data.slice(index);
    }
    return null; // Still inside the echo; keep the gate closed.
  }

  private resetEchoGate(): void {
    this.echoExpectation = "";
    this.echoMatchIndex = 0;
    this.echoGateActive = false;
    this.echoHuntBytesRemaining = 0;
    this.echoHuntDiscardAll = false;
    this.echoHuntingPromptLine = false;
  }

  private armEchoTimeout(): void {
    if (this.echoTimeoutTimer) clearTimeout(this.echoTimeoutTimer);
    this.echoTimeoutTimer = setTimeout(() => {
      this.echoTimeoutTimer = undefined;
      // The echo never arrived or could not be consumed; open the gate so output flows.
      this.echoGateActive = false;
    }, COMMAND_ECHO_TIMEOUT_MS);
  }

  private handleProtocolMarker(payload: string): void {
    // Payload is <sequence>;<exit>;<cwd>;<pid>. The pid identifies the shell that emitted
    // it: a nested or remote shell (bash inside ssh, docker exec) inherits the per-prompt
    // hook and writes markers through the same PTY, and honouring those would end the outer
    // command early and adopt the nested shell's cwd.
    const [sequenceText, exitCodeText, cwdBase64, pidText] = payload.split(";", 4);
    const sequence = Number.parseInt(sequenceText, 10);
    const exitCode = Number.parseInt(exitCodeText, 10);
    if (!Number.isFinite(sequence) || !Number.isFinite(exitCode)) return;
    if (!markerFromOwnShell(this.shellPid, pidText)) return;

    const activeCommand = this.activeCommand;

    if (cwdBase64) {
      try {
        const cwd = Buffer.from(cwdBase64, "base64").toString("utf8");
        if (cwd) this.currentCwdValue = cwd;
      } catch {
        // Keep the last known cwd when a shell cannot encode its current path.
      }
    }

    if (!this.ready) {
      this.ready = true;
      this.readyResolver?.();
      this.readyResolver = undefined;
      this.readyRejecter = undefined;
      return;
    }

    if (!activeCommand) return;
    if (activeCommand.finishing) return; // Ignore duplicate exit markers for the same command.
    activeCommand.finishing = true;
    activeCommand.finishExitCode = exitCode;
    // Windows PowerShell drains a native command's stdout on an async reader thread, so its
    // last bytes can arrive after the prompt (and its exit marker) has been emitted. Keep the
    // command alive for a short flush window so that late output is still captured; the fixed
    // width of the window bounds the added latency for every command (bridge and chat alike).
    activeCommand.finishTimer = setTimeout(() => {
      this.finishCommand(activeCommand);
    }, PTY_EXIT_DATA_FLUSH_MS);
  }

  private finishCommand(command: NonNullable<typeof this.activeCommand>): void {
    this.resetEchoGate();
    if (command.finishTimer) {
      clearTimeout(command.finishTimer);
      command.finishTimer = undefined;
    }
    if (this.echoTimeoutTimer) {
      clearTimeout(this.echoTimeoutTimer);
      this.echoTimeoutTimer = undefined;
    }
    if (this.activeCommand !== command) return; // Already finished via the PTY exit path.
    this.activeCommand = undefined;
    this.restoreDisplayDimensions();
    command.onExit(command.finishExitCode ?? null);
  }

  private stripPromptText(text: string): string {
    // Managed shells render a fixed-shape prompt right after the exit marker:
    //   PowerShell: "PS <cwd>> "   bash/sh: "$ "
    // Anchored to the tail of the chunk so real output lines that merely start with
    // "PS " or "$ " elsewhere in the stream are preserved. ConPTY chunks typically end
    // with trailing spaces/CRLF after the prompt, hence the tolerant tail.
    return text
      .replace(/(^|[\r\n])PS [^\r\n]*?>(?:[ \t]|\r?\n)*$/, "$1")
      .replace(/(^|[\r\n])\$ (?:[ \t]|\r?\n)*$/, "$1");
  }

  terminateActiveProcess(): void {
    const activePty = this.activePty;
    if (!activePty) return;
    // Detach first. terminal.dispose() synchronously closes this Pseudoterminal and calls
    // dispose(), which reaches terminateActiveProcess() again. Clearing the reference before
    // kill() makes that re-entrant path a no-op and, on Windows, avoids a second node-pty
    // ConPTY kill racing the first one inside the Extension Host.
    this.activePty = undefined;
    this.disposeActivePtySubscriptions();
    try {
      activePty.kill();
    } catch {
      // The PTY may already be gone.
    }
  }

  private disposeActivePtySubscriptions(): void {
    this.activePtyDataSubscription?.dispose();
    this.activePtyExitSubscription?.dispose();
    this.activePtyDataSubscription = undefined;
    this.activePtyExitSubscription = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.terminateActiveProcess();
    this.activePty = undefined;
    if (this.tempDir) {
      try {
        fs.rmSync(this.tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup of the zsh ZDOTDIR scratch dir.
      }
      this.tempDir = undefined;
    }
    if (this.activeCommand?.finishTimer) {
      clearTimeout(this.activeCommand.finishTimer);
      this.activeCommand.finishTimer = undefined;
    }
    if (this.echoTimeoutTimer) {
      clearTimeout(this.echoTimeoutTimer);
      this.echoTimeoutTimer = undefined;
    }
    this.resetEchoGate();
    this.activeCommand = undefined;
    this.disposeActivePtySubscriptions();
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Commands above this length are always bridged through a temp script instead of being
 * typed into the readline layer, where long fast pastes are provably lossy. */
const TEMP_SCRIPT_MAX_INLINE_LENGTH = 1024;

/**
 * True when a marker was emitted by the shell this PTY spawned.
 *
 * Any shell started under a managed terminal inherits the per-prompt hook, so a nested or
 * remote shell (bash inside ssh, docker exec) also writes markers through the same PTY.
 * Those carry the nested process's pid, which never matches the shell we spawned — sequence
 * numbers cannot serve here because a nested shell restarts its own counter and collides.
 *
 * Fails open when the shell pid is unknown: dropping every marker would hang each command
 * outright, which is worse than the bug this guards against.
 */
export function markerFromOwnShell(shellPid: number | undefined, pidText: string | undefined): boolean {
  // Zero is unknown too. The node-pty build VS Code ships reports pid 0 for a ConPTY session
  // on Windows, and 0 is a finite number, so it passed this check as though it were the shell's
  // pid: no marker can match 0, every one was dropped, the shell never reported ready, and each
  // command waited out the eight-second first-prompt timeout while the managed terminal sat
  // empty and was then disposed. A pid that cannot identify a process cannot be compared to
  // one, so it takes the same route as a missing pid.
  if (shellPid === undefined || !Number.isFinite(shellPid) || shellPid <= 0) return true;
  const pid = Number.parseInt(pidText ?? "", 10);
  // No pid means an older hook — for example a terminal VS Code restored from a previous
  // session, or a shell started before this build. It cannot be identified either way, and
  // dropping it would hang that command, so only a positively different process is rejected.
  if (!Number.isFinite(pid)) return true;
  return pid === shellPid;
}

/** Shells that need PowerShell syntax in a bridged script, whichever build they are. */
export function isPowerShellKind(kind: ShellChoice["kind"]): boolean {
  return kind === "ps51" || kind === "pwsh";
}

/**
 * Write a command to a temp script so a single one-line command can invoke it. Multi-line
 * input typed into a persistent PTY is unreliable: readline/PSReadLine continuation-mode
 * buffering can drop lines or append later commands to an unfinished statement, and non-ASCII
 * input can be mangled by the console code page. The file bridge preserves the payload
 * byte-for-byte.
 */
/**
 * Where a bridged script lives, and how it is created.
 *
 * The file used to sit at a predictable path in the shared temp directory — `os.tmpdir()`
 * plus the command id, which is a timestamp and a counter — and was written without an
 * exclusive flag. Anything on the machine that could guess the next id could put a symlink or
 * a file there first and have the next command's text written through it, and the PowerShell
 * branch set no mode at all, so the command (which can carry a secret) was readable by every
 * other account on the machine. mkdtemp makes the directory itself unguessable and creates it
 * exclusively, and the file inside is opened with "wx", so a name that is somehow already
 * there is an error rather than a write through whatever is sitting on it.
 */
function writeExclusiveScript(fileName: string, content: string, mode: number): string {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-run-"));
    const scriptPath = path.join(directory, fileName);
    try {
      fs.writeFileSync(scriptPath, content, { encoding: "utf8", mode, flag: "wx" });
      return scriptPath;
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      lastError = error;
    }
  }
  throw new Error(`could not create an exclusive temp script: ${String(lastError)}`);
}

export function writeTempScript(commandId: string, command: string, kind: ShellChoice["kind"]): string {
  if (isPowerShellKind(kind)) {
    // UTF-8 BOM: Windows PowerShell 5.1 decodes BOM-less files with the legacy ANSI code
    // page. The encoding prelude keeps the child PowerShell's native output UTF-8. A
    // param() block must stay the first statement, so when one is present the prelude is
    // inserted right after the (quote-aware) matching close paren; without a scannable
    // param block the payload keeps its original shape.
    const prelude = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\r\n";
    let content: string;
    const insertAt = encodingPreludeInsertIndex(command);
    if (insertAt >= 0) {
      content = `\uFEFF${command.slice(0, insertAt)}\r\n${prelude}${command.slice(insertAt)}\r\n`;
    } else if (leadingParamIndex(command) >= 0) {
      // A param block is present but its closing paren could not be located, so there is no
      // safe place to put the prelude. Keep the payload as written: param has to stay the
      // first statement, and a script that only loses the output-encoding hint still runs.
      content = `\uFEFF${command}\r\n`;
    } else {
      content = `\uFEFF${prelude}${command}\r\n`;
    }
    // powershell.exe -File only honors an explicit `exit` (or a thrown error): a script
    // whose final statement is a failed native command would otherwise exit 0 and mask the
    // failure. Mirror bash semantics: when the final statement failed ($?), propagate
    // $LASTEXITCODE for native commands, else exit 1.
    //
    // $LASTEXITCODE becomes an int as soon as any native command has run, so testing
    // `-is [int]` alone is not enough: a failed *cmdlet* would then inherit a stale 0 and
    // exit 0, silently masking the failure. Require a non-zero code before trusting it.
    const nativeExitGuard = "\r\nif (-not $?) { if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE } else { exit 1 } }\r\n";
    // 0o600, not the default: a bridged command can carry a secret, and nothing but the shell
    // that is about to run it needs to read the file.
    return writeExclusiveScript(`agentbridge-${commandId}.ps1`, `${content}${nativeExitGuard}`, 0o600);
  }
  // 0o700 keeps the POSIX script executable by its owner only.
  return writeExclusiveScript(`agentbridge-${commandId}.sh`, `${command}\n`, 0o700);
}

/**
 * Where tool warnings are reported. The extension host's console cannot be read by the user,
 * so activation points this at the AgentBridge output channel; until it does — and in tests —
 * warnings fall back to the console so they are still captured somewhere.
 */
let reportWarning: (message: string) => void = (message) => console.warn(message);

export function setIdeToolWarningSink(sink: ((message: string) => void) | undefined): void {
  reportWarning = sink ?? ((message: string) => console.warn(message));
}

/**
 * Removes a bridged temp script once its command has settled. Windows often still holds the
 * file for a moment after the shell exits, so a single retry is worth it — and a failure is
 * reported rather than dropped, because swallowing it is exactly how temp directories fill up
 * with nothing left to explain why.
 */
export function removeTempScript(scriptPath: string): void {
  const gone = (error: NodeJS.ErrnoException | null): boolean => !error || error.code === "ENOENT";
  const directory = path.dirname(scriptPath);
  // The script now sits in a directory mkdtemp made for it, so the file is not the only thing
  // to take away. Only a directory this function's own writer made is removed: the prefix is
  // what says so, and rm is given force so a path from an older build is simply left alone.
  const removeDirectory = (): void => {
    if (!path.basename(directory).startsWith("agentbridge-run-")) return;
    fs.rm(directory, { recursive: true, force: true }, () => {});
  };
  fs.unlink(scriptPath, (error) => {
    if (gone(error)) {
      removeDirectory();
      return;
    }
    setTimeout(() => {
      fs.unlink(scriptPath, (retryError) => {
        if (!gone(retryError)) {
          // The file is still held, so this will most likely fail as well - but a directory
          // left behind is what fills the temp directory up, and an attempt costs nothing: a
          // lock released a moment later is one the rm can still take. The old code returned
          // here and kept the directory for as long as the file was held, which is longer than
          // the warning is interesting.
          reportWarning(`[agentbridge] could not remove temp script ${scriptPath}: ${retryError?.message}`);
        }
        removeDirectory();
      });
    }, 250);
  });
}

/**
 * Char index of the `param` keyword that opens the script's parameter block, or -1 when the
 * command has none. Comment lines and `#requires` directives may precede param without
 * making it anything other than the first statement, so they are skipped: a script that
 * opens with `#requires -Version 7` and then declares parameters still parses, and callers
 * must not insert anything before that block. Block comments count the same way - `<# ... #>`
 * followed by param still parses - and missing that case sent the prelude in front of param,
 * which PowerShell rejects outright.
 */
export function leadingParamIndex(command: string): number {
  let index = 0;
  for (;;) {
    while (index < command.length && /\s/.test(command[index]!)) index++;
    if (command.startsWith("<#", index)) {
      const close = command.indexOf("#>", index + 2);
      index = close < 0 ? command.length : close + 2;
      continue;
    }
    if (command[index] === "#") {
      const nextLine = command.indexOf("\n", index);
      index = nextLine < 0 ? command.length : nextLine + 1;
      continue;
    }
    break;
  }
  return /^param\s*\(/i.test(command.slice(index)) ? index : -1;
}

/**
 * Char index just after the leading param(...) block (quote-aware depth scan), or -1 when
 * the command does not start with a scannable param block. PowerShell requires param() to
 * be the first statement, so an encoding prelude can only be inserted after it.
 */
export function encodingPreludeInsertIndex(command: string): number {
  const paramIndex = leadingParamIndex(command);
  if (paramIndex < 0) return -1;
  const open = command.indexOf("(", paramIndex + 5);
  if (open < 0) return -1;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = open; i < command.length; i++) {
    const ch = command[i];
    if (inSingle) {
      if (ch === "'") {
        if (command[i + 1] === "'") i++;
        else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      // PowerShell escapes with a backtick, not a backslash: a `" pair is a literal quote
      // and must not end the string. Treating it as the closing quote makes the paren count
      // below run into the rest of the block, and the prelude is then inserted mid-expression
      // where the parser rejects it.
      if (ch === "`") i++;
      else if (ch === '"') {
        if (command[i + 1] === '"') i++;
        else inDouble = false;
      }
      continue;
    }
    if (ch === "`") {
      i++;
      continue;
    }
    if (ch === "#") {
      const nextLine = command.indexOf("\n", i);
      i = nextLine < 0 ? command.length : nextLine;
      continue;
    }
    // Both here-string forms have to be consumed whole. A single-quoted one that is read as
    // an ordinary string ends at the first apostrophe inside its body, so the parens after
    // it are counted and the block closes in the wrong place — which silently splices the
    // encoding prelude into the middle of a parameter default.
    if (ch === "@" && command[i + 1] === '"') {
      const closing = command.indexOf('\n"@', i + 2);
      i = closing < 0 ? command.length : closing + 2;
      continue;
    }
    if (ch === "@" && command[i + 1] === "'") {
      const closing = command.indexOf("\n'@", i + 2);
      i = closing < 0 ? command.length : closing + 2;
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  // The depth scan could not pair the block (an unterminated here-string, say). A lone ")"
  // in the first column is the conventional close of a multi-line param block and is still a
  // safe insertion point, whereas guessing anywhere else would corrupt the script.
  const closingLine = /^\)[^\S\r\n]*(\r?\n|$)/m.exec(command);
  return closingLine ? closingLine.index + closingLine[0].length : -1;
}

/** Single-line invocation for a temp script. A PowerShell shell runs a child PowerShell
 * (whichever build is configured) so `exit N` inside the payload cannot kill the persistent
 * managed shell; the child's exit code lands in $LASTEXITCODE and is reported by the prompt
 * marker. POSIX shells run the script directly. */
/**
 * The arguments a direct run hands its shell for one command.
 *
 * cmd takes /c where the POSIX shells take -c, and -c is not a switch cmd recognises at all:
 * every direct command on a cmd-managed host was handed an argument the shell reported as an
 * error. /d /s is the shape that neither runs an AutoRun entry nor re-quotes the command. The
 * PowerShell families never reach this, because a direct run bridges them through a script.
 */
export function directCommandArgv(choice: ShellChoice, command: string): string[] {
  if (choice.kind === "cmd") return ["/d", "/s", "/c", command];
  return ["-c", command];
}

export function tempScriptCommand(scriptPath: string, choice: ShellChoice): string {
  // Run the managed shell rather than a hard-coded one: a PowerShell 7 override must not
  // fall back to Windows PowerShell 5.1, or operators the user opted into (&&, ??=) and
  // zsh syntax would be interpreted by the wrong shell.
  //
  // Both sides are quoted because the managed shell can be pointed at an arbitrary path by
  // workspace settings, and the temp directory can contain spaces or shell metacharacters.
  // An unescaped quote would let either value break out of its quoting and run extra text.
  if (isPowerShellKind(choice.kind)) {
    return `& "${escapeForDoubleQuotes(choice.executable)}" -NoProfile -ExecutionPolicy Bypass -File "${escapeForDoubleQuotes(scriptPath)}"`;
  }
  return `'${escapeForSingleQuotes(choice.executable)}' '${escapeForSingleQuotes(scriptPath)}'`;
}

/** Backtick-escapes the characters that are special inside a PowerShell double-quoted string. */
function escapeForDoubleQuotes(value: string): string {
  return value.replace(/[`$"]/g, "`$&");
}

/** Ends and reopens a POSIX single-quoted string so an embedded quote cannot break out. */
function escapeForSingleQuotes(value: string): string {
  return value.replace(/'/g, `'\\''`);
}

/**
 * True when the command must be bridged through a temp script rather than typed directly
 * into the persistent shell's readline layer.
 */
export function needsTempScript(command: string): boolean {
  return /\r|\n/.test(command) || /[^\x00-\x7F]/.test(command) || command.length > TEMP_SCRIPT_MAX_INLINE_LENGTH;
}

function stripAnsi(text: string): string {
  return text.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~X]))/g, "");
}

/** A trailing fragment that may be the start of a multi-byte ANSI escape split across chunks. */
const PARTIAL_ANSI_SUFFIX_RE = /[\u001B\u009B](?:[\[()#;?]*[0-9;:]*)?$/;

/**
 * Length of the ANSI escape sequence starting at text[index] (0 when none). Returns the
 * remaining length when the sequence is cut off at the end of the chunk so the caller can
 * swallow the fragment instead of leaking it.
 */
function ansiEscapeLength(text: string, index: number): number {
  if (text[index] === "\u009b") {
    let cursor = index + 1;
    while (cursor < text.length && /[0-9;:?<>]/.test(text[cursor])) cursor++;
    if (cursor < text.length && text[cursor] >= "@" && text[cursor] <= "~") return cursor - index + 1;
    return text.length - index;
  }
  if (text[index] !== "\u001b") return 0;
  if (index + 1 >= text.length) return 1;
  const second = text[index + 1];
  if (second === "[") {
    let cursor = index + 2;
    while (cursor < text.length && /[0-9;:?<>]/.test(text[cursor])) cursor++;
    if (cursor < text.length && text[cursor] >= "@" && text[cursor] <= "~") return cursor - index + 1;
    return text.length - index;
  }
  if (second === "]") {
    let cursor = index + 2;
    while (cursor < text.length) {
      if (text[cursor] === "\u0007") return cursor - index + 1;
      if (text[cursor] === "\u001b" && text[cursor + 1] === "\\") return cursor - index + 2;
      cursor++;
    }
    return text.length - index;
  }
  if (second === "(" || second === ")" || second === "#") {
    return index + 2 < text.length ? 3 : text.length - index;
  }
  if ("78=>DEHMcZ".includes(second)) return 2;
  return 0;
}

/**
 * Length of a managed-shell prompt rendered at text[index]; 0 when the text is not a prompt.
 * Returns -1 when a "PS ..." prompt line continues into a later chunk (the caller keeps the
 * gate closed and marks echoHuntingPromptLine).
 */
function promptTextLength(text: string, index: number): number {
  if (text.startsWith("PS ", index)) {
    let cursor = index + 3;
    while (cursor < text.length && text[cursor] !== "\r" && text[cursor] !== "\n" && text[cursor] !== ">") cursor++;
    if (cursor < text.length && text[cursor] === ">") {
      cursor++;
      while (cursor < text.length && (text[cursor] === " " || text[cursor] === "\t")) cursor++;
      return cursor - index;
    }
    return -1;
  }
  if (text.startsWith("$ ", index)) return 2;
  if (text.startsWith(">>> ", index)) return 4; // python / ipython REPL prompt
  if (text.startsWith("... ", index)) return 4; // python REPL continuation prompt
  if (text.startsWith("> ", index)) return 2;   // node & other REPL prompts
  return 0;
}

function normalizeRelativePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized || ".";
}

function isInside(root: string, candidate: string): boolean {
  const rootResolved = path.resolve(root);
  const candidateResolved = path.resolve(candidate);
  const rootCmp = process.platform === "win32" ? rootResolved.toLowerCase() : rootResolved;
  const candidateCmp = process.platform === "win32" ? candidateResolved.toLowerCase() : candidateResolved;
  return candidateCmp === rootCmp || candidateCmp.startsWith(`${rootCmp}${path.sep}`);
}

function workspaceRoot(): string {
  // The folder a relative path falls back to. Which folder a path really belongs to is
  // decided per path, in workspaceRootHolding - a window can hold several.
  return defaultWorkspaceRoot();
}

function resolveWorkspacePath(relative = "."): { root: string; absolute: string; relative: string; uri: vscode.Uri } {
  const rel = normalizeRelativePath(relative);
  if (path.isAbsolute(rel)) throw new Error("Path must be workspace-relative.");
  const root = workspaceRootHolding(rel);
  const absolute = path.resolve(root, rel);
  if (!isInsideAnyWorkspaceRoot(absolute)) throw new Error(`Path is outside the workspace: ${relative}`);
  const normalizedRelative = path.relative(root, absolute).replace(/\\/g, "/") || ".";
  return { root, absolute, relative: normalizedRelative, uri: vscode.Uri.file(absolute) };
}

async function resolveExistingWorkspacePath(relative = "."): Promise<{ root: string; absolute: string; relative: string; uri: vscode.Uri }> {
  const lexical = resolveWorkspacePath(relative);
  const [root, absolute] = await Promise.all([
    fs.promises.realpath(lexical.root),
    fs.promises.realpath(lexical.absolute),
  ]);
  // A symlink can lead into another folder of the same window, which is still inside the
  // workspace: only a target no folder contains is an escape. Both sides have been through
  // realpath, or a short 8.3 path would look like one.
  if (!isInsideAnyRoot(await canonicalWorkspaceRoots(), absolute)) throw new Error(`Path is outside the workspace: ${relative}`);
  return { root, absolute, relative: lexical.relative, uri: vscode.Uri.file(absolute) };
}

function toolResult(text: string): vscode.LanguageModelToolResult {
  return makeToolResult(text);
}

/**
 * Constructs a language-model tool result with a three-tier fallback. The LM result classes
 * (LanguageModelToolResult / LanguageModelTextPart) only exist in VS Code 1.95+, and
 * ExtendedLanguageModelToolResult is still proposed. On older builds a structural equivalent
 * is returned: callers only read .content, and the native Chat path is unreachable there
 * anyway because registerTool is gated on 1.95 as well.
 */
function makeToolResult(text: string, toolResultMessage?: string): vscode.LanguageModelToolResult & { toolResultMessage?: string } {
  const lm = vscode as unknown as {
    ExtendedLanguageModelToolResult?: new (content: unknown[]) => vscode.LanguageModelToolResult & { toolResultMessage?: string };
    LanguageModelToolResult?: new (content: unknown[]) => vscode.LanguageModelToolResult;
    LanguageModelTextPart?: new (value: string) => vscode.LanguageModelTextPart;
  };
  const part = typeof lm.LanguageModelTextPart === "function"
    ? new lm.LanguageModelTextPart(text)
    : { type: "text" as const, value: text };
  if (typeof lm.ExtendedLanguageModelToolResult === "function") {
    const extended = new lm.ExtendedLanguageModelToolResult([part]);
    if (toolResultMessage !== undefined) extended.toolResultMessage = toolResultMessage;
    return extended;
  }
  if (typeof lm.LanguageModelToolResult === "function") {
    return new lm.LanguageModelToolResult([part]);
  }
  return {
    content: [part],
    ...(toolResultMessage !== undefined ? { toolResultMessage } : {}),
  } as unknown as vscode.LanguageModelToolResult & { toolResultMessage?: string };
}

/** First non-empty line of a command, bounded so it fits one compact Chat step title. */
function summarizeCommand(command: string, maxLength = 48): string {
  const firstLine = command.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!firstLine) return "command";
  if (firstLine.length <= maxLength) return firstLine;
  return `${firstLine.slice(0, maxLength - 1)}…`;
}

function parseExitCode(text: string): number | null | undefined {
  const match = text.match(/^exit_code: (-?\d+|null)$/m);
  if (!match) return undefined;
  return match[1] === "null" ? null : Number.parseInt(match[1], 10);
}

function resultText(result: vscode.LanguageModelToolResult): string {
  return result.content.map((part: any) => {
    if (typeof part?.value === "string") return part.value;
    if (part?.value && typeof part.value.value === "string") return part.value.value;
    return JSON.stringify(part);
  }).filter(Boolean).join("\n");
}

export class TerminalCommandManager implements vscode.Disposable {
  private readonly states = new Map<string, CommandState>();
  private readonly slots = new Map<string, TerminalSlot>();
  private nextCommandId = 1;
  private nextTerminalId = 1;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly createManagedPty: (initialCwd: string) => ManagedCommandPseudoterminal =
      (initialCwd) => new ManagedCommandPseudoterminal(initialCwd),
  ) {
    // Older AgentBridge builds created persistent terminals. After an Extension Host restart
    // those terminals can be restored by VS Code even though the in-memory terminal pool is
    // gone, which makes every subsequent run create another duplicate. They are no longer
    // manageable (their command ids/states were lost), so close them before creating the new
    // transient pool.
    for (const terminal of vscode.window.terminals) {
      if (MANAGED_TERMINAL_NAME.test(terminal.name)) terminal.dispose();
    }

    this.disposables.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        for (const [slotId, slot] of this.slots) {
          if (slot.terminal !== terminal) continue;
          slot.closed = true;
          slot.pty.terminateActiveProcess();
          slot.busyCommandId = undefined;
          this.slots.delete(slotId);
        }
        // Collected first: finishState prunes finished states and can dispose idle terminals,
        // so settling inside the scan would mutate the map being walked.
        const orphaned: CommandState[] = [];
        for (const state of this.states.values()) {
          if (!state.terminal || state.terminal !== terminal || state.status !== "running") continue;
          orphaned.push(state);
        }
        for (const state of orphaned) {
          // Settle through finishState rather than by hand: it also releases the command's
          // bridged temp script and clears the slot's busy bookkeeping. Closing a terminal
          // used to skip both and leave a script behind for every command it killed.
          this.finishState(state, null, "killed");
        }
      }),
    );
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    // Settle before tearing the shells down. The onDidCloseTerminal listener is already
    // disposed above, so nothing else can resolve these commands: their done promise would
    // stay pending and a foreground run_command awaiting it would sit for the whole timeout,
    // then report "running" for a command that has already been killed and whose state is
    // about to be cleared. finishState is also what unlinks a bridged temp script, so
    // skipping it here leaks one script per in-flight command.
    //
    // Direct commands hold no terminal slot, so the terminal loop below never reaches them
    // and their child process has to be killed here to avoid leaving an orphan behind.
    for (const state of [...this.states.values()]) {
      if (state.status !== "running") continue;
      if (state.execution === "direct") state.child?.kill();
      this.finishState(state, null, "killed");
    }
    for (const slot of this.slots.values()) {
      if (!slot.closed) slot.terminal.dispose();
    }
    this.slots.clear();
    this.states.clear();
  }

  private sameFileSystemPath(a: string, b: string): boolean {
    return this.fileSystemPathKey(a) === this.fileSystemPathKey(b);
  }

  private fileSystemPathKey(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  private currentSlotCwd(slot: TerminalSlot): string {
    return slot.pty.currentCwd || slot.initialCwd;
  }

  private disposeIdleSlot(slot: TerminalSlot): void {
    if (slot.closed || slot.busyCommandId) return;
    slot.closed = true;
    this.slots.delete(slot.id);
    slot.terminal.dispose();
  }

  /**
   * Concurrency may temporarily require several terminals for the same cwd. Once commands
   * finish, collapse the pool back to one idle terminal per cwd and keep only a small LRU set
   * overall. Running/background terminals are never pruned.
   */
  private pruneIdleTerminals(): void {
    const idle = [...this.slots.values()].filter((slot) => !slot.closed && !slot.busyCommandId);
    const byCwd = new Map<string, TerminalSlot[]>();
    for (const slot of idle) {
      const key = this.fileSystemPathKey(this.currentSlotCwd(slot));
      const group = byCwd.get(key) ?? [];
      group.push(slot);
      byCwd.set(key, group);
    }

    for (const group of byCwd.values()) {
      group.sort(byLeastUseful);
      for (const duplicate of group.slice(1)) this.disposeIdleSlot(duplicate);
    }

    const remaining = [...this.slots.values()]
      .filter((slot) => !slot.closed && !slot.busyCommandId)
      .sort(byLeastUseful);
    for (const excess of remaining.slice(MAX_IDLE_TERMINALS)) this.disposeIdleSlot(excess);
  }

  private async acquireTerminal(
    commandId: string,
    cwdInfo: { absolute: string; relative: string; uri: vscode.Uri } | undefined,
  ): Promise<{ slot: TerminalSlot; reused: boolean; effectiveCwd: string }> {
    const candidates = [...this.slots.values()]
      .filter((slot) => !slot.closed && !slot.broken && !slot.busyCommandId)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    for (const slot of candidates) {
      if (slot.closed || slot.busyCommandId) continue;
      if (cwdInfo && !this.sameFileSystemPath(this.currentSlotCwd(slot), cwdInfo.absolute)) continue;
      slot.busyCommandId = commandId;
      slot.lastUsedAt = Date.now();
      slot.terminal.show(true);
      return { slot, reused: true, effectiveCwd: this.currentSlotCwd(slot) };
    }

    // Hard cap on live managed terminals. Idle slots are pruned to MAX_IDLE_TERMINALS, but
    // busy/background slots grow without bound — a stuck command would otherwise earn a new
    // terminal for every follow-up run_command.
    if (this.slots.size >= MAX_TOTAL_TERMINALS) {
      // A terminal whose shell never reported ready is the first thing to reclaim: it exists to
      // be read, and the pool being full is the moment that stops being worth a slot.
      const broken = [...this.slots.values()].find((slot) => slot.broken && !slot.busyCommandId);
      // Reaching this point with idle candidates means every one mismatched the requested cwd
      // (a matching candidate would have returned above); recycle the least recently used.
      const oldestIdle = candidates[candidates.length - 1];
      if (broken) {
        this.disposeIdleSlot(broken);
      } else if (oldestIdle) {
        this.disposeIdleSlot(oldestIdle);
      } else {
        const busyLines = [...this.slots.values()]
          .filter((slot) => !slot.closed && slot.busyCommandId)
          .map((slot) => ({
            slot,
            // busyCommandId is set before the command state enters this.states, so the state
            // can legitimately be missing here.
            state: slot.busyCommandId ? this.states.get(slot.busyCommandId) : undefined,
          }))
          .sort((a, b) => {
            // Show likely-stuck foreground work before intentionally long-lived background
            // tasks. Within the same class, oldest first is the most useful inspection order.
            const aPriority = a.state ? (a.state.background ? 2 : 0) : 1;
            const bPriority = b.state ? (b.state.background ? 2 : 0) : 1;
            return aPriority - bPriority || a.slot.lastUsedAt - b.slot.lastUsedAt;
          })
          .map(({ slot, state }) => {
            const mode = state ? (state.background ? "background" : "foreground") : "unknown";
            const summary = state ? summarizeCommand(state.command, 80) : "command summary unavailable";
            return `${slot.id} · ${slot.busyCommandId ?? "?"} · ${mode} · ${summary}`;
          })
          .join("\n");
        throw new Error(
          `AgentBridge terminal limit reached (${MAX_TOTAL_TERMINALS} live terminals, all busy). ` +
          `Foreground commands are listed first; background commands may be intentionally long-lived. ` +
          `Wait for intended work to finish, or use terminate_command only for a command that is actually stuck:\n${busyLines}`,
        );
      }
    }

    const initialCwd = cwdInfo?.absolute ?? resolveWorkspacePath(".").absolute;
    const terminalNumber = this.nextTerminalId++;
    const pty = this.createManagedPty(initialCwd);
    const terminal = vscode.window.createTerminal({
      name: `AgentBridge · ${terminalNumber}`,
      pty,
      iconPath: new vscode.ThemeIcon("shield"),
      color: new vscode.ThemeColor("terminal.ansiBlue"),
      // Agent terminals are implementation detail of the current Extension Host session.
      // Persisting/restoring them creates orphan duplicates because command state is in memory.
      isTransient: true,
    });
    const slot: TerminalSlot = {
      id: `terminal_${terminalNumber}`,
      terminal,
      pty,
      initialCwd,
      busyCommandId: commandId,
      closed: false,
      lastUsedAt: Date.now(),
    };
    this.slots.set(slot.id, slot);
    try {
      terminal.show(true);
      await pty.ensureStarted();
      return { slot, reused: false, effectiveCwd: this.currentSlotCwd(slot) };
    } catch (error) {
      // The terminal stays, and so does the shell behind it. Tearing both down here is how a
      // shell that never reported ready became an empty pane and "no longer available" in the
      // activity log at the same time, with nothing left to look at - and whatever the shell did
      // print is the only evidence there is about why it never got there. The slot is kept as
      // well, so the terminal can still be opened, and marked broken so that it is never handed
      // out again: the next command starts a fresh terminal, and the pool reclaims this one when
      // it needs the room.
      slot.broken = true;
      slot.busyCommandId = undefined;
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} ` +
        `Its terminal (${slot.id}) was left open and is still running, and will not be reused. ` +
        `Read that terminal before closing it, and pass execution="direct" to run the next command ` +
        `without the prompt protocol.`,
      );
    }
  }

  private displayCwd(absolute: string): string {
    const root = workspaceRoots().find((candidate) => isInsideRoot(candidate, absolute));
    if (!root) return absolute;
    return path.relative(root, absolute).replace(/\\/g, "/") || ".";
  }

  private appendOutput(state: CommandState, text: string): void {
    // stripAnsi() is per-chunk; hold back an escape fragment that is cut off at the chunk
    // boundary so split CSI/OSC sequences (e.g. "\x1b[?25" + "l") never leak stray bytes.
    const previousPending = state.ansiPending;
    let clean = stripAnsi(previousPending + text);
    const pending = clean.match(PARTIAL_ANSI_SUFFIX_RE);
    if (pending) {
      state.ansiPending = pending[0];
      clean = clean.slice(0, clean.length - pending[0].length);
    } else {
      state.ansiPending = "";
      if (previousPending && clean.startsWith(previousPending)) {
        // The held-back fragment never completed into a real escape; drop it.
        clean = clean.slice(previousPending.length);
      }
    }
    // Backspace redraw fragments that leak past the echo gate: erase the character before
    // each backspace, mirroring the terminal's delete semantics.
    clean = clean.replace(/.?\u0008/g, "");
    if (state.totalOutputBytes === 0) {
      // Strip leading blank lines that leaked past the gate before the first real byte of
      // captured output. Deliberately NOT stripping prompt-shaped text here: commands whose
      // genuine output starts with "$ " or "PS ..." (e.g. echo '$ 100') would lose bytes.
      // Prompts are handled by stripPromptText's tail-anchored pass instead.
      clean = clean.replace(/^(?:\r?\n|[ \t])*/, "");
    }
    if (!clean) return;
    const bytes = Buffer.from(clean, "utf8");
    state.outputChunkStarts.push(state.totalOutputBytes);
    state.outputChunks.push(bytes);
    state.totalOutputBytes += bytes.length;
    state.retainedOutputBytes += bytes.length;
    while (state.retainedOutputBytes > MAX_CAPTURED_OUTPUT_BYTES) {
      const head = state.outputChunks[state.outputChunkHead];
      const drop = Math.min(head.length - state.outputHeadSkip, state.retainedOutputBytes - MAX_CAPTURED_OUTPUT_BYTES);
      state.outputHeadSkip += drop;
      state.retainedOutputBytes -= drop;
      if (state.outputHeadSkip >= head.length) {
        state.outputChunkHead += 1;
        state.outputHeadSkip = 0;
      }
    }
    // Chunks left of the head are unreachable; compact so the chunk array itself cannot
    // grow without bound under sustained output.
    if (state.outputChunkHead > 0 && state.outputChunkHead * 2 >= state.outputChunks.length) {
      state.outputChunks = state.outputChunks.slice(state.outputChunkHead);
      state.outputChunkStarts = state.outputChunkStarts.slice(state.outputChunkHead);
      state.outputChunkHead = 0;
    }
    state.outputStartOffset = state.totalOutputBytes - state.retainedOutputBytes;
  }

  private finishState(state: CommandState, exitCode: number | null, status?: CommandState["status"]): void {
    if (state.status !== "running") return;
    state.exitCode = exitCode;
    state.status = status ?? (exitCode === 0 ? "completed" : "failed");
    state.endedAt = Date.now();
    if (state.slot) {
      state.slot.lastUsedAt = state.endedAt;
      if (state.slot.busyCommandId === state.id) state.slot.busyCommandId = undefined;
    }
    // The bridged temp script has served its purpose once the command settles; leaving it
    // behind would accumulate one file per multi-line command in the OS temp directory.
    const tempScript = state.tempScriptPath;
    if (tempScript) {
      state.tempScriptPath = undefined;
      removeTempScript(tempScript);
    }
    state.resolveDone();
    this.pruneIdleTerminals();
    pruneFinishedCommandStates(this.states, MAX_COMPLETED_STATES);
  }

  private readOutput(state: CommandState, requestedOffset = 0, maxBytes = DEFAULT_OUTPUT_BYTES): Record<string, unknown> {
    const limit = Math.min(MAX_OUTPUT_BYTES, Math.max(1, maxBytes));
    const outputLost = requestedOffset < state.outputStartOffset;
    const actualOffset = Math.max(state.outputStartOffset, Math.min(requestedOffset, state.totalOutputBytes));
    const slice = this.readRetainedSlice(state, actualOffset, limit);
    const nextOffset = actualOffset + slice.length;
    return {
      command_id: state.id,
      terminal_id: state.terminalId,
      terminal_name: state.terminalName,
      execution: state.execution,
      terminal_reused: state.terminalReused,
      status: state.status,
      exit_code: state.exitCode,
      cwd: state.cwd,
      background: state.background,
      duration_ms: (state.endedAt ?? Date.now()) - state.startedAt,
      output: slice.toString("utf8"),
      output_start_offset: actualOffset,
      next_offset: nextOffset,
      total_output_bytes: state.totalOutputBytes,
      output_lost: outputLost,
      has_more: nextOffset < state.totalOutputBytes,
    };
  }

  /**
   * Collects the retained-stream bytes [offset, offset + limit). Chunk start offsets let the
   * binary search land directly on the chunk overlapping the window, so read cost is bounded
   * by the window instead of the retained buffer — polling an offset already at the end of
   * the stream (the dominant get_command_output pattern) returns without touching chunks.
   */
  private readRetainedSlice(state: CommandState, offset: number, limit: number): Buffer {
    const end = Math.min(offset + limit, state.totalOutputBytes);
    if (offset >= end) return Buffer.alloc(0);
    let low = state.outputChunkHead;
    let high = state.outputChunks.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (state.outputChunkStarts[mid] + state.outputChunks[mid].length <= offset) low = mid + 1;
      else high = mid;
    }
    const slices: Buffer[] = [];
    let collected = 0;
    for (let index = low; index < state.outputChunks.length && collected < limit; index += 1) {
      const chunk = state.outputChunks[index];
      const chunkStart = state.outputChunkStarts[index];
      const from = Math.max(offset, chunkStart) - chunkStart;
      const to = Math.min(chunkStart + chunk.length, offset + limit) - chunkStart;
      if (to > from) {
        slices.push(chunk.subarray(from, to));
        collected += to - from;
      }
    }
    return slices.length === 1 ? slices[0] : slices.length === 0 ? Buffer.alloc(0) : Buffer.concat(slices);
  }

  async run(input: Record<string, unknown>): Promise<string> {
    const shellChoice = getManagedShellChoice();
    if (!RUN_COMMAND_SHELLS.has(shellChoice.kind)) {
      throw new Error(
        `Managed shell "${shellChoice.description}" does not support run_command. ` +
        `Supported: PowerShell and cmd on Windows - Git Bash and MSYS zsh count as Windows ` +
        `shells here - bash on Linux and zsh on macOS. ` +
        `Switch via the agentbridge.bridge.managedShell.* settings.`,
      );
    }
    const command = asString(input.command).trim();
    if (!command) throw new Error("command must be a non-empty string");
    const background = asBoolean(input.background, false);
    if (typeof input.background !== "boolean") throw new Error("background must be explicitly true or false");
    const timeout = boundedInteger(input.timeout_ms, 120_000, 1_000, 120_000, "timeout_ms");
    const timeoutMs = timeout.value;
    const cwdInfo = typeof input.cwd === "string" && input.cwd.trim()
      ? await resolveExistingWorkspacePath(input.cwd)
      : undefined;
    const execution = asString(input.execution, "pty");
    if (execution !== "pty" && execution !== "direct") {
      throw new Error(`execution must be "pty" or "direct".`);
    }
    if (execution === "direct") {
      if (background) {
        throw new Error(`execution="direct" does not support background=true; use the default PTY mode for long-running or user-visible commands.`);
      }
      return this.runDirect(shellChoice, command, cwdInfo, timeoutMs, timeout.note);
    }
    const id = `cmd_${Date.now()}_${this.nextCommandId++}`;
    // Never type risky commands into the readline layer: multi-line input hits
    // continuation-mode buffering (dropped lines, later commands appended to an unfinished
    // statement), long single lines are provably lossy when PSReadLine consumes a fast
    // ConPTY paste (whole payloads silently vanish), and non-ASCII input (CJK, emoji) can
    // be mangled by the console code page. Bridge all of them through a temp script that a
    // single ASCII one-line command executes instead.
    let execCommand = command;
    let tempScriptPath: string | undefined;
    if (needsTempScript(command)) {
      tempScriptPath = writeTempScript(id, command, shellChoice.kind);
      execCommand = tempScriptCommand(tempScriptPath, shellChoice);
    }
    let acquired: { slot: TerminalSlot; reused: boolean; effectiveCwd: string };
    try {
      acquired = await this.acquireTerminal(id, cwdInfo);
    } catch (error) {
      // No command state owns the script yet, so a failed acquire — every slot busy, or the
      // first prompt never arriving — would otherwise leave the file in the temp directory
      // for good, one per abandoned multi-line command.
      if (tempScriptPath) removeTempScript(tempScriptPath);
      throw error;
    }
    const { slot, reused, effectiveCwd } = acquired;
    const displayCwd = cwdInfo?.relative ?? this.displayCwd(effectiveCwd);
    const terminal = slot.terminal;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const state: CommandState = {
      id,
      terminal,
      terminalId: slot.id,
      terminalName: terminal.name,
      terminalReused: reused,
      slot,
      execution: "pty",
      command,
      cwd: displayCwd,
      startedAt: Date.now(),
      background,
      status: "running",
      exitCode: null,
      outputChunks: [],
      outputChunkStarts: [],
      outputChunkHead: 0,
      outputHeadSkip: 0,
      retainedOutputBytes: 0,
      outputStartOffset: 0,
      totalOutputBytes: 0,
      ansiPending: "",
      tempScriptPath,
      done,
      resolveDone,
    };
    this.states.set(id, state);
    try {
      await slot.pty.run(execCommand, {
        onOutput: (text) => this.appendOutput(state, text),
        onExit: (code) => this.finishState(state, code),
      });
    } catch (error) {
      this.finishState(state, null, "failed");
      throw error;
    }

    if (!background) {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          done,
          new Promise<void>((resolve) => {
            timeoutHandle = setTimeout(resolve, timeoutMs);
          }),
        ]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const snapshot = this.readOutput(state, 0, 64 * 1024);
    return [
      "=== RUN_COMMAND BEGIN ===",
      `command_id: ${id}`,
      `terminal_id: ${slot.id}`,
      `terminal_name: ${JSON.stringify(terminal.name)}`,
      `timeout_ms: ${timeoutMs}`,
      ...(timeout.note ? [timeout.note] : []),
      `execution: pty`,
      `terminal_reused: ${reused}`,
      `command: ${JSON.stringify(command)}`,
      `status: ${snapshot.status}`,
      `exit_code: ${snapshot.exit_code ?? "null"}`,
      `cwd: ${JSON.stringify(displayCwd)}`,
      `background: ${background}`,
      `script_bridge: ${tempScriptPath ? JSON.stringify(tempScriptPath) : "null"}`,
      `hint: ${snapshot.status === "running" ? "still running; poll with get_command_output using next_offset" : "none"}`,
      `duration_ms: ${snapshot.duration_ms}`,
      `next_offset: ${snapshot.next_offset}`,
      `total_output_bytes: ${snapshot.total_output_bytes}`,
      `output_lost: ${snapshot.output_lost}`,
      "--- OUTPUT BEGIN ---",
      String(snapshot.output ?? ""),
      "--- OUTPUT END ---",
      "=== RUN_COMMAND END ===",
    ].join("\n");
  }

  /**
   * Execution mode "direct": run the command through a one-shot child process with piped
   * stdio instead of the persistent PTY. The exit code comes straight from the child
   * process, so it is trustworthy by construction: no prompt protocol, no echo gate, no
   * continuation state, no terminal slot consumed, and nothing appears in a terminal view.
   * stdin is closed, so interactive programs cannot be served here. On timeout the child
   * keeps running and the command stays pollable via get_command_output, mirroring PTY
   * semantics.
   */
  private async runDirect(
    choice: ShellChoice,
    command: string,
    cwdInfo: { absolute: string; relative: string; uri: vscode.Uri } | undefined,
    timeoutMs: number,
    timeoutNote: string | null,
  ): Promise<string> {
    // Direct commands bypass the terminal pool, so a burst of them is bounded only by the
    // machine; cap them the way PTY commands are, rather than letting them exhaust handles.
    const runningDirect = [...this.states.values()]
      .filter((state) => state.execution === "direct" && state.status === "running").length;
    if (runningDirect >= MAX_CONCURRENT_DIRECT_COMMANDS) {
      throw new Error(`Too many concurrent direct commands (${MAX_CONCURRENT_DIRECT_COMMANDS}). Wait for one to finish, or use the default PTY mode, which queues onto a managed terminal.`);
    }

    const id = `cmd_${Date.now()}_${this.nextCommandId++}`;
    let file: string;
    let args: string[];
    let tempScriptPath: string | undefined;
    // Resolve the working directory before writing anything: with no workspace open this
    // throws, and a script already on disk would be left behind with no command state to
    // own it. The PTY path guards its script the same way.
    const cwd = cwdInfo?.absolute ?? resolveWorkspacePath(".").absolute;
    if (isPowerShellKind(choice.kind)) {
      // Always bridge through a temp script: it carries a UTF-8 BOM (correct non-ASCII
      // decoding on PowerShell 5.1), sets UTF-8 output encoding, and removes every quoting
      // pitfall a -Command one-liner would have.
      tempScriptPath = writeTempScript(id, command, choice.kind);
      file = choice.executable;
      args = ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tempScriptPath];
    } else {
      file = choice.executable;
      args = directCommandArgv(choice, command);
    }
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const state: CommandState = {
      id,
      terminal: null,
      terminalId: "direct",
      terminalName: "direct",
      terminalReused: false,
      execution: "direct",
      command,
      cwd: cwdInfo?.relative ?? this.displayCwd(cwd),
      startedAt: Date.now(),
      background: false,
      status: "running",
      exitCode: null,
      outputChunks: [],
      outputChunkStarts: [],
      outputChunkHead: 0,
      outputHeadSkip: 0,
      retainedOutputBytes: 0,
      outputStartOffset: 0,
      totalOutputBytes: 0,
      ansiPending: "",
      tempScriptPath,
      done,
      resolveDone,
    };
    this.states.set(id, state);
    try {
      const child = spawn(file, args, {
        cwd,
        env: managedProcessEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      state.child = child;
      const outDecoder = new StringDecoder("utf8");
      const errDecoder = new StringDecoder("utf8");
      child.stdout?.on("data", (chunk: Buffer) => this.appendOutput(state, outDecoder.write(chunk)));
      child.stderr?.on("data", (chunk: Buffer) => this.appendOutput(state, errDecoder.write(chunk)));
      let spawnFailed = false;
      child.on("error", (error: Error) => {
        spawnFailed = true;
        this.appendOutput(state, `[agentbridge] failed to start the direct command: ${error.message}\n`);
      });
      child.on("close", (rawCode, signal) => {
        // PowerShell reports negative exits (exit -1) as an unsigned 32-bit value through
        // the process handle; normalize back into signed range for callers.
        let code = typeof rawCode === "number" ? rawCode : null;
        if (code !== null && code > 0x7fffffff) code -= 0x100000000;
        const outRest = outDecoder.end();
        if (outRest) this.appendOutput(state, outRest);
        const errRest = errDecoder.end();
        if (errRest) this.appendOutput(state, errRest);
        // A process that never started has no exit code of its own. Windows still reports one
        // through the handle — -4058 for a missing executable — which reads as the program's
        // exit status when it is really the spawn failure already written to the output above.
        if (spawnFailed) code = null;
        // Termination by signal carries no exit code, so without the status this settles as
        // "failed" even though the run was stopped deliberately — the caller asked for it and
        // should see "killed".
        this.finishState(state, code, signal ? "killed" : undefined);
      });
    } catch (error) {
      this.finishState(state, null, "failed");
      throw error;
    }

    // Clear the timer once the race is decided. A command that finishes quickly otherwise
    // leaves it pending for the whole timeout, holding a handle in the extension host for
    // no reason — one per direct command run.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      done,
      new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    const snapshot = this.readOutput(state, 0, 64 * 1024);
    return [
      "=== RUN_COMMAND BEGIN ===",
      `command_id: ${id}`,
      `terminal_id: ${state.terminalId}`,
      `terminal_name: ${JSON.stringify(state.terminalName)}`,
      `timeout_ms: ${timeoutMs}`,
      ...(timeoutNote ? [timeoutNote] : []),
      `execution: direct`,
      `terminal_reused: false`,
      `command: ${JSON.stringify(command)}`,
      `status: ${snapshot.status}`,
      `exit_code: ${snapshot.exit_code ?? "null"}`,
      `cwd: ${JSON.stringify(state.cwd)}`,
      `background: false`,
      `script_bridge: ${tempScriptPath ? JSON.stringify(tempScriptPath) : "null"}`,
      `hint: ${snapshot.status === "running" ? "still running; poll with get_command_output using next_offset" : "none"}`,
      `duration_ms: ${snapshot.duration_ms}`,
      `next_offset: ${snapshot.next_offset}`,
      `total_output_bytes: ${snapshot.total_output_bytes}`,
      `output_lost: ${snapshot.output_lost}`,
      "--- OUTPUT BEGIN ---",
      String(snapshot.output ?? ""),
      "--- OUTPUT END ---",
      "=== RUN_COMMAND END ===",
    ].join("\n");
  }

  getOutput(input: Record<string, unknown>): string {
    const id = asString(input.command_id);
    const state = this.states.get(id);
    if (!state) throw new Error(`Unknown command_id: ${id}. Only the ${MAX_COMPLETED_STATES} most recent finished commands are retained.`);
    const offsetBound = boundedInteger(input.offset, 0, 0, Number.MAX_SAFE_INTEGER, "offset");
    const maxBytesBound = boundedInteger(input.max_bytes, DEFAULT_OUTPUT_BYTES, 1, MAX_OUTPUT_BYTES, "max_bytes");
    const offset = offsetBound.value;
    const maxBytes = maxBytesBound.value;
    const adjusted = boundedNotes([offsetBound, maxBytesBound]);
    const snapshot = this.readOutput(state, offset, maxBytes);
    return [
      "=== COMMAND_OUTPUT BEGIN ===",
      `command_id: ${id}`,
      `offset: ${offset}`,
      `max_bytes: ${maxBytes}`,
      ...(adjusted ? [adjusted] : []),
      `execution: ${String(snapshot.execution)}`,
      `terminal_id: ${snapshot.terminal_id}`,
      `terminal_name: ${JSON.stringify(snapshot.terminal_name)}`,
      `status: ${snapshot.status}`,
      `exit_code: ${snapshot.exit_code ?? "null"}`,
      `duration_ms: ${snapshot.duration_ms}`,
      `output_start_offset: ${snapshot.output_start_offset}`,
      `next_offset: ${snapshot.next_offset}`,
      `total_output_bytes: ${snapshot.total_output_bytes}`,
      `output_lost: ${snapshot.output_lost}`,
      `has_more: ${snapshot.has_more}`,
      "--- OUTPUT BEGIN ---",
      String(snapshot.output ?? ""),
      "--- OUTPUT END ---",
      "=== COMMAND_OUTPUT END ===",
    ].join("\n");
  }

  sendInput(input: Record<string, unknown>): string {
    const id = asString(input.command_id);
    const state = this.states.get(id);
    if (!state) throw new Error(`Unknown command_id: ${id}. Only the ${MAX_COMPLETED_STATES} most recent finished commands are retained.`);
    if (state.status !== "running") throw new Error(`Command ${id} is not running (status=${state.status}).`);
    if (state.execution !== "pty") {
      throw new Error(`Command ${id} runs in direct mode without a terminal; interactive input requires the default PTY execution mode.`);
    }
    const text = asString(input.input);
    const appendNewline = asBoolean(input.append_newline, true);
    state.slot?.pty.sendInput(text, appendNewline);
    return [
      "=== SEND_COMMAND_INPUT BEGIN ===",
      `command_id: ${id}`,
      `terminal_id: ${state.terminalId}`,
      `status: ${state.status}`,
      `bytes_sent: ${Buffer.byteLength(text, "utf8")}`,
      `append_newline: ${appendNewline}`,
      "=== SEND_COMMAND_INPUT END ===",
    ].join("\n");
  }

  terminate(input: Record<string, unknown>): string {
    const id = asString(input.command_id);
    const state = this.states.get(id);
    if (!state) throw new Error(`Unknown command_id: ${id}. Only the ${MAX_COMPLETED_STATES} most recent finished commands are retained.`);
    if (state.status !== "running") {
      return [
        "=== TERMINATE_COMMAND BEGIN ===",
        `command_id: ${id}`,
        `terminal_id: ${state.terminalId}`,
        `terminal_name: ${JSON.stringify(state.terminalName)}`,
        `status: ${state.status}`,
        `exit_code: ${state.exitCode ?? "null"}`,
        "already_finished: true",
        "=== TERMINATE_COMMAND END ===",
      ].join("\n");
    }
    // Direct commands own no terminal slot; killing the child process is the whole job.
    if (state.execution === "direct") {
      state.child?.kill();
      // Settle it here: the child's close handler otherwise fires a moment later and records
      // the state as "failed", contradicting the "killed" reported below, and this is the
      // only path that releases a direct command's bridged temp script.
      this.finishState(state, null, "killed");
      return [
        "=== TERMINATE_COMMAND BEGIN ===",
        `command_id: ${id}`,
        `terminal_id: ${state.terminalId}`,
        `terminal_name: ${JSON.stringify(state.terminalName)}`,
        "status: killed",
        "terminal_closed: false",
        "=== TERMINATE_COMMAND END ===",
      ].join("\n");
    }
    const slot = state.slot!;
    // Retire the slot before anything else: finishState clears busyCommandId, and until the
    // terminal-close event lands (debounced by PTY_EXIT_DATA_FLUSH_MS) acquireTerminal could
    // otherwise hand the dying terminal to a new command.
    slot.closed = true;
    this.slots.delete(slot.id);
    slot.pty.terminateActiveProcess();
    // finishState must run before terminal.dispose(): the onDidCloseTerminal listener also
    // marks running states killed, and if it wins the race this call would be skipped by the
    // status guard, leaving the finished-state pruning and slot bookkeeping undone.
    this.finishState(state, null, "killed");
    try {
      slot.terminal.dispose();
    } catch {
      // The terminal may already be closing.
    }
    return [
      "=== TERMINATE_COMMAND BEGIN ===",
      `command_id: ${id}`,
      `terminal_id: ${slot.id}`,
      `terminal_name: ${JSON.stringify(slot.terminal.name)}`,
      "status: killed",
      "terminal_closed: true",
      "=== TERMINATE_COMMAND END ===",
    ].join("\n");
  }

  revealTerminal(terminalId: string): boolean {
    const slot = this.slots.get(terminalId);
    if (!slot || slot.closed) return false;
    slot.terminal.show(false);
    return true;
  }
}

/**
 * What a directory entry is, from the `FileType` a provider reported.
 *
 * `FileType` is a set of bits, not an enumeration of exclusive values: a link is reported as
 * SymbolicLink combined with whatever it points at - File, or Directory - so comparing the
 * whole number against one member reported an entry that is two things at once as none of
 * them, and a symlink to a file or to a directory was listed as "unknown". The link bit is
 * what a reader asked about, so it is answered first.
 */
export function fileTypeKind(type: number): "dir" | "file" | "symlink" | "unknown" {
  if (type & vscode.FileType.SymbolicLink) return "symlink";
  if (type & vscode.FileType.Directory) return "dir";
  if (type & vscode.FileType.File) return "file";
  return "unknown";
}

export async function listDirectory(input: Record<string, unknown>): Promise<string> {
  const configuredExcludes = vscode.workspace.getConfiguration("agentbridge").get<unknown>("files.excludeGlobs");
  const excluded = excludeDirectoryNames([
    ...COMMON_EXCLUDE_GLOBS,
    ...(Array.isArray(configuredExcludes)
      ? configuredExcludes.filter((value): value is string => typeof value === "string")
      : []),
  ]);
  const scope = await resolveExistingWorkspacePath(asString(input.path, "."));
  const depthBound = boundedInteger(input.depth, 1, 1, 2, "depth");
  const depth = depthBound.value;
  const includeHidden = asBoolean(input.include_hidden, false);
  const noIgnore = asBoolean(input.no_ignore, false);
  const maxEntriesBound = boundedInteger(input.max_entries, 200, 1, 500, "max_entries");
  const maxEntries = maxEntriesBound.value;
  const adjusted = boundedNotes([depthBound, maxEntriesBound]);
  const entries: Array<{ type: "dir" | "file" | "symlink" | "unknown"; path: string }> = [];
  let truncated = false;
  let entriesSeen = 0;

  const visit = async (uri: vscode.Uri, relative: string, level: number): Promise<void> => {
    if (truncated) return;
    const children = await vscode.workspace.fs.readDirectory(uri);
    children.sort((a, b) => {
      const ad = a[1] & vscode.FileType.Directory ? 0 : 1;
      const bd = b[1] & vscode.FileType.Directory ? 0 : 1;
      return ad - bd || a[0].localeCompare(b[0]);
    });
    for (const [name, type] of children) {
      if (!includeHidden && name.startsWith(".")) continue;
      // The names are lower-cased on purpose: the built-in excludes are noise reduction, so a
      // "Vendor" entry is the same "vendor" find_files hides, not a directory the reader asked
      // to see. no_ignore still brings any of them back.
      if (!noIgnore && excluded.has(name.toLowerCase())) continue;
      const childRelative = relative === "." ? name : `${relative}/${name}`;
      // Counted whether or not it fits: "truncated: true" on its own says the answer is short
      // and not by how much, which is the difference between a directory that holds one more
      // entry and one that holds four hundred. The directory being walked is finished so the
      // count is a number and not a guess; deeper directories are not descended into once the
      // answer is full, so a truncated count is what was seen rather than all there is.
      entriesSeen += 1;
      if (entries.length < maxEntries) {
        entries.push({
          type: fileTypeKind(type),
          path: childRelative,
        });
      } else {
        truncated = true;
      }
      if (truncated) continue;
      // A symlink is not followed, so a link that points at a directory is still only a link
      // here: descending into it could walk a cycle, and readDirectory reports its type with
      // the Directory bit set as well.
      if (level < depth && (type & vscode.FileType.Directory) !== 0 && (type & vscode.FileType.SymbolicLink) === 0) {
        await visit(vscode.Uri.joinPath(uri, name), childRelative, level + 1);
        if (truncated) break;
      }
    }
  };

  await visit(scope.uri, scope.relative, 1);
  return [
    "=== LIST_DIRECTORY BEGIN ===",
    `path: ${JSON.stringify(scope.relative)}`,
    `depth: ${depth}`,
    `max_entries: ${maxEntries}`,
    `include_hidden: ${includeHidden}`,
    `no_ignore: ${noIgnore}`,
    ...(adjusted ? [adjusted] : []),
    `returned_entries: ${entries.length}`,
    `entries_seen: ${entriesSeen}`,
    `truncated: ${truncated}`,
    ...(truncated
      ? [`NOTE: the listing stopped at max_entries; entries_seen is what the walk counted, and a directory below the one it stopped in was not descended into, so more may exist.`]
      : []),
    "--- ENTRIES ---",
    ...entries.map((entry) => `${entry.type === "dir" ? "[DIR]" : entry.type === "file" ? "[FILE]" : entry.type === "symlink" ? "[LINK]" : "[OTHER]"} ${entry.path}`),
    "=== LIST_DIRECTORY END ===",
  ].join("\n");
}

/** The severities get_diagnostics accepts, in the order callers meet them. */
export const DIAGNOSTIC_SEVERITIES = ["error", "warning", "information", "hint"] as const;

/**
 * Keep the severities a caller asked for, refusing a list that names none. Writing
 * "errror" or "warn" used to be accepted and then matched nothing at all, so the tool
 * returned an empty result that looked like a clean workspace.
 */
/** What a severity argument said: the names it recognises, and the ones it does not. */
export interface SeverityFilter {
  /** The severities to keep. Empty when nothing usable was named, which means no filter. */
  known: Set<string>;
  /** The entries that are not one of DIAGNOSTIC_SEVERITIES, in the order they arrived. */
  ignored: string[];
}

/**
 * Split a severity argument into the names it recognises and the ones it does not.
 *
 * A name that cannot match anything used to be refused outright, on the grounds that filtering
 * every severity away answers "no diagnostics" for a directory that has some. That reasoning
 * holds, but failing the call is not the only way to say it: the filter is simply not applied,
 * and the report names the values it could not use and says that every severity is included.
 * A caller that misspells one name still gets its diagnostics, with the mistake in front of it.
 */
export function normalizeSeverities(values: readonly unknown[]): SeverityFilter {
  const known = new Set<string>();
  const ignored: string[] = [];
  for (const value of values) {
    if (typeof value === "string" && (DIAGNOSTIC_SEVERITIES as readonly string[]).includes(value)) {
      known.add(value);
    } else {
      // Shown the way boundedInteger shows a value it refused: one line, and safe to build
      // even from a value that is long, carries line breaks, or cannot be printed at all.
      ignored.push(describeValue(value));
    }
  }
  return { known, ignored };
}

function severityName(severity: vscode.DiagnosticSeverity): "error" | "warning" | "information" | "hint" {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error: return "error";
    case vscode.DiagnosticSeverity.Warning: return "warning";
    case vscode.DiagnosticSeverity.Information: return "information";
    default: return "hint";
  }
}

function diagnosticCode(code: vscode.Diagnostic["code"]): string | number | undefined {
  if (code === undefined) return undefined;
  if (typeof code === "string" || typeof code === "number") return code;
  return code.value;
}

/**
 * How much of one diagnostic message a report carries. A type error that expands its type can
 * run to tens of thousands of characters, and the report is cut at max_results entries, so an
 * unbounded message is one diagnostic spending the whole budget by itself.
 */
const MAX_DIAGNOSTIC_MESSAGE_CHARS = 2_000;

/**
 * Shorten one diagnostic message, and keep it on one line.
 *
 * A TypeScript error that expands a type can be longer than the whole report is meant to be,
 * so a single diagnostic used to be able to crowd every other one out of the answer it was
 * sharing. Newlines go as well: a message is emitted as a run of lines that a caller reads
 * positionally, and a diagnostic carrying its own line breaks reads as several entries.
 */
export function boundedDiagnosticMessage(message: string, maxChars = MAX_DIAGNOSTIC_MESSAGE_CHARS): string {
  const flat = message.replace(/\s+/g, " ");
  const length = countCodePoints(flat);
  if (length <= maxChars) return flat;
  return `${takeCodePoints(flat, maxChars)} ...[truncated ${length - maxChars} more characters]`;
}

/**
 * The characters in a string, counted as a reader counts them.
 *
 * `.length` counts UTF-16 units, so a character written outside the first plane - an emoji, a
 * rarer CJK extension, a mathematical symbol - counts twice. Here that decided whether a
 * message was short enough at all, and by how much it was over.
 */
function countCodePoints(text: string): number {
  let count = 0;
  let index = 0;
  while (index < text.length) {
    index += (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
    count += 1;
  }
  return count;
}

/**
 * The first `count` characters of a string, cut between characters rather than through one.
 *
 * `slice` counts UTF-16 units too, so a cut that landed between the two halves of a surrogate
 * pair left half a character at the end of the message: an unpaired surrogate, which is not
 * text a caller can print or compare, and which a JSON writer answers with a replacement
 * character or with an error instead.
 */
function takeCodePoints(text: string, count: number): string {
  let end = 0;
  for (let taken = 0; taken < count && end < text.length; taken += 1) {
    end += (text.codePointAt(end) ?? 0) > 0xffff ? 2 : 1;
  }
  return text.slice(0, end);
}

export function getDiagnostics(input: Record<string, unknown>): string {
  const root = workspaceRoot();
  const scope = input.path === undefined ? undefined : resolveWorkspacePath(asString(input.path));
  const filter = Array.isArray(input.severity) ? normalizeSeverities(input.severity) : undefined;
  const severities = filter && filter.known.size > 0 ? filter.known : undefined;
  const maxResultsBound = boundedInteger(input.max_results, 100, 1, 500, "max_results");
  const maxResults = maxResultsBound.value;
  const adjusted = boundedNotes([maxResultsBound]);
  const rows: Array<Record<string, unknown>> = [];
  let totalMatching = 0;
  let documentsWithDiagnostics = 0;
  // Both checks go through isInside rather than comparing strings: on Windows "SRC" and "src"
  // name one directory, and a string compare answered "no diagnostics" about a directory that
  // has some.
  const inScope = (filePath: string): boolean =>
    isInside(root, filePath) && (!scope || isInside(scope.absolute, filePath));

  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== "file" || !inScope(uri.fsPath)) continue;
    if (diagnostics.length > 0) documentsWithDiagnostics += 1;
    for (const diagnostic of diagnostics) {
      const severity = severityName(diagnostic.severity);
      if (severities && !severities.has(severity)) continue;
      totalMatching += 1;
      // Everything matching is collected and the answer is shortened after the sort, not
      // during the walk: stopping here kept the first N diagnostics the provider happened to
      // report, and a file full of hints reported first pushed the errors in a file reported
      // later off the end - while total_matching still counted them and truncated still said
      // so. The rows are small objects and the diagnostics are already in memory.
      rows.push({
        path: path.relative(root, uri.fsPath).replace(/\\/g, "/"),
        line: diagnostic.range.start.line + 1,
        column: diagnostic.range.start.character + 1,
        end_line: diagnostic.range.end.line + 1,
        end_column: diagnostic.range.end.character + 1,
        severity,
        source: diagnostic.source ?? null,
        code: diagnosticCode(diagnostic.code) ?? null,
        message: boundedDiagnosticMessage(diagnostic.message),
      });
    }
  }

  rows.sort((a, b) => {
    const order: Record<string, number> = { error: 0, warning: 1, information: 2, hint: 3 };
    return (order[String(a.severity)] ?? 9) - (order[String(b.severity)] ?? 9)
      || String(a.path).localeCompare(String(b.path))
      || Number(a.line) - Number(b.line)
      || Number(a.column) - Number(b.column);
  });
  const returned = rows.slice(0, maxResults);
  // What the editor is looking at in this scope. A zero result next to a zero here is the
  // difference between "nothing is wrong" and "nothing has been looked at": diagnostics exist
  // only for documents a provider has published them for, which in practice means the ones
  // open in the editor, so a file with an error that was never opened reports nothing.
  const openDocuments = (vscode.workspace.textDocuments ?? []).filter(
    (document) => document.uri.scheme === "file" && inScope(document.uri.fsPath),
  ).length;
  return [
    "=== GET_DIAGNOSTICS BEGIN ===",
    `scope: ${JSON.stringify(scope?.relative ?? ".")}`,
    `max_results: ${maxResults}`,
    ...(adjusted ? [adjusted] : []),
    `returned: ${returned.length}`,
    `total_matching: ${totalMatching}`,
    `truncated: ${totalMatching > returned.length}`,
    `documents_with_diagnostics: ${documentsWithDiagnostics}`,
    `open_documents: ${openDocuments}`,
    ...(returned.length === 0
      ? [`NOTE: no diagnostics were reported for this scope, which is not proof its files are clean - only documents a provider has published diagnostics for are counted, and ${openDocuments === 0 ? "no document in this scope is open in the editor" : `${openDocuments === 1 ? "1 document in this scope is" : `${openDocuments} documents in this scope are`} open in the editor`}.`]
      : []),
    ...(filter && filter.ignored.length > 0
      ? [
        `ignored_severity_values: ${JSON.stringify(filter.ignored)}`,
        `severity_filter_applied: ${severities !== undefined}`,
        ...(severities === undefined
          ? [`NOTE: none of the severity values is one of ${DIAGNOSTIC_SEVERITIES.join(", ")}, so no severity filter was applied and every severity is included.`]
          : [`NOTE: severity values that are not one of ${DIAGNOSTIC_SEVERITIES.join(", ")} were ignored; the rest were applied.`]),
      ]
      : []),
    "--- DIAGNOSTICS ---",
    ...returned.map((row, index) => [
      `--- DIAGNOSTIC ${index + 1} ---`,
      `${row.path}:${row.line}:${row.column}`,
      `severity: ${row.severity}`,
      `source: ${JSON.stringify(row.source)}`,
      `code: ${JSON.stringify(row.code)}`,
      String(row.message),
    ].join("\n")),
    "=== GET_DIAGNOSTICS END ===",
  ].join("\n");
}

export class IdeToolBroker implements vscode.Disposable {
  private readonly terminalManager = new TerminalCommandManager();

  async runTerminalSmokeTest(): Promise<string> {
    const firstCommand = process.platform === "win32"
      ? "$env:AGENTBRIDGE_PERSISTENT_SMOKE='yes'; Write-Output 'agentbridge-terminal-smoke-1'"
      : "export AGENTBRIDGE_PERSISTENT_SMOKE=yes; printf 'agentbridge-terminal-smoke-1\\n'";
    const secondCommand = process.platform === "win32"
      ? "Write-Output ('agentbridge-terminal-smoke-2:' + $env:AGENTBRIDGE_PERSISTENT_SMOKE)"
      : "printf 'agentbridge-terminal-smoke-2:%s\\n' \"$AGENTBRIDGE_PERSISTENT_SMOKE\"";
    const first = await this.terminalManager.run({
      command: firstCommand,
      cwd: ".",
      background: false,
      timeout_ms: 15_000,
    });
    const second = await this.terminalManager.run({
      command: secondCommand,
      background: false,
      timeout_ms: 15_000,
    });
    return `${first}\n--- SECOND COMMAND ---\n${second}`;
  }

  async runLspSmokeTest(): Promise<string> {
    return invokeLspTool({ operation: "workspace_symbols", query: "RuntimeClient", max_results: 20 });
  }

  revealTerminal(terminalId: string): boolean {
    return this.terminalManager.revealTerminal(terminalId);
  }

  private async executeTool(name: string, input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
    switch (name) {
      case "list_directory": return toolResult(await listDirectory(input));
      case "run_command": return this.terminalResult(name, input, await this.terminalManager.run(input));
      case "get_command_output": return this.terminalResult(name, input, this.terminalManager.getOutput(input));
      case "send_command_input": return this.terminalResult(name, input, this.terminalManager.sendInput(input));
      case "terminate_command": return this.terminalResult(name, input, this.terminalManager.terminate(input));
      case "get_diagnostics": return toolResult(getDiagnostics(input));
      case "lsp": return toolResult(await invokeLspTool(input));
      default: throw new Error(`Unsupported IDE tool: ${name}`);
    }
  }

  /**
   * Wraps a terminal tool result in the structured result type so the Chat UI shows a compact
   * step summary with success/failure and exit code instead of dumping the raw terminal
   * transcript into the response stream. The full transcript still reaches the model as the
   * text content and stays available in the step's expandable details.
   */
  private terminalResult(name: string, input: Record<string, unknown>, text: string): vscode.LanguageModelToolResult {
    // ExtendedLanguageModelToolResult is still a proposed API (Carrier-only); makeToolResult
    // falls back to the stable LanguageModelToolResult (1.95+) or a structural equivalent.
    const result = makeToolResult(text);
    const exitCode = parseExitCode(text);
    const command = typeof input.command === "string" ? input.command.trim() : "";
    const summary = summarizeCommand(command || (typeof input.input === "string" ? input.input : ""));
    switch (name) {
      case "run_command":
        result.toolResultMessage = exitCode === undefined || exitCode === null
          ? `Ran ${summary}`
          : exitCode === 0
            ? `Ran ${summary} · exit 0`
            : `Command failed: ${summary} · exit ${exitCode}`;
        break;
      case "get_command_output":
        result.toolResultMessage = exitCode === undefined || exitCode === null || exitCode === 0
          ? "Read command output"
          : `Command output · exit ${exitCode}`;
        break;
      case "send_command_input":
        result.toolResultMessage = typeof input.command_id === "string" && input.command_id
          ? `Sent command input · ${input.command_id}`
          : "Sent command input";
        break;
      case "terminate_command": {
        const alreadyFinished = /^already_finished: true$/m.test(text);
        result.toolResultMessage = typeof input.command_id === "string" && input.command_id
          ? `${alreadyFinished ? "Command already finished" : "Terminated command"} · ${input.command_id}`
          : alreadyFinished ? "Command already finished" : "Terminated command";
        break;
      }
    }
    return result;
  }

  async invokeDirect(
    name: string,
    args: Record<string, unknown>,
    cancellationToken?: vscode.CancellationToken,
  ): Promise<{ text: string; isError: boolean }> {
    if (!getIdeToolDefinition(name)) return { text: `Unknown IDE tool: ${name}`, isError: true };
    if (cancellationToken?.isCancellationRequested) return { text: `IDE tool ${name} canceled.`, isError: true };
    try {
      const result = await this.executeTool(name, args);
      if (cancellationToken?.isCancellationRequested) return { text: `IDE tool ${name} canceled.`, isError: true };
      return { text: resultText(result), isError: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { text: `IDE tool ${name} failed: ${message}`, isError: true };
    }
  }

  dispose(): void {
    this.terminalManager.dispose();
  }
}

