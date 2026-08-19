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

## Step 3 — Enable Developer mode in ChatGPT and create a bridge plugin

1. Open [chatgpt.com](https://chatgpt.com/) (or click "Open ChatGPT" in the VS Code panel — AgentBridge opens it in the built-in browser)
2. Click your avatar in the bottom-left corner → **Settings**
3. In Settings, find **Plugins**
4. Scroll down to **Developer mode** and turn the toggle on
5. Click **Plugins** again to enter the plugin library
6. Click the **plus icon** next to the search bar at the top-right to create a new bridge plugin:
   - Name can be anything; description can be left empty
   - Most importantly, paste the MCP address you copied into the URL field
   - Under Authentication, choose **No auth**
   - Click **Create**
7. Once the plugin is created, click **Connect** on the pop-up page

After a successful connection, the session area in the AgentBridge panel shows the tools and actions ChatGPT is invoking in real time.

## Step 4 — Grant permissions

1. On the plugin page, click **Permission**
2. Choose **Allow all actions** — this lets the AI read files, search the project, modify code and run terminals
3. You can also grant only a subset of tools if preferred
4. Refresh the page

## Step 5 — Start using it

1. Start a new conversation
2. Select the plugin you created, or type `@` followed by the plugin name
3. Send the AI a file path from your project and ask it to "read and analyze this file"

The AI does the analysis and decision-making on the web; AgentBridge performs the actual local reads, searches, file edits and terminal commands, writing results straight back into your workspace. The plugin works in both Work and Chat modes without needing an API key (actual usable quota depends on your ChatGPT account and subscription plan).

## Troubleshooting

**The web app doesn't see the tools / reports tools not found**
ChatGPT caches the tool list at session start. After adding or upgrading tools, refresh the page and reconnect the plugin (or Remove and re-add it).

**Can't connect after switching networks or restarting**
The Quick Tunnel address changed — update the URL in the plugin, or switch to a fixed-address provider (Named Tunnel / ngrok).

**ChatGPT still behaves like the old toolset after a tool change**
Same as above: refresh the plugin manually. Restarting Bridge alone is not enough.

**Can the same MCP address be used by multiple web AI models? Any conflicts?**
Yes. At the protocol layer everything is isolated: each client (ChatGPT / Claude / Grok, etc.) gets its own independent MCP session and they don't interfere with each other (capacity up to 64 sessions). But note that they **share the same workspace and tools**:
- If two models `apply_patch` the same file at the same time, the later write overwrites the earlier one (no file locking)
- `run_command` terminal sessions are shared — two models running commands simultaneously and sending input to each other will interleave
- Recommendation: assign one task per model (different files / different terminals), or use them at different times; you can also "Disconnect" a session individually in the panel session list