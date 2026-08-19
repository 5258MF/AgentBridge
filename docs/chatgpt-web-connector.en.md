# Connecting the ChatGPT Web App to AgentBridge

> Expose your current VS Code workspace tools (files, terminal, LSP, diagnostics, images) to ChatGPT in the browser. The whole flow is just two steps: start Bridge locally, then add a Connector on the web.

## Step 1 — Install AgentBridge and open your project

1. In the VS Code Extensions panel search for `VSC AgentBridge` and install it (or install from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=agentbridge.vsc-agentbridge))
2. Open the project folder you actually want to work on (`File → Open Folder`)
3. If asked whether you trust the authors of the files in this folder, choose **Trust** — file reading, project search, code modification and terminal execution all run inside the current workspace
4. Click the AgentBridge icon in the Activity Bar to open the panel

## Step 2 — Pick a tunnel and start Bridge

AgentBridge offers three tunnel providers, selected via the "Tunnel Provider" radio group in the panel:

| Provider | Address | Notes |
|---|---|---|
| Cloudflare Quick Tunnel | Temporary (changes every restart) | Simplest, zero config, good for a first try |
| Cloudflare Named Tunnel | Fixed domain | Requires a managed domain, stable long-term, more setup — see [Cloudflare Named Tunnel setup guide](cloudflare-named-tunnel-setup.en.md) |
| ngrok | Fixed address | Easy config, stable address, slightly higher latency |

For the first try, use **Cloudflare Quick Tunnel** (the panel will auto-install cloudflared):

1. In the panel, select `Cloudflare Quick Tunnel (temporary address)` under Tunnel Provider
2. Click **Start Bridge** and wait until the status shows Online
3. The public MCP URL looks like `https://xxxx.trycloudflare.com/mcp/<routeToken>` — click "Copy MCP address"

> Note: Quick Tunnel addresses change on every restart, so the web app needs the URL updated each time. For long-term use, prefer Named Tunnel or ngrok with fixed addresses.

## Step 3 — Add a Connector in ChatGPT

1. Open [chatgpt.com](https://chatgpt.com/) (or click "Open ChatGPT" in the VS Code panel — AgentBridge opens it in the built-in browser)
2. Click your avatar in the bottom-left corner → **Settings**
3. Find **Connectors**
4. Click **Add new connector** in the top-right
5. Paste the MCP address into the URL field and click **Create**
6. Once created, click **Connect**

After a successful connection, the session area in the AgentBridge panel shows the tools and actions ChatGPT is invoking in real time.

## Step 4 — Grant permissions

1. In the Connectors list, find the connector you just created
2. Click **Permission**
3. Choose **Allow all actions** — this lets the AI read files, search the project, modify code and run terminals
4. You can also grant only a subset of tools if preferred

## Step 5 — Start using it

1. Refresh or start a new conversation
2. Select the connector you created, or type `@` followed by the connector name
3. Send the AI a file path from your project and ask it to "read and analyze this file"

The AI does the analysis and decision-making on the web; AgentBridge performs the actual local reads, searches, file edits and terminal commands, writing results straight back into your workspace.

## Troubleshooting

**The web app doesn't see the tools / reports tools not found**
ChatGPT Connectors caches the tool list at session start. After adding or upgrading tools, click **Refresh** on the connector in `Settings → Connectors` (or Remove and re-add it).

**Can't connect after switching networks or restarting**
The Quick Tunnel address changed — update the URL in the Connector, or switch to a fixed-address provider (Named Tunnel / ngrok).

**ChatGPT still behaves like the old toolset after a tool change**
Same as above: refresh the Connector manually. Restarting Bridge alone is not enough.

**Prefer an API instead of the web app?**
Web Connectors work in both Work and Chat modes without any API key. If you prefer an API, you can also use the same MCP address in Claude Desktop / Cursor / Cline with `streamableHttp` transport.