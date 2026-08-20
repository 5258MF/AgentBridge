# ngrok Development Domain Setup Guide

> Use the fixed HTTPS development domain assigned to your ngrok account to expose AgentBridge at a public MCP address that can be reused after restarts. This Windows-focused guide covers installation, domain setup, Authtoken configuration, checks, startup, and verification.

## Step 1 — Select ngrok and install the client

1. Open the project folder you want a remote AI to work with in VS Code
2. Open the AgentBridge panel from the Activity Bar; if Bridge is running, click **Stop Bridge** first
3. Under Tunnel Provider, select `ngrok dev domain (fixed address)`
4. Expand `Configure ngrok`
5. Run the install command shown in the panel from Windows PowerShell or the VS Code integrated terminal:

   ```powershell
   winget install --id 9MVS1J51GMK6 --source msstore --accept-package-agreements --accept-source-agreements
   ```

To update later:

```powershell
winget upgrade --id 9MVS1J51GMK6 --source msstore --accept-package-agreements --accept-source-agreements
```

After installation, **fully restart VS Code** so the Extension Host reloads the `ngrok` command. On macOS / Linux, install from the [official ngrok download page](https://ngrok.com/download) and make sure `ngrok` is on `PATH`.

## Step 2 — Get a fixed development domain

1. In the panel's `Configure ngrok` section, click **Open Domains page**, or visit [dashboard.ngrok.com/domains](https://dashboard.ngrok.com/domains)
2. Sign up or log in if this is your first time using ngrok
3. Find the fixed development domain assigned to your account
4. Copy the full hostname, usually in a form similar to:

   ```text
   your-name.ngrok-free.dev
   ```

5. Return to the AgentBridge panel and paste it into the `ngrok Domain` field

Enter the hostname only. Do not include `https://`, a port, path, query string, or trailing `/`. Use the exact value assigned in your own ngrok dashboard; the suffix may vary by account or plan.

## Step 3 — Configure the ngrok Authtoken

1. Open the [ngrok Authtoken page](https://dashboard.ngrok.com/get-started/your-authtoken)
2. Copy the complete configuration command generated for your account, or substitute the Token into:

   ```powershell
   ngrok config add-authtoken <YOUR_AUTHTOKEN>
   ```

3. In VS Code, open `Terminal → New Terminal`
4. Paste and run the command

`<YOUR_AUTHTOKEN>` is a placeholder and must not be run literally. AgentBridge does not store the ngrok Authtoken; the ngrok CLI writes it to the user's ngrok configuration file.

> If the ngrok login flow cannot finish inside VS Code Simple Browser, temporarily set AgentBridge's advanced `Open Mode` to `External All`, or open the page directly in your OS browser.

## Step 4 — Verify the installation, account configuration, and domain

Run in PowerShell:

```powershell
ngrok version; ngrok config check
```

Expected results:

- `ngrok version` prints the installed version
- `ngrok config check` reports a valid configuration and shows the config-file location

Then return to the AgentBridge panel:

1. Confirm that `ngrok Domain` is filled in
2. Click **Check Tunnel**
3. The status should show that ngrok is installed, the configuration is valid, and the fixed domain is ready

## Step 5 — Start Bridge and copy the fixed MCP address

1. Click **Start Bridge**
2. AgentBridge starts the local MCP service and launches an ngrok command equivalent to:

   ```text
   ngrok http <dynamic-local-port> --url https://<your-fixed-domain>
   ```

   AgentBridge allocates the local port automatically; you do not need to enter one.
3. Wait for the panel status to turn online
4. The public MCP address has this form:

   ```text
   https://your-name.ngrok-free.dev/mcp/<routeToken>
   ```

5. Click `Copy MCP address`, then add it to ChatGPT, Arena, or another client that supports Streamable HTTP MCP

As long as you keep using the same ngrok development domain and do not rotate the routeToken, the public MCP address normally stays unchanged after stopping or restarting Bridge.

## Verify the public MCP endpoint

Use `curl.exe` from PowerShell and run it on one line:

```powershell
curl.exe -i -X POST "https://your-name.ngrok-free.dev/mcp/<routeToken>" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "MCP-Protocol-Version: 2025-11-25" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

An HTTP 200 response with an `Mcp-Session-Id` header means the public request reached AgentBridge through ngrok.

## Troubleshooting

**The panel reports `ngrok was not found`**  
Fully quit and reopen VS Code after installation, then run `Get-Command ngrok`. If it is still missing, repeat Step 1 or install using ngrok's official instructions and add it to `PATH`.

**`ngrok config check` fails**  
Copy and run the complete command again from the current account's Authtoken page. Do not mix a Token from another account.

**The panel still asks for a domain after you entered one**  
Paste only the hostname assigned on the Domains page, such as `your-name.ngrok-free.dev`. Do not paste the full MCP URL, protocol, path, or port.

**Startup reports a domain or authorization error**  
Confirm that the fixed domain and Authtoken belong to the same ngrok account, then inspect the `[ngrok]` lines in `AgentBridge: Show Output`. Current quotas and available domains depend on the plan shown in your ngrok dashboard.

**The web client still shows the old tool list**  
The client may have cached `tools/list`. For ChatGPT on the web, Refresh the Connector or Remove and re-add it; Stop + Start Bridge alone is not enough.

## Security notes

- Treat the ngrok Authtoken as an account credential. Never send it to an AI, expose it in tutorial screenshots, or commit it; rotate it immediately in the ngrok dashboard if leaked
- The full MCP URL contains a routeToken that can invoke workspace tools. Do not publish it; use `Rotate MCP Address` in AgentBridge's advanced settings if it leaks
- The fixed domain itself may be public, but never publish the complete MCP URL that combines it with the routeToken
- AgentBridge lets remote clients edit files and run commands; connect only AI clients you trust

---

**Last updated**: 2026-08-20 (verified against the current AgentBridge 0.1.3 source)
