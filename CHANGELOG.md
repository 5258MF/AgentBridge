# Change Log

## 0.1.4 (2026-08-20)

Feature and reliability release. The MCP tool surface remains unchanged at 13 tools.

- **Bilingual Bridge panel** — the panel now follows the VS Code display language (`zh-*` → Chinese, everything else → English). Dynamic labels use serializable `{0}` templates with catalog key/type/placeholder checks, so session counts, request counts, duration, success rate, and tunnel-ready messages render correctly after crossing the Webview boundary.
- **More web-assistant shortcuts** — a collapsible `More Sites` group adds Arena, WorkBuddy, Trae, and Qwen alongside ChatGPT. Smart link routing now parses real hostnames and accepts legitimate subdomains such as `work.trae.cn` without matching lookalike domains.
- **Panel state synchronization hardening** — critical Start/Stop controls update before non-critical timeline rendering; render failures are isolated and reported to Extension Host logs; showing or rebuilding the view restarts polling without an old view disposing the new timer.
- **Quick Tunnel clipboard reliability** — fixed the Webview-scope `lastCopiedQuickTunnelUrl` `ReferenceError`, and moved once-per-URL copy state into the long-lived Extension Host so switching away from and back to AgentBridge no longer overwrites the clipboard repeatedly.
- **Bilingual ngrok development-domain guides** — added complete Chinese and English walkthroughs for installation, reserved domain, Authtoken, checks, startup, endpoint verification, troubleshooting, and security, linked from both READMEs.

## 0.1.3 (2026-08-20)

Bug-fix release.

- **Session view overflow fix** — the panel body now uses a flex column layout (`display: flex; flex-direction: column; overflow: hidden`) with the session view as a flex item (`flex: 1 1 0`), so the sessions timeline no longer overflows and the footer stays pinned at the viewport bottom without double scrollbars.
- **Real average tool duration** — `formatDuration` now renders sub-second calls in milliseconds (e.g. `0.9s`); the footer average reflects the true mean instead of rounding every fast call down to `0s`.
- **Live elapsed time for running tools** — a running tool card now ticks its elapsed time every second (`data-live-id` / `data-started-at` + a 1s `setInterval`), instead of showing a static "running" label until the activity ends.
- **Open Arena button fix** — the `ARENA_URL` constant lived at module scope in `bridge-panel.ts` but was referenced inside the webview template-string script (a separate sandbox scope); esbuild tree-shook the constant and the button threw a `ReferenceError` at runtime. The URL is now inlined next to the button like the ChatGPT one.

## 0.1.2 (2026-08-19)

Documentation revision.

- **Repositioned as a web-based MCP assistant bridge** — tagline and description now target web-based AI assistants that support MCP (GPT, Arena, etc.) instead of "remote MCP clients".
- **Dropped hardcoded version strings from README status lines** — no more stale version numbers; install steps now reference "the latest release" instead of a specific vsix filename.
- Repackaged with the revised READMEs (Marketplace listing overview refresh).

## 0.1.1 (2026-08-19)

Bug-fix and documentation release.

- **DoH fallback for Cloudflare Quick Tunnel health checks** — on networks whose DNS cannot resolve `*.trycloudflare.com` wildcard subdomains (campus / corporate DNS), the bridge now resolves the tunnel hostname via DNS-over-HTTPS (`dns.alidns.com` / `doh.pub`) and verifies health directly against the resolved IP with SNI + Host headers, so TLS is still validated against the real hostname. Previously the health check timed out after 60s and the tunnel never came online. Startup diagnostics were added to the Output panel (`[bridge]` lines) so future connectivity issues are visible at a glance.
- **Open-mode radio hover fix** — the selected "打开方式" button now keeps a visible highlight on hover (was blending into the background).
- **Bilingual Cloudflare Named Tunnel setup guides** — `docs/cloudflare-named-tunnel-setup.md` (中文) and `docs/cloudflare-named-tunnel-setup.en.md` (English), linked from both READMEs.

## 0.1.0 (2026-08-18)

First public preview release.

- **13 MCP tools** exposed to remote AI clients: file system (read_files, apply_patch, search_files, find_files, list_directory, read_image_file), terminal (run_command, get_command_output, send_command_input), LSP / diagnostics (get_diagnostics, lsp), bridge state (set_todos, report_progress).
- **Vision-capable `read_image_file`** returns MCP `ImageContent` blocks (PNG / JPEG / GIF / WebP / BMP, up to 5 MiB) so vision-capable clients see pixels natively. SVG stays text via `read_files`.
- **3 tunnel providers**: Cloudflare Quick Tunnel (default, zero-config), Cloudflare Named Tunnel (stable hostname), ngrok (reserved domain).
- **9 managed shells**: Windows PowerShell 5.1 / PowerShell 7+ / cmd; POSIX bash / zsh / sh / fish. AI-seen runtime description updates automatically when you switch managed shell.
- **External link routing** `agentbridge.bridge.openInternalBrowser` (`auto` / `all` / `external`) controls whether ChatGPT / Arena URLs open inside VS Code's Simple Browser or the OS default browser; default `auto` restores the original in-editor experience.
- **Bridge panel** — Activity Bar view with tunnel provider radio, status hero, persistent toggle, sessions timeline with mini diffs, advanced card (managed shell, link routing, copy MCP prompt, reset routeToken).
- **Auto-start** via `agentbridge.bridge.persistentMode`.
- **Client compatibility** verified against ChatGPT Connectors, Claude Desktop, Cursor, Cline, and Continue.
- **Cloudflare Quick Tunnel** issues a fresh random subdomain on every start/restart; Cloudflare Named Tunnel and ngrok give you a stable hostname.
- **Known limitations**: ChatGPT Web Connectors caches `tools/list` at client startup — after installing/upgrading, refresh the connector (Settings → Connectors → Refresh, or Remove+re-add). Simple-Browser ChatGPT login may hit Cloudflare managed challenges; retry succeeds, or use OS browser (`openInternalBrowser=external`).

See `README.md` for full features and configuration.
