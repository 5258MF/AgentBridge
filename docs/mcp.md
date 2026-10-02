# 接入外部 MCP 服务器

AgentBridge 可以连接其他 MCP 服务器，把它们的工具和原来的 16 个内置工具一起提供给网页 AI。网页 AI 仍然只连接当前 Bridge 的 MCP 地址。

```text
网页 AI → 当前工作区的 AgentBridge → 内置工具
                                 → 本地 stdio MCP 进程
                                 → 远程 Streamable HTTP MCP 服务
```

## 配置入口

在 AgentBridge 面板展开「外部 MCP 服务器」，选择「用户配置」或「工作区配置」。按钮会创建空配置并在 VS Code 编辑器中打开：

- 用户配置：`~/.agentbridge/mcp.json`，供不同工作区使用。
- 工作区配置：`<工作区>/.agentbridge/mcp.json`，只用于当前工作区。

配置使用标准 JSON。工作区的同名条目整体覆盖用户条目，不逐字段合并；多文件夹工作区按文件夹顺序，前面的同名条目优先。每个条目旁的「编辑配置」打开实际生效的文件。配置保存、创建或删除后自动重新加载，也可以点击「重新加载配置」。有错误的条目显示原因，其他有效条目和内置工具继续可用。

## 本地 stdio 示例

```json
{
  "mcpServers": {
    "local": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/tools/mcp-server.js"],
      "cwd": "${workspaceFolder}",
      "env": {
        "SERVICE_TOKEN": "${secret:service_token}"
      },
      "timeout": 60,
      "connectTimeout": 10,
      "planMode": "read-only"
    }
  }
}
```

先准备实际的 MCP 服务脚本；示例路径不会自动下载或创建服务器。`command` 是可执行文件，参数放在 `args`，不填写整段 shell 命令。也可以使用已安装的 `npx`、`uvx` 等启动器。服务进程必须使用标准输入／输出传输 MCP 消息，日志写到标准错误。stderr 会显示在 AgentBridge 输出面板中。

默认工作目录是配置所属工作区文件夹；用户配置使用当前工作区的第一个文件夹。没有工作区时使用用户目录。相对 `cwd` 从这个目录解析。子进程由 MCP SDK 提供基础环境，再叠加 `env`；服务需要的其他变量应明确配置或引用宿主环境变量。

## 远程 Streamable HTTP 示例

```json
{
  "mcpServers": {
    "docs": {
      "type": "http",
      "url": "https://your-mcp-server.example/mcp",
      "headers": {
        "Authorization": "Bearer ${secret:docs_token}"
      },
      "tools": ["search", "read_document"],
      "planMode": "read-only"
    }
  }
}
```

将地址替换为实际的 Streamable HTTP MCP 接口。`http` 和 `streamable-http` 都可作为 HTTP 类型；省略 `type` 时根据 `command` 或 `url` 推断。地址仅支持 HTTP(S)，不能在 URL 中嵌入用户名、密码或 fragment。填写最终接口地址，连接不会跟随 HTTP 重定向，以免将自定义鉴权头传到其他地址。鉴权使用服务要求的 HTTP headers；目前不执行 OAuth 登录流程。

`tools` 是上游工具原名的允许列表：省略时暴露全部发现的工具，`[]` 时不暴露工具。示例中的工具名需要替换为服务器实际提供的名称。

## 凭据和变量

点击面板中的「设置凭据」，输入名称和密码框中的值。凭据保存在 VS Code SecretStorage；配置文件写引用，例如 `${secret:docs_token}`。再次设置同名凭据会更新它，并重新连接引用它的服务。凭据不会放进面板状态或写回配置文件。

错误和 stderr 日志会隐藏已解析的配置变量、env/header 值及多行凭据的各行。为保护短凭据，一两个字符的配置值也会被替换，因此普通日志中相同字符可能被过度隐藏。stderr 按 UTF-8 完整行处理，超过 64 KiB 的行整体省略。

配置字符串支持以下变量，替换一次，不把替换结果再次当作表达式处理：

| 写法 | 含义 |
|---|---|
| `${workspaceFolder}` | 配置所属工作区文件夹；用户配置使用第一个工作区文件夹 |
| `${userHome}` | 用户目录 |
| `${TOKEN}` 或 `${env:TOKEN}` | VS Code 扩展宿主进程中的环境变量 |
| `${secret:token}` | 名为 `token` 的已存储凭据 |

变量可用于 `command`、`args`、`env`、`cwd`、`url` 和 `headers` 的值。缺少引用变量时连接失败并显示变量名。`command`、`args` 和 `cwd` 的开头还支持 `~/` 或 `~\`。SecretStorage 凭据名允许字母、数字、下划线、点和连字符，长度 1–80。

## 工具和 Plan 模式

上游 `docs` 服务的 `search` 工具通常显示为 `mcp__docs__search`。名称最多 64 个字符；包含特殊字符、歧义下划线或过长时会附加稳定的摘要，保持不同工具的身份。调用时 AgentBridge 转发上游原名和参数，保留工具 schema、annotations、返回文本、图片、资源内容、结构化结果、metadata 和 `isError`。调用结果显示在现有工具活动时间线中；`isError: true` 会计入失败统计。

外部服务器提供的 instructions 会在每个网页 AI 连接第一次调用该服务器的工具时附带到结果中，上限 16,384 字符。其他服务器的工具不受这段说明影响。

每个服务器可以配置 `planMode`：

| 值 | Plan 模式下的行为 |
|---|---|
| `read-only`（默认） | 只允许 annotations 中 `readOnlyHint: true` 的工具 |
| `all` | 允许该服务器全部已暴露的工具 |
| `disabled` | 拒绝该服务器全部工具调用 |

只读声明来自外部服务器，AgentBridge 不检查其内部实现。外部工具的文件、网络和账户权限由外部服务器自身决定；AgentBridge 内置文件工具的工作区路径限制不作用于外部进程。Build 模式允许调用当前启用服务器的工具。切换 Plan／Build 不改变工具列表。

## 连接生命周期

扩展启动时只加载配置；点击 Start 启动 Bridge 后才连接远程服务或启动本地进程。未受信任的工作区不连接外部服务。Stop 和扩展停用会取消正在进行的调用并关闭连接；有状态 HTTP 服务会先尝试用 DELETE 终止会话，最多等待 3 秒，然后关闭本地传输。服务器可以拒绝终止会话，此时远程清理由它自身决定。Windows 本地进程使用进程树清理，其他系统使用 SDK 的进程关闭流程。

同一个 Bridge 的网页 AI 连接共用一组外部 MCP 连接。不同工作区的 Bridge 分别管理连接和面板启停状态。用户配置可以共享，但不同 Bridge 会各自启动本地进程、连接远程服务；远程服务器自身的数据隔离由该服务器决定。

面板启用／禁用设置保存在当前 VS Code 工作区存储中，优先于配置文件的 `enabled` 字段，不修改配置文件。禁用会移除该服务的工具并关闭连接；启用后按 Bridge 当前状态决定是否连接。点击「重连」会重建连接并重新发现工具。

连接或发现工具默认限时 10 秒，每次工具调用默认限时 60 秒；分别用 `connectTimeout` 和 `timeout` 调整，单位秒，范围大于 0 且不超过 3600。工具进度消息不延长截止时间。调用取消和超时会通知上游取消，并单独关闭对应 HTTP 请求流，保留同一连接上的其他调用；外部服务器是否实际停止操作由其实现决定。

连接断开或 HTTP 会话返回 404 后最多自动重试 5 次，间隔为 1、2、4、8、16 秒，成功连接后重置次数。重试期间保留已知工具列表，调用会明确报告连接不可用。达到重试上限后可手动重连。工具调用失败不会自动重放，避免重复执行写入操作。

工具列表变化会发送 MCP `tools/list_changed` 通知。网页 AI 若缓存工具列表或不处理通知，需要在客户端刷新 MCP 工具；例如 ChatGPT Connectors 中执行 Refresh 或重新添加连接。服务连接较慢时内置工具仍可使用，后续发现的外部工具通过通知提供。

## 当前支持范围

本版本提供工具发现、分页、列表变更和工具调用代理，并向支持 roots 的服务器提供对应工作区文件夹。工具返回的资源 block/link 会正常转发；单独的 `resources/list`、`resources/read` 和 prompts 接口尚未代理。旧式 SSE、OAuth、sampling、elicitation 和 MCP tasks 尚未支持。

每个配置文件最大 1 MiB、32 个服务器，合并后每个 Bridge 最多 32 个服务器；每个服务器最多发现 32 页、1024 个工具。VS Code 会为 `.agentbridge/mcp.json` 自动加载配置 schema，提示字段和类型错误。工作区中的 `.agentbridge` 和 `.agents` 目录不会加入扩展安装包。
