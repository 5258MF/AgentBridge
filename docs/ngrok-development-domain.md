# ngrok 开发域名配置指南

> 使用 ngrok 账号分配的固定 HTTPS 开发域名，把 AgentBridge 暴露为重启后仍可复用的公网 MCP 地址。本文以 Windows 为例，完成 ngrok 安装、开发域名、Authtoken、检查、启动与验证。

## Step 1 — 选择 ngrok 并安装客户端

1. 在 VS Code 中打开要交给远程 AI 使用的项目文件夹
2. 左侧活动栏打开 AgentBridge 面板；如果 Bridge 正在运行，先点 **Stop Bridge**
3. 在「隧道供应商」中选择 `ngrok 开发域名（固定地址）`
4. 展开「配置 ngrok」
5. 在 Windows PowerShell 或 VS Code 集成终端执行面板提供的安装命令：

   ```powershell
   winget install --id 9MVS1J51GMK6 --source msstore --accept-package-agreements --accept-source-agreements
   ```

后续更新：

```powershell
winget upgrade --id 9MVS1J51GMK6 --source msstore --accept-package-agreements --accept-source-agreements
```

安装完成后**完全重启 VS Code**，让 Extension Host 重新读取 `ngrok` 命令。macOS / Linux 请按 [ngrok 官方下载页](https://ngrok.com/download) 安装，并确保 `ngrok` 位于 `PATH` 中。

## Step 2 — 获取固定开发域名

1. 在面板「配置 ngrok」中点击 **打开 Domains 页面**，或直接访问 [dashboard.ngrok.com/domains](https://dashboard.ngrok.com/domains)
2. 首次使用时注册或登录 ngrok 账号
3. 在 Domains 页面找到账号分配的固定开发域名
4. 复制完整主机名，形式通常类似：

   ```text
   your-name.ngrok-free.dev
   ```

5. 返回 AgentBridge 面板，把它粘贴到 `ngrok 域名` 输入框

只填写主机名，不要附带 `https://`、端口、路径、查询参数或结尾的 `/`。以你自己的 ngrok dashboard 实际分配值为准，域名后缀可能随账号或套餐变化。

## Step 3 — 配置 ngrok Authtoken

1. 打开 [ngrok Authtoken 页面](https://dashboard.ngrok.com/get-started/your-authtoken)
2. 复制页面为当前账号生成的完整配置命令，或把 Token 替换进：

   ```powershell
   ngrok config add-authtoken <YOUR_AUTHTOKEN>
   ```

3. 在 VS Code 中打开 `Terminal → New Terminal`
4. 粘贴并执行命令

`<YOUR_AUTHTOKEN>` 只是占位符，不能原样执行。AgentBridge 不保存 ngrok Authtoken；该命令由 ngrok CLI 写入其用户配置文件。

> 如果 ngrok 登录页在 VS Code Simple Browser 中无法完成登录，请在 AgentBridge 高级设置把「打开方式」临时切为「全部外跳」，或直接用系统浏览器打开上述页面。

## Step 4 — 验证安装、账号配置和域名

在 PowerShell 中执行：

```powershell
ngrok version; ngrok config check
```

预期结果：

- `ngrok version` 输出当前版本
- `ngrok config check` 返回配置有效，并显示配置文件位置

然后回到 AgentBridge 面板：

1. 确认 `ngrok 域名` 已填写
2. 点击 **检查隧道**
3. 状态应显示 ngrok 已安装、配置有效并且固定域名已就绪

## Step 5 — 启动 Bridge 并复制固定 MCP 地址

1. 点击 **Start Bridge**
2. AgentBridge 会自动启动本地 MCP 服务，并运行等价于以下形式的 ngrok 命令：

   ```text
   ngrok http <动态本地端口> --url https://<你的固定域名>
   ```

   本地端口由 AgentBridge 自动分配，无需手动填写。
3. 等待面板状态变为在线
4. 公网 MCP 地址形如：

   ```text
   https://your-name.ngrok-free.dev/mcp/<routeToken>
   ```

5. 点击「复制 MCP 地址」，再添加到 ChatGPT、Arena 或其他支持 Streamable HTTP MCP 的客户端

只要继续使用同一个 ngrok 开发域名且没有重置 routeToken，停止或重启 Bridge 后公网 MCP 地址通常保持不变。

## 验证公网 MCP 端点

PowerShell 下使用 `curl.exe`，单行执行：

```powershell
curl.exe -i -X POST "https://your-name.ngrok-free.dev/mcp/<routeToken>" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "MCP-Protocol-Version: 2025-11-25" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

返回 HTTP 200，并且响应头包含 `Mcp-Session-Id`，说明公网请求已经通过 ngrok 到达 AgentBridge。

## 常见问题

**面板提示 `ngrok was not found`**  
安装后完全退出并重开 VS Code，再执行 `Get-Command ngrok`。仍找不到时重新运行 Step 1，或按 ngrok 官方方式安装并加入 `PATH`。

**`ngrok config check` 失败**  
重新从当前账号的 Authtoken 页面复制完整命令并执行。不要混用其他账号的 Token。

**域名输入后仍提示需要配置**  
只粘贴 Domains 页面分配的主机名，例如 `your-name.ngrok-free.dev`；不要粘贴完整 MCP URL，也不要带协议、路径或端口。

**启动时报域名或授权错误**  
确认固定域名和 Authtoken 属于同一个 ngrok 账号，并查看 `AgentBridge: Show Output` 中的 `[ngrok]` 日志。套餐额度和可用域名以 ngrok dashboard 当前显示为准。

**网页端仍看不到最新工具**  
客户端可能缓存了 `tools/list`。ChatGPT 网页版需要在 Connector 设置中 Refresh，或 Remove 后重新 Add；仅 Stop + Start Bridge 不够。

## 安全提示

- ngrok Authtoken 等同账号凭证，不要发给 AI、写进教程截图或提交到仓库；泄露后立即在 ngrok dashboard 中轮换
- 完整 MCP URL 中的 routeToken 可以调用工作区工具，不要公开分享；泄露后在 AgentBridge 高级设置中「重置 MCP 地址」
- 固定域名本身可以公开，但不要把固定域名和 routeToken 组合后的完整 MCP URL 公开
- AgentBridge 允许远程客户端修改文件和执行命令，只连接你信任的 AI 客户端

---

**最后更新**：2026-08-20（按当前 AgentBridge 0.1.3 源码复核）
