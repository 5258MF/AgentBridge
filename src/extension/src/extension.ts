import * as vscode from "vscode";
import { BridgeManager, BridgeStartCancelledError, DEFAULT_CLOUDFLARE_NAMED_LOCAL_PORT, type BridgeStatus } from "./bridge-server.js";
import { BridgePanelProvider } from "./bridge-panel.js";
import { IdeToolBroker, invalidateManagedShellCache, setIdeToolWarningSink } from "./ide-tool-broker.js";
import { invalidateTranslator, translate } from "./i18n.js";
import { boundedInteger } from "./bounded-integer.js";
import { workspaceFolders } from "./workspace-roots.js";
import fs from "node:fs";
import path from "node:path";

let activeBridge: BridgeManager | undefined;

/**
 * The line and column a bridge resource is to be opened at.
 *
 * A position counts from one and is a whole number, and a caller sending 2.5, -1, Infinity or
 * a string used to be given exactly that: the fractional part was dropped by the constructor
 * without a word, a negative number landed before the first line, and Infinity named a line no
 * document has. Each is now brought into range the way every other number the bridge receives
 * is, so a caller that sent something else is answered with the first line rather than with a
 * different line entirely - and a value that is not an integer at all is the fallback, which
 * is what the rest of the bridge does with one.
 */
export function bridgeOpenPosition(input: { line?: unknown; column?: unknown }): { line: number; column: number } {
  return {
    line: boundedInteger(input.line, 1, 1, Number.MAX_SAFE_INTEGER, "line").value,
    column: boundedInteger(input.column, 1, 1, Number.MAX_SAFE_INTEGER, "column").value,
  };
}

/**
 * Split a caller-supplied path into the segments it names below the workspace root.
 *
 * Every segment is resolved against what came before it, so ".." can be honoured when it
 * stays inside the root and rejected when it would climb out of it. The checks this
 * replaced only recognised ".." followed by a separator, so a bare ".." — and "./..",
 * which is rewritten to it — slipped through and resolved to the workspace's parent.
 *
 * An absolute path is rejected rather than reinterpreted. Stripping the leading separator
 * and joining the rest onto the root would turn "/etc/passwd" into <root>/etc/passwd: no
 * escape, but the caller silently gets a different file from the one it named.
 */
export function bridgeWorkspaceSegments(relativePath: string): string[] {
  const normalized = relativePath.trim().replace(/\\/g, "/");
  // POSIX absolute, and a Windows drive-qualified path ("C:/x") whose colon would otherwise
  // become an ordinary segment name.
  if (normalized.startsWith("/") || /^[a-zA-Z]:\/?/.test(normalized)) {
    throw new Error(`Invalid Bridge workspace path: ${relativePath}`);
  }
  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) throw new Error(`Invalid Bridge workspace path: ${relativePath}`);
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments;
}

function bridgeWorkspaceUri(relativePath: string): vscode.Uri {
  const segments = bridgeWorkspaceSegments(relativePath);
  const folders = workspaceFolders();
  // The folder that has the file, not always the first one: in a window holding two folders a
  // click in the panel opened <root1>/<path> for a file that only exists under the second.
  const folder = folders.find((candidate) => fs.existsSync(path.join(candidate.uri.fsPath, ...segments))) ?? folders[0]!;
  return vscode.Uri.joinPath(folder.uri, ...segments);
}

function bridgeDiffSnippet(diff: string, filePath?: string): { before: string; after: string } {
  const lines = diff.split(/\r?\n/);
  let active = !filePath;
  const before: string[] = [];
  const after: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("--- ")) {
      const oldPath = line.slice(4).replace(/^a\//, "");
      const next = lines[index + 1]?.startsWith("+++ ") ? lines[index + 1].slice(4).replace(/^b\//, "") : "";
      active = !filePath || oldPath === filePath || next === filePath;
      continue;
    }
    if (!active || line.startsWith("+++ ") || line.startsWith("@@") || line === "\\ No newline at end of file") continue;
    if (line.startsWith("-")) before.push(line.slice(1));
    else if (line.startsWith("+")) after.push(line.slice(1));
    else if (line.startsWith(" ")) {
      before.push(line.slice(1));
      after.push(line.slice(1));
    }
  }
  return { before: before.join("\n"), after: after.join("\n") };
}

export function activate(context: vscode.ExtensionContext): void {
  const t = translate;
  const output = vscode.window.createOutputChannel("AgentBridge");
  // Tool-level warnings (a bridged temp script that could not be unlinked, say) have to land
  // where the user can read them; the extension host's console is not that place.
  setIdeToolWarningSink((message) => output.appendLine(message));
  const ideToolBroker = new IdeToolBroker();
  const bridge = new BridgeManager(context, output, ideToolBroker);
  activeBridge = bridge;
  const bridgeReady = bridge.initialize();

  // Status bar item — the primary UI in regular VS Code (no Carrier Bridge panel).
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusBarItem.command = "agentbridge.bridge.showOutput";
  statusBarItem.tooltip = "AgentBridge";
  statusBarItem.text = "$(radio-tower) Bridge";

  function updateStatusBar(): void {
    const status = bridge.getStatus();
    const icon = status.state === "running" ? "$(circle-filled)" : status.state === "starting" ? "$(loading~spin)" : status.state === "error" ? "$(error)" : "$(radio-tower)";
    if (status.state === "running" && status.publicUrl) {
      const host = status.publicUrl.replace(/^https?:\/\//, "").split("/")[0];
      statusBarItem.text = `${icon} ${host}`;
      statusBarItem.tooltip = `Bridge running\nPublic: ${status.publicUrl}\nLocal: ${status.localUrl ?? "n/a"}\nClick to view output`;
    } else if (status.state === "error" && status.lastError) {
      statusBarItem.text = `${icon} Bridge Error`;
      statusBarItem.tooltip = `Bridge error: ${status.lastError}\nClick to view output`;
    } else {
      statusBarItem.text = `${icon} Bridge`;
      const tunnel = status.lastError ? `\nTunnel: ${status.lastError}` : "";
      statusBarItem.tooltip = `Bridge ${status.state}${tunnel}\nClick to view output`;
    }
  }

  const statusTimer = setInterval(updateStatusBar, 3000);
  updateStatusBar();
  statusBarItem.show();

  const bridgePanel = new BridgePanelProvider(bridge, bridgeReady);

  context.subscriptions.push(
    output,
    ideToolBroker,
    bridge,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("agentbridge.bridge.managedShell")) {
        invalidateManagedShellCache();
      }
      if (event.affectsConfiguration("agentbridge.bridge.readOnlyMode")) {
        bridge.setReadOnlyMode(vscode.workspace.getConfiguration("agentbridge.bridge").get<boolean>("readOnlyMode", false));
      }
      // The language a message is written in is decided once, so a change to the setting has to
      // be told about: without this the panel and the log went on answering in the language
      // they started in.
      if (event.affectsConfiguration("agentbridge.language")) {
        invalidateTranslator();
      }
    }),
    vscode.window.registerWebviewViewProvider("agentbridge.bridge.panel", bridgePanel),
    statusBarItem,
    { dispose: () => clearInterval(statusTimer) },
    vscode.commands.registerCommand("agentbridge.bridge.showOutput", () => output.show()),
    vscode.commands.registerCommand("agentbridge.bridge.start", async (domain?: unknown) => {
      await bridgeReady;
      if (domain !== undefined && typeof domain !== "string") throw new Error("Bridge domain must be a string.");
      let status: BridgeStatus;
      try {
        status = await bridge.start(domain as string | undefined);
      } catch (error) {
        if (!(error instanceof BridgeStartCancelledError)) throw error;
        updateStatusBar();
        return bridge.getStatus();
      }
      updateStatusBar();
      if (status.publicUrl) {
        const copy = "Copy MCP URL";
        const choice = await vscode.window.showInformationMessage(
          `Bridge is running at:\n${status.publicUrl}`,
          copy,
        );
        if (choice === copy) {
          await vscode.env.clipboard.writeText(status.publicUrl);
          await vscode.window.showInformationMessage("MCP URL copied to clipboard.");
        }
      } else if (status.lastError) {
        await vscode.window.showErrorMessage(`Bridge failed to start: ${status.lastError}`);
      }
      return status;
    }),
    vscode.commands.registerCommand("agentbridge.bridge.stop", async () => {
      await bridgeReady;
      const status = await bridge.stop();
      updateStatusBar();
      return status;
    }),
    vscode.commands.registerCommand("agentbridge.bridge.checkNgrok", async () => {
      await bridgeReady;
      const status = await bridge.checkNgrok();
      updateStatusBar();
      return status;
    }),
    vscode.commands.registerCommand("agentbridge.bridge.checkTunnel", async () => {
      await bridgeReady;
      const status = await bridge.checkTunnel();
      updateStatusBar();
      return status;
    }),
    vscode.commands.registerCommand("agentbridge.bridge.installCloudflared", async () => {
      await bridgeReady;
      const status = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: t("installingCloudflaredForAgentBridge"),
        cancellable: false,
      }, () => bridge.installCloudflared());
      await vscode.window.showInformationMessage(t("cloudflaredReady", status.tunnelVersion ?? t("installedVersionFallback")));
      updateStatusBar();
      return status;
    }),
    vscode.commands.registerCommand("agentbridge.bridge.rotateEndpoint", async () => {
      await bridgeReady;
      const status = await bridge.rotateEndpoint();
      updateStatusBar();
      if (status.publicUrl) {
        await vscode.window.showInformationMessage(`New Bridge endpoint: ${status.publicUrl}`);
      }
      return status;
    }),
    vscode.commands.registerCommand("agentbridge.bridge.openResource", async (value: unknown) => {
      const input = value && typeof value === "object" ? value as { path?: unknown; line?: unknown; column?: unknown; folder?: unknown } : {};
      if (typeof input.path !== "string") throw new Error("Bridge resource path is required.");
      let uri: vscode.Uri;
      try {
        uri = bridgeWorkspaceUri(input.path);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showWarningMessage(message);
        return;
      }
      if (input.folder === true) {
        await vscode.commands.executeCommand("revealInExplorer", uri);
        return;
      }
      const { line, column } = bridgeOpenPosition(input);
      const position = new vscode.Position(line - 1, column - 1);
      await vscode.window.showTextDocument(uri, { preview: true, selection: new vscode.Range(position, position) });
    }),
    vscode.commands.registerCommand("agentbridge.bridge.openDiff", async (value: unknown) => {
      const input = value && typeof value === "object" ? value as { diff?: unknown; path?: unknown } : {};
      if (typeof input.diff !== "string" || !input.diff.trim()) throw new Error("Bridge diff content is required.");
      const filePath = typeof input.path === "string" ? input.path : undefined;
      const snippet = bridgeDiffSnippet(input.diff, filePath);
      const before = await vscode.workspace.openTextDocument({ content: snippet.before });
      const after = await vscode.workspace.openTextDocument({ content: snippet.after });
      await vscode.commands.executeCommand("vscode.diff", before.uri, after.uri, `${filePath ?? "Bridge edit"} · Before ↔ After`, { preview: true });
    }),
    vscode.commands.registerCommand("agentbridge.bridge.openTerminal", async (terminalId: unknown) => {
      if (typeof terminalId !== "string" || !terminalId) throw new Error("Bridge terminal id is required.");
      if (!ideToolBroker.revealTerminal(terminalId)) {
        await vscode.window.showInformationMessage("That Bridge terminal is no longer available.");
      }
    }),
    vscode.commands.registerCommand("agentbridge.bridge.getStatus", async () => {
      await bridgeReady;
      return bridge.getStatus();
    }),
    vscode.commands.registerCommand("agentbridge.bridge.configure", async (domain: unknown) => {
      await bridgeReady;
      if (typeof domain !== "string") throw new Error("Bridge ngrok domain must be a string.");
      return bridge.configure(domain);
    }),
    vscode.commands.registerCommand("agentbridge.bridge.configureNamedTunnel", async (value: unknown) => {
      await bridgeReady;
      let input = value && typeof value === "object"
        ? value as { domain?: unknown; token?: unknown; localPort?: unknown }
        : undefined;
      if (!input || typeof input.domain !== "string" || typeof input.localPort !== "number") {
        const domain = (await vscode.window.showInputBox({
          title: t("namedHostnameTitle"),
          prompt: t("namedHostnamePrompt"),
          ignoreFocusOut: true,
        }))?.trim();
        if (!domain) throw new Error(t("namedHostnameRequired"));
        const tokenInput = await vscode.window.showInputBox({
          title: t("namedTokenTitle"),
          prompt: t("namedTokenPrompt"),
          password: true,
          ignoreFocusOut: true,
        });
        if (tokenInput === undefined) throw new Error(t("namedTokenRequired"));
        const portText = (await vscode.window.showInputBox({
          title: t("namedLocalPortTitle"),
          prompt: t("namedLocalPortPrompt"),
          value: String(vscode.workspace.getConfiguration("agentbridge.bridge").get<number>("cloudflareNamedLocalPort", DEFAULT_CLOUDFLARE_NAMED_LOCAL_PORT)),
          ignoreFocusOut: true,
        }))?.trim();
        const localPort = Number(portText);
        if (!portText || !Number.isInteger(localPort)) throw new Error(t("namedLocalPortRequired"));
        input = { domain, token: tokenInput.trim() || undefined, localPort };
      }
      if (input.token !== undefined && typeof input.token !== "string") throw new Error(t("namedTokenMustBeString"));
      return bridge.configureNamedTunnel({
        domain: input.domain as string,
        token: input.token as string | undefined,
        localPort: input.localPort as number,
      });
    }),
    vscode.commands.registerCommand("agentbridge.bridge.clearNamedTunnelToken", async () => {
      await bridgeReady;
      return bridge.clearNamedTunnelToken();
    }),
    vscode.commands.registerCommand("agentbridge.bridge.setTunnelProvider", async (provider: unknown) => {
      await bridgeReady;
      let selected: string | undefined;
      if (typeof provider === "string") {
        selected = provider;
      } else {
        const current = bridge.getStatus().tunnelProvider;
        const choice = await vscode.window.showQuickPick(
          [
            { label: "Cloudflare Quick Tunnel", description: t("quickTunnelPickDescription"), value: "cloudflare" },
            { label: "Cloudflare Named Tunnel", description: t("namedTunnelPickDescription"), value: "cloudflare-named" },
            { label: "ngrok", description: t("ngrokPickDescription"), value: "ngrok" },
          ],
          { title: t("tunnelProviderTitle"), placeHolder: t("currentTunnelProvider", current) },
        );
        selected = choice?.value;
      }
      if (!selected) return bridge.getStatus();
      return bridge.setTunnelProvider(selected);
    }),
  );

  output.appendLine("[extension] AgentBridge registered: Streamable HTTP MCP + Cloudflare Quick/Named Tunnel + ngrok");
  output.appendLine("[extension] IDE tool broker registered: list_directory, run_command, get_command_output, send_command_input, terminate_command, get_diagnostics, lsp");

  // Persistent mode brings the Bridge up with the window; either way the tunnel is checked, because
  // a check starts nothing - it reads the configured provider and asks its CLI for a version. Left
  // out, a machine whose cloudflared is missing or whose named-tunnel hostname is unset looks
  // exactly like a working one until the user starts the Bridge and waits to find out.
  const persistentMode = vscode.workspace.getConfiguration("agentbridge.bridge").get<boolean>("persistentMode", false);
  if (persistentMode) {
    output.appendLine("[extension] persistent Bridge mode enabled; auto-starting");
  }
  const startupTimer = setTimeout(() => {
    // The window can be reloaded before the timer fires, and the Bridge it captured then belongs
    // to an activation that is already gone.
    if (activeBridge !== bridge) return;
    if (persistentMode) {
      void bridgeReady.then(() => bridge.start(undefined, { automaticCheck: true })).then(
        (status) => {
          updateStatusBar();
          const endpoint = status.domain ? `https://${status.domain}/mcp/<redacted>` : "";
          output.appendLine(`[bridge] persistent start: ${status.state}${endpoint ? ` ${endpoint}` : ""}`);
        },
        (error) => output.appendLine(`[bridge] persistent start failed: ${error instanceof Error ? error.message : String(error)}`),
      );
      return;
    }
    void bridgeReady.then(() => bridge.checkTunnel()).then(
      (status) => {
        updateStatusBar();
        const parts: Array<string | undefined> = [
          status.tunnelProvider,
          status.tunnelInstalled === undefined ? "installed: unknown" : status.tunnelInstalled ? "installed" : "not installed",
          status.tunnelVersion,
          status.lastError,
        ];
        output.appendLine(`[bridge] startup tunnel check: ${parts.filter((part) => part).join(" | ")}`);
      },
      (error) => output.appendLine(`[bridge] startup tunnel check failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  }, 100);
  // The timer outlives activation by design, so deactivation has to be able to call it off: a
  // reload must not start a Bridge, or log a check, against a manager that is already gone.
  context.subscriptions.push({ dispose: () => clearTimeout(startupTimer) });
}

export async function deactivate(): Promise<void> {
  const bridge = activeBridge;
  activeBridge = undefined;
  if (bridge) await bridge.disposeAsync();
}
