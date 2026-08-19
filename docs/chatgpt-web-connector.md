# ChatGPT 网页版连接 AgentBridge 指南

> 把 VS Code 当前工作区的工具（文件、终端、LSP、诊断、图片）暴露给 ChatGPT 网页版。整个流程只需要两步：本地启动 Bridge → 网页端添加 Connector。

## Step 1 — 安装 AgentBridge 并打开项目

1. 在 VS Code 扩展面板搜索 `VSC AgentBridge` 安装（或从 [Marketplace](https://marketplace.visualstudio.com/items?itemName=agentbridge.vsc-agentbridge) 安装）
2. 打开你要真正使用的项目文件夹（`文件 → 打开文件夹`）
3. 如果提示「是否信任此文件夹中的文件的作者」，选择**信任**——因为后面的文件读取、项目搜索、代码修改、终端运行都围绕当前工作区运行
4. 左侧活动栏点击 AgentBridge 图标打开面板

## Step 2 — 选择隧道方式并启动 Bridge

AgentBridge 提供三种隧道连接方式，面板「隧道供应商」单选，按需选择：

| 方式 | 地址 | 特点 |
|---|---|---|
| Cloudflare Quick Tunnel | 临时（每次重启变化） | 最简单，基本零配置，适合第一次体验 |
| Cloudflare Named Tunnel | 固定域名 | 需要托管域名，长期稳定，首次配置较复杂，见 [Cloudflare Named Tunnel 配置指南](cloudflare-named-tunnel-setup.md) |
| ngrok | 固定地址 | 配置简单、地址固定，延迟略高 |

初次使用推荐 **Cloudflare Quick Tunnel**（面板会自动安装 cloudflared）：

1. 面板「隧道供应商」选 `Cloudflare Quick Tunnel（临时地址）`
2. 点 **Start Bridge**，等待状态变「在线」
3. 公网 MCP 地址形如 `https://xxxx.trycloudflare.com/mcp/<routeToken>`，点「复制 MCP 地址」

> 注意：Quick Tunnel 地址每次重启都会变化，网页端需要重新更新地址。长期使用推荐 Named Tunnel 或 ngrok 固定地址。

## Step 3 — 在 ChatGPT 网页版开启开发者模式并创建桥接插件

1. 打开 [chatgpt.com](https://chatgpt.com/)（也可以在 VS Code 面板点「打开 ChatGPT」，AgentBridge 会用内置浏览器打开）
2. 点击左下角个人头像 → **Settings**（设置）
3. 在设置里找到 **插件 Plugins**
4. 继续向下滑，找到 **Developer mode**（开发者模式），把开关打开
5. 再次点击 **插件 Plugins** 进入插件库
6. 点击右上角搜索栏旁边的**加号**，创建一个新的桥接插件：
   - 名字随意填写，作用描述也可以留空
   - 最重要的是把刚才复制的 MCP 地址粘贴进 URL 输入框
   - 下方认证方式选择 **No auth**
   - 点击 **Create**
7. 等待插件创建成功，再点击自动弹出页面里的 **Connect**

连接成功后，AgentBridge 面板的会话区会实时显示 ChatGPT 正在调用的工具和操作。

## Step 4 — 授予权限

1. 在插件页面点击 **Permission**（权限）
2. 选择 **Allow all actions**（允许全部操作）——放开后 AI 才能读取文件、搜索项目、修改代码、运行终端
3. 也可以按需只授权部分工具
4. 刷新页面

## Step 5 — 开始使用

1. 新建一个对话
2. 直接选择刚才创建的插件，或在输入框输入 `@` 加插件名称
3. 把项目里的文件路径发给 AI，让它「读取并分析这个文件」

AI 会在网页端完成分析和决策，AgentBridge 负责真正在本地读取、搜索、修改文件并执行终端命令，修改结果直接写回工作区。这个插件在 Work 和 Chat 模式里都可以使用，不需要另外配置 API Key（实际可用额度以你的 ChatGPT 账号和订阅方案为准）。

## 常见问题

**网页端看不到工具/报工具不存在**
ChatGPT 网页端在会话启动时缓存工具列表。新增或升级工具后，需要刷新页面并重新连接插件（或 Remove 后重新 Add）。

**换了网络/重启后连不上**
Quick Tunnel 地址变化了，在插件里更新 URL 为新地址，或改用固定地址方式（Named Tunnel / ngrok）。

**修改工具后 ChatGPT 端还是旧行为**
同上，手动刷新插件即可，仅重启 Bridge 不够。