import * as vscode from "vscode";
import { describeManagedShell, invalidateManagedShellCache, sanityCheckManagedShellPath } from "./ide-tool-broker.js";
import type { BridgeManager, BridgeStatus } from "./bridge-server.js";

const POLL_INTERVAL_MS = 1500;

const ARENA_URL = "https://arena.ai/agent";

function buildArenaPrompt(shellPromptZH: string): string {
  return [
    "连接这个 MCP（URL），明确使用规则，熟悉可用工具，做好处理接下来一系列工作的准备。",
    shellPromptZH,
    "",
    "行动准则：专注当前任务，以完成功能为最高优先。只读取、修改直接相关的文件，采用最小必要改动，不主动审计、重构或优化整个项目。",
    "可并行的读写操作应并行执行，提高效率。协作方式：你来做，我来验收；未经我明确允许，不执行全量测试、构建、部署或自动验收。",
    "发现旁支问题，除非直接阻塞当前任务，否则不处理。沟通简短，快速交付。",
  ].join("\n");
}

interface PanelMessage {
  type: string;
  [key: string]: unknown;
}

export class BridgePanelProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private lastCopiedQuickTunnelUrl = "";

  constructor(
    private readonly bridge: BridgeManager,
    private readonly bridgeReady: Promise<void>,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };
    webviewView.webview.html = this.renderHtml();
    webviewView.webview.onDidReceiveMessage((message: PanelMessage) => {
      void this.handleMessage(message).then(() => this.pushStatus(), (error) => {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      });
    });
    this.startPolling();
    webviewView.onDidDispose(() => this.stopPolling());
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

  private pushStatus(): void {
    if (!this.view) return;
    const status = this.bridge.getStatus();
    const persistentMode = vscode.workspace.getConfiguration("agentbridge.bridge").get<boolean>("persistentMode", false);
    void this.view.webview.postMessage({ type: "status", status, persistentMode });
  }

  private async handleMessage(message: PanelMessage): Promise<void> {
    switch (message.type) {
      case "refresh":
        return;
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
      case "installCloudflared":
        await this.bridgeReady;
        await this.bridge.installCloudflared();
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
      case "openExternal": {
        const url = message.url;
        if (typeof url === "string" && url) {
          const mode = vscode.workspace.getConfiguration("agentbridge.bridge").get<"auto" | "all" | "external">("openInternalBrowser", "auto");
          const isEmbeddedHost = /^https?:\/\/(?:www\.)?(?:chatgpt\.com|arena\.ai)\b/i.test(url);
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
          openLabel: "选作工作区文件夹",
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
          void vscode.window.showInformationMessage("已复制到剪贴板。");
        }
        return;
      }
      case "copyPrompt": {
        const status = this.bridge.getStatus();
        if (!status.publicUrl) throw new Error("请先启动 Bridge 获取 MCP 地址。");
        const { chatPromptZH } = describeManagedShell();
        await vscode.env.clipboard.writeText(`${status.publicUrl}\n\n${buildArenaPrompt(chatPromptZH)}`);
        void vscode.window.showInformationMessage("MCP 地址与连接提示已复制到剪贴板。");
        return;
      }
      case "disconnectSession": {
        const sid = message.sessionId;
        if (typeof sid !== "string" || !sid) throw new Error("sessionId must be a string.");
        await this.bridgeReady;
        this.bridge.destroySession(sid);
        return;
      }
      case "setOpenInternalBrowser": {
        const v = message.value;
        if (v !== "auto" && v !== "all" && v !== "external") throw new Error("Invalid openInternalBrowser value.");
        await vscode.workspace.getConfiguration("agentbridge.bridge").update("openInternalBrowser", v, vscode.ConfigurationTarget.Global);
        return;
      }
      case "configureManagedShell": {
        const candidatePath = typeof message.path === "string" ? message.path.trim() : "";
        if (candidatePath !== "") {
          const ok = await sanityCheckManagedShellPath(candidatePath);
          if (!ok) {
            void vscode.window.showErrorMessage(
              `AgentBridge 无法以该路径启动 shell：${candidatePath}\n请检查完整可执行路径（如 C:\\Program Files\\PowerShell\\7\\pwsh.exe）。配置未保存。`
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
            ? "Management Shell 自定义路径已清空。新 MCP 会话与新建终端将回退到默认 shell；如需所有会话立即套用，请 Stop + Start Bridge。"
            : `Management Shell 已更新为 ${candidatePath}。新 MCP 会话与新建终端将使用它；如需所有会话立即套用，请 Stop + Start Bridge。`
        );
        return;
      }
      case "resetManagedShell": {
        const key = process.platform === "win32" ? "managedShell.windows" : "managedShell.unix";
        await vscode.workspace.getConfiguration("agentbridge.bridge").update(
          key, undefined, vscode.ConfigurationTarget.Global
        );
        invalidateManagedShellCache();
        void vscode.window.showInformationMessage("Management Shell 已重置为默认。");
        return;
      }
      default:
        return;
    }
  }

  private renderHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.view?.webview.cspSource ?? ""} 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  html { height: 100%; margin: 0; padding: 0; }
  body { box-sizing: border-box; width: 100%; height: 100%; min-width: 0; min-height: 0; max-width: none; padding: 0 0 24px; display: flex; flex-direction: column; overflow: hidden; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  .agentbridge-card h2, .agentbridge-card h3, .agentbridge-advanced-section h4, .agentbridge-setup-step h4 { margin: 0; font-weight: 600; }
  .agentbridge-hero-description { max-width: 720px; margin: 7px 0 0; color: var(--vscode-descriptionForeground); line-height: 1.4; }
  .agentbridge-security-note { display: flex; align-items: center; gap: 6px; margin-top: 12px; color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.4; }
  .agentbridge-security-note > span:first-child { color: var(--vscode-editorWarning-foreground); }
  .agentbridge-open-folder-group { margin-top: 12px; padding: 8px 10px; border: 1px dashed var(--vscode-editorWarning-foreground); border-radius: 4px; }
  .agentbridge-open-folder-hint { color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.4; margin: 0 0 8px 0; }
  .agentbridge-card, .agentbridge-setup { box-sizing: border-box; padding: 13px 15px; margin-bottom: 10px; border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); border-radius: 6px; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); }
  .agentbridge-hero { padding: 16px; }
  .agentbridge-card-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .agentbridge-hero-actions { margin-top: 14px; }
  .agentbridge-hero-actions > button { width: auto; min-width: 150px; }
  .agentbridge-connection-card, .agentbridge-advanced-card { padding: 0; }
  .agentbridge-connection-card > summary, .agentbridge-advanced-card > summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 14px; cursor: pointer; list-style-position: inside; }
  .agentbridge-connection-card > summary::marker, .agentbridge-advanced-card > summary::marker { color: var(--vscode-descriptionForeground); }
  .agentbridge-connection-summary-main { display: flex; min-width: 0; flex: 1 1 auto; align-items: baseline; gap: 10px; }
  .agentbridge-connection-summary-main h3 { flex: 0 0 auto; }
  .agentbridge-connection-details { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.4; }
  .agentbridge-connection-body { padding: 2px 14px 14px; border-top: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); }
  .agentbridge-field { display: flex; flex-direction: column; gap: 5px; margin-top: 12px; }
  .agentbridge-label, .agentbridge-url-label { font-size: 12px; font-weight: 600; }
  .agentbridge-input, .agentbridge-select { box-sizing: border-box; width: min(100%, 680px); height: 28px; padding: 3px 8px; border: 1px solid var(--vscode-input-border, transparent); outline: none; background: var(--vscode-input-background); color: var(--vscode-input-foreground); font: inherit; }
  .agentbridge-input:focus, .agentbridge-select:focus { border-color: var(--vscode-focusBorder); }
  .agentbridge-input:disabled, .agentbridge-select:disabled { opacity: .72; }
  .agentbridge-provider-choices { display: flex; width: min(100%, 680px); flex-direction: column; gap: 8px; }
  .agentbridge-provider-choice { box-sizing: border-box; width: 100%; padding: 10px 12px; border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); border-radius: 5px; background: var(--vscode-editor-background); color: var(--vscode-foreground); font: inherit; text-align: left; cursor: pointer; }
  .agentbridge-provider-choice:hover:not(:disabled) { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground, var(--vscode-editor-background)); }
  .agentbridge-provider-choice:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .agentbridge-provider-choice.selected { border-color: var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground, var(--vscode-editor-background)); color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground)); }
  .agentbridge-provider-choice:disabled { opacity: .65; cursor: default; }

  .agentbridge-oib-radio { padding: 4px 10px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; background: transparent; color: var(--vscode-foreground); font: inherit; cursor: pointer; transition: background-color 120ms ease, border-color 120ms ease; }
  .agentbridge-oib-radio[aria-checked="true"] { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background, transparent); }
  .agentbridge-oib-radio[aria-checked="true"]:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .agentbridge-oib-radio[aria-checked="false"]:hover:not(:disabled) { background: var(--vscode-list-hoverBackground, transparent); }
  .agentbridge-oib-radio:disabled { opacity: .55; cursor: default; }
  .agentbridge-provider-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .agentbridge-provider-title { font-weight: 600; }
  .agentbridge-provider-badge { flex: 0 0 auto; padding: 2px 7px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 11px; }
  .agentbridge-provider-summary, .agentbridge-provider-facts { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.45; }
  .agentbridge-provider-summary { margin-top: 5px; }
  .agentbridge-provider-facts { margin: 6px 0 0; padding-left: 18px; }
  .agentbridge-named-configuration { box-sizing: border-box; width: min(100%, 680px); margin-top: 12px; padding: 12px; border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); border-radius: 5px; background: var(--vscode-editor-background); }
  .agentbridge-named-configuration h4 { margin: 0 0 4px; font-size: 12px; }
  .agentbridge-named-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 12px; }
  .agentbridge-named-grid .agentbridge-field, .agentbridge-named-grid .agentbridge-input { min-width: 0; width: 100%; }
  .agentbridge-named-origin-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: stretch; }
  .agentbridge-named-origin-row .agentbridge-input { border-right: 0; border-radius: 0; }
  .agentbridge-help, .agentbridge-status-details, .agentbridge-tunnel-state, .agentbridge-address-notice { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.45; }
  .agentbridge-controls { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .agentbridge-state { padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); white-space: nowrap; }
  .agentbridge-state.state-running { color: var(--vscode-testing-iconPassed, var(--vscode-foreground)); }
  .agentbridge-state.state-error { color: var(--vscode-errorForeground); }
  .agentbridge-status-details { margin-top: 7px; }
  .agentbridge-tunnel-state { margin-top: 5px; }
  .agentbridge-tunnel-panel { box-sizing: border-box; width: min(100%, 680px); margin-top: 12px; padding: 10px 12px; border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); border-radius: 4px; background: var(--vscode-editor-background); }
  .agentbridge-tunnel-panel.needs-attention { border-color: var(--vscode-inputValidation-warningBorder, var(--vscode-editorWarning-foreground)); background: var(--vscode-inputValidation-warningBackground, var(--vscode-editor-background)); }
  .agentbridge-tunnel-status-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .agentbridge-tunnel-status-text { min-width: 0; flex: 1 1 auto; }
  .agentbridge-tunnel-actions { flex: 0 0 auto; margin-top: 0; }
  .agentbridge-url-section { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); }
  .agentbridge-address-notice { margin-top: 7px; padding: 7px 9px; border-left: 3px solid var(--vscode-editorWarning-foreground); background: var(--vscode-inputValidation-warningBackground, var(--vscode-editor-background)); }
  .agentbridge-url-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: stretch; gap: 8px; margin: 6px 0; min-width: 0; width: 100%; }
  .agentbridge-command-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; min-width: 0; width: 100%; }
  .agentbridge-command-row > button { flex: 0 0 auto; width: auto; min-width: 28px; }
  .agentbridge-url-value { box-sizing: border-box; min-width: 0; width: 100%; height: 30px; padding: 5px 8px; border: 1px solid var(--vscode-input-border, var(--vscode-contrastBorder, transparent)); border-radius: 3px; outline: none; background: var(--vscode-input-background); color: var(--vscode-input-foreground); font-family: var(--monaco-monospace-font); font-size: 12px; white-space: nowrap; user-select: text; }
  .agentbridge-url-value:focus { border-color: var(--vscode-focusBorder); }
  .agentbridge-copy-url { box-sizing: border-box; min-width: 72px; height: 30px; padding: 0 12px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; background: var(--vscode-button-secondaryBackground, var(--vscode-button-background)); color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground)); font: inherit; white-space: nowrap; cursor: pointer; }
  .agentbridge-copy-url:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
  .agentbridge-copy-url:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .agentbridge-command-row code { box-sizing: border-box; min-width: 0; width: 0; padding: 6px 8px; border-radius: 3px; background: var(--vscode-textCodeBlock-background); color: var(--vscode-textPreformat-foreground); font-family: var(--monaco-monospace-font); font-size: 12px; white-space: pre-wrap; word-break: break-word; flex: 1 1 0; }
  .agentbridge-tools { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .agentbridge-tool { padding: 3px 7px; border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-family: var(--monaco-monospace-font); font-size: 11px; }
  .agentbridge-tool.bridge-only { border-style: dashed; }
  .agentbridge-advanced-card > summary { cursor: pointer; }
  .agentbridge-advanced-body { padding: 14px; border-top: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); }
  .agentbridge-static-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; max-width: 680px; padding: 8px 10px; border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); border-radius: 4px; background: var(--vscode-editor-background); }
  .agentbridge-static-value { color: var(--vscode-descriptionForeground); font-family: var(--monaco-monospace-font); font-size: 12px; }
  .agentbridge-advanced-section { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); }
  .agentbridge-advanced-section h4 { font-size: 12px; }
  .agentbridge-setup > summary { cursor: pointer; font-weight: 600; }
  .agentbridge-setup-body { padding-top: 10px; }
  .agentbridge-setup-step { margin-top: 14px; }
  .agentbridge-setup-step h4 { margin-bottom: 6px; font-size: 12px; }
  .agentbridge-persistent-row { display: flex; align-items: center; justify-content: space-between; gap: 18px; width: min(100%, 680px); margin-top: 14px; }
  .agentbridge-persistent-text { display: flex; min-width: 0; flex: 1 1 auto; flex-direction: column; gap: 4px; }
  .agentbridge-switch { position: relative; display: inline-flex; width: 36px; height: 20px; flex: 0 0 auto; padding: 0; border: 0; outline: none; appearance: none; background: transparent; color: inherit; font: inherit; cursor: pointer; }
  .agentbridge-switch-track { box-sizing: border-box; width: 36px; height: 20px; border: 1px solid var(--vscode-checkbox-border, var(--vscode-widget-border)); border-radius: 10px; background: var(--vscode-checkbox-background); transition: background-color 120ms ease, border-color 120ms ease; }
  .agentbridge-switch-track::after { content: ""; display: block; width: 14px; height: 14px; margin: 2px; border-radius: 50%; background: var(--vscode-checkbox-foreground); transition: transform 120ms ease; }
  .agentbridge-switch[aria-checked=true] .agentbridge-switch-track { border-color: var(--vscode-button-background); background: var(--vscode-button-background); }
  .agentbridge-switch[aria-checked=true] .agentbridge-switch-track::after { transform: translateX(16px); background: var(--vscode-button-foreground); }
  .agentbridge-switch:focus-visible .agentbridge-switch-track { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .agentbridge-switch:disabled { opacity: .55; cursor: default; }
  button { font: inherit; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 12px; border-radius: 2px; cursor: pointer; min-height: 26px; }
  button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-button-border, transparent); padding: 4px 12px; border-radius: 2px; cursor: pointer; min-height: 26px; }
  button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: .5; cursor: default; }
  @media (max-width: 520px) {
    .agentbridge-named-grid { grid-template-columns: minmax(0, 1fr); }
    .agentbridge-connection-card > summary, .agentbridge-connection-summary-main, .agentbridge-advanced-card > summary, .agentbridge-static-row { align-items: flex-start; flex-direction: column; }
    .agentbridge-connection-details { white-space: normal; }
    .agentbridge-persistent-row { align-items: flex-start; }
  }
  .agentbridge-tabs { display: flex; align-items: center; gap: 2px; margin: 0 12px 10px; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); }
  .agentbridge-tab { flex: 1 1 auto; padding: 8px 12px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--vscode-descriptionForeground); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; text-align: center; }
  .agentbridge-tab:hover { background: var(--vscode-list-hoverBackground, transparent); }
  .agentbridge-tab:focus { outline: none; }
  .agentbridge-tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder, var(--vscode-button-background)); }
  .agentbridge-session-view { display: flex; flex-direction: column; min-height: 0; flex: 1 1 0; }
  #configSection { flex: 1; min-height: 0; overflow: auto; }
  .agentbridge-session-todos-region { max-width: 950px; margin: 0 auto; width: 100%; padding: 14px 12px 0; box-sizing: border-box; }
  .agentbridge-session-scroll { flex: 1; min-height: 0; overflow: auto; }
  .agentbridge-session-timeline { max-width: 950px; margin: 0 auto; display: flex; flex-direction: column; }
  .agentbridge-session-empty { display: flex; min-height: 180px; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--vscode-descriptionForeground); }
  .agentbridge-session-empty-icon { font-size: 26px; opacity: .6; }
  .agentbridge-session-empty strong { color: var(--vscode-foreground); font-weight: 600; }
  .agentbridge-session-empty span { font-size: 12px; }
  .agentbridge-todos { border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); border-radius: 6px; background: color-mix(in srgb, var(--vscode-editorWidget-background, var(--vscode-editor-background)) 78%, transparent); margin-bottom: 10px; }
  .agentbridge-todos-summary { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; align-items: center; gap: 7px; min-height: 30px; padding: 4px 8px; border-radius: 6px; cursor: pointer; list-style: none; font-size: 12px; }
  .agentbridge-todos-summary::-webkit-details-marker { display: none; }
  .agentbridge-todos-summary:hover { background: var(--vscode-list-hoverBackground); }
  .agentbridge-todos-count { font-size: 11px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
  .agentbridge-todos-body { display: flex; flex-direction: column; gap: 1px; padding: 2px 8px 8px 33px; }
  .agentbridge-todo { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; align-items: center; gap: 7px; min-height: 26px; padding: 2px 5px; border-radius: 4px; font-size: 12px; }
  .agentbridge-todo.in-progress { background: color-mix(in srgb, var(--vscode-list-activeSelectionBackground) 35%, transparent); }
  .agentbridge-todo.completed .agentbridge-todo-title { text-decoration: line-through; color: var(--vscode-descriptionForeground); }
  .agentbridge-todo-icon { display: inline-flex; align-items: center; justify-content: center; color: var(--vscode-descriptionForeground); }
  .agentbridge-todo.completed .agentbridge-todo-icon { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
  .agentbridge-todo.in-progress .agentbridge-todo-icon { color: var(--vscode-progressBar-background); }
  .agentbridge-todo-progress { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .agentbridge-todo-progress .phase { font-weight: 600; }
  .agentbridge-todo-progress .percent { font-variant-numeric: tabular-nums; }
  .agentbridge-todo.in-progress .agentbridge-todo-progress .phase, .agentbridge-todo.in-progress .agentbridge-todo-progress .percent { color: var(--vscode-foreground); }
  .agentbridge-progress-row { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; align-items: center; gap: 7px; min-height: 28px; padding: 4px 8px; border: 1px solid transparent; border-radius: 4px; font-size: 12px; margin-bottom: 1px; }
  .agentbridge-progress-row:hover { background: var(--vscode-list-hoverBackground); }
  .agentbridge-progress-row .agentbridge-progress-icon { color: var(--vscode-progressBar-background); }
  .agentbridge-progress-body { display: flex; min-width: 0; flex-direction: column; gap: 1px; }
  .agentbridge-progress-task { display: flex; min-width: 0; align-items: baseline; gap: 6px; overflow: hidden; }
  .agentbridge-progress-task .task { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .agentbridge-progress-task .phase { font-weight: 600; white-space: nowrap; }
  .agentbridge-progress-task .message { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .agentbridge-progress-percent { font-size: 11px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
  .agentbridge-tool-card { margin-bottom: 1px; border: 1px solid transparent; border-radius: 5px; }
  .agentbridge-tool-card[open] { border-color: var(--vscode-widget-border, var(--vscode-editorWidget-border)); background: color-mix(in srgb, var(--vscode-editorWidget-background, var(--vscode-editor-background)) 78%, transparent); }
  .agentbridge-tool-card.state-error { border-color: color-mix(in srgb, var(--vscode-errorForeground) 38%, transparent); }
  .agentbridge-tool-summary { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; align-items: center; gap: 7px; min-height: 28px; padding: 4px 6px; border-radius: 4px; cursor: pointer; list-style: none; font-size: 12px; }
  .agentbridge-tool-summary::-webkit-details-marker { display: none; }
  .agentbridge-tool-summary:hover { background: var(--vscode-list-hoverBackground); }
  .agentbridge-tool-card:not([open]) > .agentbridge-tool-body { display: none; }
  .agentbridge-tool-icon { display: inline-flex; align-items: center; justify-content: center; color: var(--vscode-descriptionForeground); }
  .agentbridge-tool-card.state-running .agentbridge-tool-icon { color: var(--vscode-progressBar-background); }
  .agentbridge-tool-card.state-error .agentbridge-tool-icon, .agentbridge-tool-card.state-error .agentbridge-tool-meta { color: var(--vscode-errorForeground); }
  .agentbridge-tool-labels { display: flex; min-width: 0; flex-direction: column; gap: 1px; }
  .agentbridge-tool-title, .agentbridge-tool-subtitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .agentbridge-tool-title { color: var(--vscode-foreground); }
  .agentbridge-tool-subtitle, .agentbridge-tool-meta { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .agentbridge-tool-meta { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .agentbridge-tool-body { display: flex; flex-direction: column; gap: 8px; padding: 3px 8px 10px 31px; }
  .agentbridge-tool-items, .agentbridge-tool-files { display: flex; flex-direction: column; gap: 2px; }
  .agentbridge-tool-item, .agentbridge-tool-file { display: flex; min-width: 0; align-items: center; gap: 6px; min-height: 25px; padding: 2px 5px; border-radius: 4px; font-size: 12px; }
  .agentbridge-tool-item { cursor: pointer; }
  .agentbridge-tool-item:hover, .agentbridge-tool-item:focus-visible { outline: none; background: var(--vscode-list-hoverBackground); }
  .agentbridge-tool-item-icon { flex: none; color: var(--vscode-descriptionForeground); }
  .agentbridge-tool-item.severity-error .agentbridge-tool-item-icon { color: var(--vscode-errorForeground); }
  .agentbridge-tool-item.severity-warning .agentbridge-tool-item-icon { color: var(--vscode-editorWarning-foreground); }
  .agentbridge-tool-item-labels { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 1px; }
  .agentbridge-tool-item-primary, .agentbridge-tool-item-secondary { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .agentbridge-tool-item-primary { color: var(--vscode-foreground); }
  .agentbridge-tool-item-secondary { font-size: 10px; color: var(--vscode-descriptionForeground); }
  .agentbridge-tool-item-action { display: inline-flex; flex: none; width: 25px; height: 24px; align-items: center; justify-content: center; border: 0; border-radius: 3px; background: transparent; color: var(--vscode-descriptionForeground); cursor: pointer; font: inherit; font-size: 11px; }
  .agentbridge-tool-item-action:hover { background: var(--vscode-button-secondaryHoverBackground); color: var(--vscode-button-secondaryForeground); }
  .agentbridge-tool-actions { display: flex; align-items: center; gap: 6px; margin-top: 2px; }
  .agentbridge-tool-action { display: inline-flex; flex: none; align-items: center; justify-content: center; gap: 5px; height: 24px; padding: 0 7px; border: 1px solid var(--vscode-button-secondaryBorder, transparent); border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; font-family: inherit; font-size: 11px; }
  .agentbridge-tool-action:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .agentbridge-tool-card.kind-edit .agentbridge-tool-summary { grid-template-rows: auto auto; }
  .agentbridge-edit-summary-files { display: flex; min-width: 0; grid-column: 2 / 4; flex-direction: column; gap: 1px; margin-top: 3px; }
  .agentbridge-edit-summary-file { display: grid; min-width: 0; grid-template-columns: 16px minmax(0, 1fr) auto; align-items: center; gap: 6px; height: 24px; padding: 0 5px; border: 0; border-radius: 3px; background: transparent; color: var(--vscode-foreground); cursor: pointer; font: inherit; font-size: 11px; text-align: left; }
  .agentbridge-edit-summary-file:hover, .agentbridge-edit-summary-file:focus-visible { outline: none; background: var(--vscode-list-hoverBackground); }
  .agentbridge-edit-summary-file-icon { color: var(--vscode-descriptionForeground); }
  .agentbridge-edit-summary-file-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .agentbridge-edit-summary-file-stats { display: inline-flex; gap: 5px; white-space: nowrap; font-family: var(--monaco-monospace-font); font-size: 10px; }
  .agentbridge-edit-summary-file-stats .additions { color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-testing-iconPassed)); }
  .agentbridge-edit-summary-file-stats .deletions { color: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-errorForeground)); }
  .agentbridge-edit-summary-more { padding: 2px 5px 1px 22px; font-size: 10px; color: var(--vscode-descriptionForeground); }
  .agentbridge-mini-diff { display: flex; min-width: 0; flex-direction: column; gap: 8px; }
  .agentbridge-mini-diff-file { min-width: 0; overflow: hidden; border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); border-radius: 5px; background: var(--vscode-textCodeBlock-background); }
  .agentbridge-mini-diff-header { display: flex; min-width: 0; align-items: center; gap: 4px; min-height: 28px; padding: 0 4px 0 6px; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); background: color-mix(in srgb, var(--vscode-editorWidget-background) 72%, transparent); }
  .agentbridge-mini-diff-file-button { display: inline-flex; min-width: 0; flex: 1; align-items: center; gap: 6px; height: 24px; padding: 0 4px; border: 0; border-radius: 3px; background: transparent; color: var(--vscode-foreground); cursor: pointer; font: inherit; justify-content: flex-start; }
  .agentbridge-mini-diff-open { display: inline-flex; min-width: 0; flex: none; width: 24px; align-items: center; justify-content: center; gap: 6px; height: 24px; padding: 0 4px; border: 0; border-radius: 3px; background: transparent; color: var(--vscode-descriptionForeground); cursor: pointer; font: inherit; }
  .agentbridge-mini-diff-file-button:hover, .agentbridge-mini-diff-open:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
  .agentbridge-mini-diff-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
  .agentbridge-mini-diff-code { min-width: 0; font-family: var(--monaco-monospace-font); font-size: 11px; line-height: 18px; }
  .agentbridge-mini-diff-line { display: grid; min-width: 0; grid-template-columns: 36px 14px minmax(0, 1fr); min-height: 18px; }
  .agentbridge-mini-diff-line.add { background: var(--vscode-diffEditor-insertedLineBackground, color-mix(in srgb, var(--vscode-testing-iconPassed) 12%, transparent)); }
  .agentbridge-mini-diff-line.delete { background: var(--vscode-diffEditor-removedLineBackground, color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent)); }
  .agentbridge-mini-diff-line-number { padding-right: 7px; border-right: 1px solid color-mix(in srgb, var(--vscode-widget-border) 65%, transparent); color: var(--vscode-editorLineNumber-foreground); text-align: right; user-select: none; }
  .agentbridge-mini-diff-marker { color: var(--vscode-descriptionForeground); text-align: center; user-select: none; }
  .agentbridge-mini-diff-line.add .agentbridge-mini-diff-marker { color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-testing-iconPassed)); }
  .agentbridge-mini-diff-line.delete .agentbridge-mini-diff-marker { color: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-errorForeground)); }
  .agentbridge-mini-diff-text { min-width: 0; overflow: hidden; padding: 0 7px 0 2px; color: var(--vscode-editor-foreground); text-overflow: ellipsis; white-space: pre; }
  .agentbridge-mini-diff-gap, .agentbridge-mini-diff-truncated { padding: 2px 8px 2px 50px; font-size: 10px; color: var(--vscode-descriptionForeground); }
  .agentbridge-tool-file > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .agentbridge-tool-more { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 1px 5px; }
  .agentbridge-tool-section { min-width: 0; }
  .agentbridge-tool-section-label { display: block; margin: 0 0 4px; font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); }
  .agentbridge-tool-section pre { box-sizing: border-box; max-height: 260px; margin: 0; padding: 7px 9px; overflow: auto; border-radius: 4px; background: var(--vscode-textCodeBlock-background); color: var(--vscode-textPreformat-foreground); font-family: var(--monaco-monospace-font); font-size: 11px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
  .agentbridge-tool-error { font-size: 12px; color: var(--vscode-errorForeground); white-space: pre-wrap; }
  .agentbridge-session-footer { flex: none; box-sizing: border-box; padding: 10px 12px 11px; border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
  .agentbridge-session-connection-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .agentbridge-session-connection-actions { display: flex; flex: none; align-items: center; gap: 5px; }
  .agentbridge-session-connection-info { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
  .agentbridge-session-connection-heading { display: flex; align-items: center; gap: 7px; font-size: 12px; }
  .agentbridge-session-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
  .agentbridge-session-dot.state-connected, .agentbridge-session-dot.state-running { background: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
  .agentbridge-session-dot.state-starting { background: var(--vscode-progressBar-background); }
  .agentbridge-session-dot.state-error { background: var(--vscode-errorForeground); }
  .agentbridge-session-connection-description, .agentbridge-session-meta, .agentbridge-session-hint { font-size: 11px; line-height: 1.4; color: var(--vscode-descriptionForeground); }
  .agentbridge-session-stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; margin-top: 10px; }
  .agentbridge-session-stat { display: flex; min-width: 0; flex-direction: column; gap: 3px; padding: 7px 9px; border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); border-radius: 4px; }
  .agentbridge-session-stat span { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .agentbridge-session-stat strong { font-size: 13px; font-weight: 500; font-variant-numeric: tabular-nums; }
  .agentbridge-session-meta { margin-top: 8px; }
  .agentbridge-session-hint { margin-top: 5px; }
  .agentbridge-session-list { margin-top: 8px; padding: 7px; border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); border-radius: 4px; font-size: 11px; max-height: 120px; overflow-y: auto; }
  .agentbridge-session-list-header { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 5px; }
  .agentbridge-session-list-row { display: flex; align-items: center; gap: 6px; padding: 3px 0; }
  .agentbridge-session-list-info { flex: 1 1 auto; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .agentbridge-session-list-disconnect { flex: 0 0 auto; padding: 1px 7px; font-size: 10px; }
  .agentbridge-session-badge { display: inline-block; flex: 0 0 auto; padding: 1px 5px; border: 1px solid; border-radius: 3px; font-size: 10px; font-family: var(--vscode-editor-font-family, Menlo, Consolas, monospace); font-variant-numeric: tabular-nums; line-height: 1; vertical-align: middle; }
  .agentbridge-tool-labels .agentbridge-session-badge { margin-left: 6px; }
  .agentbridge-session-view.footer-collapsed .agentbridge-session-footer { padding-top: 7px; padding-bottom: 7px; }
  .agentbridge-session-view.footer-collapsed .agentbridge-session-connection-info { gap: 1px; }
  .agentbridge-session-view.footer-collapsed .agentbridge-session-connection-description { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  @media (max-width: 340px) {
    .agentbridge-session-connection-description { display: none; }
    .agentbridge-session-stats { grid-template-columns: 1fr; }
  }
  .agentbridge-spin { display: inline-block; animation: agentbridge-spin 1s linear infinite; }
  @keyframes agentbridge-spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div class="agentbridge-tabs" id="agentbridgeTabs" role="tablist">
    <button class="agentbridge-tab active" id="tabConfig" role="tab" aria-selected="true" tabindex="0" type="button">配置</button>
    <button class="agentbridge-tab" id="tabSession" role="tab" aria-selected="false" tabindex="-1" type="button">会话</button>
  </div>
  <div id="configSection">
  <div class="agentbridge-card agentbridge-hero">
    <div class="agentbridge-card-header">
      <h2>AgentBridge</h2>
      <span class="agentbridge-state state-stopped" id="stateBadge">…</span>
    </div>
    <p class="agentbridge-hero-description">把当前工作区的工具开放为远程 Streamable HTTP MCP 端点，供 ChatGPT 等远程 MCP 客户端连接。</p>
    <div class="agentbridge-status-details" id="stateDetails">正在检查 Bridge 状态…</div>
    <div class="agentbridge-open-folder-group" id="openFolderGroup" style="display:none">
      <p class="agentbridge-open-folder-hint">Bridge 需要一个工作区文件夹作为外部工具的根目录。</p>
      <button class="secondary" id="openFolderButton" type="button">选择文件夹…</button>
    </div>
    <div class="agentbridge-url-section" id="publicUrlSection" style="display:none">
      <div class="agentbridge-url-label">MCP 地址</div>
      <div class="agentbridge-url-row">
        <input class="agentbridge-url-value" id="publicUrlValue" type="text" readonly spellcheck="false">
        <button class="agentbridge-copy-url" id="copyUrlButton" title="复制 MCP 地址">复制</button>
      </div>
    </div>
    <div class="agentbridge-address-notice" id="addressNotice" style="display:none"></div>
    <div class="agentbridge-controls agentbridge-hero-actions">
      <button class="primary" id="startStopButton">启动 Bridge</button>
      <button class="secondary" id="openChatGptButton">打开 ChatGPT</button>
      <button class="secondary" id="openArenaButton">打开 Arena</button>
      <button class="secondary" id="copyPromptButton">复制连接提示</button>
    </div>
    <div class="agentbridge-security-note">
      <span>⚠</span><span>Bridge 可以编辑文件并执行终端命令。请勿泄露 MCP 地址。</span>
    </div>
  </div>

  <details class="agentbridge-card agentbridge-connection-card" id="connectionCard">
    <summary>
      <div class="agentbridge-connection-summary-main">
        <h3>连接设置</h3>
        <div class="agentbridge-connection-details" id="connectionDetails">正在检查隧道设置…</div>
      </div>
      <span class="agentbridge-state state-stopped" id="connectionBadge">检查中</span>
    </summary>
    <div class="agentbridge-connection-body">
      <div class="agentbridge-field">
        <label class="agentbridge-label">隧道模式</label>
        <div class="agentbridge-provider-choices" role="radiogroup">
          <button class="agentbridge-provider-choice" data-provider="cloudflare" role="radio" id="quickProvider" type="button">
            <div class="agentbridge-provider-header">
              <span class="agentbridge-provider-title">Cloudflare Quick Tunnel（免账号免域名）</span>
              <span class="agentbridge-provider-badge">默认 · 零配置</span>
            </div>
            <div class="agentbridge-provider-summary">每次启动 Bridge 都会生成新的临时地址。适合优先简单、不要求固定地址的场景。</div>
            <ul class="agentbridge-provider-facts">
              <li>地址：临时；重启后变化</li>
              <li>限制：无月度请求配额上限；200 并发请求；无 SLA</li>
              <li>配置：只需安装 cloudflared；无需账号或域名</li>
            </ul>
          </button>
          <button class="agentbridge-provider-choice" data-provider="cloudflare-named" role="radio" id="namedProvider" type="button">
            <div class="agentbridge-provider-header">
              <span class="agentbridge-provider-title">Cloudflare Named Tunnel（固定地址）</span>
              <span class="agentbridge-provider-badge">固定地址</span>
            </div>
            <div class="agentbridge-provider-summary">使用 Cloudflare 托管的固定域名，重启后保持不变。</div>
            <ul class="agentbridge-provider-facts">
              <li>地址：Cloudflare 托管域名上的固定主机名</li>
              <li>限制：无 ngrok 式每月 2 万请求配额</li>
              <li>配置：Cloudflare 账号、域名、Tunnel Token 与已发布的应用路由</li>
            </ul>
          </button>
          <button class="agentbridge-provider-choice" data-provider="ngrok" role="radio" id="ngrokProvider" type="button">
            <div class="agentbridge-provider-header">
              <span class="agentbridge-provider-title">ngrok 开发域名（固定地址）</span>
              <span class="agentbridge-provider-badge">固定地址</span>
            </div>
            <div class="agentbridge-provider-summary">使用账号分配的保留域名，重启后可以复用，MCP 地址通常保持不变。</div>
            <ul class="agentbridge-provider-facts">
              <li>地址：固定；重启后可复用</li>
              <li>限制：免费版每月 2 万 HTTP/S 请求、1 GB 出站流量</li>
              <li>配置：ngrok 账号、Authtoken 与分配的开发域名</li>
            </ul>
          </button>
        </div>
        <div class="agentbridge-help">切换隧道模式前请先停止 Bridge。</div>
      </div>

      <div class="agentbridge-field" id="domainField">
        <label class="agentbridge-label">ngrok 域名</label>
        <input class="agentbridge-input" id="domainInput" type="text" placeholder="your-name.ngrok-free.dev" spellcheck="false">
        <div class="agentbridge-help">填写 ngrok 控制台分配的保留域名。</div>
      </div>

      <div class="agentbridge-named-configuration" id="namedConfiguration" style="display:none">
        <h4>Cloudflare Named Tunnel 配置</h4>
        <div class="agentbridge-named-grid">
          <div class="agentbridge-field">
            <label class="agentbridge-label">公网主机名</label>
            <input class="agentbridge-input" id="namedDomainInput" type="text" placeholder="mcp.example.com" spellcheck="false">
          </div>
          <div class="agentbridge-field">
            <label class="agentbridge-label">Tunnel Token</label>
            <input class="agentbridge-input" id="namedTokenInput" type="password" placeholder="粘贴 Token 以设置或替换" spellcheck="false" autocomplete="off">
            <div class="agentbridge-help" id="namedTokenStatus"></div>
          </div>
          <div class="agentbridge-field">
            <label class="agentbridge-label">固定本地端口</label>
            <input class="agentbridge-input" id="namedPortInput" type="number" min="1024" max="65535" step="1">
          </div>
          <div class="agentbridge-field">
            <label class="agentbridge-label">Cloudflare Service URL</label>
            <div class="agentbridge-named-origin-row">
              <input class="agentbridge-input" id="namedOriginValue" type="text" readonly>
              <button class="agentbridge-copy-url" id="copyOriginButton">复制</button>
            </div>
          </div>
        </div>
        <div class="agentbridge-help">在 Cloudflare Tunnels 中，发布的应用主机名必须与上面的公网主机名一致，Service URL 必须与此本地地址完全一致。</div>
        <div class="agentbridge-controls">
          <button class="primary" id="saveNamedTunnelButton">保存 Named Tunnel</button>
          <button class="secondary" id="clearNamedTunnelTokenButton">清除 Token</button>
        </div>
      </div>

      <div class="agentbridge-tunnel-panel" id="tunnelSetupPanel">
        <div class="agentbridge-tunnel-status-row">
          <div class="agentbridge-tunnel-status-text">
            <div class="agentbridge-label">隧道状态</div>
            <div class="agentbridge-tunnel-state" id="tunnelState">尚未检查隧道客户端。</div>
          </div>
          <div class="agentbridge-controls agentbridge-tunnel-actions">
            <button class="secondary" id="checkButton">检查隧道</button>
            <button class="primary" id="installCloudflaredButton" style="display:none">安装 cloudflared</button>
          </div>
        </div>
        <details class="agentbridge-setup" id="cloudflareSetup">
          <summary>安装 cloudflared</summary>
          <div class="agentbridge-setup-body">
            <p>一次性安装 cloudflared。Quick Tunnel 不需要 Cloudflare 账号、Token 或域名。</p>
            <div class="agentbridge-setup-step">
              <h4>1. 安装或更新 cloudflared</h4>
              <div class="agentbridge-command-row"><code>winget install --id Cloudflare.cloudflared --exact --accept-package-agreements --accept-source-agreements</code><button class="secondary" data-copy="winget install --id Cloudflare.cloudflared --exact --accept-package-agreements --accept-source-agreements">复制</button></div>
              <div class="agentbridge-command-row"><code>winget upgrade --id Cloudflare.cloudflared --exact --accept-package-agreements --accept-source-agreements</code><button class="secondary" data-copy="winget upgrade --id Cloudflare.cloudflared --exact --accept-package-agreements --accept-source-agreements">复制</button></div>
            </div>
            <div class="agentbridge-setup-step">
              <h4>2. 验证 cloudflared</h4>
              <div class="agentbridge-command-row"><code>cloudflared --version</code><button class="secondary" data-copy="cloudflared --version">复制</button></div>
            </div>
            <p class="agentbridge-help">每次启动都会生成新的临时 MCP 地址，请在 ChatGPT 中更新地址。</p>
          </div>
        </details>
        <details class="agentbridge-setup" id="cloudflareNamedSetup" style="display:none">
          <summary>配置 Cloudflare Named Tunnel</summary>
          <div class="agentbridge-setup-body">
            <p>创建远程托管的 Cloudflare Tunnel，复制其 Token，并将主机名发布到上面显示的固定 Service URL。</p>
            <div class="agentbridge-setup-step">
              <h4>1. 安装或更新 cloudflared</h4>
              <div class="agentbridge-command-row"><code>winget install --id Cloudflare.cloudflared --exact --accept-package-agreements --accept-source-agreements</code><button class="secondary" data-copy="winget install --id Cloudflare.cloudflared --exact --accept-package-agreements --accept-source-agreements">复制</button></div>
            </div>
            <div class="agentbridge-setup-step">
              <h4>2. 创建或打开 Cloudflare Tunnel 并复制 Token</h4>
              <button class="secondary" data-open="https://dash.cloudflare.com/?to=%2F%3Aaccount%2Ftunnels">打开 Cloudflare Tunnels</button>
            </div>
            <div class="agentbridge-setup-step">
              <h4>3. 添加发布的应用路由</h4>
              <p class="agentbridge-help">将公网主机名设为上面保存的值，Service URL 设为 ShunCode 显示的 http://127.0.0.1:&lt;port&gt;。</p>
            </div>
            <div class="agentbridge-setup-step">
              <h4>4. 检查主机名 DNS 记录</h4>
              <button class="secondary" data-open="https://dash.cloudflare.com/?to=%2F%3Aaccount%2F%3Azone%2Fdns%2Frecords">打开 Cloudflare DNS</button>
            </div>
          </div>
        </details>
        <details class="agentbridge-setup" id="ngrokSetup" style="display:none">
          <summary>配置 ngrok</summary>
          <div class="agentbridge-setup-body">
            <p>在 Windows PowerShell 中一次性执行以下步骤。安装完成后重启 VS Code，使 ngrok 对扩展主机可用。</p>
            <div class="agentbridge-setup-step">
              <h4>1. 安装或更新 ngrok</h4>
              <div class="agentbridge-command-row"><code>winget install --id 9MVS1J51GMK6 --source msstore --accept-package-agreements --accept-source-agreements</code><button class="secondary" data-copy="winget install --id 9MVS1J51GMK6 --source msstore --accept-package-agreements --accept-source-agreements">复制</button></div>
              <div class="agentbridge-command-row"><code>winget upgrade --id 9MVS1J51GMK6 --source msstore --accept-package-agreements --accept-source-agreements</code><button class="secondary" data-copy="winget upgrade --id 9MVS1J51GMK6 --source msstore --accept-package-agreements --accept-source-agreements">复制</button></div>
            </div>
            <div class="agentbridge-setup-step">
              <h4>2. 添加 ngrok Authtoken</h4>
              <div class="agentbridge-command-row"><code>ngrok config add-authtoken &lt;YOUR_AUTHTOKEN&gt;</code><button class="secondary" data-copy="ngrok config add-authtoken <YOUR_AUTHTOKEN>">复制</button></div>
            </div>
            <div class="agentbridge-setup-step">
              <h4>3. 验证安装与配置</h4>
              <div class="agentbridge-command-row"><code>ngrok version; ngrok config check</code><button class="secondary" data-copy="ngrok version; ngrok config check">复制</button></div>
            </div>
            <div class="agentbridge-setup-step">
              <h4>4. 选择免费保留域名</h4>
              <button class="secondary" data-open="https://dashboard.ngrok.com/domains">打开 Domains 页面</button>
            </div>
          </div>
        </details>
      </div>

      <div class="agentbridge-persistent-row">
        <div class="agentbridge-persistent-text">
          <label class="agentbridge-label">随 VS Code 启动 Bridge</label>
          <div class="agentbridge-help">应用就绪后自动打开并启动 Bridge。</div>
        </div>
        <button class="agentbridge-switch" id="persistentModeToggle" role="switch" type="button">
          <span class="agentbridge-switch-track"></span>
        </button>
      </div>
    </div>
  </details>

  <details class="agentbridge-card agentbridge-advanced-card" id="advancedCard">
    <summary><h3>高级设置</h3></summary>
    <div class="agentbridge-advanced-body">
      <div class="agentbridge-static-row">
        <div class="agentbridge-label">传输协议</div>
        <div class="agentbridge-static-value">Streamable HTTP</div>
      </div>
      <div class="agentbridge-advanced-section">
        <h4>安全与访问</h4>
        <p class="agentbridge-help">若 MCP 地址泄露，可重置密钥路径。所有使用旧地址的客户端将立即失效。</p>
        <div class="agentbridge-controls">
          <button class="secondary" id="rotateButton">重置 MCP 地址</button>
        </div>
      </div>
      <div class="agentbridge-advanced-section">
        <h4>已开放的工具</h4>
        <div class="agentbridge-tools" id="toolsContainer"></div>
      </div>
      <div class="agentbridge-advanced-section">
        <h4>管理 Shell</h4>
        <p class="agentbridge-help">AgentBridge 会以该 shell 启动每个 PTY 槽位。留空则使用默认（Windows PowerShell 5.1 / /bin/bash）。改后仅新 MCP 会话与新建终端生效；如需立即套用到所有会话，请 Stop + Start Bridge。</p>
        <div class="agentbridge-static-row">
          <div class="agentbridge-label">当前</div>
          <div class="agentbridge-static-value" id="managedShellCurrentLabel">（读取中…）</div>
        </div>
        <div class="agentbridge-controls" style="display:flex; flex-direction:column; gap:8px; margin-top:8px;">
          <input id="managedShellInput" type="text" placeholder="留空 = 默认 · 或输入绝对路径 (如 C:\\Program Files\\PowerShell\\7\\pwsh.exe)" style="width:100%; box-sizing:border-box; padding:6px 8px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent)); border-radius:2px;" />
          <div style="display:flex; gap:8px;">
            <button class="secondary" id="managedShellSaveButton">保存</button>
            <button class="secondary" id="managedShellResetButton">重置为默认</button>
          </div>
          <div id="managedShellWarning" style="color:var(--vscode-errorForeground); display:none; font-size:11px; line-height:1.4;"></div>
        </div>
      </div>
      <div class="agentbridge-advanced-section">
        <h4>打开方式</h4>
        <p class="agentbridge-help">默认「智能」:ChatGPT / Arena 在 VS Code 内置 Simple Browser 中打开，其他外链仍跳 OS 默认浏览器（与原 ShunCode 行为一致）。「全部内嵌」连 Cloudflare / ngrok 等第三方 OAuth dashboard 也强制嵌 Simple Browser，但 iframe X-Frame-Options 限制可能导致登录卡住。「全部外跳」恢复当前 agentbridge 早期所有链接走 OS 浏览器的行为。</p>
        <div class="agentbridge-controls" style="display:flex; gap:8px; flex-wrap:wrap; margin-top:4px;">
          <button class="secondary agentbridge-oib-radio" id="openInternalBrowserAuto" role="radio" aria-checked="true">智能</button>
          <button class="secondary agentbridge-oib-radio" id="openInternalBrowserAll" role="radio" aria-checked="false">全部内嵌</button>
          <button class="secondary agentbridge-oib-radio" id="openInternalBrowserExternal" role="radio" aria-checked="false">全部外跳</button>
        </div>
      </div>
    </div>
  </details>
  </div>

  <div class="agentbridge-session-view" id="sessionSection" style="display:none">
    <div class="agentbridge-session-todos-region" id="todosRegion"></div>
    <div class="agentbridge-session-scroll">
      <div class="agentbridge-session-timeline" id="timeline"></div>
    </div>
    <div class="agentbridge-session-footer">
      <div class="agentbridge-session-connection-row">
        <div class="agentbridge-session-connection-info">
          <div class="agentbridge-session-connection-heading">
            <span class="agentbridge-session-dot" id="connectionDot"></span>
            <strong id="connectionTitle">AgentBridge</strong>
          </div>
          <span class="agentbridge-session-connection-description" id="connectionDescription">启动 Bridge 以监控远程活动。</span>
        </div>
        <div class="agentbridge-session-connection-actions">
          <button class="primary" id="sessionStartStopButton">连接</button>
          <button class="secondary" id="sessionCollapseButton" title="折叠">▾</button>
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
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let lastStatus = null;
  let busy = false;
  let installingCloudflared = false;
  let domainInputDirty = false;
  let namedTunnelInputDirty = false;
  let lastRevision = -1;
  let todoExpanded = false;
  let footerCollapsed = false;
  const expandedToolActivities = new Set();
  const sessionScroll = $('sessionSection').querySelector('.agentbridge-session-scroll');
  const timelineEl = $('timeline');

  function formatDuration(durationMs) {
    if (durationMs == null) return '';
    if (durationMs < 1000) return (Math.round(durationMs / 100) / 10) + 's';
    const s = Math.round(durationMs / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  function formatTime(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function activityIconChar(activity) {
    if (activity.status === 'error') return '✕';
    if (activity.status === 'running') return '◌';
    switch (activity.presentation && activity.presentation.kind) {
      case 'files': return '🗎';
      case 'search': return '⌕';
      case 'edit': return '✎';
      case 'terminal': return '⌨';
      case 'diagnostics': return '⚠';
      case 'lsp': return 'ƒ';
      default: return '⚙';
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function isNearBottom() {
    return sessionScroll.scrollHeight - sessionScroll.scrollTop - sessionScroll.clientHeight < 72;
  }

  function openResource(item) {
    vscode.postMessage({ type: 'openResource', value: { path: item.path, line: item.line, column: item.column, folder: item.folder } });
  }

  function renderTodos(todos) {
    const region = $('todosRegion');
    region.textContent = '';
    if (!todos || todos.length === 0) return;
    const details = el('details', 'agentbridge-todos');
    details.open = todoExpanded;
    const summary = el('summary', 'agentbridge-todos-summary');
    summary.appendChild(el('span', 'agentbridge-todo-icon', '☑'));
    summary.appendChild(el('strong', null, '任务'));
    const count = todos.filter((t) => t.status === 'completed').length;
    summary.appendChild(el('span', 'agentbridge-todos-count', count + ' / ' + todos.length));
    details.appendChild(summary);
    const body = el('div', 'agentbridge-todos-body');
    for (const todo of todos) {
      const row = el('div', 'agentbridge-todo ' + todo.status);
      row.appendChild(el('span', 'agentbridge-todo-icon', todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◌' : '○'));
      row.appendChild(el('span', 'agentbridge-todo-title', todo.title));
      if (todo.status === 'in_progress') {
        const progress = el('span', 'agentbridge-todo-progress');
        if (todo.phase) progress.appendChild(el('span', 'phase', todo.phase));
        if (todo.message) progress.appendChild(el('span', 'message', todo.message));
        if (todo.percent != null) progress.appendChild(el('span', 'percent', Math.round(todo.percent) + '%'));
        row.appendChild(progress);
      }
      body.appendChild(row);
    }
    details.appendChild(body);
    region.appendChild(details);
  }

  function renderProgress(activity) {
    const row = el('div', 'agentbridge-progress-row');
    row.appendChild(el('span', 'agentbridge-progress-icon agentbridge-spin', '◌'));
    const body = el('div', 'agentbridge-progress-body');
    const task = el('div', 'agentbridge-progress-task');
    if (activity.todoTitle) task.appendChild(el('span', 'task', activity.todoTitle));
    if (activity.phase) task.appendChild(el('span', 'phase', activity.phase));
    if (activity.message) task.appendChild(el('span', 'message', activity.message));
    body.appendChild(task);
    row.appendChild(body);
    if (activity.percent != null) row.appendChild(el('span', 'agentbridge-progress-percent', Math.round(activity.percent) + '%'));
    return row;
  }

  function renderCodeSection(label, text) {
    const section = el('div', 'agentbridge-tool-section');
    section.appendChild(el('label', 'agentbridge-tool-section-label', label));
    const pre = el('pre', null);
    pre.textContent = text || '';
    section.appendChild(pre);
    return section;
  }

  function renderToolItems(activity, container) {
    const items = activity.presentation.items || [];
    const shown = items.slice(0, 40);
    for (const item of shown) {
      const row = el('div', 'agentbridge-tool-item' + (item.severity ? ' severity-' + item.severity : ''));
      const iconChar = item.kind === 'folder' ? '▸' : item.kind === 'search' ? '⌕' : item.kind === 'diagnostic' ? '⚠' : item.kind === 'symbol' ? 'ƒ' : '🗎';
      row.appendChild(el('span', 'agentbridge-tool-item-icon', iconChar));
      const labels = el('div', 'agentbridge-tool-item-labels');
      labels.appendChild(el('span', 'agentbridge-tool-item-primary', item.label || item.path || ''));
      const secondary = [];
      if (item.line != null) secondary.push((item.line != null ? 'L' + item.line : '') + (item.column != null ? ':' + item.column : ''));
      if (item.description) secondary.push(item.description);
      if (item.additions != null || item.deletions != null) {
        const stats = el('span', null);
        if (item.additions) stats.appendChild(el('span', 'additions', '+' + item.additions));
        if (item.deletions) stats.appendChild(el('span', 'deletions', '-' + item.deletions));
        labels.appendChild(stats);
      }
      if (secondary.length) labels.appendChild(el('span', 'agentbridge-tool-item-secondary', secondary.join(' · ')));
      row.appendChild(labels);
      row.addEventListener('click', () => openResource(item));
      container.appendChild(row);
    }
    if (items.length > 40) container.appendChild(el('div', 'agentbridge-tool-more', '+ ' + (items.length - 40) + ' more'));
  }

  function renderMiniDiff(diffPreview, container) {
    if (!diffPreview) return;
    const mini = el('div', 'agentbridge-mini-diff');
    for (const file of diffPreview) {
      const fileCard = el('div', 'agentbridge-mini-diff-file');
      const header = el('div', 'agentbridge-mini-diff-header');
      const fileButton = el('button', 'agentbridge-mini-diff-file-button');
      fileButton.appendChild(el('span', null, '🗎'));
      fileButton.appendChild(el('span', 'agentbridge-mini-diff-path', file.path || ''));
      fileButton.addEventListener('click', () => openResource({ path: file.path, line: 1 }));
      header.appendChild(fileButton);
      const openButton = el('button', 'agentbridge-mini-diff-open', '⇄');
      openButton.title = '打开完整 diff';
      openButton.addEventListener('click', () => vscode.postMessage({ type: 'openDiff', value: { diff: file.diff, path: file.path } }));
      header.appendChild(openButton);
      fileCard.appendChild(header);
      const code = el('div', 'agentbridge-mini-diff-code');
      const hunks = (file.diff || '').split('\\n');
      for (const line of hunks) {
        let cls = 'context';
        let marker = '';
        let text = line;
        if (line.startsWith('+')) { cls = 'add'; marker = '+'; }
        else if (line.startsWith('-')) { cls = 'delete'; marker = '-'; }
        else if (line.startsWith('@@')) { cls = 'context'; marker = '@@'; text = line.slice(2).trim(); }
        const row = el('div', 'agentbridge-mini-diff-line ' + cls);
        row.appendChild(el('span', 'agentbridge-mini-diff-line-number', ''));
        row.appendChild(el('span', 'agentbridge-mini-diff-marker', marker));
        row.appendChild(el('span', 'agentbridge-mini-diff-text', text));
        code.appendChild(row);
      }
      fileCard.appendChild(code);
      mini.appendChild(fileCard);
    }
    container.appendChild(mini);
  }

  function renderEditSummaryItems(activity, summary) {
    const items = activity.presentation.items || [];
    const files = items.filter((i) => i.kind === 'file');
    const shown = files.slice(0, 8);
    const wrap = el('div', 'agentbridge-edit-summary-files');
    for (const file of shown) {
      const button = el('button', 'agentbridge-edit-summary-file');
      button.appendChild(el('span', 'agentbridge-edit-summary-file-icon', '🗎'));
      button.appendChild(el('span', 'agentbridge-edit-summary-file-path', file.path || file.label || ''));
      if (file.additions != null || file.deletions != null) {
        const stats = el('span', 'agentbridge-edit-summary-file-stats');
        if (file.additions) stats.appendChild(el('span', 'additions', '+' + file.additions));
        if (file.deletions) stats.appendChild(el('span', 'deletions', '-' + file.deletions));
        button.appendChild(stats);
      }
      button.addEventListener('click', () => openResource(file));
      wrap.appendChild(button);
    }
    if (files.length > 8) wrap.appendChild(el('div', 'agentbridge-edit-summary-more', '+ ' + (files.length - 8) + ' more'));
    summary.appendChild(wrap);
  }

  function sessionShortId(sid) {
    return (sid || '').slice(0, 8).toUpperCase();
  }
  function sessionHue(sid) {
    if (!sid) return 220;
    let h = 0;
    for (let i = 0; i < Math.min(sid.length, 8); i++) h = (h * 31 + sid.charCodeAt(i)) % 360;
    return h;
  }
  function sessionBadge(sid) {
    if (!sid) return null;
    const span = el('span', 'agentbridge-session-badge');
    span.textContent = '#' + sessionShortId(sid);
    const hue = sessionHue(sid);
    span.style.color = 'hsl(' + hue + ', 70%, 45%)';
    span.style.borderColor = 'hsl(' + hue + ', 70%, 65%)';
    span.title = 'MCP session · ' + sid;
    return span;
  }

  function renderSessionList(sessions) {
    const list = $('sessionList');
    list.textContent = '';
    if (!sessions || sessions.length === 0) {
      list.style.display = 'none';
      return;
    }
    list.style.display = '';
    list.appendChild(el('div', 'agentbridge-session-list-header', '活跃 MCP 会话 · ' + sessions.length));
    for (const session of sessions) {
      const row = el('div', 'agentbridge-session-list-row');
      const badge = sessionBadge(session.sessionId);
      if (badge) row.appendChild(badge);
      const info = el('span', 'agentbridge-session-list-info');
      info.textContent = session.activeRequests + ' 个活动请求 · ' + formatTime(session.lastActivity);
      row.appendChild(info);
      const btn = el('button', 'secondary agentbridge-session-list-disconnect', '断开');
      btn.addEventListener('click', () => vscode.postMessage({ type: 'disconnectSession', sessionId: session.sessionId }));
      row.appendChild(btn);
      list.appendChild(row);
    }
  }

  function renderToolCard(activity) {
    const details = el('details', 'agentbridge-tool-card state-' + activity.status + ' kind-' + (activity.presentation && activity.presentation.kind || 'generic'));
    const isOpen = expandedToolActivities.has(activity.id);
    details.open = isOpen;
    const summary = el('summary', 'agentbridge-tool-summary');
    const icon = el('span', 'agentbridge-tool-icon' + (activity.status === 'running' ? ' agentbridge-spin' : ''));
    icon.textContent = activityIconChar(activity);
    summary.appendChild(icon);
    const labels = el('div', 'agentbridge-tool-labels');
    labels.appendChild(el('span', 'agentbridge-tool-title', activity.tool));
    const badge = sessionBadge(activity.sessionId);
    if (badge) labels.appendChild(badge);
    if (activity.presentation && activity.presentation.subtitle) {
      labels.appendChild(el('span', 'agentbridge-tool-subtitle', activity.presentation.subtitle));
    }
    summary.appendChild(labels);
    const meta = activity.status === 'running' ? '运行中' : activity.status === 'error' ? '失败' : formatDuration(activity.durationMs);
    const metaEl = el('span', 'agentbridge-tool-meta', meta);
    if (activity.status === 'running' && activity.at) {
      metaEl.dataset.liveId = String(activity.id);
      metaEl.dataset.startedAt = String(new Date(activity.at).getTime());
    }
    summary.appendChild(metaEl);
    if (activity.presentation && activity.presentation.kind === 'edit' && activity.presentation.items && activity.presentation.items.length) {
      renderEditSummaryItems(activity, summary);
    }
    details.appendChild(summary);
    const body = el('div', 'agentbridge-tool-body');
    const pres = activity.presentation || {};
    if (pres.kind !== 'edit' && pres.items && pres.items.length) renderToolItems(activity, body);
    if (pres.kind === 'edit' && pres.diffPreview) renderMiniDiff(pres.diffPreview, body);
    if (activity.terminalId) {
      const actions = el('div', 'agentbridge-tool-actions');
      const button = el('button', 'agentbridge-tool-action', '打开终端');
      button.addEventListener('click', () => vscode.postMessage({ type: 'openTerminal', terminalId: activity.terminalId }));
      actions.appendChild(button);
      body.appendChild(actions);
    }
    const showRawInput = pres.kind === 'generic' || activity.tool === 'send_command_input';
    if (showRawInput && pres.input != null) body.appendChild(renderCodeSection('输入', pres.input));
    if (pres.output != null) body.appendChild(renderCodeSection('输出', pres.output));
    if (activity.status === 'error' && activity.message && activity.message !== pres.output) {
      body.appendChild(el('div', 'agentbridge-tool-error', activity.message));
    }
    details.appendChild(body);
    details.addEventListener('toggle', () => {
      if (details.open) expandedToolActivities.add(activity.id);
      else expandedToolActivities.delete(activity.id);
    });
    return details;
  }

  function renderTimeline(activities) {
    timelineEl.textContent = '';
    if (!activities || activities.length === 0) {
      const empty = el('div', 'agentbridge-session-empty');
      empty.appendChild(el('div', 'agentbridge-session-empty-icon', '◌'));
      empty.appendChild(el('strong', null, '暂无远程活动'));
      empty.appendChild(el('span', null, '启动 Bridge 后，远程 AI 的每一次操作都会显示在这里。'));
      timelineEl.appendChild(empty);
      return;
    }
    for (const activity of activities) {
      if (activity.status === 'progress') timelineEl.appendChild(renderProgress(activity));
      else timelineEl.appendChild(renderToolCard(activity));
    }
  }

  function renderSessionStatus(status) {
    const connected = status.connected;
    const state = status.state;
    const dot = $('connectionDot');
    dot.className = 'agentbridge-session-dot state-' + (connected ? 'connected' : state);
    $('connectionTitle').textContent = 'AgentBridge' + (connected ? ' · 已连接' : '');
    const desc = $('connectionDescription');
    if (footerCollapsed) {
      const parts = [];
      parts.push(connected ? '已连接' : state === 'running' ? '等待连接' : state);
      if (status.stats && status.stats.toolCalls != null) parts.push(status.stats.toolCalls + ' 次调用');
      if (status.stats && status.stats.averageDurationMs != null) parts.push(formatDuration(status.stats.averageDurationMs) + ' 均值');
      if (status.stats && status.stats.successRate != null) parts.push(Math.round(status.stats.successRate) + '% 成功');
      desc.textContent = parts.join(' · ');
      $('footerDetails').style.display = 'none';
    } else {
      desc.textContent = connected ? '远程客户端已连接，正在监控活动…'
        : state === 'running' ? '等待远程客户端连接。'
        : state === 'error' ? (status.lastError || 'Bridge 无法启动。')
        : '启动 Bridge 以监控远程活动。';
      $('footerDetails').style.display = '';
      renderSessionList(status.sessions || []);
      const stats = $('sessionStats');
      stats.textContent = '';
      const statDefs = [
        ['工具调用', status.stats ? status.stats.toolCalls : null, ''],
        ['平均时长', status.stats ? status.stats.averageDurationMs : null, formatDuration],
        ['失败', status.stats ? status.stats.failedToolCalls : null, ''],
        ['成功率', status.stats ? status.stats.successRate : null, (v) => v == null ? '' : Math.round(v) + '%'],
      ];
      for (const [label, value, fmt] of statDefs) {
        const stat = el('div', 'agentbridge-session-stat');
        stat.appendChild(el('span', null, label));
        stat.appendChild(el('strong', null, value == null ? '—' : (typeof fmt === 'function' ? fmt(value) : value)));
        stats.appendChild(stat);
      }
      const meta = [];
      if (status.activeRequests) meta.push(status.activeRequests + ' 个活动请求');
      if (status.stats && status.stats.lastTool) meta.push('最近: ' + status.stats.lastTool);
      if (status.stats && status.stats.lastToolAt) meta.push(formatTime(status.stats.lastToolAt));
      $('footerMeta').textContent = meta.length ? '最近活动：' + meta.join(' · ') : '';
      $('footerHint').textContent = connected ? '正在监控远程活动…' : state === 'running' ? '启动会话后此处将实时更新。' : '启动 Bridge 以监控远程活动。';
    }
    const startStop = $('sessionStartStopButton');
    startStop.disabled = busy || state === 'starting';
    startStop.textContent = state === 'running' ? '停止' : state === 'starting' ? '启动中…' : '连接';
  }

  function renderSession(status) {
    if (status.revision === lastRevision && status.revision != null) {
      renderSessionStatus(status);
      return;
    }
    lastRevision = status.revision;
    const wasNearBottom = isNearBottom();
    renderTodos(status.todos);
    renderTimeline(status.activities);
    renderSessionStatus(status);
    if (sessionScroll.scrollHeight > sessionScroll.clientHeight && wasNearBottom) {
      sessionScroll.scrollTop = sessionScroll.scrollHeight;
    }
  }

  function renderStateBadge(badge, state) {
    badge.className = 'agentbridge-state state-' + state;
    badge.textContent = state === 'running' ? '运行中' : state === 'starting' ? '启动中…' : state === 'error' ? '错误' : '已停止';
  }

  function refreshStatus(status, persistentMode) {
    lastStatus = status;
    renderSession(status);
    const isNgrok = status.tunnelProvider === 'ngrok';
    const isNamed = status.tunnelProvider === 'cloudflare-named';
    const isQuick = status.tunnelProvider === 'cloudflare';

    renderStateBadge($('stateBadge'), status.state);
    $('openFolderGroup').style.display = 'none';
    if (status.state === 'running') {
      $('stateDetails').textContent = '远程端点已就绪 · ' + status.activeRequests + ' 个进行中的请求';
    } else if (status.state === 'starting') {
      $('stateDetails').textContent = isQuick ? '正在生成新的临时 Cloudflare MCP 地址…' : isNamed ? '正在连接固定 Cloudflare 主机名…' : '正在打开安全的 MCP 端点…';
    } else if (status.state === 'error') {
      $('stateDetails').textContent = status.lastError || 'Bridge 无法启动。';
      if (typeof status.lastError === 'string' && status.lastError.includes('workspace folder')) {
        $('openFolderGroup').style.display = '';
      }
    } else {
      $('stateDetails').textContent = isQuick ? '启动 Bridge 以生成临时 Cloudflare MCP 地址。'
        : isNamed ? (status.configuredNamedDomain ? 'Bridge 已停止。固定 Cloudflare 主机名未连接。' : '先配置 Cloudflare 主机名与 Tunnel Token 再启动。')
        : status.configuredDomain ? 'Bridge 已停止。没有开放的公共端点。' : '在连接设置中填写 ngrok 域名后再启动。';
    }

    const providerDomainMissing = isNgrok ? !status.configuredDomain : isNamed ? !status.configuredNamedDomain : false;
    const connectionNeedsAttention = status.state === 'error' || status.tunnelInstalled !== true || status.tunnelConfigValid !== true || providerDomainMissing;
    if (connectionNeedsAttention) $('connectionCard').open = true;
    const connectionState = status.state === 'error' ? 'error' : connectionNeedsAttention ? 'stopped' : 'running';
    renderStateBadge($('connectionBadge'), connectionState);
    if (status.state === 'error') {
      $('connectionBadge').textContent = '需要处理';
      $('connectionDetails').textContent = 'Bridge 连接需要处理';
    } else if (status.tunnelInstalled === undefined) {
      $('connectionBadge').textContent = '检查中';
      $('connectionDetails').textContent = '正在检查隧道设置…';
    } else if (!status.tunnelInstalled) {
      $('connectionBadge').textContent = '需要配置';
      $('connectionDetails').textContent = isQuick || isNamed ? 'cloudflared 未安装' : 'ngrok 未安装';
    } else if (!status.tunnelConfigValid) {
      $('connectionBadge').textContent = '需要处理';
      $('connectionDetails').textContent = isNamed ? 'Cloudflare Named Tunnel 配置需要处理' : 'ngrok 配置需要处理';
    } else if (providerDomainMissing) {
      $('connectionBadge').textContent = '需要配置';
      $('connectionDetails').textContent = isNamed ? 'Cloudflare 主机名未设置' : '保留域名未设置';
    } else {
      $('connectionBadge').textContent = '已就绪';
      $('connectionDetails').textContent = isQuick ? 'Cloudflare Quick Tunnel 已就绪 · 临时地址重启后变化'
        : isNamed ? 'Cloudflare Named Tunnel 已就绪 · ' + status.configuredNamedDomain
        : 'ngrok 已就绪 · ' + status.configuredDomain;
    }

    if (status.tunnelInstalled === undefined) {
      $('tunnelState').textContent = '尚未检查隧道客户端。';
    } else if (!status.tunnelInstalled) {
      $('tunnelState').textContent = isQuick || isNamed ? 'cloudflared 未安装。请完成下方的一次性配置。' : 'ngrok 未安装。请完成下方配置。';
    } else if (!status.tunnelConfigValid) {
      $('tunnelState').textContent = isNamed ? 'cloudflared 已安装，但主机名、Tunnel Token 或 Service URL 需要处理。' : 'ngrok 已安装，但 Authtoken 或配置需要处理。';
    } else if (providerDomainMissing) {
      $('tunnelState').textContent = 'ngrok 已就绪。请填写保留域名。';
    } else {
      $('tunnelState').textContent = (status.tunnelVersion || (isQuick || isNamed ? 'cloudflared' : 'ngrok')) + ' · 已就绪';
    }

    const needsTunnelSetup = status.tunnelInstalled === false || status.tunnelConfigValid === false || providerDomainMissing;
    $('tunnelSetupPanel').classList.toggle('needs-attention', needsTunnelSetup);
    $('cloudflareSetup').style.display = isQuick ? '' : 'none';
    $('cloudflareNamedSetup').style.display = isNamed ? '' : 'none';
    $('ngrokSetup').style.display = isNgrok ? '' : 'none';
    $('installCloudflaredButton').style.display = (isQuick || isNamed) && status.tunnelInstalled === false ? '' : 'none';
    $('cloudflareSetup').querySelector('summary').textContent = needsTunnelSetup ? '安装 cloudflared' : 'cloudflared 配置帮助';
    $('ngrokSetup').querySelector('summary').textContent = needsTunnelSetup ? '配置 ngrok' : 'ngrok 配置帮助';
    $('cloudflareNamedSetup').querySelector('summary').textContent = needsTunnelSetup ? '配置 Cloudflare Named Tunnel' : 'Cloudflare Named Tunnel 配置帮助';

    const showUrl = status.state === 'running' && status.publicUrl;
    $('publicUrlSection').style.display = showUrl ? '' : 'none';
    if (showUrl) {
      $('publicUrlValue').value = status.publicUrl;
      $('publicUrlValue').title = status.publicUrl;
    }
    if (isQuick && status.state === 'running' && status.publicUrl) {
      $('addressNotice').style.display = '';
      $('addressNotice').textContent = '临时 MCP 地址已复制。每次重启 Bridge 后请在 ChatGPT 中更新地址。';
      if (status.publicUrl !== lastCopiedQuickTunnelUrl) {
        lastCopiedQuickTunnelUrl = status.publicUrl;
        vscode.postMessage({ type: 'copy', text: status.publicUrl });
      }
    } else {
      $('addressNotice').style.display = 'none';
    }

    $('toolsContainer').textContent = '';
    for (const tool of status.toolNames) {
      const badge = document.createElement('span');
      badge.className = 'agentbridge-tool' + (tool === 'report_progress' || tool === 'set_todos' ? ' bridge-only' : '');
      badge.textContent = tool;
      if (tool === 'set_todos' || tool === 'report_progress') badge.title = '仅 Bridge 可用的工具';
      $('toolsContainer').appendChild(badge);
    }

    $('quickProvider').classList.toggle('selected', isQuick);
    $('namedProvider').classList.toggle('selected', isNamed);
    $('ngrokProvider').classList.toggle('selected', isNgrok);
    $('quickProvider').setAttribute('aria-checked', String(isQuick));
    $('namedProvider').setAttribute('aria-checked', String(isNamed));
    $('ngrokProvider').setAttribute('aria-checked', String(isNgrok));
    $('domainField').style.display = isNgrok ? '' : 'none';
    $('namedConfiguration').style.display = isNamed ? '' : 'none';
    if (!domainInputDirty && document.activeElement !== $('domainInput')) {
      $('domainInput').value = status.configuredDomain || '';
    }
    if (!namedTunnelInputDirty) {
      if (document.activeElement !== $('namedDomainInput')) {
        $('namedDomainInput').value = status.configuredNamedDomain || '';
      }
      if (document.activeElement !== $('namedPortInput')) {
        $('namedPortInput').value = String(status.namedTunnelLocalPort || 48271);
      }
    }
    $('namedTokenStatus').textContent = status.namedTunnelTokenConfigured ? 'Token 已安全保存。留空则保持不变。' : '尚未保存 Token。';
    if (typeof persistentMode === 'boolean') {
      $('persistentModeToggle').setAttribute('aria-checked', String(persistentMode));
      $('persistentModeToggle').title = persistentMode ? '重启后将自动打开并启动 Bridge' : 'Bridge 将仅在手动启动时运行';
    }
    if (typeof status.openInternalBrowser === 'string' && ['auto','all','external'].includes(status.openInternalBrowser)) {
      $('openInternalBrowserAuto').setAttribute('aria-checked', String(status.openInternalBrowser === 'auto'));
      $('openInternalBrowserAll').setAttribute('aria-checked', String(status.openInternalBrowser === 'all'));
      $('openInternalBrowserExternal').setAttribute('aria-checked', String(status.openInternalBrowser === 'external'));
    }
    $('managedShellCurrentLabel').textContent = status.managedShellPath || '（未知）';
    const managedShellWarnEl = $('managedShellWarning');
    const managedShellWarn = status.managedShellOverrideWarning;
    if (managedShellWarn && typeof managedShellWarn === 'string' && managedShellWarn) {
      managedShellWarnEl.style.display = '';
      managedShellWarnEl.textContent = '⚠ ' + managedShellWarn;
    } else {
      managedShellWarnEl.style.display = 'none';
      managedShellWarnEl.textContent = '';
    }
    updateNamedTunnelOriginPreview();
    updateControls();
  }

  function updateNamedTunnelOriginPreview() {
    const port = Number($('namedPortInput').value) || (lastStatus && lastStatus.namedTunnelLocalPort) || 48271;
    $('namedOriginValue').value = 'http://127.0.0.1:' + port;
    $('namedOriginValue').title = $('namedOriginValue').value;
  }

  function renderLocalError(message) {
    $('stateBadge').className = 'agentbridge-state state-error';
    $('stateBadge').textContent = '错误';
    $('stateDetails').textContent = message;
  }

  function updateControls() {
    const running = lastStatus && lastStatus.state === 'running';
    const starting = lastStatus && lastStatus.state === 'starting';
    const isNgrok = lastStatus && lastStatus.tunnelProvider === 'ngrok';
    const isNamed = lastStatus && lastStatus.tunnelProvider === 'cloudflare-named';
    const isQuick = lastStatus && lastStatus.tunnelProvider === 'cloudflare';

    $('quickProvider').disabled = busy || running || starting;
    $('namedProvider').disabled = busy || running || starting;
    $('ngrokProvider').disabled = busy || running || starting;
    $('domainInput').disabled = busy || running || starting || !isNgrok;
    $('namedDomainInput').disabled = busy || running || starting || !isNamed;
    $('namedTokenInput').disabled = busy || running || starting || !isNamed;
    $('namedPortInput').disabled = busy || running || starting || !isNamed;
    $('copyOriginButton').disabled = !$('namedOriginValue').value;
    $('saveNamedTunnelButton').disabled = busy || running || starting || !isNamed || !$('namedDomainInput').value.trim() || !Number.isInteger(Number($('namedPortInput').value));
    $('clearNamedTunnelTokenButton').disabled = busy || running || starting || !isNamed || lastStatus.namedTunnelTokenConfigured !== true;
    $('checkButton').disabled = busy || starting;
    $('installCloudflaredButton').disabled = busy || running || starting || !(isQuick || isNamed) || lastStatus.tunnelInstalled === true;
    $('installCloudflaredButton').textContent = installingCloudflared ? '安装中…' : '安装 cloudflared';
    $('rotateButton').disabled = busy || running || starting;
    $('startStopButton').disabled = busy || starting || (!running && busy);
    $('startStopButton').textContent = running ? '停止 Bridge' : starting ? '启动中…' : '启动 Bridge';
    $('persistentModeToggle').disabled = busy;
  }

  function selectTunnelProvider(provider) {
    if (busy || (lastStatus && (lastStatus.state === 'running' || lastStatus.state === 'starting' || lastStatus.tunnelProvider === provider))) return;
    busy = true;
    domainInputDirty = false;
    namedTunnelInputDirty = false;
    updateControls();
    vscode.postMessage({ type: 'setProvider', provider });
  }

  async function persistDomain() {
    if (busy || !lastStatus || lastStatus.tunnelProvider !== 'ngrok' || lastStatus.state === 'running' || lastStatus.state === 'starting') return;
    const domain = $('domainInput').value.trim();
    if (!domain) {
      domainInputDirty = false;
      $('domainInput').value = lastStatus.configuredDomain || '';
      return;
    }
    if (domain === lastStatus.configuredDomain) {
      domainInputDirty = false;
      return;
    }
    busy = true;
    updateControls();
    vscode.postMessage({ type: 'configure', domain });
  }

  async function saveNamedTunnel() {
    if (busy || !lastStatus || lastStatus.state === 'running' || lastStatus.state === 'starting') return;
    const domain = $('namedDomainInput').value.trim();
    const token = $('namedTokenInput').value.trim();
    const localPort = Number($('namedPortInput').value);
    if (!domain) {
      renderLocalError('请输入 Cloudflare 公网主机名。');
      $('namedDomainInput').focus();
      return;
    }
    if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535) {
      renderLocalError('请输入 1024 到 65535 之间的本地端口。');
      $('namedPortInput').focus();
      return;
    }
    if (!token && lastStatus.namedTunnelTokenConfigured !== true) {
      renderLocalError('保存前请粘贴 Cloudflare Tunnel Token。');
      $('namedTokenInput').focus();
      return;
    }
    busy = true;
    updateControls();
    vscode.postMessage({
      type: 'configureNamedTunnel',
      domain,
      token: token || undefined,
      localPort,
    });
    namedTunnelInputDirty = false;
  }

  function toggleBridge() {
    if (busy) return;
    if (lastStatus && lastStatus.state === 'running') {
      busy = true;
      updateControls();
      vscode.postMessage({ type: 'stop' });
      return;
    }
    const provider = (lastStatus && lastStatus.tunnelProvider) || 'cloudflare';
    const domain = $('domainInput').value.trim();
    if (provider === 'ngrok' && !domain) {
      $('connectionCard').open = true;
      renderLocalError('启动 Bridge 前请先填写 ngrok 保留域名。');
      $('domainInput').focus();
      return;
    }
    if (provider === 'cloudflare-named' && (!lastStatus || !lastStatus.configuredNamedDomain || !lastStatus.namedTunnelTokenConfigured)) {
      $('connectionCard').open = true;
      renderLocalError('启动 Bridge 前请先保存 Cloudflare 主机名与 Tunnel Token。');
      (lastStatus && lastStatus.configuredNamedDomain ? $('namedTokenInput') : $('namedDomainInput')).focus();
      return;
    }
    busy = true;
    updateControls();
    vscode.postMessage({ type: 'start', domain: provider === 'ngrok' ? domain : undefined });
  }

  function resetBusy() {
    busy = false;
    installingCloudflared = false;
    updateControls();
  }

  $('startStopButton').addEventListener('click', toggleBridge);
  $('openFolderButton').addEventListener('click', () => vscode.postMessage({ type: 'openFolder' }));
  $('copyUrlButton').addEventListener('click', () => {
    if (lastStatus && lastStatus.publicUrl) vscode.postMessage({ type: 'copy', text: lastStatus.publicUrl });
  });
  $('copyOriginButton').addEventListener('click', () => vscode.postMessage({ type: 'copy', text: $('namedOriginValue').value }));
  $('openChatGptButton').addEventListener('click', () => vscode.postMessage({ type: 'openExternal', url: 'https://chatgpt.com/' }));
  $('openArenaButton').addEventListener('click', () => vscode.postMessage({ type: 'openExternal', url: ARENA_URL }));
  $('copyPromptButton').addEventListener('click', () => vscode.postMessage({ type: 'copyPrompt' }));
  $('checkButton').addEventListener('click', () => {
    busy = true;
    updateControls();
    vscode.postMessage({ type: 'checkTunnel' });
  });
  $('installCloudflaredButton').addEventListener('click', () => {
    if (busy) return;
    installingCloudflared = true;
    updateControls();
    vscode.postMessage({ type: 'installCloudflared' });
  });
  $('rotateButton').addEventListener('click', () => {
    if (busy) return;
    busy = true;
    updateControls();
    vscode.postMessage({ type: 'rotateEndpoint' });
  });
  $('persistentModeToggle').addEventListener('click', () => {
    const enabled = $('persistentModeToggle').getAttribute('aria-checked') !== 'true';
    $('persistentModeToggle').setAttribute('aria-checked', String(enabled));
    $('persistentModeToggle').title = enabled ? '重启后将自动打开并启动 Bridge' : 'Bridge 将仅在手动启动时运行';
    vscode.postMessage({ type: 'setPersistentMode', enabled });
  });
  $('managedShellSaveButton').addEventListener('click', () => {
    const raw = $('managedShellInput').value.trim();
    $('managedShellInput').value = '';
    vscode.postMessage({ type: 'configureManagedShell', path: raw });
  });
  $('managedShellInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      $('managedShellSaveButton').click();
    }
  });
  $('managedShellResetButton').addEventListener('click', () => {
    $('managedShellInput').value = '';
    vscode.postMessage({ type: 'resetManagedShell' });
  });
  const setOib = (v) => vscode.postMessage({ type: 'setOpenInternalBrowser', value: v });
  $('openInternalBrowserAuto').addEventListener('click', () => setOib('auto'));
  $('openInternalBrowserAll').addEventListener('click', () => setOib('all'));
  $('openInternalBrowserExternal').addEventListener('click', () => setOib('external'));
  $('quickProvider').addEventListener('click', () => selectTunnelProvider('cloudflare'));
  $('namedProvider').addEventListener('click', () => selectTunnelProvider('cloudflare-named'));
  $('ngrokProvider').addEventListener('click', () => selectTunnelProvider('ngrok'));
  $('domainInput').addEventListener('input', () => { domainInputDirty = true; });
  $('domainInput').addEventListener('blur', () => persistDomain());
  $('domainInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      persistDomain();
      $('domainInput').blur();
    }
  });
  for (const input of [$('namedDomainInput'), $('namedTokenInput'), $('namedPortInput')]) {
    input.addEventListener('input', () => {
      namedTunnelInputDirty = true;
      updateNamedTunnelOriginPreview();
      updateControls();
    });
  }
  $('saveNamedTunnelButton').addEventListener('click', saveNamedTunnel);
  $('clearNamedTunnelTokenButton').addEventListener('click', () => {
    if (busy || !lastStatus || !lastStatus.namedTunnelTokenConfigured) return;
    if (window.confirm('清除 Cloudflare Tunnel Token？')) {
      busy = true;
      updateControls();
      vscode.postMessage({ type: 'clearNamedTunnelToken' });
    }
  });
  document.querySelectorAll('.agentbridge-command-row button[data-copy]').forEach((button) => {
    button.addEventListener('click', () => vscode.postMessage({ type: 'copy', text: button.getAttribute('data-copy') }));
  });
  document.querySelectorAll('button[data-open]').forEach((button) => {
    button.addEventListener('click', () => vscode.postMessage({ type: 'openExternal', url: button.getAttribute('data-open') }));
  });

  function switchTab(tab) {
    const isSession = tab === 'session';
    $('tabConfig').classList.toggle('active', !isSession);
    $('tabSession').classList.toggle('active', isSession);
    $('tabConfig').setAttribute('aria-selected', String(!isSession));
    $('tabSession').setAttribute('aria-selected', String(isSession));
    $('tabConfig').tabIndex = isSession ? -1 : 0;
    $('tabSession').tabIndex = isSession ? 0 : -1;
    $('configSection').style.display = isSession ? 'none' : '';
    $('sessionSection').style.display = isSession ? '' : 'none';
    const target = isSession ? $('tabSession') : $('tabConfig');
    target.focus();
  }
  $('tabConfig').addEventListener('click', () => switchTab('config'));
  $('tabSession').addEventListener('click', () => switchTab('session'));
  const tabs = [$('tabConfig'), $('tabSession')];
  document.addEventListener('keydown', (event) => {
    const tag = document.activeElement ? document.activeElement.tagName : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (event.key === 'ArrowRight' || event.key === 'End') {
      event.preventDefault();
      switchTab('session');
    } else if (event.key === 'ArrowLeft' || event.key === 'Home') {
      event.preventDefault();
      switchTab('config');
    }
  });
  $('sessionStartStopButton').addEventListener('click', () => {
    if (busy) return;
    busy = true;
    if (lastStatus && lastStatus.state === 'running') vscode.postMessage({ type: 'stop' });
    else vscode.postMessage({ type: 'start' });
  });
  $('sessionCollapseButton').addEventListener('click', () => {
    footerCollapsed = !footerCollapsed;
    $('sessionSection').classList.toggle('footer-collapsed', footerCollapsed);
    $('sessionCollapseButton').textContent = footerCollapsed ? '▴' : '▾';
    if (lastStatus) renderSessionStatus(lastStatus);
  });
  $('todosRegion').addEventListener('toggle', (event) => {
    if (event.target && event.target.tagName === 'DETAILS' && event.target.classList.contains('agentbridge-todos')) {
      todoExpanded = event.target.open;
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message && message.type === 'status' && message.status) {
      refreshStatus(message.status, message.persistentMode);
      resetBusy();
    }
  });
  setInterval(() => {
    const now = Date.now();
    document.querySelectorAll('.agentbridge-tool-meta[data-live-id]').forEach((el) => {
      const started = Number(el.dataset.startedAt);
      if (Number.isFinite(started)) el.textContent = formatDuration(now - started);
    });
  }, 1000);
  vscode.postMessage({ type: 'refresh' });
})();
</script>
</body>
</html>`;
  }
}