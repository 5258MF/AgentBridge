import { readFileSync } from "node:fs";

type ConfigChangeListener = (event: { affectsConfiguration(section: string): boolean }) => void;

const config = new Map<string, unknown>();
const configListeners = new Set<ConfigChangeListener>();
const workspaceFolderListeners = new Set<() => void>();
const trustListeners = new Set<() => void>();
const fileWatchers = new Set<{ listeners: Set<() => void> }>();
let trustedWorkspace = true;
let updateHandler: ((input: { key: string; value: unknown; apply(): void }) => Promise<void>) | undefined;

const errors: string[] = [];
const warnings: string[] = [];
const information: string[] = [];
const registeredCommands = new Map<string, (...args: any[]) => any>();
const terminalCloseListeners = new Set<(terminal: any) => void>();
const terminals: Array<{ name: string; show(preserveFocus?: boolean): void; dispose(): void }> = [];
type ExecuteCommandHandler = (id: string, ...args: any[]) => unknown;
let executeCommandHandler: ExecuteCommandHandler | undefined;
const textDocuments: Array<{ uri: { toString(): string } }> = [];

function fullKey(section: string, key: string): string {
  return section ? `${section}.${key}` : key;
}

function emitConfigurationChange(key: string): void {
  const event = {
    affectsConfiguration(section: string): boolean {
      return key === section || key.startsWith(`${section}.`) || section.startsWith(`${key}.`);
    },
  };
  for (const listener of [...configListeners]) listener(event);
}

export const vscodeTest = {
  setTrust(trusted: boolean): void { trustedWorkspace = trusted; if (trusted) for (const listener of trustListeners) listener(); },
  fireMcpConfigChange(): void { for (const watcher of fileWatchers) for (const listener of watcher.listeners) listener(); },
  fireWorkspaceFoldersChange(): void { for (const listener of workspaceFolderListeners) listener(); },
  createMemento() {
    const values = new Map<string, unknown>();
    return {
      get: <T>(key: string, fallback?: T) => (values.has(key) ? values.get(key) : fallback) as T,
      update: async (key: string, value: unknown) => {
        if (value === undefined) values.delete(key);
        else values.set(key, JSON.parse(JSON.stringify(value)));
      },
      keys: () => [...values.keys()],
    };
  },
  errors,
  warnings,
  information,
  reset(): void {
    config.clear();
    configListeners.clear();
    workspaceFolderListeners.clear();
    trustListeners.clear();
    fileWatchers.clear();
    trustedWorkspace = true;
    updateHandler = undefined;
    errors.length = 0;
    warnings.length = 0;
    information.length = 0;
    registeredCommands.clear();
    terminalCloseListeners.clear();
    terminals.length = 0;
    executeCommandHandler = undefined;
    textDocuments.length = 0;
    config.set("agentbridge.language", "en");
    config.set("agentbridge.bridge.tunnelProvider", "cloudflare");
    config.set("agentbridge.bridge.tunnelProtocol", "auto");
    config.set("agentbridge.bridge.trustedBrowserOrigins", []);
    config.set("agentbridge.bridge.persistentMode", false);
    config.set("agentbridge.bridge.readOnlyMode", false);
    config.set("agentbridge.bridge.openInternalBrowser", "auto");
  },
  setConfig(key: string, value: unknown): void {
    if (value === undefined) config.delete(key);
    else config.set(key, value);
  },
  getConfig<T>(key: string): T | undefined {
    return config.get(key) as T | undefined;
  },
  emitConfig(key: string): void {
    emitConfigurationChange(key);
  },
  setUpdateHandler(handler: typeof updateHandler): void {
    updateHandler = handler;
  },
  /** Answers `commands.executeCommand` (e.g. the `vscode.execute*Provider` commands) until reset. */
  setExecuteCommandHandler(handler: ExecuteCommandHandler | undefined): void {
    executeCommandHandler = handler;
  },
  /** Documents VS Code reports as open; `openTextDocument` on a file adds to it, as in VS Code. */
  textDocuments,
  getCommand<T extends (...args: any[]) => any>(id: string): T {
    const command = registeredCommands.get(id);
    if (!command) throw new Error(`Command not registered: ${id}`);
    return command as T;
  },
};

vscodeTest.reset();

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;
export const ExtensionMode = { Production: 1, Development: 2, Test: 3 } as const;
export const ProgressLocation = { Notification: 15 } as const;
export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 } as const;
export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 } as const;
export const SymbolKind = {} as Record<string, number>;

export class RelativePattern {
  constructor(readonly base: unknown, readonly pattern: string) {}
}

export class MarkdownString {
  constructor(readonly value = "") {}
}

export class EventEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();
  readonly event = (listener: (value: T) => void) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value: T): void {
    for (const listener of this.listeners) listener(value);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export class ThemeIcon {
  constructor(readonly id: string) {}
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class CancellationTokenSource {
  private cancelled = false;
  readonly token = {
    get isCancellationRequested(): boolean {
      return false;
    },
    onCancellationRequested: () => ({ dispose() {} }),
  };
  cancel(): void {
    this.cancelled = true;
    void this.cancelled;
  }
  dispose(): void {}
}

export class Position {
  constructor(readonly line: number, readonly character: number) {}
}

export class Range {
  constructor(readonly start: Position, readonly end: Position) {}
}

export const Uri = {
  parse(value: string) {
    return { toString: () => value, fsPath: value };
  },
  joinPath(base: { fsPath: string }, ...parts: string[]) {
    return { fsPath: [base.fsPath, ...parts].join("/") };
  },
  file(value: string) {
    return { fsPath: value, toString: () => value };
  },
};

export const workspace = {
  get isTrusted() { return trustedWorkspace; },
  onDidGrantWorkspaceTrust(listener: () => void) { trustListeners.add(listener); return { dispose: () => trustListeners.delete(listener) }; },
  onDidChangeWorkspaceFolders(listener: () => void) { workspaceFolderListeners.add(listener); return { dispose: () => workspaceFolderListeners.delete(listener) }; },
  createFileSystemWatcher(_pattern: unknown) {
    const watcher = { listeners: new Set<() => void>() };
    fileWatchers.add(watcher);
    const add = (listener: () => void) => { watcher.listeners.add(listener); return { dispose: () => watcher.listeners.delete(listener) }; };
    return { onDidCreate: add, onDidChange: add, onDidDelete: add, dispose: () => fileWatchers.delete(watcher) };
  },
  workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
  getConfiguration(section = "") {
    return {
      get<T>(key: string, defaultValue?: T): T {
        const value = config.get(fullKey(section, key));
        return (value === undefined ? defaultValue : value) as T;
      },
      async update(key: string, value: unknown): Promise<void> {
        const keyName = fullKey(section, key);
        const apply = () => {
          if (value === undefined) config.delete(keyName);
          else config.set(keyName, value);
          emitConfigurationChange(keyName);
        };
        if (updateHandler) {
          await updateHandler({ key: keyName, value, apply });
          return;
        }
        apply();
      },
    };
  },
  onDidChangeConfiguration(listener: ConfigChangeListener) {
    configListeners.add(listener);
    return { dispose: () => configListeners.delete(listener) };
  },
  updateWorkspaceFolders(): boolean {
    return true;
  },
  textDocuments,
  async openTextDocument(input: unknown) {
    const fsPath = (input as { fsPath?: unknown } | undefined)?.fsPath;
    if (typeof fsPath !== "string") return { uri: input };
    const uri = input as { toString(): string };
    const lines = readFileSync(fsPath, "utf8").split(/\r?\n/);
    const document = {
      uri,
      languageId: /\.[cm]?tsx?$/.test(fsPath) ? "typescript" : "plaintext",
      lineCount: lines.length,
      lineAt: (line: number) => ({ text: lines[line] ?? "" }),
    };
    if (!textDocuments.some((open) => open.uri.toString() === uri.toString())) textDocuments.push(document);
    return document;
  },
};

export const env = {
  language: "en",
  appRoot: process.cwd(),
  clipboard: {
    async writeText(): Promise<void> {},
  },
  async openExternal(): Promise<boolean> {
    return true;
  },
};

export const window = {
  terminals,
  createTerminal(options: { name: string; pty: any }) {
    let opened = false;
    let closed = false;
    const terminal = {
      name: options.name,
      show(): void {
        if (opened || closed) return;
        opened = true;
        options.pty.open?.(undefined);
      },
      dispose(): void {
        if (closed) return;
        closed = true;
        options.pty.close?.();
        const index = window.terminals.indexOf(terminal);
        if (index >= 0) window.terminals.splice(index, 1);
        for (const listener of [...terminalCloseListeners]) listener(terminal);
      },
    };
    window.terminals.push(terminal);
    return terminal;
  },
  onDidCloseTerminal(listener: (terminal: any) => void) {
    terminalCloseListeners.add(listener);
    return { dispose: () => terminalCloseListeners.delete(listener) };
  },
  async showErrorMessage(message: string): Promise<undefined> {
    errors.push(message);
    return undefined;
  },
  async showWarningMessage(message: string): Promise<undefined> {
    warnings.push(message);
    return undefined;
  },
  async showInformationMessage(message: string): Promise<undefined> {
    information.push(message);
    return undefined;
  },
  async showOpenDialog(): Promise<undefined> {
    return undefined;
  },
  async showInputBox(): Promise<undefined> {
    return undefined;
  },
  async withProgress<T>(_options: unknown, task: () => Promise<T>): Promise<T> {
    return task();
  },
  createOutputChannel() {
    return { append() {}, appendLine() {}, show() {}, dispose() {} };
  },
  createStatusBarItem() {
    return { text: "", tooltip: "", command: "", show() {}, dispose() {} };
  },
  registerWebviewViewProvider() {
    return { dispose() {} };
  },
  async showTextDocument(): Promise<void> {},
};

export const commands = {
  async executeCommand(id: string, ...args: any[]): Promise<any> {
    return executeCommandHandler?.(id, ...args);
  },
  registerCommand(id: string, callback: (...args: any[]) => any) {
    registeredCommands.set(id, callback);
    return { dispose: () => registeredCommands.delete(id) };
  },
};

export const languages = {
  getDiagnostics: () => [],
};
