# VSC AgentBridge

<p align="center">
  <img src="./media/icon.png" alt="VSC AgentBridge icon" width="128">
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=agentbridge.vsc-agentbridge"><img src="https://img.shields.io/badge/VS_Marketplace-install-007ACC?style=flat-square&amp;logo=visualstudiocode&amp;logoColor=white" alt="Install from the VS Marketplace"></a>
  <a href="https://github.com/5258MF/AgentBridge/releases/latest"><img src="https://img.shields.io/github/v/release/5258MF/AgentBridge?style=flat-square&amp;logo=github" alt="GitHub Release"></a>
  <a href="https://github.com/5258MF/AgentBridge/blob/main/LICENSE"><img src="https://img.shields.io/github/license/5258MF/AgentBridge?style=flat-square&amp;cacheSeconds=14400&amp;label=license" alt="License"></a>
</p>

Expose your VS Code workspace's tools — files, terminal, LSP, diagnostics, and images — to web-based AI assistants that support MCP (GPT, Arena, etc.) over a public HTTPS tunnel.

> [中文文档 | README.zh-CN.md](./README.zh-CN.md)

## Status

Published to the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=agentbridge.vsc-agentbridge). Built and tested on Windows with VS Code 1.95+ and Node 22+. All fourteen development phases are landed and verified end-to-end against ChatGPT Connectors.

## Features

- **13 MCP tools** spanning:
  - **File system** — `read_files`, `apply_patch`, `search_files`, `find_files`, `list_directory`, `read_image_file`
  - **Terminal** — `run_command`, `get_command_output`, `send_command_input`
  - **LSP / diagnostics** — `get_diagnostics`, `lsp`
  - **Bridge state** — `set_todos`, `report_progress`
- **3 tunnel providers** — Cloudflare Quick Tunnel (default, zero-config), Cloudflare Named Tunnel (stable hostname), ngrok (reserved domain).
- **Cross-platform cloudflared detection and installation** — one-click Winget installation on Windows and Homebrew installation on macOS; Linux checks PATH, `/usr/bin`, and `/usr/local/bin` while keeping installation manual through Cloudflare's official instructions.
- **Managed shell support matrix** — PowerShell 5.1 / PowerShell 7+ (Windows), bash (Linux) and zsh (macOS) fully support `run_command` via per-prompt protocol hooks; cmd, sh and fish are rejected up front with a clear error instead of timing out. The syntax hint shown to the AI updates automatically when you switch shells.
- **Vision-capable `read_image_file`** — returns MCP `ImageContent` blocks (PNG / JPEG / GIF / WebP / BMP) up to 5 MiB so vision-capable clients see pixels natively. SVG stays text via `read_files`.
- **External link routing** — `agentbridge.bridge.openInternalBrowser` (`auto` / `all` / `external`) controls whether ChatGPT / Arena open inside VS Code's Simple Browser or in the OS default browser. Default `auto` matches the original in-editor experience.
- **Bridge panel** — Activity Bar view with tunnel provider radio, status hero, persistent toggle, sessions timeline with mini diffs, and an advanced card covering managed shell, link routing, copy-MCP-prompt, and reset routeToken.
- **Auto-start** — flip `agentbridge.bridge.persistentMode` to bring the Bridge up on extension activation.
- **Client compatibility** — verified against ChatGPT Connectors, Claude Desktop, Cursor, Cline, Continue.

## Installation

### Option A — From VS Code Marketplace (recommended)

The extension is published on the VS Code Marketplace, so you can install it directly from the Extensions panel.

1. Open VS Code → Extensions panel (`Ctrl+Shift+X` / `Cmd+Shift+X`)
2. Search `VSC AgentBridge` (or visit the [Marketplace page](https://marketplace.visualstudio.com/items?itemName=agentbridge.vsc-agentbridge))
3. Click **Install**

Or from the command line:

```bash
code --install-extension agentbridge.vsc-agentbridge
```

### Option B — Download prebuilt vsix (offline / VSCodium)

For environments without Marketplace access (VSCodium, internal networks, manual installer distribution), grab the prebuilt vsix from GitHub Release and sideload.

1. Open the [latest release page](https://github.com/5258MF/AgentBridge/releases/latest)
2. Download the latest vsix release to your computer
3. Install it:

   ```bash
   code --install-extension /path/to/downloaded.vsix
   ```

   Or graphically: VS Code → Extensions panel → `⋯` menu → "Install from VSIX..." → pick the downloaded file.

### Option C — Build from source (for developers)

Requires Node 22+ and npm.

```bash
git clone https://github.com/5258MF/AgentBridge.git
cd AgentBridge
npm install
npm run build
```

Then either run it as a dev extension or sideload the packaged vsix:

```bash
# Dev mode
"Code.exe" --extensionDevelopmentPath="$PWD"

# Or package a vsix locally
npx @vscode/vsce package --out vsc-agentbridge-latest.vsix --skip-license --allow-missing-repository
code --install-extension vsc-agentbridge-latest.vsix
```

## Tunnel providers

| Mode | Public URL stability | Requirements |
|---|---|---|
| `cloudflare` (default) | Ephemeral — changes after each restart | None |
| `cloudflare-named` | Stable hostname (`mcp.example.com`) | Cloudflare account, managed domain, Tunnel Token, published app route |
| `ngrok` | Reserved domain (`you.ngrok-free.dev`) | ngrok Authtoken + reserved hostname |

Choose in the **AgentBridge** panel's tunnel provider radio, or set `agentbridge.bridge.tunnelProvider` in `settings.json`.

### cloudflared detection and installation

Cloudflare Quick Tunnel and Cloudflare Named Tunnel share the same `cloudflared` detection and installation help. The required flow is **Check Tunnel → install if needed (with automatic verification) → Start Bridge**. Every check actually runs `cloudflared --version`; finding a file that cannot execute does not count as an installed client. Manual Cloudflare starts stay disabled until the selected provider and configuration have passed a check; Persistent Mode performs that check automatically before starting. ngrok keeps its existing start behavior.

| System | Automatic installation | Detection locations |
|---|---|---|
| Windows | Winget | PATH, Winget Links, WindowsApps, Program Files |
| macOS | Homebrew | PATH, `/opt/homebrew/bin`, `/usr/local/bin` |
| Linux | Manual instructions only in this release | PATH, `/usr/bin`, `/usr/local/bin` |

When a check cannot find `cloudflared`, AgentBridge also verifies whether Winget or Homebrew can actually run. The one-click install button appears only when that installer is available. A successful installation is checked automatically; Start Bridge unlocks only after the selected Cloudflare provider and its configuration pass verification. If Winget is missing on Windows, Homebrew is missing on macOS, or cloudflared is absent on Linux, open the official Cloudflare downloads instructions from the panel, install it manually, and click **Check Tunnel** again. This release does not run APT or modify Linux package sources.

## Configuration

All settings live under the `agentbridge.bridge.*` namespace.

| Key | Type | Default | Notes |
|---|---|---|---|
| `tunnelProvider` | enum | `cloudflare` | `cloudflare` / `cloudflare-named` / `ngrok` |
| `cloudflareNamedDomain` | string | `""` | Fixed hostname (e.g. `mcp.example.com`) |
| `cloudflareNamedLocalPort` | integer | `48271` | Local port the named tunnel routes to |
| `ngrokDomain` | string | `""` | Reserved ngrok domain (e.g. `you.ngrok-free.dev`) |
| `managedShell.windows` | string | `""` | Absolute path (e.g. `C:\Program Files\PowerShell\7\pwsh.exe`); empty = Windows PowerShell 5.1 default |
| `managedShell.unix` | string | `""` | Absolute path or PATH-resolvable name (e.g. `/bin/zsh` or `bash`); empty = `/bin/bash` default (or `/bin/sh` when bash is unavailable) |
| `openInternalBrowser` | enum | `auto` | `auto` / `all` / `external`; controls whether external links open in VS Code Simple Browser or OS default browser |
| `persistentMode` | boolean | `false` | Start the Bridge automatically on extension activation |

Runtime toggles for managed shell and open-internally-browser live on the Bridge panel's **advanced** card.

### Cloudflare Named Tunnel walkthrough

See [docs/cloudflare-named-tunnel-setup.md](docs/cloudflare-named-tunnel-setup.md) for a step-by-step guide (check/install cloudflared, create the tunnel, copy the token, add the route, verify DNS, check, then start + verify the bridge). English version: [cloudflare-named-tunnel-setup.en.md](docs/cloudflare-named-tunnel-setup.en.md).

### ngrok development domain walkthrough

See [docs/ngrok-development-domain.en.md](docs/ngrok-development-domain.en.md) for a step-by-step guide (install ngrok → copy the fixed domain → configure Authtoken → check → start + verify). Chinese version: [ngrok-development-domain.md](docs/ngrok-development-domain.md).

Connecting the ChatGPT web app: see [docs/chatgpt-web-connector.md](docs/chatgpt-web-connector.md) (start Bridge → copy MCP address → add Connector → grant permissions). English version: [chatgpt-web-connector.en.md](docs/chatgpt-web-connector.en.md).

## Known limitations

- **Cloudflare Quick Tunnel URL is ephemeral** — rotates every restart. Use Named Tunnel (or ngrok) for stable, shareable URLs.
- **Cloudflare Tunnel requires outbound port 7844.** cloudflared defaults to `auto`: it uses QUIC over UDP 7844 and falls back to HTTP/2 over TCP 7844 when UDP is unavailable. If a campus, corporate, firewall, or proxy network blocks both transports, neither Quick Tunnel nor Named Tunnel can connect; allow one of the 7844 transports, switch networks, or use ngrok instead.
- **Simple Browser + ChatGPT login sometimes bumps into Cloudflare managed challenges.** Multi-retry usually resolves; if it persists, switch to the OS browser via `agentbridge.bridge.openInternalBrowser: "external"`.
- **ChatGPT Connectors caches `tools/list` at session start.** Adding / removing / modifying MCP tools requires the user to manually Refresh (or Remove + re-add) the Connector in `chatgpt.com → Settings → Connectors`. Stop+Start the Bridge alone is not enough.

## Compatibility

- VS Code 1.95+
- Node 22+
- Built and verified on Windows; macOS supports Homebrew installation, while Linux detects an existing cloudflared and provides a manual installation entry point.

## License

MIT. See [LICENSE](./LICENSE) for the full text.

Third-party notices, including the MIT terms for portions derived from `microsoft/vscode`, are listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
