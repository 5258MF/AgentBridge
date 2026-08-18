# AgentBridge

Expose your VS Code workspace's tools — files, terminal, LSP, diagnostics, and images — to remote MCP clients (ChatGPT Connectors, Claude Desktop, Cursor, Cline, Continue) over a public HTTPS tunnel.

> [中文文档 | README.zh-CN.md](./README.zh-CN.md)

## Status

**v0.1.0 — first stable release.** Built and tested on Windows with VS Code 1.95+ and Node 22+. All fourteen development phases are landed and verified end-to-end against ChatGPT Connectors.

## Features

- **13 MCP tools** spanning:
  - **File system** — `read_files`, `apply_patch`, `search_files`, `find_files`, `list_directory`, `read_image_file`
  - **Terminal** — `run_command`, `get_command_output`, `send_command_input`
  - **LSP / diagnostics** — `get_diagnostics`, `lsp`
  - **Bridge state** — `set_todos`, `report_progress`
- **3 tunnel providers** — Cloudflare Quick Tunnel (default, zero-config), Cloudflare Named Tunnel (stable hostname), ngrok (reserved domain).
- **9 managed shells** — Windows PowerShell 5.1, PowerShell 7+, cmd; POSIX bash, zsh, sh, fish. The description shown to the AI updates automatically when you switch shells.
- **Vision-capable `read_image_file`** — returns MCP `ImageContent` blocks (PNG / JPEG / GIF / WebP / BMP) up to 5 MiB so vision-capable clients see pixels natively. SVG stays text via `read_files`.
- **External link routing** — `agentbridge.bridge.openInternalBrowser` (`auto` / `all` / `external`) controls whether ChatGPT / Arena open inside VS Code's Simple Browser or in the OS default browser. Default `auto` matches the original in-editor experience.
- **Bridge panel** — Activity Bar view with tunnel provider radio, status hero, persistent toggle, sessions timeline with mini diffs, and an advanced card covering managed shell, link routing, copy-MCP-prompt, and reset routeToken.
- **Auto-start** — flip `agentbridge.bridge.persistentMode` to bring the Bridge up on extension activation.
- **Client compatibility** — verified against ChatGPT Connectors, Claude Desktop, Cursor, Cline, Continue.

## Installation

### Option A — Download prebuilt vsix (recommended)

Most users don't need Node.js or build toolchain. Just grab the prebuilt vsix and install it into VS Code.

1. Open the [latest release page](https://github.com/5258MF/AgentBridge/releases/latest)
2. Download `agentbridge-0.1.0.vsix` to your computer
3. Install it:

   ```bash
   code --install-extension /path/to/agentbridge-0.1.0.vsix
   ```

   Or graphically: VS Code → Extensions panel → `⋯` menu → "Install from VSIX..." → pick the downloaded file.

### Option B — Build from source (for developers)

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
npx @vscode/vsce package --skip-license --allow-missing-repository
code --install-extension agentbridge-0.1.0.vsix
```

### Option C — From VS Code Marketplace (pending)

Once publisher registration is complete, you'll also be able to install directly from the Extensions panel by searching "AgentBridge".

## Tunnel providers

| Mode | Public URL stability | Requirements |
|---|---|---|
| `cloudflare` (default) | Ephemeral — changes after each restart | None |
| `cloudflare-named` | Stable hostname (`mcp.example.com`) | Cloudflare account, managed domain, Tunnel Token, published app route |
| `ngrok` | Reserved domain (`you.ngrok-free.dev`) | ngrok Authtoken + reserved hostname |

Choose in the **AgentBridge** panel's tunnel provider radio, or set `agentbridge.bridge.tunnelProvider` in `settings.json`.

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

## Known limitations

- **Cloudflare Quick Tunnel URL is ephemeral** — rotates every restart. Use Named Tunnel (or ngrok) for stable, shareable URLs.
- **Restricted networks (教育网 / strict-firewall campus networks) can hang Quick Tunnel.** UDP/QUIC is often half-blocked. Work around it with `HTTP2`/`http` transport override and a routing rule to `cloudflare.com` in your proxy. Named Tunnel is the long-term fix.
- **Simple Browser + ChatGPT login sometimes bumps into Cloudflare managed challenges.** Multi-retry usually resolves; if it persists, switch to the OS browser via `agentbridge.bridge.openInternalBrowser: "external"`.
- **ChatGPT Connectors caches `tools/list` at session start.** Adding / removing / modifying MCP tools requires the user to manually Refresh (or Remove + re-add) the Connector in `chatgpt.com → Settings → Connectors`. Stop+Start the Bridge alone is not enough.

## Compatibility

- VS Code 1.95+
- Node 22+
- Verified on Windows. POSIX shell providers resolve paths via `which(1)`.

## License

MIT. See [LICENSE](./LICENSE) for the full text.

Parts derived from `microsoft/vscode` are covered by that project's MIT license. See <https://github.com/microsoft/vscode> for details.
