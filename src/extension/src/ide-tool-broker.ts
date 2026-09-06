import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { getIdeToolDefinition } from "./ide-tool-definitions.js";
import { invokeLspTool } from "./lsp-tool.js";

const COMMON_EXCLUDES = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", "target", "vendor"]);
const MAX_CAPTURED_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_COMPLETED_STATES = 32;
const DEFAULT_OUTPUT_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_IDLE_TERMINALS = 4;
const PTY_EXIT_DATA_FLUSH_MS = 100;
const COMMAND_ECHO_TIMEOUT_MS = 3000;
const MAX_ECHO_HUNT_BYTES = 1024 * 1024;
const MANAGED_TERMINAL_NAME = /^AgentBridge · \d+$/;
const CHAT_CAPTURE_COLUMNS = 1000;
const CHAT_CAPTURE_INPUT_KEY = "__agentbridgeChatCapture";
/** Shell kinds with a per-prompt hook that can emit the OSC 633 protocol marker. */
const RUN_COMMAND_SHELLS: ReadonlySet<ShellChoice["kind"]> = new Set(["ps51", "pwsh", "bash", "zsh"]);

interface TerminalSlot {
  id: string;
  terminal: vscode.Terminal;
  pty: ManagedCommandPseudoterminal;
  initialCwd: string;
  busyCommandId?: string;
  closed: boolean;
  lastUsedAt: number;
}

interface CommandState {
  id: string;
  terminal: vscode.Terminal;
  terminalId: string;
  terminalReused: boolean;
  slot: TerminalSlot;
  command: string;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  background: boolean;
  status: "running" | "completed" | "failed" | "killed";
  exitCode: number | null;
  output: Buffer;
  outputStartOffset: number;
  totalOutputBytes: number;
  ansiPending: string;
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
 * Evict oldest finished command states (Map insertion order = start order) until at most
 * `cap` finished entries remain. Running states — including in-flight background commands,
 * whose `status` stays "running" until they finish — are never evicted.
 */
export function pruneFinishedCommandStates(states: Map<string, CommandState>, cap: number): void {
  let finished = 0;
  for (const state of states.values()) {
    if (state.status !== "running") finished++;
  }
  if (finished <= cap) return;
  let excess = finished - cap;
  for (const [id, state] of states) {
    if (excess <= 0) break;
    if (state.status === "running") continue;
    states.delete(id);
    excess--;
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

function inferShellKindFromPath(executable: string, fallback: ShellChoice["kind"]): ShellChoice["kind"] {
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

function resolveManagedShellChoice(): ShellChoice {
  const override = resolveOverrideManagedShell();
  if (override === "") {
    // defaults below
  } else if (process.platform === "win32") {
    if (!path.isAbsolute(override)) {
      throw new Error(`managedShell.windows 需要绝对路径（例如 C:\\Program Files\\PowerShell\\7\\pwsh.exe），收到的值：${override}`);
    }
    if (!fs.existsSync(override)) {
      throw new Error(`managedShell.windows 指定的 shell 路径不存在：${override}`);
    }
    const kind = inferShellKindFromPath(override, "ps51");
    switch (kind) {
      case "pwsh": return describePwshShell(override);
      case "cmd": return describeCmdShell(override);
      default: return describePs51Shell(override);
    }
  } else {
    const resolved = path.isAbsolute(override) ? override : lookupOnPathEnv(override);
    if (resolved === null) {
      throw new Error(`managedShell.unix 指定的 shell 未在 PATH 中找到：${override}`);
    }
    if (path.isAbsolute(override) && !fs.existsSync(override)) {
      throw new Error(`managedShell.unix 指定的 shell 路径不存在：${override}`);
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
      throw new Error(`AgentBridge 默认 Management Shell 未找到：${executable}。请在设置中指定一个可用的 shell（例如 C:\\Program Files\\PowerShell\\7\\pwsh.exe）。`);
    }
    return describePs51Shell(executable);
  }
  if (fs.existsSync("/bin/bash")) return describePosixShell("/bin/bash", "bash");
  if (fs.existsSync("/bin/sh")) return describePosixShell("/bin/sh", "sh");
  throw new Error("AgentBridge 未在默认路径找到 /bin/bash 或 /bin/sh；请在设置中手动指定 managedShell.unix。");
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
 * -NoProfile -Command "exit 0" / -c "exit 0". Returns false on non-zero exit
 * or timeout error. Caller (panel) uses this before writing the config so
 * invalid paths never silently fall back at Bridge Start time.
 */
export function sanityCheckManagedShellPath(candidatePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      const isCmd = /\.cmd$/i.test(candidatePath) || /cmd\.exe$/i.test(candidatePath);
      const args = isCmd ? ["/c", "exit 0"] : ["-NoProfile", "-Command", "exit 0"];
      const child = spawn(candidatePath, args, { windowsHide: true, timeout: 2000 });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
    } else {
      const child = spawn(candidatePath, ["-c", "exit 0"], { timeout: 2000 });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
    }
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
        `  [Console]::Write("${markerPrefix}$global:__AgentBridgePromptSequence;$agentBridgeExit;$agentBridgeCwd\u0007")`,
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
        `printf '\\033]633;AgentBridge;${protocolToken};%s;%s;%s\\007' \"$__agentbridge_seq\" \"$__agentbridge_ec\" \"$__agentbridge_cwd\"`,
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
      // The marker payload order (seq;ec;cwd) must match handleProtocolMarker's split().
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-zsh-"));
      const zshrc = [
        "PROMPT='$ '",
        "__agentbridge_seq=0",
        "precmd() {",
        "  __agentbridge_ec=$?",
        "  __agentbridge_seq=$((__agentbridge_seq + 1))",
        "  __agentbridge_cwd=$(printf '%s' \"$PWD\" | base64 | tr -d '\\r\\n')",
        `  printf '\\033]633;AgentBridge;${protocolToken};%s;%s;%s\\007' \"$__agentbridge_seq\" \"$__agentbridge_ec\" \"$__agentbridge_cwd\"`,
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
  return env;
}

class ManagedCommandPseudoterminal implements vscode.Pseudoterminal, vscode.Disposable {
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
  private activePtyDataSubscription: NodePtyDisposable | undefined;
  private activePtyExitSubscription: NodePtyDisposable | undefined;
  private activeCommand: {
    sequence: number;
    started: boolean;
    captureColumns?: number;
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

  constructor(private readonly initialCwd: string) {
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
      this.activePty.resize(this.activeCommand?.captureColumns ?? this.cols, this.rows);
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
    this.echoExpectation = text.replace(/[\r\n]+/g, "");
    this.echoMatchIndex = 0;
    this.echoHuntBytesRemaining = MAX_ECHO_HUNT_BYTES;
    // Discard everything (bounded) until the echo anchor: a REPL may render its prompt
    // (">>> ") plus stale redraw content in the same chunk that precedes the echo.
    this.echoHuntDiscardAll = true;
    this.echoHuntingPromptLine = false;
    this.echoGateActive = true;
    this.armEchoTimeout();
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
    captureColumns?: number,
  ): Promise<void> {
    await this.ensureStarted();
    if (this.disposed) throw new Error("The AgentBridge managed terminal is closed.");
    if (!this.activePty) throw new Error("The AgentBridge managed PTY shell is not running.");
    if (this.activeCommand) throw new Error("The AgentBridge managed terminal is already running a command.");
    const sequence = this.nextCommandSequence++;
    this.activeCommand = { sequence, started: false, captureColumns, ...handlers };
    if (captureColumns) {
      try {
        this.activePty.resize(captureColumns, this.rows);
      } catch {
        // The PTY may exit immediately before the command starts.
      }
    }
    this.writeDisplay(`${command.replace(/\r?\n/g, "\r\n")}\r\n`);
    const normalizedCommand = command.replace(/[\r\n]+/g, "");
    // Arm the echo gate BEFORE writing: every byte that arrives from the PTY after the write
    // is either the echo (consume it) or noise that precedes it (stale prompt, resize redraw);
    // the timeout bounds how long the gate may stay closed when no echo ever renders.
    this.echoExpectation = normalizedCommand;
    this.echoMatchIndex = 0;
    this.echoHuntBytesRemaining = MAX_ECHO_HUNT_BYTES;
    // Discard everything (bounded) until the echo anchor for every run: chat capture resizes
    // the PTY (full-screen redraw), and a previous command's restore-resize redraw can be
    // delivered late into the next command's gate window (background snapshots showed the
    // previous commands' full history). Hunting discards that noise and keeps only the echo.
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
    const ptyProcess = getNodePty().spawn(shell.executable, shell.args, {
      name: process.platform === "win32" ? "cmd" : "xterm-256color",
      cwd: this.initialCwd,
      env,
      cols: this.cols,
      rows: this.rows,
    });
    this.activePty = ptyProcess;

    this.activePtyDataSubscription = ptyProcess.onData((data) => {
      this.handlePtyData(data);
    });
    this.activePtyExitSubscription = ptyProcess.onExit((event) => {
      setTimeout(() => {
        if (this.activePty === ptyProcess) this.activePty = undefined;
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
   * that rendering late, preceded by stale prompt text, full-screen redraws (chat capture
   * resizes the PTY to CHAT_CAPTURE_COLUMNS before each command) and cooked-echo fragments
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
      const active = this.activeCommand;
      if (active && !active.started) active.started = true;
    }, COMMAND_ECHO_TIMEOUT_MS);
  }

  private handleProtocolMarker(payload: string): void {
    if (payload.startsWith("S;")) {
      const sequence = Number.parseInt(payload.slice(2), 10);
      if (this.activeCommand?.sequence === sequence) this.activeCommand.started = true;
      return;
    }
    const [sequenceText, exitCodeText, cwdBase64] = payload.split(";", 3);
    const sequence = Number.parseInt(sequenceText, 10);
    const exitCode = Number.parseInt(exitCodeText, 10);
    if (!Number.isFinite(sequence) || !Number.isFinite(exitCode)) return;
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

    const activeCommand = this.activeCommand;
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

function asInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, Number(value)));
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
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error("No workspace folder is open.");
  return folder.uri.fsPath;
}

function resolveWorkspacePath(relative = "."): { root: string; absolute: string; relative: string; uri: vscode.Uri } {
  const root = workspaceRoot();
  const rel = normalizeRelativePath(relative);
  if (path.isAbsolute(rel)) throw new Error("Path must be workspace-relative.");
  const absolute = path.resolve(root, rel);
  if (!isInside(root, absolute)) throw new Error(`Path is outside the workspace: ${relative}`);
  const normalizedRelative = path.relative(root, absolute).replace(/\\/g, "/") || ".";
  return { root, absolute, relative: normalizedRelative, uri: vscode.Uri.file(absolute) };
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

class TerminalCommandManager implements vscode.Disposable {
  private readonly states = new Map<string, CommandState>();
  private readonly slots = new Map<string, TerminalSlot>();
  private nextCommandId = 1;
  private nextTerminalId = 1;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
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
        for (const state of this.states.values()) {
          if (state.terminal !== terminal || state.status !== "running") continue;
          state.status = "killed";
          state.exitCode = null;
          state.endedAt = Date.now();
          state.resolveDone();
        }
      }),
    );
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
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
      group.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
      for (const duplicate of group.slice(1)) this.disposeIdleSlot(duplicate);
    }

    const remaining = [...this.slots.values()]
      .filter((slot) => !slot.closed && !slot.busyCommandId)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    for (const excess of remaining.slice(MAX_IDLE_TERMINALS)) this.disposeIdleSlot(excess);
  }

  private async acquireTerminal(
    commandId: string,
    cwdInfo: { absolute: string; relative: string; uri: vscode.Uri } | undefined,
  ): Promise<{ slot: TerminalSlot; reused: boolean; effectiveCwd: string }> {
    const candidates = [...this.slots.values()]
      .filter((slot) => !slot.closed && !slot.busyCommandId)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    for (const slot of candidates) {
      if (slot.closed || slot.busyCommandId) continue;
      if (cwdInfo && !this.sameFileSystemPath(this.currentSlotCwd(slot), cwdInfo.absolute)) continue;
      slot.busyCommandId = commandId;
      slot.lastUsedAt = Date.now();
      slot.terminal.show(true);
      return { slot, reused: true, effectiveCwd: this.currentSlotCwd(slot) };
    }

    const initialCwd = cwdInfo?.absolute ?? resolveWorkspacePath(".").absolute;
    const terminalNumber = this.nextTerminalId++;
    const pty = new ManagedCommandPseudoterminal(initialCwd);
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
      slot.closed = true;
      slot.busyCommandId = undefined;
      this.slots.delete(slot.id);
      terminal.dispose();
      throw error;
    }
  }

  private displayCwd(absolute: string): string {
    const root = workspaceRoot();
    if (!isInside(root, absolute)) return absolute;
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
    if (state.output.length === 0) {
      // Strip leading blank lines that leaked past the gate before the first real byte of
      // captured output. Deliberately NOT stripping prompt-shaped text here: commands whose
      // genuine output starts with "$ " or "PS ..." (e.g. echo '$ 100') would lose bytes.
      // Prompts are handled by stripPromptText's tail-anchored pass instead.
      clean = clean.replace(/^(?:\r?\n|[ \t])*/, "");
    }
    if (!clean) return;
    const bytes = Buffer.from(clean, "utf8");
    state.totalOutputBytes += bytes.length;
    state.output = Buffer.concat([state.output, bytes]);
    if (state.output.length > MAX_CAPTURED_OUTPUT_BYTES) {
      state.output = state.output.subarray(state.output.length - MAX_CAPTURED_OUTPUT_BYTES);
    }
    state.outputStartOffset = state.totalOutputBytes - state.output.length;
  }

  private finishState(state: CommandState, exitCode: number | null, status?: CommandState["status"]): void {
    if (state.status !== "running") return;
    state.exitCode = exitCode;
    state.status = status ?? (exitCode === 0 ? "completed" : "failed");
    state.endedAt = Date.now();
    state.slot.lastUsedAt = state.endedAt;
    if (state.slot.busyCommandId === state.id) state.slot.busyCommandId = undefined;
    state.resolveDone();
    this.pruneIdleTerminals();
    pruneFinishedCommandStates(this.states, MAX_COMPLETED_STATES);
  }

  private readOutput(state: CommandState, requestedOffset = 0, maxBytes = DEFAULT_OUTPUT_BYTES): Record<string, unknown> {
    const limit = Math.min(MAX_OUTPUT_BYTES, Math.max(1, maxBytes));
    const outputLost = requestedOffset < state.outputStartOffset;
    const actualOffset = Math.max(state.outputStartOffset, Math.min(requestedOffset, state.totalOutputBytes));
    const localStart = actualOffset - state.outputStartOffset;
    const available = state.output.subarray(localStart);
    const slice = available.subarray(0, limit);
    const nextOffset = actualOffset + slice.length;
    return {
      command_id: state.id,
      terminal_id: state.terminalId,
      terminal_name: state.terminal.name,
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

  async run(input: Record<string, unknown>): Promise<string> {
    const shellChoice = getManagedShellChoice();
    if (!RUN_COMMAND_SHELLS.has(shellChoice.kind)) {
      throw new Error(
        `Managed shell "${shellChoice.description}" does not support run_command. ` +
        `Supported: PowerShell (Windows), bash (Linux), zsh (macOS). ` +
        `Switch via the agentbridge.bridge.managedShell.* settings.`,
      );
    }
    const command = asString(input.command).trim();
    if (!command) throw new Error("command must be a non-empty string");
    const background = asBoolean(input.background, false);
    if (typeof input.background !== "boolean") throw new Error("background must be explicitly true or false");
    const timeoutMs = asInteger(input.timeout_ms, 120_000, 1_000, 120_000);
    const cwdInfo = typeof input.cwd === "string" && input.cwd.trim()
      ? resolveWorkspacePath(input.cwd)
      : undefined;
    const id = `cmd_${Date.now()}_${this.nextCommandId++}`;
    const { slot, reused, effectiveCwd } = await this.acquireTerminal(id, cwdInfo);
    const displayCwd = cwdInfo?.relative ?? this.displayCwd(effectiveCwd);
    const terminal = slot.terminal;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const state: CommandState = {
      id,
      terminal,
      terminalId: slot.id,
      terminalReused: reused,
      slot,
      command,
      cwd: displayCwd,
      startedAt: Date.now(),
      background,
      status: "running",
      exitCode: null,
      output: Buffer.alloc(0),
      outputStartOffset: 0,
      totalOutputBytes: 0,
      ansiPending: "",
      done,
      resolveDone,
    };
    this.states.set(id, state);
    try {
      const captureColumns = asBoolean(input[CHAT_CAPTURE_INPUT_KEY], false) && !background
        ? CHAT_CAPTURE_COLUMNS
        : undefined;
      await slot.pty.run(command, {
        onOutput: (text) => this.appendOutput(state, text),
        onExit: (code) => this.finishState(state, code),
      }, captureColumns);
    } catch (error) {
      this.finishState(state, null, "failed");
      throw error;
    }

    if (!background) {
      await Promise.race([done, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const snapshot = this.readOutput(state, 0, 64 * 1024);
    return [
      "=== RUN_COMMAND BEGIN ===",
      `command_id: ${id}`,
      `terminal_id: ${slot.id}`,
      `terminal_name: ${JSON.stringify(terminal.name)}`,
      `terminal_reused: ${reused}`,
      `command: ${JSON.stringify(command)}`,
      `status: ${snapshot.status}`,
      `exit_code: ${snapshot.exit_code ?? "null"}`,
      `cwd: ${JSON.stringify(displayCwd)}`,
      `background: ${background}`,
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
    const offset = asInteger(input.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const maxBytes = asInteger(input.max_bytes, DEFAULT_OUTPUT_BYTES, 1, MAX_OUTPUT_BYTES);
    const snapshot = this.readOutput(state, offset, maxBytes);
    return [
      "=== COMMAND_OUTPUT BEGIN ===",
      `command_id: ${id}`,
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
    const text = asString(input.input);
    const appendNewline = asBoolean(input.append_newline, true);
    state.slot.pty.sendInput(text, appendNewline);
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
        `status: ${state.status}`,
        `exit_code: ${state.exitCode ?? "null"}`,
        "already_finished: true",
        "=== TERMINATE_COMMAND END ===",
      ].join("\n");
    }
    const slot = state.slot;
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

async function listDirectory(input: Record<string, unknown>): Promise<string> {
  const scope = resolveWorkspacePath(asString(input.path, "."));
  const depth = asInteger(input.depth, 1, 1, 2);
  const includeHidden = asBoolean(input.include_hidden, false);
  const noIgnore = asBoolean(input.no_ignore, false);
  const maxEntries = asInteger(input.max_entries, 200, 1, 500);
  const entries: Array<{ type: "dir" | "file" | "symlink" | "unknown"; path: string }> = [];
  let truncated = false;

  const visit = async (uri: vscode.Uri, relative: string, level: number): Promise<void> => {
    if (truncated) return;
    const children = await vscode.workspace.fs.readDirectory(uri);
    children.sort((a, b) => {
      const ad = a[1] === vscode.FileType.Directory ? 0 : 1;
      const bd = b[1] === vscode.FileType.Directory ? 0 : 1;
      return ad - bd || a[0].localeCompare(b[0]);
    });
    for (const [name, type] of children) {
      if (!includeHidden && name.startsWith(".")) continue;
      if (!noIgnore && COMMON_EXCLUDES.has(name)) continue;
      const childRelative = relative === "." ? name : `${relative}/${name}`;
      entries.push({
        type: type === vscode.FileType.Directory ? "dir" : type === vscode.FileType.File ? "file" : type === vscode.FileType.SymbolicLink ? "symlink" : "unknown",
        path: childRelative,
      });
      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }
      if (level < depth && type === vscode.FileType.Directory) {
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
    `include_hidden: ${includeHidden}`,
    `no_ignore: ${noIgnore}`,
    `returned_entries: ${entries.length}`,
    `truncated: ${truncated}`,
    "--- ENTRIES ---",
    ...entries.map((entry) => `${entry.type === "dir" ? "[DIR]" : entry.type === "file" ? "[FILE]" : entry.type === "symlink" ? "[LINK]" : "[OTHER]"} ${entry.path}`),
    "=== LIST_DIRECTORY END ===",
  ].join("\n");
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

function getDiagnostics(input: Record<string, unknown>): string {
  const root = workspaceRoot();
  const scope = input.path === undefined ? undefined : resolveWorkspacePath(asString(input.path));
  const severities = Array.isArray(input.severity) ? new Set(input.severity.filter((value): value is string => typeof value === "string")) : undefined;
  const maxResults = asInteger(input.max_results, 100, 1, 500);
  const rows: Array<Record<string, unknown>> = [];
  let totalMatching = 0;

  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== "file" || !isInside(root, uri.fsPath)) continue;
    if (scope) {
      const scopePath = path.resolve(scope.absolute);
      const candidate = path.resolve(uri.fsPath);
      if (!(candidate === scopePath || candidate.startsWith(`${scopePath}${path.sep}`))) continue;
    }
    for (const diagnostic of diagnostics) {
      const severity = severityName(diagnostic.severity);
      if (severities && !severities.has(severity)) continue;
      totalMatching += 1;
      if (rows.length >= maxResults) continue;
      rows.push({
        path: path.relative(root, uri.fsPath).replace(/\\/g, "/"),
        line: diagnostic.range.start.line + 1,
        column: diagnostic.range.start.character + 1,
        end_line: diagnostic.range.end.line + 1,
        end_column: diagnostic.range.end.character + 1,
        severity,
        source: diagnostic.source ?? null,
        code: diagnosticCode(diagnostic.code) ?? null,
        message: diagnostic.message,
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
  return [
    "=== GET_DIAGNOSTICS BEGIN ===",
    `scope: ${JSON.stringify(scope?.relative ?? ".")}`,
    `returned: ${returned.length}`,
    `total_matching: ${totalMatching}`,
    `truncated: ${totalMatching > returned.length}`,
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
      case "terminate_command":
        result.toolResultMessage = typeof input.command_id === "string" && input.command_id
          ? `Terminated command · ${input.command_id}`
          : "Terminated command";
        break;
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

