# Change Log

## 0.1.6 (2026-08-22)

Reliability release. The MCP tool surface remains unchanged at 13 tools.

- **Fixed scoped file searches with glob patterns** — `find_files` / `search_files` passed an absolute path as ripgrep's search root, but `--glob` patterns match traversal-relative paths, so any search that combined a directory scope with a glob (`src/**/*.ts`, exclude filters) silently returned nothing. Both tools now spawn ripgrep with the scope directory as the working directory and `.` as the root.
- **Fixed `run_command` eating real output lines** — two prompt-stripping passes could remove genuine content: leading lines starting with `$ ` or `PS ...` were dropped from the first captured chunk, and trailing prompt removal could eat real lines when a command's output ended near a prompt boundary. Stripping is now tail-anchored to the end of the output, and the leading pass only trims blank lines.
- **Capped retained finished command states** — long-running Bridges kept every finished `run_command` state forever. States are now pruned to the 32 most recent (running/background commands are never evicted).
- **Honest shell support matrix** — `run_command`'s persistent-shell protocol is now officially supported on PowerShell (Windows), bash (Linux), and zsh (macOS via ZDOTDIR injection). cmd, plain sh, and fish are no longer attempted: selecting one fails fast with a clear error naming the supported shells, instead of hanging ~8 s waiting for protocol markers that never arrive.
- **Layered DoH hardening for Quick Tunnel health checks** — on networks whose DNS cannot resolve `*.trycloudflare.com` subdomains (campus/corporate resolvers), startup no longer times out after 60 s. Cloudflare's own DoH endpoint is tried first (zero propagation lag for its own zone), DoH queries carry a cache-buster with `no-store`, and if every resolver fails — including the window where the account-less control plane has not yet published its DNS record — the health check falls back to pinned Cloudflare anycast IPs with SNI + Host headers while TLS stays validated against the real hostname. A new `[bridge] DoH fallback exhausted, ...` log line makes the fallback path visible in the Output panel. First successful starts on affected networks drop from ~60 s to a few seconds.
- **Housekeeping** — file locks now use reference counting so idle mutexes are evicted; removed a misleading empty authorization hook from the Bridge start path.

## 0.1.5 (2026-08-21)

Feature release.

- **Read-only mode** — a new `agentbridge.bridge.readOnlyMode` setting (application scope, so workspace settings cannot override it) disables every tool that can modify or drive the local environment: `apply_patch`, `run_command`, and `send_command_input`. Defense in depth: blocked tools disappear from `tools/list` (13 → 10), and any client that cached the old list gets an `isError` response ("disabled in read-only mode") plus a "Blocked by Read-Only Mode" entry in the activity timeline if it tries anyway. Toggling takes effect immediately via configuration watching — no Bridge restart needed; connected clients see the change after they refresh their tool list. The panel adds a switch in Advanced Settings → Security & Access (next to Rotate MCP Address), a hero badge while active, and the per-session server instructions tell remote agents up front not to attempt writes.
- **MCP discovery workflow prompt** — Copy Prompt now emits a modern discovery guide instead of a fixed assistant prompt: probe `server/discover` with `MCP-Protocol-Version: 2026-07-28` headers, handle version negotiation errors (-32022 UnsupportedProtocolVersion, -32020 HeaderMismatch), fall back on JSON-RPC -32601 / HTTP 400·404·405 to the legacy `initialize` flow (protocolVersion 2025-11-25), and never fall back on 401/403/429/5xx. The old Arena-specific prompt builder was removed along with the now-unused `chatPromptZH` field.

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
