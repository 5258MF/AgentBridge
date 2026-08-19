# Cloudflare Named Tunnel 配置指南

> 对应 AgentBridge 面板「配置 Cloudflare Named Tunnel」的 4 步教程(子域与域名请替换为你自己的托管域名)。

## Step 1 — 安装或更新 cloudflared

打开任意 Windows PowerShell 终端(开始菜单搜「PowerShell」/ Windows Terminal / VS Code 集成终端),粘贴执行:

```powershell
winget install --id Cloudflare.cloudflared --exact --accept-package-agreements --accept-source-agreements
```

装好后验证:

```powershell
cloudflared --version
```

输出 `Cloudflare Cloudflared version 2024.x.x` 即安装成功。

后续更新:

```powershell
winget upgrade --id Cloudflare.cloudflared --exact --accept-package-agreements --accept-source-agreements
```

## Step 2 — 创建或打开 Cloudflare Tunnel 并复制 Token

1. 点击面板「打开 Cloudflare Tunnels」,进入 dash.cloudflare.com 的 Tunnels 列表
2. 点「创建隧道」
3. 输入隧道名称(如 temp / agentbridge),再点「创建隧道」
4. 在「设置环境」页选择操作系统 + 架构(这里默认设置即可)
5. 在「安装并运行」的命令 `cloudflared.exe service install <your-tunnel-token>` 中,末尾那串 base64 就是 Tunnel Token
6. 只复制 Token 粘贴到 AgentBridge 面板,**不要执行这条 service install 命令**(会把 cloudflared 装成系统服务,与 AgentBridge 冲突)
7. 页面「连接状态:正在等待您的隧道连接...」是正常的,Start Bridge 后会自动连上

## Step 3 — 添加发布的应用路由

1. 复制完 Token 后,在当前页面点「取消」,回到 dash.cloudflare.com 的 Tunnels 列表
2. 点击刚才创建的隧道
3. 点「路由」标签 → 点「添加路由」
4. 点「已发布的应用程序」
5. 配置:
   - 子域:`mcp`
   - 域:选择已托管到 Cloudflare 的域名(`example.com`)
   - 服务 URL:`http://127.0.0.1:48271`
6. 点「添加路由」完成

注意:

- 端口 `48271` 要与 AgentBridge 面板「固定本地端口」一致
- 服务 URL 必须带 `http://` 前缀,否则 cloudflared 502
- 子域(`mcp`)可随意换,只要 AgentBridge 面板「公网主机名」填的一致即可;`/mcp/` 路径是固定的,不受子域影响

## Step 4 — 检查主机名 DNS 记录

1. 点击面板「打开 Cloudflare DNS」,进入 DNS Records
2. 确认存在 CNAME:`mcp.example.com → <tunnel-uuid>.cfargotunnel.com`,状态为 Proxied(橙云)
3. 没有则手动添加:

   | Type | Name | Target | Proxy status |
   |---|---|---|---|
   | CNAME | `mcp` | `<tunnel-uuid>.cfargotunnel.com` | Proxied (橙云) |

## 面板剩余 4 field

| Field | 填什么 | 说明 |
|---|---|---|
| 公网主机名 | `mcp.example.com` | 与 Step 3 的 Subdomain + Domain 一致 |
| Tunnel Token | 粘贴 Step 2 复制的 Token | 加密存储,不写入 settings.json |
| 固定本地端口 | `48271`(默认) | 与 Step 3 的 Port 一致 |
| Cloudflare Service URL | 自动显示,不用改 | `http://127.0.0.1:<端口>` |

点 **保存 Named Tunnel**。

## Start Bridge + 验证

1. 点 `Start Bridge`,状态变为在线,公网 URL:

   ```
   https://mcp.example.com/mcp/<routeToken>
   ```
2. 验证(PowerShell 下用 `curl.exe`,单行执行,`\` 续行在 PowerShell 无效):

   ```powershell
   curl.exe -i -X POST "https://mcp.example.com/mcp/<routeToken>" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
   ```

   返回 200 + 响应头含 `Mcp-Session-Id` 即正常。注意:Streamable HTTP 的 GET 必须先 POST initialize 建立会话,直接 GET 会返回 400 `Mcp-Session-Id header is required`;POST 不带会话头但非 initialize 也会 400 — 这些报错本身说明隧道已通、请求已到达 AgentBridge

## routeToken rotate

AgentBridge 面板 → 高级卡 → 「重置 MCP 地址」→ 生成新 URL(旧 URL 立即失效)。域名与 Tunnel Token 不变,客户端只需更新 URL 的 `/<routeToken>` 段。

## 安全提示

- routeToken 泄露 = 任何人可调用你的 MCP 工具,不要公开或提交 URL
- Tunnel Token 泄露 = 隧道被劫持,立即在 CF dashboard rotate
- 不要执行 `cloudflared service install`(与 AgentBridge 冲突)

---

**最后更新**:2026-08-19(v0.1.0 时期复现)
