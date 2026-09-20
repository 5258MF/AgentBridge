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

- **14 MCP tools** spanning:
  - **File system** — `read_files`, `apply_patch`, `search_files`, `find_files`, `list_directory`, `read_image_file`
  - **Terminal** — `run_command`, `get_command_output`, `send_command_input`, `terminate_command`
  - **LSP / diagnostics** — `get_diagnostics`, `lsp`
  - **Bridge state** — `set_todos`, `report_progress`
- **3 tunnel providers** — Cloudflare Quick Tunnel (default, zero-config), Cloudflare Named Tunnel (stable hostname), ngrok (reserved domain).
- **Cross-platform cloudflared detection and installation** — one-click Winget installation on Windows and Homebrew installation on macOS; Linux checks PATH, `/usr/bin`, and `/usr/local/bin` while keeping installation manual through Cloudflare's official instructions.
- **Managed shell support matrix** — PowerShell 5.1 / PowerShell 7+ (Windows), bash (Linux) and zsh (macOS) fully support `run_command` via per-prompt protocol hooks; cmd, sh and fish are rejected up front with a clear error instead of timing out. The syntax hint shown to the AI updates automatically when you switch shells.
- **Bundled PSReadLine for Windows PowerShell 5.1** — managed PowerShell terminals prepend the extension's `vendor/` directory to `PSModulePath` so the bundled PSReadLine 2.3.4 is used instead of the Windows in-box 2.0.0, whose negative cursor-position handling produces ConPTY rendering artifacts. The payload contains only PSReadLine, so no other module is shadowed; if it is absent the shell silently falls back to the in-box version.
- **Two `run_command` execution modes** — the default `pty` mode runs in the managed persistent terminal described above; `execution: "direct"` runs a one-shot child process with piped stdio and a real process-level exit code, so builds, tests and scripts no longer occupy a terminal slot or wait on the prompt protocol. Direct commands are non-interactive and cannot be backgrounded.
- **Temp-script bridge for fragile commands** — commands that are multi-line, non-ASCII, or longer than 1024 characters are written to a temporary script and executed as a single ASCII one-liner, avoiding readline continuation-mode buffering, lossy fast pastes, and console code-page mangling. On Windows the script carries a UTF-8 BOM plus an output-encoding prelude, and a native exit-code guard so a failed final native command propagates its status instead of exiting 0.
- **Vision-capable `read_image_file`** — returns MCP `ImageContent` blocks (PNG / JPEG / GIF / WebP / BMP) up to 5 MiB so vision-capable clients see pixels natively. SVG stays text via `read_files`.
- **External link routing** — `agentbridge.bridge.openInternalBrowser` (`auto` / `all` / `external`) controls whether ChatGPT / Arena open inside VS Code's Simple Browser or in the OS default browser. Default `auto` matches the original in-editor experience.
- **More Sites** — the panel's **More sites** group holds the sites that do not fit the hero row: Arena, WorkBuddy, Trae, Qwen Work and Manus. Manus is on the embeddable domain list, so `auto` opens it inside VS Code like the others instead of falling back to the OS browser.
- **Quick open shortcuts** — add your own `http(s)` links from the panel's **Quick open** card and they appear as buttons at the top of the page, one click away. Stored in the `agentbridge.bridge.quickLinks` setting (up to 16 entries), shared with Settings Sync like any other `application`-scoped setting, and editable from `settings.json` as well.
- **Bridge panel** — Activity Bar view with tunnel provider radio, status hero, continuous public-endpoint health, persistent toggle, sessions timeline with mini diffs, quick open shortcuts, and an advanced card covering interface language, managed shell, link routing, copy-MCP-prompt, and reset routeToken.
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

After a successful start, AgentBridge checks the public health endpoint every 10 seconds for Cloudflare Quick and Named Tunnels. One failure is shown as a network fluctuation; two consecutive failures mark the public endpoint unavailable while keeping the local Bridge running. Each monitoring pass has an 8-second total network budget. To avoid consuming ngrok's HTTP/S request quota while idle, ngrok is verified at startup and through **Check now**, without background polling. The Session footer shows a compact indicator, and Connection Settings shows timestamps and failure details. A later successful check clears the warning automatically. Monitoring reports status only and does not restart a live tunnel solely because of a transient health failure.

## Configuration

The interface-language override is `agentbridge.language`; Bridge and tunnel settings live under `agentbridge.bridge.*`.

| Key | Type | Default | Scope | Notes |
|---|---|---|---|---|
| `agentbridge.language` | enum | `auto` | `application` | `auto` follows the VS Code display language; `zh-CN` / `en` override AgentBridge's own panel and runtime messages |
| `trustedBrowserOrigins` | string[] | `[]` | `machine` | Exact CORS origins trusted to call MCP directly from a browser or browser extension. Supports `http://`, `https://`, `chrome-extension://`, and `moz-extension://`; no wildcards or URL paths. Editable in Advanced Settings; changes apply immediately to subsequent requests. |
| `quickLinks` | object[] | `[]` | `application` | Quick open shortcuts: `{ "name": "...", "url": "https://..." }` entries (max 16). Names are 40 characters and URLs 500; only `http://` and `https://` addresses are kept, and duplicate URLs are refused. Rendered as buttons at the top of the Bridge panel and in the Quick open card. |
| `tunnelProvider` | enum | `cloudflare` | `application` | `cloudflare` / `cloudflare-named` / `ngrok` |
| `tunnelProtocol` | enum | `auto` | `application` | cloudflared↔Cloudflare edge transport (Cloudflare tunnels only): `auto` / `quic` (UDP 7844) / `http2` (TCP 7844). Use `http2` on networks where QUIC is unstable (campus/corporate networks often drop sustained UDP flows). Applies on the next tunnel start or automatic reconnect. |
| `cloudflareNamedDomain` | string | `""` | `application` | Fixed hostname (e.g. `mcp.example.com`) |
| `cloudflareNamedLocalPort` | integer | `48271` | `machine` | Local port the named tunnel routes to; machine-specific and not Settings Sync/workspace-overridable |
| `ngrokDomain` | string | `""` | `application` | Reserved ngrok domain (e.g. `you.ngrok-free.dev`) |
| `ngrokUseHttpProxy` | boolean | `false` | `application` | Let the ngrok process use the resolved HTTP proxy. Off by default because ngrok Free rejects HTTP proxies (`ERR_NGROK_9009`) — inherited `*_PROXY` variables are stripped. Enable only on a Pay-as-you-go plan. |
| `managedShell.windows` | string | `""` | `machine-overridable` | Absolute path (e.g. `C:\Program Files\PowerShell\7\pwsh.exe`); empty = Windows PowerShell 5.1 default |
| `managedShell.unix` | string | `""` | `machine-overridable` | Absolute path or PATH-resolvable name (e.g. `/bin/zsh` or `bash`); empty = `/bin/bash` default (or `/bin/sh` when bash is unavailable) |
| `openInternalBrowser` | enum | `auto` | `machine-overridable` | `auto` / `all` / `external`; controls whether external links open in VS Code Simple Browser or OS default browser |
| `persistentMode` | boolean | `false` | `application` | Start the Bridge automatically on extension activation |
| `startupTimeoutMs` | integer | `20000` | `application` | How long to wait for the public health endpoint while starting a tunnel (5000-120000). Raise it on slow networks. Deterministic failures (DNS, refused/reset connections, TLS interception) abort after 3 consecutive attempts instead of waiting out the whole timeout. |
| `files.veryLargeFileBytes` | integer | `8388608` | `application` | Size in bytes above which `read_files` requires an explicit `start_line`/`end_line` instead of reading a file whole (262144-134217728). Generated bundles, lockfiles and large configs routinely exceed the previous 2 MB default; the bytes actually returned stay capped separately. |
| `files.imageMaxBytes` | integer | `5242880` | `application` | Size in bytes above which `read_image_file` refuses to decode an image (262144-134217728). The image is handed to the model as base64, so this is also a ceiling on what one call puts into a conversation. Checked against the bytes that were read, not only against the size the file had when it was stat-ed. |
| `files.excludeGlobs` | string[] | `[]` | `application` | Glob patterns excluded from `find_files`, `search_files` and `list_directory`. Added to the built-in list rather than replacing it, so `node_modules` and friends cannot be lost; patterns ripgrep cannot parse are ignored. |

Interface language, managed shell, and link-routing controls also live on the Bridge panel's **advanced** card.

### Cloudflare Named Tunnel walkthrough

See [docs/cloudflare-named-tunnel-setup.md](docs/cloudflare-named-tunnel-setup.md) for a step-by-step guide (check/install cloudflared, create the tunnel, copy the token, add the route, verify DNS, check, then start + verify the bridge). English version: [cloudflare-named-tunnel-setup.en.md](docs/cloudflare-named-tunnel-setup.en.md).

### ngrok development domain walkthrough

See [docs/ngrok-development-domain.en.md](docs/ngrok-development-domain.en.md) for a step-by-step guide (install ngrok → copy the fixed domain → configure Authtoken → check → start + verify). Chinese version: [ngrok-development-domain.md](docs/ngrok-development-domain.md).

Connecting the ChatGPT web app: see [docs/chatgpt-web-connector.md](docs/chatgpt-web-connector.md) (start Bridge → copy MCP address → add Connector → grant permissions). English version: [chatgpt-web-connector.en.md](docs/chatgpt-web-connector.en.md).

## Known limitations

- **Cloudflare Quick Tunnel URL is ephemeral** — rotates every restart. Use Named Tunnel (or ngrok) for stable, shareable URLs.
- **Cloudflare Tunnel requires outbound port 7844.** cloudflared prefers QUIC over UDP 7844; TCP 7844 (HTTP/2) is the alternate transport. If a campus, corporate, firewall, or proxy network blocks both transports, neither Quick Tunnel nor Named Tunnel can connect; allow one of the 7844 transports, switch networks, or use ngrok instead.
- **QUIC can stay unstable even when cloudflared's pre-check passes.** The pre-check only probes short QUIC handshakes; networks that pass the handshake but drop sustained UDP flows (common on campus/corporate networks) keep failing real traffic, and cloudflared does not reliably fall back to HTTP/2 within its startup window. AgentBridge self-heals: with `tunnelProtocol: auto` (default), repeated edge dial failures with zero registrations restart the tunnel with HTTP/2 (TCP 7844) automatically and announce it in the panel; set `tunnelProtocol: http2` to skip QUIC entirely.
- **Simple Browser + ChatGPT login sometimes bumps into Cloudflare managed challenges.** Multi-retry usually resolves; if it persists, switch to the OS browser via `agentbridge.bridge.openInternalBrowser: "external"`.
- **ChatGPT Connectors caches `tools/list` at session start.** Adding / removing / modifying MCP tools requires the user to manually Refresh (or Remove + re-add) the Connector in `chatgpt.com → Settings → Connectors`. Stop+Start the Bridge alone is not enough.

## Compatibility

- VS Code 1.95+
- Node 22+
- Built and verified on Windows; macOS supports Homebrew installation, while Linux detects an existing cloudflared and provides a manual installation entry point.
- File search bundles ripgrep on Windows. On macOS/Linux it uses `rg` from PATH when available, otherwise the built-in bounded Node engine (content search: at most 20,000 files and files up to 2 MiB; file discovery: at most 5,000 candidates).

## License

MIT. See [LICENSE](./LICENSE) for the full text.

Third-party notices, including the MIT terms for portions derived from `microsoft/vscode`, are listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
