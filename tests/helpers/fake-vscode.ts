type ConfigChangeListener = (event: { affectsConfiguration(section: string): boolean }) => void;

const config = new Map<string, unknown>();
// What a workspace settings.json holds, kept apart from the user-level map above so a
// test can set a value in one scope and not the other, the way a repository does.
const workspaceConfig = new Map<string, unknown>();
const configListeners = new Set<ConfigChangeListener>();
let updateHandler: ((input: { key: string; value: unknown; apply(): void }) => Promise<void>) | undefined;

const errors: string[] = [];
const warnings: string[] = [];
const information: string[] = [];
const registeredCommands = new Map<string, (...args: any[]) => any>();
const terminalCloseListeners = new Set<(terminal: any) => void>();
const terminals: Array<{ name: string; show(preserveFocus?: boolean): void; dispose(): void }> = [];

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
  errors,
  warnings,
  information,
  reset(): void {
    config.clear();
    workspaceConfig.clear();
    configListeners.clear();
    updateHandler = undefined;
    errors.length = 0;
    warnings.length = 0;
    information.length = 0;
    registeredCommands.clear();
    terminalCloseListeners.clear();
    terminals.length = 0;
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
  setWorkspaceConfig(key: string, value: unknown): void {
    if (value === undefined) workspaceConfig.delete(key);
    else workspaceConfig.set(key, value);
  },
  emitConfig(key: string): void {
    emitConfigurationChange(key);
  },
  setUpdateHandler(handler: typeof updateHandler): void {
    updateHandler = handler;
  },
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

/**
 * What `workspace.fs.readDirectory` answers. The real host reads the filesystem; a test names
 * the entries instead. Left unset, a listing that reaches it fails rather than silently
 * reporting an empty directory.
 */
export const workspaceFs = {
  readDirectory: undefined as undefined | ((uri: { fsPath: string }) => Promise<Array<[string, number]>>),
};

export const workspace = {
  workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
  // Diagnostics exist only for documents a provider has published them for, and get_diagnostics
  // reports the open ones so that a zero result can be told from an unexamined scope.
  textDocuments: [] as Array<{ uri: { scheme: string; fsPath: string } }>,
  fs: {
    async readDirectory(uri: { fsPath: string }): Promise<Array<[string, number]>> {
      if (!workspaceFs.readDirectory) throw new Error("workspaceFs.readDirectory is not set up in this test");
      return workspaceFs.readDirectory(uri);
    },
  },
  getConfiguration(section = "") {
    return {
      get<T>(key: string, defaultValue?: T): T {
        // A workspace value wins over the user-level one, which is what the real
        // configuration object answers when both are set.
        const keyName = fullKey(section, key);
        const value = workspaceConfig.has(keyName) ? workspaceConfig.get(keyName) : config.get(keyName);
        return (value === undefined ? defaultValue : value) as T;
      },
      inspect<T>(key: string): { key: string; globalValue?: T; workspaceValue?: T } {
        const keyName = fullKey(section, key);
        return {
          key: keyName,
          globalValue: config.get(keyName) as T | undefined,
          workspaceValue: workspaceConfig.get(keyName) as T | undefined,
        };
      },
      async update(key: string, value: unknown, configurationTarget?: unknown): Promise<void> {
        const keyName = fullKey(section, key);
        const apply = () => {
          const store = configurationTarget === ConfigurationTarget.Workspace ? workspaceConfig : config;
          if (value === undefined) store.delete(keyName);
          else store.set(keyName, value);
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
  async openTextDocument(input: unknown) {
    return { uri: input };
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
  async executeCommand(): Promise<undefined> {
    return undefined;
  },
  registerCommand(id: string, callback: (...args: any[]) => any) {
    registeredCommands.set(id, callback);
    return { dispose: () => registeredCommands.delete(id) };
  },
};

export const languages = {
  getDiagnostics: () => [],
};
