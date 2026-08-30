# VSC AgentBridge

<p align="center">
  <img src="./media/icon.png" alt="VSC AgentBridge 图标" width="128">
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=agentbridge.vsc-agentbridge">
    <img src="https://img.shields.io/badge/VS_Marketplace-install-007ACC?style=flat-square&amp;logo=visualstudiocode&amp;logoColor=white" alt="从 VS Marketplace 安装">
  </a>
  <a href="https://github.com/5258MF/AgentBridge/releases/latest">
    <img src="https://img.shields.io/github/v/release/5258MF/AgentBridge?style=flat-square&amp;logo=github" alt="GitHub 最新版本">
  </a>
  <a href="https://github.com/5258MF/AgentBridge/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/5258MF/AgentBridge?style=flat-square" alt="许可证">
  </a>
</p>

把 VS Code 工作区的工具 — 文件、终端、LSP、诊断、图片 — 通过公共 HTTPS 隧道暴露给支持 MCP 的网页端大模型（如 GPT、Arena 等）。

> [English | README.md](./README.md)

## 状态

已发布到 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=agentbridge.vsc-agentbridge)。在 Windows 上基于 VS Code 1.95+ 与 Node 22+ 构建验证。14 个开发阶段已全部完成，对 ChatGPT Connectors 端到端打通。

## 核心特性

- **13 个 MCP 工具**，覆盖：
  - **文件系统** — `read_files`、`apply_patch`、`search_files`、`find_files`、`list_directory`、`read_image_file`
  - **终端** — `run_command`、`get_command_output`、`send_command_input`
  - **LSP / 诊断** — `get_diagnostics`、`lsp`
  - **Bridge 状态** — `set_todos`、`report_progress`
- **3 种公共隧道供应商** — Cloudflare Quick Tunnel（默认，零配置）、Cloudflare Named Tunnel（固定主机名）、ngrok（保留域名）。
- **跨平台 cloudflared 检测与安装** — Windows 可用 Winget 一键安装，macOS 可用 Homebrew 一键安装；Linux 检测 PATH、`/usr/bin` 与 `/usr/local/bin`，安装仍按 Cloudflare 官方说明手动完成。
- **托管 shell 支持矩阵** — Windows PowerShell 5.1 / PowerShell 7+（Windows）、bash（Linux）、zsh（macOS）通过每提示符协议钩子完整支持 `run_command`；cmd/sh/fish 会被直接拒绝并返回明确错误，而不是挂到超时。切换 shell 时 AI 看到的运行时语法提示自动更新。
- **可识别像素的 `read_image_file`** — 返回 MCP `ImageContent` block（PNG / JPEG / GIF / WebP / BMP，上限 5 MiB），让自带 vision 的客户端（ChatGPT、Claude）直接看到图像内容。SVG 仍走 `read_files` 按文本读。
- **外链打开方式三选一** — `agentbridge.bridge.openInternalBrowser`（`auto` / `all` / `external`）决定 ChatGPT / Arena 等外链在 VS Code 内置 Simple Browser 还是 OS 默认浏览器中打开。默认 `auto` 还原在编辑器内嵌的体验。
- **Bridge 面板** — 活动栏视图 + 隧道供应商单选卡 + 状态 hero + 自动启动 toggle + 会话时间线（含 mini diff）+ 高级卡（Managed Shell / 打开方式 / 复制 MCP 提示词 / 重置 routeToken）。
- **自动启动** — `agentbridge.bridge.persistentMode` 设为 true，激活插件即起 Bridge。
- **客户端兼容性** — 已实测 ChatGPT Connectors、Claude Desktop、Cursor、Cline、Continue。

## 安装

### 方式 A — 从 VS Code Marketplace 安装(推荐)

扩展已发布到 VS Code Marketplace,可直接在扩展面板安装。

1. 打开 VS Code → 扩展面板(`Ctrl+Shift+X` / `Cmd+Shift+X`)
2. 搜索 `VSC AgentBridge`(或直接访问 [Marketplace 页](https://marketplace.visualstudio.com/items?itemName=agentbridge.vsc-agentbridge))
3. 点击 **Install**

或命令行:

```bash
code --install-extension agentbridge.vsc-agentbridge
```

### 方式 B — 下载预构建 vsix(离线 / VSCodium)

无 Marketplace 访问的环境(VSCodium、内网、需手动分发安装包),从 GitHub Release 下载预构建 vsix 旁加载。

1. 打开 [最新 Release 页](https://github.com/5258MF/AgentBridge/releases/latest)
2. 下载最新版本的 vsix 文件到本地
3. 安装:

   ```bash
   code --install-extension /path/to/downloaded.vsix
   ```

   或者图形操作:VS Code → 扩展面板 → `⋯` 菜单 → "从 VSIX 安装..." → 选中下载的文件。

### 方式 C — 从源码构建(开发者方式)

需要 Node 22+ 和 npm。

```bash
git clone https://github.com/5258MF/AgentBridge.git
cd AgentBridge
npm install
npm run build
```

然后以开发扩展运行,或打包 vsix 旁加载:

```bash
# 开发模式
"Code.exe" --extensionDevelopmentPath="$PWD"

# 或本地打包 vsix
npx @vscode/vsce package --out vsc-agentbridge-latest.vsix --skip-license --allow-missing-repository
code --install-extension vsc-agentbridge-latest.vsix
```

## 隧道供应商

| 模式 | 公网 URL 稳定性 | 要求 |
|---|---|---|
| `cloudflare`（默认） | 易失 — 每次重启变 | 无 |
| `cloudflare-named` | 固定主机名（如 `mcp.example.com`） | Cloudflare 账号、托管域名、Tunnel Token、已发布的应用路由 |
| `ngrok` | 保留域名（如 `you.ngrok-free.dev`） | ngrok Authtoken + 已保留的域名 |

在 AgentBridge 面板的隧道供应商单选卡选择，或直接改 `settings.json` 的 `agentbridge.bridge.tunnelProvider`。

### cloudflared 检测与安装

Cloudflare Quick Tunnel 与 Cloudflare Named Tunnel 共用同一套 `cloudflared` 检测和安装帮助，固定流程为 **检查隧道 → 必要时安装并自动复检 → 启动 Bridge**。检查始终实际执行 `cloudflared --version`；仅找到文件但无法运行时不会被视为已安装。手动启动 Cloudflare 前，当前供应商及配置必须先通过检查；Persistent Mode 会在自动启动前自行检查。ngrok 继续保持原有启动流程。

| 系统 | 自动安装 | 检测位置 |
|---|---|---|
| Windows | Winget | PATH、Winget Links、WindowsApps、Program Files |
| macOS | Homebrew | PATH、`/opt/homebrew/bin`、`/usr/local/bin` |
| Linux | 本版本仅提供手动安装说明 | PATH、`/usr/bin`、`/usr/local/bin` |

检查未找到 `cloudflared` 时，AgentBridge 还会实际验证 Winget 或 Homebrew 能否运行；只有安装器可用时才显示一键安装按钮。安装成功后会自动复检；只有所选 Cloudflare 供应商及其配置通过验证，才会解锁“启动 Bridge”。Windows 没有 Winget、macOS 没有 Homebrew，或 Linux 尚未安装时，请从面板打开 Cloudflare 官方下载说明，手动安装后重新点击“检查隧道”。本版本不会在 Linux 上运行 APT 或修改软件源。

## 配置项

全部位于 `agentbridge.bridge.*` 命名空间下。

| 配置键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `tunnelProvider` | enum | `cloudflare` | `cloudflare` / `cloudflare-named` / `ngrok` |
| `cloudflareNamedDomain` | string | `""` | 固定主机名（如 `mcp.example.com`） |
| `cloudflareNamedLocalPort` | integer | `48271` | Named Tunnel 路由到的本地端口 |
| `ngrokDomain` | string | `""` | ngrok 保留域名（如 `you.ngrok-free.dev`） |
| `managedShell.windows` | string | `""` | 绝对路径（如 `C:\Program Files\PowerShell\7\pwsh.exe`）；空 = Windows PowerShell 5.1 默认 |
| `managedShell.unix` | string | `""` | 绝对路径或 PATH 可解析名（如 `/bin/zsh` 或 `bash`）；空 = `/bin/bash` 默认（无 bash 时回退 `/bin/sh`） |
| `openInternalBrowser` | enum | `auto` | `auto` / `all` / `external`；控制外链在 Simple Browser 或 OS 默认浏览器中打开 |
| `persistentMode` | boolean | `false` | 插件激活时自动启动 Bridge |

Managed Shell 与 打开方式 的运行时切换入口位于 Bridge 面板的 **高级卡**。

### Cloudflare Named Tunnel 配置教程

逐步指南见 [docs/cloudflare-named-tunnel-setup.md](docs/cloudflare-named-tunnel-setup.md)（检查/安装 cloudflared → 创建隧道 → 复制 Token → 添加路由 → 检查 DNS → 检查隧道 → 启动并验证）。英文版：[cloudflare-named-tunnel-setup.en.md](docs/cloudflare-named-tunnel-setup.en.md)。

### ngrok 开发域名配置教程

逐步指南见 [docs/ngrok-development-domain.md](docs/ngrok-development-domain.md)（安装 ngrok → 复制固定域名 → 配置 Authtoken → 检查 → 启动并验证）。英文版：[ngrok-development-domain.en.md](docs/ngrok-development-domain.en.md)。

ChatGPT 网页版连接见 [docs/chatgpt-web-connector.md](docs/chatgpt-web-connector.md)（启动 Bridge → 复制 MCP 地址 → 添加 Connector → 授予权限）。英文版：[chatgpt-web-connector.en.md](docs/chatgpt-web-connector.en.md)。

## 已知限制

- **Cloudflare Quick Tunnel URL 易失** — 每次重启都换地址。要稳定可分享的 URL，用 Named Tunnel（或 ngrok）。
- **受限网络（教育网 / 严格防火墙校园网）下 Quick Tunnel 可能挂起。** UDP/QUIC 经常半残。可选 `HTTP2`/`http` 传输协议 + Clash 加 cloudflare 域名分流作为应急；彻底解法是 Named Tunnel。
- **在 Simple Browser 里登录 ChatGPT 偶尔撞 Cloudflare 托管质询。** 多试几次通常能过；若持续撞墙，把 `agentbridge.bridge.openInternalBrowser` 设 `external` 走 OS 浏览器。
- **ChatGPT Connectors 在会话启动时缓存 `tools/list`。** 新增 / 移除 / 修改 MCP 工具后，需要在 `chatgpt.com → 设置 → Connectors` 里手动 Refresh（或 Remove 后重新 Add）才拉到新工具。仅 Stop+Start Bridge 不够。

## 兼容性

- VS Code 1.95+
- Node 22+
- Windows 上构建验证；macOS 支持 Homebrew 安装，Linux 支持检测现有 cloudflared 并提供手动安装入口。

## 许可协议

MIT，详见 [LICENSE](./LICENSE)。

第三方声明（包括派生自 `microsoft/vscode` 的部分所适用的 MIT 条款）详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
