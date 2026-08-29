import * as vscode from "vscode";
import { BridgeManager } from "./bridge-server.js";
import { BridgePanelProvider } from "./bridge-panel.js";
import { IdeToolBroker, invalidateManagedShellCache } from "./ide-tool-broker.js";
import { createTranslator, detectLang } from "./i18n.js";

let activeBridge: BridgeManager | undefined;

function bridgeWorkspaceUri(relativePath: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error("No workspace folder is open.");
  const normalized = relativePath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../") || normalized.startsWith("/")) {
    throw new Error(`Invalid Bridge workspace path: ${relativePath}`);
  }
  return vscode.Uri.joinPath(folder.uri, ...normalized.split("/").filter(Boolean));
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
  const t = createTranslator(detectLang());
  const output = vscode.window.createOutputChannel("AgentBridge");
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
      statusBarItem.tooltip = `Bridge ${status.state}\nClick to view output`;
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
    }),
    vscode.window.registerWebviewViewProvider("agentbridge.bridge.panel", bridgePanel),
    statusBarItem,
    { dispose: () => clearInterval(statusTimer) },
    vscode.commands.registerCommand("agentbridge.bridge.showOutput", () => output.show()),
    vscode.commands.registerCommand("agentbridge.bridge.start", async (domain?: unknown) => {
      await bridgeReady;
      if (domain !== undefined && typeof domain !== "string") throw new Error("Bridge domain must be a string.");
      const status = await bridge.start(domain as string | undefined);
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
      const uri = bridgeWorkspaceUri(input.path);
      if (input.folder === true) {
        await vscode.commands.executeCommand("revealInExplorer", uri);
        return;
      }
      const line = typeof input.line === "number" && input.line > 0 ? input.line : 1;
      const column = typeof input.column === "number" && input.column > 0 ? input.column : 1;
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
          title: "Cloudflare Named Tunnel · Hostname",
          prompt: "Public hostname from Cloudflare Tunnels, e.g. mcp.example.com",
          ignoreFocusOut: true,
        }))?.trim();
        if (!domain) throw new Error("Cloudflare Named Tunnel hostname must be a string.");
        const tokenInput = await vscode.window.showInputBox({
          title: "Cloudflare Named Tunnel · Tunnel Token",
          prompt: "Tunnel token from Cloudflare Zero Trust (eyJ...). Leave blank to keep the existing token.",
          password: true,
          ignoreFocusOut: true,
        });
        if (tokenInput === undefined) throw new Error("Cloudflare Tunnel Token is required.");
        const portText = (await vscode.window.showInputBox({
          title: "Cloudflare Named Tunnel · Local Port",
          prompt: "Must match the tunnel's public hostname Service URL port.",
          value: String(vscode.workspace.getConfiguration("agentbridge.bridge").get<number>("cloudflareNamedLocalPort", 48271)),
          ignoreFocusOut: true,
        }))?.trim();
        const localPort = Number(portText);
        if (!portText || !Number.isInteger(localPort)) throw new Error("Cloudflare Named Tunnel local port must be a number.");
        input = { domain, token: tokenInput.trim() || undefined, localPort };
      }
      if (input.token !== undefined && typeof input.token !== "string") throw new Error("Cloudflare Tunnel Token must be a string.");
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
            { label: "Cloudflare Quick Tunnel", description: "免费免账号，公网地址重启后变化", value: "cloudflare" },
            { label: "Cloudflare Named Tunnel", description: "固定域名，需 Cloudflare 账号、Tunnel Token、路由配置", value: "cloudflare-named" },
            { label: "ngrok", description: "保留域名，需 ngrok 账号与 Authtoken", value: "ngrok" },
          ],
          { title: "AgentBridge · Tunnel Provider", placeHolder: `当前: ${current}` },
        );
        selected = choice?.value;
      }
      if (!selected) return bridge.getStatus();
      return bridge.setTunnelProvider(selected);
    }),
  );

  output.appendLine("[extension] AgentBridge registered: Streamable HTTP MCP + Cloudflare Quick/Named Tunnel + ngrok");
  output.appendLine("[extension] IDE tool broker registered: list_directory, run_command, get_command_output, send_command_input, get_diagnostics, lsp");

  if (vscode.workspace.getConfiguration("agentbridge.bridge").get<boolean>("persistentMode", false)) {
    output.appendLine("[extension] persistent Bridge mode enabled; auto-starting");
    setTimeout(() => {
      void bridgeReady.then(() => bridge.start()).then(
        (status) => {
          updateStatusBar();
          output.appendLine(`[bridge] persistent start: ${status.state} ${status.publicUrl ?? ""}`);
        },
        (error) => output.appendLine(`[bridge] persistent start failed: ${error instanceof Error ? error.message : String(error)}`),
      );
    }, 100);
  }
}

export async function deactivate(): Promise<void> {
  const bridge = activeBridge;
  activeBridge = undefined;
  if (bridge) await bridge.disposeAsync();
}
