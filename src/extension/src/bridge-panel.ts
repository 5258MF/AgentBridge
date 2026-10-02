/// <reference path="./webview/assets.d.ts" />
import * as vscode from "vscode";
import { invalidateManagedShellCache, sanityCheckManagedShellPath } from "./ide-tool-broker.js";
import { BridgeStartCancelledError, type BridgeManager, type BridgeStatus } from "./bridge-server.js";
import { normalizeTrustedBrowserOrigin } from "./http-helpers.js";
import { READ_ONLY_BLOCKED_TOOL_NAMES } from "./server-instructions.js";
import PANEL_CSS from "webview:panel.css";
import PANEL_SCRIPT from "webview:panel.js";
import { createTranslator, detectLang, enMessages, readLanguagePreference, translate, zhMessages } from "./i18n.js";

const POLL_INTERVAL_MS = 1500;

const t = translate;
const CLOUDFLARE_DOWNLOADS_URL = "https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/";
const CAN_AUTO_INSTALL_CLOUDFLARED = process.platform === "win32" || process.platform === "darwin";

function buildConnectionPrompt(): string {
  return t("connectionPrompt");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function readConfiguredTrustedBrowserOrigins(): string[] {
  const configured = vscode.workspace.getConfiguration("agentbridge.bridge").get<unknown>("trustedBrowserOrigins", []);
  if (!Array.isArray(configured)) return [];
  const origins: string[] = [];
  for (const value of configured) {
    if (typeof value !== "string") continue;
    const normalized = normalizeTrustedBrowserOrigin(value);
    if (normalized && !origins.includes(normalized)) origins.push(normalized);
  }
  return origins;
}

function cloudflaredCommandRow(command: string): string {
  const escaped = escapeHtml(command);
  return `<div class="agentbridge-command-row"><code>${escaped}</code><button class="secondary" data-copy="${escaped}">${t("copy")}</button></div>`;
}

function cloudflaredInstallHelpHtml(): string {
  const verify = cloudflaredCommandRow("cloudflared --version");
  const downloads = `<button class="secondary" data-open="${CLOUDFLARE_DOWNLOADS_URL}">${t("openCloudflareDownloads")}</button>`;
  if (process.platform === "win32") {
    return [
      `<p class="agentbridge-help">${t("wingetInstallHelp")}</p>`,
      cloudflaredCommandRow("winget install --id Cloudflare.cloudflared --exact --accept-package-agreements --accept-source-agreements"),
      cloudflaredCommandRow("winget upgrade --id Cloudflare.cloudflared --exact --accept-package-agreements --accept-source-agreements"),
      verify,
      downloads,
    ].join("\n");
  }
  if (process.platform === "darwin") {
    return [
      `<p class="agentbridge-help">${t("homebrewInstallHelp")}</p>`,
      cloudflaredCommandRow("brew install cloudflared"),
      cloudflaredCommandRow("brew upgrade cloudflared"),
      verify,
      `<p class="agentbridge-help">${t("reloadAfterInstallHelp")}</p>`,
      downloads,
    ].join("\n");
  }
  return [
    `<p class="agentbridge-help">${t("linuxManualInstallHelp")}</p>`,
    verify,
    downloads,
  ].join("\n");
}

interface PanelMessage {
  type: string;
  [key: string]: unknown;
}

const BUSY_PANEL_MESSAGE_TYPES = new Set([
  "start",
  "stop",
  "setProvider",
  "configure",
  "configureNamedTunnel",
  "clearNamedTunnelToken",
  "checkTunnel",
  "rotateEndpoint",
  "setLanguage",
  "setTrustedBrowserOrigins",
  "reloadExternalMcp",
  "reconnectExternalMcp",
  "setExternalMcpEnabled",
  "setExternalMcpCredential",
  "addExternalMcpServer",
]);

const ADVANCED_SECTION_IDS = new Set([
  "securitySettingsSection", "exposedToolsSection", "managedShellSection",
  "tunnelTransportSection", "openModeSection", "trustedBrowserOriginsRules",
]);

export class BridgePanelProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private keepAdvancedOpenOnLanguageChange = false;
  private keepAdvancedSectionsOpenOnLanguageChange: string[] = [];
  private namedTunnelInputDirty = false;
  private trustedBrowserOriginsInputDirty = false;
  private externalMcpFormDirty = false;
  private pendingLanguageRefresh = false;
  private pendingTrustedBrowserOriginsRefresh = false;
  private trustedBrowserOriginsConfigRevision = 0;
  private quickTunnelCopyQueue: Promise<void> = Promise.resolve();
  private lastAttemptedQuickTunnelUrl = "";
  private lastCopiedQuickTunnelUrl = "";

  constructor(
    private readonly bridge: BridgeManager,
    private readonly bridgeReady: Promise<void>,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.keepAdvancedOpenOnLanguageChange = false;
    this.keepAdvancedSectionsOpenOnLanguageChange = [];
    this.namedTunnelInputDirty = false;
    this.trustedBrowserOriginsInputDirty = false;
    this.externalMcpFormDirty = false;
    this.pendingLanguageRefresh = false;
    this.pendingTrustedBrowserOriginsRefresh = false;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };
    webviewView.webview.html = this.renderHtml();
    webviewView.webview.onDidReceiveMessage((message: PanelMessage) => {
      void this.handleMessage(message, webviewView.webview).then(() => {
        if (message.type !== "installCloudflared" && message.type !== "checkPublicHealth" && message.type !== "clearIdleSessions" && message.type !== "clearActivityHistory" && this.view === webviewView) {
          const operationFinished = BUSY_PANEL_MESSAGE_TYPES.has(message.type);
          this.pushStatus(operationFinished ? "operationFinished" : "status", operationFinished ? message.type : undefined, operationFinished ? true : undefined, typeof message.requestId === "string" ? message.requestId : undefined);
        }
      }, (error) => {
        if (!(error instanceof BridgeStartCancelledError) && message.type !== "addExternalMcpServer") {
          void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
        if (message.type !== "installCloudflared" && message.type !== "checkPublicHealth" && this.view === webviewView) {
          const operationFinished = BUSY_PANEL_MESSAGE_TYPES.has(message.type);
          this.pushStatus(operationFinished ? "operationFinished" : "status", operationFinished ? message.type : undefined, operationFinished ? false : undefined, typeof message.requestId === "string" ? message.requestId : undefined);
        }
      });
    });
    const configurationSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (this.view !== webviewView) return;
      if (event.affectsConfiguration("agentbridge.bridge.trustedBrowserOrigins")) {
        const revision = ++this.trustedBrowserOriginsConfigRevision;
        if (this.trustedBrowserOriginsInputDirty) {
          this.pendingTrustedBrowserOriginsRefresh = true;
        } else {
          this.pendingTrustedBrowserOriginsRefresh = false;
          void webviewView.webview.postMessage({
            type: "trustedBrowserOriginsChanged",
            origins: readConfiguredTrustedBrowserOrigins(),
            revision,
          });
        }
      }
      if (!event.affectsConfiguration("agentbridge.language")) return;
      const advancedOpen = this.keepAdvancedOpenOnLanguageChange;
      const advancedSectionsOpen = this.keepAdvancedSectionsOpenOnLanguageChange;
      if (this.namedTunnelInputDirty || this.trustedBrowserOriginsInputDirty || this.externalMcpFormDirty) {
        this.pendingLanguageRefresh = true;
        return;
      }
      this.keepAdvancedOpenOnLanguageChange = false;
      this.keepAdvancedSectionsOpenOnLanguageChange = [];
      this.pendingLanguageRefresh = false;
      this.pendingTrustedBrowserOriginsRefresh = false;
      webviewView.webview.html = this.renderHtml(advancedOpen, advancedSectionsOpen);
    });
    if (webviewView.visible) this.startPolling();
    webviewView.onDidChangeVisibility(() => {
      if (this.view !== webviewView) return;
      if (webviewView.visible) this.startPolling();
      else this.stopPolling();
    });
    webviewView.onDidDispose(() => {
      configurationSubscription.dispose();
      if (this.view !== webviewView) return;
      this.view = undefined;
      this.keepAdvancedOpenOnLanguageChange = false;
      this.keepAdvancedSectionsOpenOnLanguageChange = [];
      this.namedTunnelInputDirty = false;
      this.trustedBrowserOriginsInputDirty = false;
      this.externalMcpFormDirty = false;
      this.pendingLanguageRefresh = false;
      this.pendingTrustedBrowserOriginsRefresh = false;
      this.stopPolling();
    });
  }

  private flushDeferredConfigurationRefresh(sourceWebview: vscode.Webview): void {
    if (this.view?.webview !== sourceWebview) return;
    if (this.pendingLanguageRefresh && !this.namedTunnelInputDirty && !this.trustedBrowserOriginsInputDirty && !this.externalMcpFormDirty) {
      const advancedOpen = this.keepAdvancedOpenOnLanguageChange;
      const advancedSectionsOpen = this.keepAdvancedSectionsOpenOnLanguageChange;
      this.keepAdvancedOpenOnLanguageChange = false;
      this.keepAdvancedSectionsOpenOnLanguageChange = [];
      this.pendingLanguageRefresh = false;
      this.pendingTrustedBrowserOriginsRefresh = false;
      sourceWebview.html = this.renderHtml(advancedOpen, advancedSectionsOpen);
      return;
    }
    if (this.pendingTrustedBrowserOriginsRefresh && !this.trustedBrowserOriginsInputDirty) {
      this.pendingTrustedBrowserOriginsRefresh = false;
      void sourceWebview.postMessage({
        type: "trustedBrowserOriginsChanged",
        origins: readConfiguredTrustedBrowserOrigins(),
        revision: this.trustedBrowserOriginsConfigRevision,
      });
    }
  }

  private startPolling(): void {
    this.stopPolling();
    this.pushStatus();
    this.pollTimer = setInterval(() => this.pushStatus(), POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private isCurrentQuickTunnelUrl(url: string): boolean {
    const status = this.bridge.getStatus();
    return status.tunnelProvider === "cloudflare"
      && status.state === "running"
      && status.publicUrl === url
      && this.lastAttemptedQuickTunnelUrl === url;
  }

  private pushStatus(type: "status" | "operationFinished" = "status", operation?: string, succeeded?: boolean, requestId?: string): void {
    if (!this.view) return;
    const status = this.bridge.getStatus();
    if (status.tunnelProvider === "cloudflare" && status.state === "running" && status.publicUrl && status.publicUrl !== this.lastAttemptedQuickTunnelUrl) {
      const url = status.publicUrl;
      this.lastAttemptedQuickTunnelUrl = url;
      this.quickTunnelCopyQueue = this.quickTunnelCopyQueue.then(async () => {
        // Skip queued writes that became stale before they reached the clipboard.
        if (!this.isCurrentQuickTunnelUrl(url)) return;
        try {
          await vscode.env.clipboard.writeText(url);
        } catch (error) {
          console.error(`[AgentBridge panel] Failed to copy Quick Tunnel URL: ${error instanceof Error ? error.message : String(error)}`);
          if (this.isCurrentQuickTunnelUrl(url)) {
            void vscode.window.showWarningMessage(t("quickAddressCopyFailed"));
          }
          if (this.view?.visible) this.pushStatus();
          return;
        }
        if (this.isCurrentQuickTunnelUrl(url)) {
          this.lastCopiedQuickTunnelUrl = url;
        }
        if (this.view?.visible) this.pushStatus();
      });
    }
    const persistentMode = vscode.workspace.getConfiguration("agentbridge.bridge").get<boolean>("persistentMode", false);
    const quickTunnelCopied = status.publicUrl !== undefined && status.publicUrl === this.lastCopiedQuickTunnelUrl;
    void this.view.webview.postMessage({ type, status, persistentMode, quickTunnelCopied, operation, succeeded, requestId });
  }

  private async handleMessage(message: PanelMessage, sourceWebview: vscode.Webview): Promise<void> {
    switch (message.type) {
      case "refresh":
        return;
      case "reloadExternalMcp":
        await this.bridgeReady;
        await this.bridge.reloadExternalMcp();
        return;
      case "reconnectExternalMcp": {
        if (typeof message.name !== "string") throw new Error("MCP server name must be a string.");
        await this.bridgeReady;
        await this.bridge.reconnectExternalMcp(message.name);
        return;
      }
      case "setExternalMcpEnabled": {
        if (typeof message.name !== "string" || typeof message.enabled !== "boolean") throw new Error("Invalid MCP server enabled state.");
        await this.bridgeReady;
        await this.bridge.setExternalMcpEnabled(message.name, message.enabled);
        return;
      }
      case "openExternalMcpConfig": {
        if (message.scope !== "user" && message.scope !== "workspace") throw new Error("Invalid MCP configuration scope.");
        if (message.name !== undefined && typeof message.name !== "string") throw new Error("Invalid MCP server name.");
        await this.bridgeReady;
        const file = await this.bridge.externalMcpConfigurationPath(message.scope, message.name as string | undefined);
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        await vscode.window.showTextDocument(document);
        return;
      }
      case "setExternalMcpCredential": {
        await this.bridgeReady;
        const suggestedName = typeof message.suggestedName === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(message.suggestedName) ? message.suggestedName : undefined;
        const name = await vscode.window.showInputBox({ title: t("mcpCredentialName"), prompt: t("mcpCredentialNameHelp"), value: suggestedName, ignoreFocusOut: true });
        if (!name) return;
        const value = await vscode.window.showInputBox({ title: t("mcpCredentialValue"), password: true, ignoreFocusOut: true });
        if (value === undefined || value === "") return;
        await this.bridge.setExternalMcpCredential(name.trim(), value);
        await sourceWebview.postMessage({ type: "externalMcpCredentialSaved", name: name.trim(), forForm: message.forForm === true });
        return;
      }
      case "addExternalMcpServer": {
        try {
          if (message.scope !== "user" && message.scope !== "workspace") throw new Error("Invalid MCP configuration scope.");
          if (typeof message.name !== "string") throw new Error("MCP server name must be a string.");
          if (typeof message.requestId !== "string" || !message.requestId || message.requestId.length > 100) throw new Error("Invalid MCP save request.");
          await this.bridgeReady;
          await this.bridge.addExternalMcpServer(message.scope, message.name, message.config);
          await sourceWebview.postMessage({ type: "externalMcpServerSaved", requestId: message.requestId, name: message.name });
        } catch (error) {
          await sourceWebview.postMessage({ type: "externalMcpServerSaveFailed", requestId: message.requestId, detail: error instanceof Error ? error.message : "Could not save MCP configuration." });
          throw error;
        }
        return;
      }
      case "externalMcpFormDirtyChanged": {
        if (typeof message.dirty !== "boolean") throw new Error("Invalid MCP form state.");
        this.externalMcpFormDirty = message.dirty;
        if (!message.dirty) this.flushDeferredConfigurationRefresh(sourceWebview);
        return;
      }
      case "namedTunnelDirtyChanged": {
        if (typeof message.dirty !== "boolean") throw new Error("Named Tunnel dirty state must be a boolean.");
        this.namedTunnelInputDirty = message.dirty;
        if (!this.namedTunnelInputDirty) this.flushDeferredConfigurationRefresh(sourceWebview);
        return;
      }
      case "trustedBrowserOriginsDirtyChanged": {
        if (typeof message.dirty !== "boolean") throw new Error("Trusted browser Origin dirty state must be a boolean.");
        this.trustedBrowserOriginsInputDirty = message.dirty;
        if (!this.trustedBrowserOriginsInputDirty) this.flushDeferredConfigurationRefresh(sourceWebview);
        return;
      }
      case "panelRenderError": {
        const detail = typeof message.detail === "string" ? message.detail : "Unknown webview render error.";
        console.error(`[AgentBridge panel] ${detail}`);
        return;
      }
      case "start": {
        const domain = message.domain;
        if (domain !== undefined && typeof domain !== "string") throw new Error("Bridge ngrok domain must be a string.");
        await this.bridgeReady;
        if (this.bridge.getStatus().state !== "running") await this.bridge.start(domain as string | undefined);
        return;
      }
      case "stop":
        await this.bridgeReady;
        await this.bridge.stop();
        return;
      case "setProvider": {
        const provider = message.provider;
        if (typeof provider !== "string") throw new Error("Bridge tunnel provider must be a string.");
        await this.bridgeReady;
        await this.bridge.setTunnelProvider(provider);
        return;
      }
      case "configure": {
        const domain = message.domain;
        if (typeof domain !== "string" || !domain.trim()) throw new Error("Bridge ngrok domain must be a string.");
        await this.bridgeReady;
        await this.bridge.configure(domain);
        return;
      }
      case "configureNamedTunnel": {
        const domain = message.domain;
        const token = message.token;
        const localPort = message.localPort;
        if (typeof domain !== "string" || !domain.trim()) throw new Error("Cloudflare Named Tunnel hostname must be a string.");
        if (token !== undefined && typeof token !== "string") throw new Error("Cloudflare Tunnel Token must be a string.");
        if (typeof localPort !== "number" || !Number.isInteger(localPort)) throw new Error("Cloudflare Named Tunnel local port must be a number.");
        await this.bridgeReady;
        await this.bridge.configureNamedTunnel({
          domain,
          token: typeof token === "string" && token.trim() ? token.trim() : undefined,
          localPort,
        });
        return;
      }
      case "clearNamedTunnelToken":
        await this.bridgeReady;
        await this.bridge.clearNamedTunnelToken();
        return;
      case "checkTunnel":
        await this.bridgeReady;
        await this.bridge.checkTunnel();
        return;
      case "checkPublicHealth":
        if (typeof message.requestId !== "string" || !message.requestId) throw new Error("Public health request ID must be a non-empty string.");
        try {
          await this.bridgeReady;
          await this.bridge.checkPublicHealth();
        } finally {
          try {
            const status = this.bridge.getStatus();
            const persistentMode = vscode.workspace.getConfiguration("agentbridge.bridge").get<boolean>("persistentMode", false);
            await sourceWebview.postMessage({
              type: "publicHealthChecked",
              requestId: message.requestId,
              status,
              persistentMode,
              quickTunnelCopied: status.publicUrl !== undefined && status.publicUrl === this.lastCopiedQuickTunnelUrl,
            });
          } catch {
            // The originating Webview may have been disposed while the network check was running.
          }
        }
        return;
      case "installCloudflared":
        try {
          await this.bridgeReady;
          await this.bridge.installCloudflared();
        } finally {
          const persistentMode = vscode.workspace.getConfiguration("agentbridge.bridge").get<boolean>("persistentMode", false);
          try {
            await sourceWebview.postMessage({
              type: "cloudflaredInstallFinished",
              status: this.bridge.getStatus(),
              persistentMode,
            });
          } catch {
            // The originating Webview may have been disposed while the package manager was running.
          }
        }
        return;
      case "rotateEndpoint":
        await this.bridgeReady;
        await this.bridge.rotateEndpoint();
        return;
      case "setPersistentMode": {
        const enabled = message.enabled;
        if (typeof enabled !== "boolean") throw new Error("Bridge persistent mode must be a boolean.");
        await vscode.workspace.getConfiguration("agentbridge.bridge").update("persistentMode", enabled, vscode.ConfigurationTarget.Global);
        return;
      }
      case "setReadOnlyMode": {
        const enabled = message.enabled;
        if (typeof enabled !== "boolean") throw new Error("Bridge read-only mode must be a boolean.");
        await vscode.workspace.getConfiguration("agentbridge.bridge").update("readOnlyMode", enabled, vscode.ConfigurationTarget.Global);
        this.bridge.setReadOnlyMode(enabled);
        return;
      }
      case "openExternal": {
        const url = message.url;
        if (typeof url === "string" && url) {
          const mode = vscode.workspace.getConfiguration("agentbridge.bridge").get<"auto" | "all" | "external">("openInternalBrowser", "auto");
          let isEmbeddedHost = false;
          try {
            const hostname = new URL(url).hostname.toLowerCase();
            const embeddedDomains = ["chatgpt.com", "arena.ai", "workbuddy.cn", "trae.cn", "qwenwork.cn"];
            isEmbeddedHost = embeddedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
          } catch {
            // Malformed or non-HTTP URLs retain the external-browser fallback.
          }
          const useSimpleBrowser = mode === "all" || (mode === "auto" && isEmbeddedHost);
          if (useSimpleBrowser) {
            try {
              await vscode.commands.executeCommand("simpleBrowser.show", url);
            } catch {
              await vscode.env.openExternal(vscode.Uri.parse(url));
            }
          } else {
            await vscode.env.openExternal(vscode.Uri.parse(url));
          }
        }
        return;
      }
      case "openFolder": {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: t("openFolderLabel"),
        });
        if (picked && picked[0]) {
          vscode.workspace.updateWorkspaceFolders(0, 0, { uri: picked[0] });
        }
        return;
      }
      case "openResource": {
        const input = message.value && typeof message.value === "object" ? message.value as { path?: unknown; line?: unknown; column?: unknown; folder?: unknown } : {};
        await vscode.commands.executeCommand("agentbridge.bridge.openResource", input);
        return;
      }
      case "openDiff": {
        const input = message.value && typeof message.value === "object" ? message.value as { diff?: unknown; path?: unknown } : {};
        await vscode.commands.executeCommand("agentbridge.bridge.openDiff", input);
        return;
      }
      case "openTerminal": {
        const terminalId = message.terminalId;
        if (typeof terminalId === "string" && terminalId) {
          await vscode.commands.executeCommand("agentbridge.bridge.openTerminal", terminalId);
        }
        return;
      }
      case "copy": {
        const text = message.text;
        if (typeof text === "string" && text) {
          await vscode.env.clipboard.writeText(text);
          void vscode.window.showInformationMessage(t("copiedToClipboard"));
        }
        return;
      }
      case "copyPrompt": {
        const status = this.bridge.getStatus();
        if (!status.publicUrl) throw new Error(t("needStartBridgeFirst"));
        await vscode.env.clipboard.writeText(`${status.publicUrl}\n\n${buildConnectionPrompt()}`);
        void vscode.window.showInformationMessage(t("promptCopied"));
        return;
      }
      case "disconnectSession": {
        const sid = message.sessionId;
        if (typeof sid !== "string" || !sid) throw new Error("sessionId must be a string.");
        await this.bridgeReady;
        this.bridge.destroySession(sid);
        return;
      }
      case "clearIdleSessions": {
        await this.bridgeReady;
        const clearedCount = this.bridge.clearIdleSessions();
        const status = this.bridge.getStatus();
        const persistentMode = vscode.workspace.getConfiguration("agentbridge.bridge").get<boolean>("persistentMode", false);
        const quickTunnelCopied = status.publicUrl !== undefined && status.publicUrl === this.lastCopiedQuickTunnelUrl;
        await sourceWebview.postMessage({
          type: "idleSessionsCleared",
          clearedCount,
          status,
          persistentMode,
          quickTunnelCopied,
        });
        void vscode.window.showInformationMessage(t("idleSessionsCleared", clearedCount));
        return;
      }
      case "clearActivityHistory": {
        await this.bridgeReady;
        const clearedCount = this.bridge.clearActivityHistory();
        const status = this.bridge.getStatus();
        const persistentMode = vscode.workspace.getConfiguration("agentbridge.bridge").get<boolean>("persistentMode", false);
        const quickTunnelCopied = status.publicUrl !== undefined && status.publicUrl === this.lastCopiedQuickTunnelUrl;
        await sourceWebview.postMessage({
          type: "activityHistoryCleared",
          clearedCount,
          status,
          persistentMode,
          quickTunnelCopied,
        });
        return;
      }
      case "setOpenInternalBrowser": {
        const v = message.value;
        if (v !== "auto" && v !== "all" && v !== "external") throw new Error("Invalid openInternalBrowser value.");
        await vscode.workspace.getConfiguration("agentbridge.bridge").update("openInternalBrowser", v, vscode.ConfigurationTarget.Global);
        return;
      }
      case "setTunnelProtocol": {
        const v = message.value;
        if (v !== "auto" && v !== "quic" && v !== "http2") throw new Error("Invalid tunnelProtocol value.");
        await vscode.workspace.getConfiguration("agentbridge.bridge").update("tunnelProtocol", v, vscode.ConfigurationTarget.Global);
        return;
      }
      case "setLanguage": {
        const v = message.value;
        if (v !== "auto" && v !== "zh-CN" && v !== "en") throw new Error("Invalid AgentBridge language value.");
        if (readLanguagePreference() === v) return;
        this.keepAdvancedOpenOnLanguageChange = message.advancedOpen === true;
        this.keepAdvancedSectionsOpenOnLanguageChange = Array.isArray(message.expandedSections) && message.expandedSections.length <= ADVANCED_SECTION_IDS.size
          ? message.expandedSections.filter((id): id is string => typeof id === "string" && ADVANCED_SECTION_IDS.has(id))
          : [];
        try {
          await vscode.workspace.getConfiguration("agentbridge").update("language", v, vscode.ConfigurationTarget.Global);
        } catch (error) {
          this.keepAdvancedOpenOnLanguageChange = false;
          this.keepAdvancedSectionsOpenOnLanguageChange = [];
          throw error;
        }
        return;
      }
      case "setTrustedBrowserOrigins": {
        const origins = message.origins;
        if (!Array.isArray(origins) || origins.length > 32 || origins.some((value) => typeof value !== "string" || value.length > 512)) {
          throw new Error(t("trustedBrowserOriginsInvalid"));
        }
        const normalizedOrigins: string[] = [];
        for (const value of origins) {
          const normalized = normalizeTrustedBrowserOrigin(value);
          if (!normalized) throw new Error(t("trustedBrowserOriginsInvalid"));
          if (!normalizedOrigins.includes(normalized)) normalizedOrigins.push(normalized);
        }
        await vscode.workspace.getConfiguration("agentbridge.bridge").update(
          "trustedBrowserOrigins",
          normalizedOrigins,
          vscode.ConfigurationTarget.Global,
        );
        const effectiveOrigins = readConfiguredTrustedBrowserOrigins();
        const revision = this.trustedBrowserOriginsConfigRevision;
        this.trustedBrowserOriginsInputDirty = false;
        this.pendingTrustedBrowserOriginsRefresh = false;
        try {
          await sourceWebview.postMessage({ type: "trustedBrowserOriginsSaved", origins: effectiveOrigins, revision });
        } catch {
          // The originating Webview may have been disposed while the setting was saved.
        }
        this.flushDeferredConfigurationRefresh(sourceWebview);
        return;
      }
      case "configureManagedShell": {
        const candidatePath = typeof message.path === "string" ? message.path.trim() : "";
        if (candidatePath !== "") {
          const ok = await sanityCheckManagedShellPath(candidatePath);
          if (!ok) {
            void vscode.window.showErrorMessage(
              t("shellPathError", candidatePath)
            );
            return;
          }
        }
        const key = process.platform === "win32" ? "managedShell.windows" : "managedShell.unix";
        await vscode.workspace.getConfiguration("agentbridge.bridge").update(
          key, candidatePath === "" ? undefined : candidatePath, vscode.ConfigurationTarget.Global
        );
        invalidateManagedShellCache();
        void vscode.window.showInformationMessage(
          candidatePath === ""
            ? t("managedShellCleared")
            : t("managedShellUpdated", candidatePath)
        );
        return;
      }
      case "resetManagedShell": {
        const key = process.platform === "win32" ? "managedShell.windows" : "managedShell.unix";
        await vscode.workspace.getConfiguration("agentbridge.bridge").update(
          key, undefined, vscode.ConfigurationTarget.Global
        );
        invalidateManagedShellCache();
        void vscode.window.showInformationMessage(t("managedShellReset"));
        return;
      }
      default:
        return;
    }
  }

private renderHtml(advancedOpen = false, advancedSectionsOpen: readonly string[] = []): string {
    const lang = detectLang();
    const languagePreference = readLanguagePreference();
    const trustedBrowserOrigins = readConfiguredTrustedBrowserOrigins();
    const t = createTranslator(lang);
    const dict = lang === "zh" ? zhMessages : enMessages;
    const sectionOpen = (id: string) => advancedSectionsOpen.includes(id) ? " open" : "";
    return /* html */ `<!DOCTYPE html>
 <html lang="${lang === "zh" ? "zh-CN" : "en"}">
 <head>
 <meta charset="UTF-8">
 <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.view?.webview.cspSource ?? ""} 'unsafe-inline'; script-src 'unsafe-inline';">
 <script>
   window.__AB_I18N__ = ${JSON.stringify(dict).replace(/</g, "\\u003c")};
   window.__AB_CAN_AUTO_INSTALL_CLOUDFLARED__ = ${JSON.stringify(CAN_AUTO_INSTALL_CLOUDFLARED)};
   window.__AB_MCP_WORKSPACE_AVAILABLE__ = ${JSON.stringify(Boolean(vscode.workspace.workspaceFolders?.length))};
   window.__AB_TRUSTED_BROWSER_ORIGINS_REVISION__ = ${JSON.stringify(this.trustedBrowserOriginsConfigRevision)};
 </script>
 <style>
${PANEL_CSS}</style>
</head>
<body>
  <div class="agentbridge-tabs" id="agentbridgeTabs" role="tablist">
    <button class="agentbridge-tab active" id="tabConfig" role="tab" aria-selected="true" tabindex="0" type="button">${t("tabConfig")}</button>
    <button class="agentbridge-tab" id="tabSession" role="tab" aria-selected="false" tabindex="-1" type="button">${t("tabSession")}</button>
  </div>
  <div id="configSection">
  <div class="agentbridge-card agentbridge-hero">
    <div class="agentbridge-card-header">
      <div class="agentbridge-brand">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8 6H6a4 4 0 0 0-4 4v4a4 4 0 0 0 4 4h2m8-12h2a4 4 0 0 1 4 4v4a4 4 0 0 1-4 4h-2M8 12h8" stroke-linecap="round"/><path d="m10 9-3 3 3 3m4-6 3 3-3 3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <h2>AgentBridge</h2>
      </div>
        <span class="agentbridge-mode-switch" role="radiogroup" aria-label="${escapeHtml(t("modeSwitchLabel"))}">
          <button class="agentbridge-mode-plan" id="modePlanButton" role="radio" aria-checked="false" type="button" title="${escapeHtml(t("modePlanTitle") + [...READ_ONLY_BLOCKED_TOOL_NAMES].join(", "))}" disabled>${t("modePlan")}</button>
          <button class="agentbridge-mode-build" id="modeBuildButton" role="radio" aria-checked="true" type="button" title="${escapeHtml(t("modeBuildTitle"))}" disabled>${t("modeBuild")}</button>
        </span>
    </div>
    <p class="agentbridge-hero-description">${t("heroDescription")}</p>
    <div class="agentbridge-hero-status" role="status">
      <span class="agentbridge-state state-stopped" id="stateBadge">…</span>
      <div class="agentbridge-status-details" id="stateDetails">${t("loadingBridgeStatus")}</div>
    </div>
    <div class="agentbridge-address-notice" id="readOnlyNotice" role="status" style="display:none"></div>
    <div class="agentbridge-open-folder-group" id="openFolderGroup" style="display:none">
      <p class="agentbridge-open-folder-hint">${t("openFolderHint")}</p>
      <button class="secondary" id="openFolderButton" type="button">${t("openFolderButton")}</button>
    </div>
    <div class="agentbridge-url-section" id="publicUrlSection" style="display:none">
      <div class="agentbridge-url-label">${t("mcpAddressLabel")}</div>
      <div class="agentbridge-url-row">
        <input class="agentbridge-url-value" id="publicUrlValue" type="text" readonly spellcheck="false">
        <button class="agentbridge-copy-url" id="copyUrlButton" title="${t("copyTitle")}">${t("copy")}</button>
      </div>
    </div>
    <div class="agentbridge-address-notice" id="addressNotice" style="display:none"></div>
    <div class="agentbridge-controls agentbridge-hero-actions">
      <button class="primary" id="startStopButton" disabled>${t("startBridge")}</button>
      <button class="secondary" id="openChatGptButton" title="${t("openChatGpt")}" aria-label="${t("openChatGpt")}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M9 2h5v5m0-5L7 9M6 3H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3" stroke-linecap="round" stroke-linejoin="round"/></svg><span>ChatGPT</span></button>
      <button class="secondary" id="copyPromptButton" title="${t("copyPrompt")}" aria-label="${t("copyPrompt")}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="5" y="5" width="8" height="9" rx="1.5"/><path d="M10 5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h2" stroke-linecap="round"/></svg><span>${t("copyPromptShort")}</span></button>
      <button class="secondary agentbridge-more-sites-toggle" id="moreSitesButton" type="button" title="${t("moreSites")}" aria-label="${t("moreSites")}" aria-expanded="false" aria-controls="moreSitesGroup"><svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="13" cy="8" r="1.2"/></svg></button>
    </div>
    <div class="agentbridge-more-sites" id="moreSitesGroup" hidden>
      <button class="secondary" id="openArenaButton">${t("openArena")}</button>
      <button class="secondary" id="openWorkBuddyButton">${t("openWorkBuddy")}</button>
      <button class="secondary" id="openTraeButton">${t("openTrae")}</button>
      <button class="secondary" id="openQwenButton">${t("openQwen")}</button>
    </div>
    <div class="agentbridge-security-note">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M8 1.5 13 3.5V8c0 3-5 6.5-5 6.5S3 11 3 8V3.5L8 1.5Z" stroke-linejoin="round"/><path d="M8 5v3m0 2h.01" stroke-linecap="round"/></svg><span>${t("securityNote")}</span>
    </div>
  </div>

  <details class="agentbridge-card agentbridge-connection-card" id="connectionCard">
    <summary class="agentbridge-section-heading">
      <span class="agentbridge-section-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 15 15 9m-5-3 2-2a5 5 0 0 1 7 7l-2 2m-7 0-2 2a5 5 0 0 1-7-7l2-2" stroke-linecap="round"/></svg></span>
      <div class="agentbridge-connection-summary-main">
        <h3>${t("connectionSettings")}</h3>
        <div class="agentbridge-connection-details" id="connectionDetails">${t("checkingTunnelSettings")}</div>
      </div>
      <span class="agentbridge-state state-stopped" id="connectionBadge">${t("checking")}</span>
      <svg class="agentbridge-section-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>
    </summary>
    <div class="agentbridge-connection-body">
      <div class="agentbridge-public-health-row" id="publicHealthPanel" style="display:none">
        <div class="agentbridge-public-health-info">
          <div class="agentbridge-label">${t("publicHealthLabel")}</div>
          <div class="agentbridge-public-health-details" id="publicHealthDetails">${t("publicHealthInactiveDetails")}</div>
          <div class="agentbridge-public-health-meta" id="publicHealthMeta"></div>
        </div>
        <span class="agentbridge-public-health-badge state-inactive" id="configPublicHealthBadge">${t("publicHealthInactive")}</span>
        <button class="secondary agentbridge-public-health-check" id="checkPublicHealthButton" type="button" disabled>${t("checkPublicHealthNow")}</button>
      </div>
      <div class="agentbridge-field">
        <label class="agentbridge-label">${t("tunnelMode")}</label>
        <div class="agentbridge-provider-choices" role="radiogroup" aria-label="${t("tunnelMode")}">
          <button class="agentbridge-provider-choice" data-provider="cloudflare" role="radio" id="quickProvider" type="button" title="${t("quickTitle")}" disabled>
            <span class="agentbridge-provider-radio" aria-hidden="true"></span>
            <span class="agentbridge-provider-content">
              <span class="agentbridge-provider-header"><span class="agentbridge-provider-title">${t("quickChoiceTitle")}</span><span class="agentbridge-provider-badge">${t("temporaryAddress")}</span></span>
              <span class="agentbridge-provider-caption">${t("quickChoiceHelp")}</span>
            </span>
          </button>
          <button class="agentbridge-provider-choice" data-provider="cloudflare-named" role="radio" id="namedProvider" type="button" title="${t("namedTitle")}" disabled>
            <span class="agentbridge-provider-radio" aria-hidden="true"></span>
            <span class="agentbridge-provider-content">
              <span class="agentbridge-provider-header"><span class="agentbridge-provider-title">${t("namedChoiceTitle")}</span><span class="agentbridge-provider-badge">${t("fixedAddress")}</span></span>
              <span class="agentbridge-provider-caption">${t("namedChoiceHelp")}</span>
            </span>
          </button>
          <button class="agentbridge-provider-choice" data-provider="ngrok" role="radio" id="ngrokProvider" type="button" title="${t("ngrokTitle")}" disabled>
            <span class="agentbridge-provider-radio" aria-hidden="true"></span>
            <span class="agentbridge-provider-content">
              <span class="agentbridge-provider-header"><span class="agentbridge-provider-title">${t("ngrokChoiceTitle")}</span><span class="agentbridge-provider-badge">${t("fixedAddress")}</span></span>
              <span class="agentbridge-provider-caption">${t("ngrokChoiceHelp")}</span>
            </span>
          </button>
        </div>
        <div class="agentbridge-provider-info">
          <p class="agentbridge-provider-summary" id="providerDescription">${t("quickSummary")}</p>
          <details class="agentbridge-provider-notes">
            <summary>${t("tunnelDetails")}</summary>
            <ul class="agentbridge-provider-facts">
              <li id="providerAddressFact">${t("quickFactAddr")}</li>
              <li id="providerLimitFact">${t("quickFactLimit")}</li>
              <li id="providerConfigFact">${t("quickFactConfig")}</li>
            </ul>
          </details>
        </div>
        <div class="agentbridge-provider-switch-hint">${t("stopBeforeSwitch")}</div>
      </div>

      <div class="agentbridge-field" id="domainField">
        <label class="agentbridge-label">${t("ngrokDomainLabel")}</label>
        <input class="agentbridge-input" id="domainInput" type="text" placeholder="${t("ngrokDomainPlaceholder")}" spellcheck="false" disabled>
        <div class="agentbridge-help">${t("ngrokDomainHelp")}</div>
      </div>

      <div class="agentbridge-named-configuration" id="namedConfiguration" style="display:none">
        <h4>${t("namedConfigTitle")}</h4>
        <div class="agentbridge-named-grid">
          <div class="agentbridge-field">
            <label class="agentbridge-label">${t("publicHostname")}</label>
            <input class="agentbridge-input" id="namedDomainInput" type="text" placeholder="${t("namedDomainPlaceholder")}" spellcheck="false" disabled>
          </div>
          <div class="agentbridge-field">
            <label class="agentbridge-label">${t("tunnelToken")}</label>
            <input class="agentbridge-input" id="namedTokenInput" type="password" placeholder="${t("pasteTokenPlaceholder")}" spellcheck="false" autocomplete="off" disabled>
            <div class="agentbridge-help" id="namedTokenStatus"></div>
          </div>
          <div class="agentbridge-field">
            <label class="agentbridge-label">${t("fixedLocalPort")}</label>
            <input class="agentbridge-input" id="namedPortInput" type="number" min="1024" max="65535" step="1" disabled>
          </div>
          <div class="agentbridge-field">
            <label class="agentbridge-label">${t("serviceUrlLabel")}</label>
            <div class="agentbridge-named-origin-row">
              <input class="agentbridge-input" id="namedOriginValue" type="text" readonly>
              <button class="agentbridge-copy-url" id="copyOriginButton" disabled>${t("copy")}</button>
            </div>
          </div>
        </div>
        <div class="agentbridge-help">${t("namedHelp")}</div>
        <div class="agentbridge-controls">
          <button class="primary" id="saveNamedTunnelButton" disabled>${t("saveNamedTunnel")}</button>
          <button class="secondary" id="clearNamedTunnelTokenButton" disabled>${t("clearToken")}</button>
        </div>
      </div>

      <div class="agentbridge-tunnel-panel" id="tunnelSetupPanel">
        <div class="agentbridge-tunnel-status-row">
          <div class="agentbridge-tunnel-status-text">
            <div class="agentbridge-label">${t("tunnelStatusLabel")}</div>
            <div class="agentbridge-tunnel-state" id="tunnelState">${t("notCheckedTunnel")}</div>
          </div>
          <div class="agentbridge-controls agentbridge-tunnel-actions">
            <button class="secondary" id="checkButton" disabled>${t("checkTunnel")}</button>
            <button class="primary" id="installCloudflaredButton" style="display:none" disabled>${t("installCloudflared")}</button>
          </div>
        </div>
        <div class="agentbridge-help" id="cloudflaredInstallerNotice" style="display:none"></div>
        <details class="agentbridge-setup" id="cloudflareSetup">
          <summary>${t("setupCloudflaredSummary")}</summary>
          <div class="agentbridge-setup-body">
            <p>${t("installCloudflaredIntro")}</p>
            <div class="agentbridge-setup-step">
              <h4>${t("installOrUpdateCloudflared")}</h4>
              ${cloudflaredInstallHelpHtml()}
            </div>
            <p class="agentbridge-help">${t("tempAddressHelp")}</p>
          </div>
        </details>
        <details class="agentbridge-setup" id="cloudflareNamedSetup" style="display:none">
          <summary>${t("setupNamedSummary")}</summary>
          <div class="agentbridge-setup-body">
            <p>${t("setupNamedIntro")}</p>
            <div class="agentbridge-setup-step">
              <h4>${t("installOrUpdateCloudflared")}</h4>
              ${cloudflaredInstallHelpHtml()}
            </div>
            <div class="agentbridge-setup-step">
              <h4>${t("createOrOpenTunnel")}</h4>
              <button class="secondary" data-open="https://dash.cloudflare.com/?to=%2F%3Aaccount%2Ftunnels">${t("openCloudflareTunnels")}</button>
            </div>
            <div class="agentbridge-setup-step">
              <h4>${t("addPublishedRoute")}</h4>
              <p class="agentbridge-help">${t("publishedRouteHelp")}</p>
            </div>
            <div class="agentbridge-setup-step">
              <h4>${t("checkDnsRecords")}</h4>
              <button class="secondary" data-open="https://dash.cloudflare.com/?to=%2F%3Aaccount%2F%3Azone%2Fdns%2Frecords">${t("openCloudflareDns")}</button>
            </div>
          </div>
        </details>
        <details class="agentbridge-setup" id="ngrokSetup" style="display:none">
          <summary>${t("setupNgrokSummary")}</summary>
          <div class="agentbridge-setup-body">
            <p>${t("setupNgrokIntro")}</p>
            <div class="agentbridge-setup-step">
              <h4>${t("installOrUpdateNgrok")}</h4>
              <div class="agentbridge-command-row"><code>winget install --id 9MVS1J51GMK6 --source msstore --accept-package-agreements --accept-source-agreements</code><button class="secondary" data-copy="winget install --id 9MVS1J51GMK6 --source msstore --accept-package-agreements --accept-source-agreements">${t("copy")}</button></div>
              <div class="agentbridge-command-row"><code>winget upgrade --id 9MVS1J51GMK6 --source msstore --accept-package-agreements --accept-source-agreements</code><button class="secondary" data-copy="winget upgrade --id 9MVS1J51GMK6 --source msstore --accept-package-agreements --accept-source-agreements">${t("copy")}</button></div>
            </div>
            <div class="agentbridge-setup-step">
              <h4>${t("addAuthtoken")}</h4>
              <div class="agentbridge-command-row"><code>ngrok config add-authtoken &lt;YOUR_AUTHTOKEN&gt;</code><button class="secondary" data-copy="ngrok config add-authtoken <YOUR_AUTHTOKEN>">${t("copy")}</button></div>
            </div>
            <div class="agentbridge-setup-step">
              <h4>${t("verifyNgrok")}</h4>
              <div class="agentbridge-command-row"><code>ngrok version; ngrok config check</code><button class="secondary" data-copy="ngrok version; ngrok config check">${t("copy")}</button></div>
            </div>
            <div class="agentbridge-setup-step">
              <h4>${t("chooseFreeDomain")}</h4>
              <button class="secondary" data-open="https://dashboard.ngrok.com/domains">${t("openDomainsPage")}</button>
            </div>
          </div>
        </details>
      </div>

      <div class="agentbridge-persistent-row">
        <div class="agentbridge-persistent-text">
          <label class="agentbridge-label">${t("persistentLabel")}</label>
          <div class="agentbridge-help">${t("persistentHelp")}</div>
        </div>
        <button class="agentbridge-switch" id="persistentModeToggle" role="switch" type="button" disabled>
          <span class="agentbridge-switch-track"></span>
        </button>
      </div>
    </div>
  </details>

  <details class="agentbridge-card agentbridge-mcp-card" id="externalMcpCard">
    <summary class="agentbridge-mcp-heading">
      <span class="agentbridge-mcp-heading-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="3" width="16" height="7" rx="2"/><rect x="4" y="14" width="16" height="7" rx="2"/><path d="M8 6.5h.01M8 17.5h.01M12 6.5h4M12 17.5h4" stroke-linecap="round"/></svg></span>
      <h3>${t("externalMcpServers")}</h3>
      <span id="externalMcpSummaryState" class="agentbridge-mcp-badge">${t("mcpNotConfigured")}</span>
      <svg class="agentbridge-mcp-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>
    </summary>
    <div class="agentbridge-mcp-body">
      <p class="agentbridge-mcp-description">${t("externalMcpHelp")}</p>
      <div class="agentbridge-mcp-toolbar">
        <div class="agentbridge-mcp-config-actions">
          <button class="primary" id="mcpAddServerButton" type="button" aria-expanded="false" aria-controls="mcpAddServerForm">${t("mcpAddServer")}</button>
          <button class="secondary" id="mcpWorkspaceConfigButton" title="${t("mcpWorkspaceConfig")}">${t("mcpWorkspaceConfig")}</button>
          <button class="secondary" id="mcpUserConfigButton" title="${t("mcpUserConfig")}">${t("mcpUserConfig")}</button>
        </div>
        <div class="agentbridge-mcp-utilities">
          <button class="agentbridge-mcp-icon-button" id="mcpReloadButton" title="${t("mcpReloadHint")}" aria-label="${t("mcpReload")}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M13 5a5.4 5.4 0 1 0 .2 5M13 2v3h-3" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          <button class="agentbridge-mcp-icon-button" id="mcpCredentialButton" title="${t("mcpCredentialHint")}" aria-label="${t("mcpCredentialButton")}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="5.5" cy="5.5" r="3"/><path d="m7.7 7.7 5.5 5.5M10 10l1.7-1.7M11.7 11.7l1.7-1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        </div>
      </div>
      <form id="mcpAddServerForm" class="agentbridge-mcp-form" hidden novalidate>
        <div class="agentbridge-mcp-form-heading"><strong>${t("mcpAddServer")}</strong><span class="agentbridge-mcp-badge">MCP</span></div>
        <div class="agentbridge-field">
          <label class="agentbridge-label" for="mcpFormName">${t("mcpFormName")}</label>
          <input class="agentbridge-input" id="mcpFormName" type="text" maxlength="32" placeholder="my-server" autocomplete="off" spellcheck="false" />
          <div class="agentbridge-help">${t("mcpFormNameHelp")}</div>
        </div>
        <div class="agentbridge-mcp-form-grid">
          <div class="agentbridge-field"><label class="agentbridge-label" for="mcpFormScope">${t("mcpFormScope")}</label><select class="agentbridge-input" id="mcpFormScope"><option value="workspace">${t("mcpWorkspaceConfig")}</option><option value="user">${t("mcpUserConfig")}</option></select></div>
          <div class="agentbridge-field"><label class="agentbridge-label" for="mcpFormTransport">${t("mcpFormTransport")}</label><select class="agentbridge-input" id="mcpFormTransport"><option value="stdio">${t("mcpFormStdio")}</option><option value="http">${t("mcpFormHttp")}</option></select></div>
        </div>
        <p class="agentbridge-help" id="mcpFormScopeHint"></p>
        <div id="mcpFormStdioFields">
          <div class="agentbridge-field"><label class="agentbridge-label" for="mcpFormCommand">${t("mcpFormCommand")}</label><input class="agentbridge-input" id="mcpFormCommand" type="text" placeholder="npx" autocomplete="off" spellcheck="false" /><div class="agentbridge-help">${t("mcpFormCommandHelp")}</div></div>
          <div class="agentbridge-field"><label class="agentbridge-label" for="mcpFormArgs">${t("mcpFormArgs")}</label><textarea class="agentbridge-textarea" id="mcpFormArgs" rows="3" placeholder="-y&#10;@scope/mcp-server" spellcheck="false"></textarea><div class="agentbridge-help">${t("mcpFormArgsHelp")}</div></div>
        </div>
        <div id="mcpFormHttpFields" hidden>
          <div class="agentbridge-field"><label class="agentbridge-label" for="mcpFormUrl">${t("mcpFormUrl")}</label><input class="agentbridge-input" id="mcpFormUrl" type="text" placeholder="https://example.com/mcp" autocomplete="off" spellcheck="false" /></div>
          <div class="agentbridge-field"><label class="agentbridge-label" for="mcpFormHeaders">${t("mcpFormHeaders")}</label><textarea class="agentbridge-textarea" id="mcpFormHeaders" rows="3" placeholder="Authorization: Bearer &#36;{secret:my-server_token}" spellcheck="false"></textarea><div class="agentbridge-help">${t("mcpFormHeadersHelp")}</div></div>
        </div>
        <div class="agentbridge-mcp-form-credentials">
          <button class="secondary" id="mcpFormCredentialButton" type="button">${t("mcpCredentialButton")}</button>
          <div class="agentbridge-help">${t("mcpFormCredentialHelp")}</div>
          <input class="agentbridge-input" id="mcpFormCredentialReference" type="text" readonly aria-label="${t("mcpFormCredentialReference")}" hidden />
        </div>
        <details class="agentbridge-mcp-form-options" id="mcpFormOptions">
          <summary>${t("mcpFormOptions")}</summary>
          <div id="mcpFormStdioOptions">
            <div class="agentbridge-field"><label class="agentbridge-label" for="mcpFormCwd">${t("mcpFormCwd")}</label><input class="agentbridge-input" id="mcpFormCwd" type="text" placeholder="&#36;{workspaceFolder}" spellcheck="false" /></div>
            <div class="agentbridge-field"><label class="agentbridge-label" for="mcpFormEnv">${t("mcpFormEnv")}</label><textarea class="agentbridge-textarea" id="mcpFormEnv" rows="3" placeholder="SERVICE_TOKEN=&#36;{secret:my-server_token}" spellcheck="false"></textarea><div class="agentbridge-help">${t("mcpFormEnvHelp")}</div></div>
          </div>
          <div class="agentbridge-field"><label class="agentbridge-label" for="mcpFormPlanMode">${t("mcpFormPlanMode")}</label><select class="agentbridge-input" id="mcpFormPlanMode"><option value="read-only">${t("mcpFormPlanReadOnly")}</option><option value="all">${t("mcpFormPlanAll")}</option><option value="disabled">${t("mcpFormPlanDisabled")}</option></select></div>
          <div class="agentbridge-mcp-form-grid">
            <div class="agentbridge-field"><label class="agentbridge-label" for="mcpFormConnectTimeout">${t("mcpFormConnectTimeout")}</label><input class="agentbridge-input" id="mcpFormConnectTimeout" type="number" min="0.001" max="3600" step="any" placeholder="10" /></div>
            <div class="agentbridge-field"><label class="agentbridge-label" for="mcpFormTimeout">${t("mcpFormTimeout")}</label><input class="agentbridge-input" id="mcpFormTimeout" type="number" min="0.001" max="3600" step="any" placeholder="60" /></div>
          </div>
        </details>
        <div id="mcpFormError" class="agentbridge-mcp-error-box" role="alert" hidden></div>
        <div class="agentbridge-mcp-form-actions"><button class="primary" id="mcpFormSaveButton" type="submit">${t("mcpFormSave")}</button><button class="secondary" id="mcpFormCancelButton" type="button">${t("mcpFormCancel")}</button></div>
        <p class="agentbridge-help">${t("mcpFormSaveHelp")}</p>
      </form>
      <div id="mcpFormSavedStatus" class="agentbridge-help agentbridge-origins-status" role="status" hidden></div>
      <div id="externalMcpErrors" class="agentbridge-mcp-error-box" role="alert" hidden></div>
      <div id="externalMcpEmpty" class="agentbridge-mcp-empty">
        <svg class="agentbridge-mcp-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M9 3v4m6-4v4M7 7h10v5a5 5 0 0 1-10 0V7Zm5 10v4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <strong>${t("mcpEmptyTitle")}</strong>
        <p>${t("mcpNoServers")}</p>
      </div>
      <div id="externalMcpList" class="agentbridge-mcp-list"></div>
      <p class="agentbridge-mcp-footer" title="${t("externalMcpRefreshHint")}">${t("mcpConfigHint")}</p>
    </div>
  </details>

  <details class="agentbridge-card agentbridge-advanced-card" id="advancedCard"${advancedOpen ? " open" : ""}>
    <summary class="agentbridge-section-heading">
      <span class="agentbridge-section-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 6h16M4 12h16M4 18h16" stroke-linecap="round"/><circle cx="9" cy="6" r="2" fill="var(--vscode-editorWidget-background)"/><circle cx="15" cy="12" r="2" fill="var(--vscode-editorWidget-background)"/><circle cx="8" cy="18" r="2" fill="var(--vscode-editorWidget-background)"/></svg></span>
      <h3>${t("advancedSettings")}</h3>
      <svg class="agentbridge-section-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>
    </summary>
    <div class="agentbridge-advanced-body">
      <div class="agentbridge-field" style="margin-top:0;">
        <label class="agentbridge-label" for="languageSelect">${t("interfaceLanguage")}</label>
        <select class="agentbridge-select" id="languageSelect">
          <option value="auto"${languagePreference === "auto" ? " selected" : ""}>${t("languageFollowVscode")}</option>
          <option value="zh-CN"${languagePreference === "zh-CN" ? " selected" : ""}>${t("languageChinese")}</option>
          <option value="en"${languagePreference === "en" ? " selected" : ""}>${t("languageEnglish")}</option>
        </select>
        <div class="agentbridge-help">${t("interfaceLanguageHelp")}</div>
      </div>
      <div class="agentbridge-static-row" style="margin-top:12px;">
        <div class="agentbridge-label">${t("transportProtocol")}</div>
        <div class="agentbridge-static-value">Streamable HTTP</div>
      </div>
      <details class="agentbridge-advanced-section" id="securitySettingsSection"${sectionOpen("securitySettingsSection")}>
        <summary><h4>${t("securityAccess")}</h4></summary>
        <p class="agentbridge-help">${t("securityHelp")}</p>
        <div class="agentbridge-controls">
          <button class="secondary" id="rotateButton" disabled>${t("rotateEndpoint")}</button>
        </div>
        <div class="agentbridge-field agentbridge-origins-field">
          <div class="agentbridge-origins-heading">
            <label class="agentbridge-label" for="trustedBrowserOriginsInput">${t("trustedBrowserOrigins")}</label>
            <span class="agentbridge-setting-count">${t("trustedBrowserOriginsPerLine")}</span>
          </div>
          <div class="agentbridge-help" id="trustedBrowserOriginsHint">${t("trustedBrowserOriginsBatchHint")}</div>
          <div class="agentbridge-origins-editor">
            <textarea class="agentbridge-textarea" id="trustedBrowserOriginsInput" rows="5" wrap="off" spellcheck="false" autocapitalize="off" autocomplete="off" aria-describedby="trustedBrowserOriginsHint" placeholder="${escapeHtml(t("trustedBrowserOriginsPlaceholder"))}" disabled>${escapeHtml(trustedBrowserOrigins.join("\n"))}</textarea>
            <div class="agentbridge-origins-toolbar">
              <span>${t("trustedBrowserOriginsLocalOnly")}</span>
              <button class="primary" id="trustedBrowserOriginsSaveButton" disabled>${t("saveTrustedBrowserOrigins")}</button>
            </div>
          </div>
          <details class="agentbridge-origins-rules" id="trustedBrowserOriginsRules"${sectionOpen("trustedBrowserOriginsRules")}>
            <summary>${t("trustedBrowserOriginsRules")}</summary>
            <p class="agentbridge-help">${t("trustedBrowserOriginsHelp")}</p>
          </details>
          <div class="agentbridge-help agentbridge-origins-status" id="trustedBrowserOriginsStatus" role="status" style="display:none;"></div>
        </div>
      </details>
      <details class="agentbridge-advanced-section" id="exposedToolsSection"${sectionOpen("exposedToolsSection")}>
        <summary><h4>${t("exposedTools")}</h4><span class="agentbridge-setting-count" id="toolsCount"></span></summary>
        <div class="agentbridge-tools" id="toolsContainer"></div>
      </details>
      <details class="agentbridge-advanced-section" id="managedShellSection"${sectionOpen("managedShellSection")}>
        <summary><h4>${t("managedShell")}</h4></summary>
        <p class="agentbridge-help">${t("managedShellHelp")}</p>
        <div class="agentbridge-static-row">
          <div class="agentbridge-label">${t("current")}</div>
          <div class="agentbridge-static-value" id="managedShellCurrentLabel">${t("reading")}</div>
        </div>
        <div class="agentbridge-controls" style="display:flex; flex-direction:column; gap:8px; margin-top:8px;">
          <input class="agentbridge-input" id="managedShellInput" type="text" placeholder="${t("managedShellPlaceholder")}" disabled />
          <div style="display:flex; gap:8px;">
            <button class="secondary" id="managedShellSaveButton" disabled>${t("save")}</button>
            <button class="secondary" id="managedShellResetButton" disabled>${t("resetToDefault")}</button>
          </div>
          <div id="managedShellWarning" style="color:var(--vscode-errorForeground); display:none; font-size:11px; line-height:1.4;"></div>
        </div>
      </details>
      <details class="agentbridge-advanced-section" id="tunnelTransportSection"${sectionOpen("tunnelTransportSection")}>
        <summary><h4>${t("tunnelTransportSection")}</h4></summary>
        <p class="agentbridge-help">${t("tunnelTransportHelp")}</p>
        <div class="agentbridge-controls" style="display:flex; gap:8px; flex-wrap:wrap; margin-top:4px;">
          <button class="secondary agentbridge-oib-radio" id="tunnelProtocolAuto" role="radio" aria-checked="true" disabled>${t("tunnelProtocolAutoLabel")}</button>
          <button class="secondary agentbridge-oib-radio" id="tunnelProtocolQuic" role="radio" aria-checked="false" disabled>${t("tunnelProtocolQuicLabel")}</button>
          <button class="secondary agentbridge-oib-radio" id="tunnelProtocolHttp2" role="radio" aria-checked="false" disabled>${t("tunnelProtocolHttp2Label")}</button>
        </div>
      </details>
      <details class="agentbridge-advanced-section" id="openModeSection"${sectionOpen("openModeSection")}>
        <summary><h4>${t("openMode")}</h4></summary>
        <p class="agentbridge-help">${t("openModeHelp")}</p>
        <div class="agentbridge-controls" style="display:flex; gap:8px; flex-wrap:wrap; margin-top:4px;">
          <button class="secondary agentbridge-oib-radio" id="openInternalBrowserAuto" role="radio" aria-checked="true" disabled>${t("smart")}</button>
          <button class="secondary agentbridge-oib-radio" id="openInternalBrowserAll" role="radio" aria-checked="false" disabled>${t("embedAll")}</button>
          <button class="secondary agentbridge-oib-radio" id="openInternalBrowserExternal" role="radio" aria-checked="false" disabled>${t("externalAll")}</button>
        </div>
      </details>
    </div>
  </details>
  </div>

  <div class="agentbridge-session-view" id="sessionSection" style="display:none">
    <div class="agentbridge-session-todos-region" id="todosRegion"></div>
    <div class="agentbridge-session-history-toolbar">
      <span class="agentbridge-session-history-title">${t("activityHistory")}</span>
      <span class="agentbridge-session-history-divider" aria-hidden="true"></span>
      <button class="agentbridge-session-history-clear" id="clearHistoryButton" type="button" title="${t("clearHistoryTitle")}" disabled>${t("clearHistory")}</button>
    </div>
    <div class="agentbridge-session-scroll">
      <div class="agentbridge-session-timeline" id="timeline"></div>
    </div>
    <div class="agentbridge-session-footer">
      <div class="agentbridge-session-connection-row">
        <div class="agentbridge-session-connection-info">
          <div class="agentbridge-session-connection-heading">
            <span class="agentbridge-session-dot" id="connectionDot"></span>
            <strong id="connectionTitle">AgentBridge</strong>
            <span class="agentbridge-public-health-badge state-inactive" id="sessionPublicHealthBadge" role="status" aria-live="polite" aria-atomic="true" style="display:none">${t("publicHealthInactive")}</span>
          </div>
          <span class="agentbridge-session-connection-description" id="connectionDescription">${t("startToMonitor")}</span>
        </div>
        <div class="agentbridge-session-connection-actions">
          <button class="primary" id="sessionStartStopButton" disabled>${t("connect")}</button>
          <button class="secondary" id="sessionCollapseButton" title="${t("collapseTitle")}">▾</button>
        </div>
      </div>
      <div class="agentbridge-session-footer-details" id="footerDetails">
        <div class="agentbridge-session-list" id="sessionList"></div>
        <div class="agentbridge-session-stats" id="sessionStats"></div>
        <div class="agentbridge-session-meta" id="footerMeta"></div>
        <div class="agentbridge-session-hint" id="footerHint"></div>
      </div>
    </div>
  </div>

<script>
${PANEL_SCRIPT}</script>
</body>
</html>`;
  }
}
