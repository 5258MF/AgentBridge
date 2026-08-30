# Cloudflare Named Tunnel Setup Guide

> Mirrors the 4-step tutorial in the AgentBridge panel ("Configure Cloudflare Named Tunnel"). Replace the subdomain and domain with your own Cloudflare-managed domain.

## Step 1 — Install or update cloudflared

The recommended panel flow is to select **Cloudflare Named Tunnel** and click **Check Tunnel** first. If `cloudflared` is missing, AgentBridge offers one-click installation only after confirming Winget (Windows) or Homebrew (macOS) is available; installation success is verified automatically. Linux and systems without a supported installer use the Cloudflare manual installation link in the panel.

For manual Windows installation, open PowerShell or Windows Terminal and paste:

```powershell
winget install --id Cloudflare.cloudflared --exact --accept-package-agreements --accept-source-agreements
```

Verify the installation:

```powershell
cloudflared --version
```

Output `Cloudflare Cloudflared version 2024.x.x` means it installed successfully.

To update later:

```powershell
winget upgrade --id Cloudflare.cloudflared --exact --accept-package-agreements --accept-source-agreements
```

## Step 2 — Create or open a Cloudflare Tunnel and copy the Token

1. Click "Open Cloudflare Tunnels" in the panel to go to the Tunnels list at dash.cloudflare.com
2. Click "Create a tunnel"
3. Enter a tunnel name (e.g. temp / agentbridge), then click "Save tunnel"
4. On the "Configure" page, select the operating system + architecture (defaults are fine)
5. In the "Install and run" command `cloudflared.exe service install <your-tunnel-token>`, the base64 string at the end is the Tunnel Token
6. Copy only the Token and paste it into the AgentBridge panel — **do NOT run this service install command** (it would install cloudflared as a system service and conflict with AgentBridge)
7. The page showing "Connection status: Waiting for your tunnel..." is normal; it will connect automatically once you Start Bridge

## Step 3 — Add a published application route

1. After copying the Token, click "Cancel" on the current page to return to the Tunnels list at dash.cloudflare.com
2. Click the tunnel you just created
3. Click the "Routes" tab → "Add a route"
4. Click "Published applications"
5. Configure:
   - Subdomain: `mcp`
   - Domain: select the domain hosted on Cloudflare (`example.com`)
   - Service URL: `http://127.0.0.1:48271`
6. Click "Add route" to finish

Notes:

- Port `48271` must match the "Fixed local port" in the AgentBridge panel
- The Service URL must include the `http://` prefix, otherwise cloudflared returns 502
- The subdomain (`mcp`) can be anything, as long as it matches the "Public hostname" in the AgentBridge panel; the `/mcp/` path is fixed and independent of the subdomain

## Step 4 — Verify the DNS record

1. Click "Open Cloudflare DNS" in the panel to go to DNS Records
2. Confirm a CNAME exists: `mcp.example.com → <tunnel-uuid>.cfargotunnel.com`, with status Proxied (orange cloud)
3. If missing, add it manually:

   | Type | Name | Target | Proxy status |
   |---|---|---|---|
   | CNAME | `mcp` | `<tunnel-uuid>.cfargotunnel.com` | Proxied (orange cloud) |

## The 4 panel fields

| Field | What to enter | Notes |
|---|---|---|
| Public hostname | `mcp.example.com` | Must match Step 3's Subdomain + Domain |
| Tunnel Token | Paste the Token copied in Step 2 | Stored encrypted; never written to settings.json |
| Fixed local port | `48271` (default) | Must match Step 3's Port |
| Cloudflare Service URL | Shown automatically, no change needed | `http://127.0.0.1:<port>` |

Click **Save Named Tunnel**. Saving or changing this configuration requires a new tunnel check.

## Start Bridge + verify

1. Click **Check Tunnel**. If installation is offered, complete it and wait for automatic verification; resolve any configuration warning before continuing.
2. Click `Start Bridge`; the status turns online and the public URL is:

   ```
   https://mcp.example.com/mcp/<routeToken>
   ```
3. Verify (use `curl.exe` in PowerShell, on a single line; the `\` line continuation does not work in PowerShell):

   ```powershell
   curl.exe -i -X POST "https://mcp.example.com/mcp/<routeToken>" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
   ```

   A 200 response with a `Mcp-Session-Id` header means it works. Note: with Streamable HTTP, a GET must be preceded by a POST initialize to establish the session; a bare GET returns 400 `Mcp-Session-Id header is required`, and a non-initialize POST without a session header also returns 400 — these errors themselves prove the tunnel is up and the request reached AgentBridge.

## Rotating the routeToken

AgentBridge panel → Advanced card → "Reset MCP address" → a new URL is generated (the old URL becomes invalid immediately). The domain and Tunnel Token stay unchanged; clients only need to update the `/<routeToken>` segment of the URL.

## Security notes

- A leaked routeToken lets anyone call your MCP tools; never publish or commit the URL
- A leaked Tunnel Token means your tunnel can be hijacked; rotate it immediately in the CF dashboard
- Never run `cloudflared service install` (it conflicts with AgentBridge)

---

**Last updated**: 2026-08-19 (reproduced during v0.1.0)
