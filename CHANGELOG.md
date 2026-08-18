# Change Log

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
