# MCP Feedback Collector

[English](README.md) | 简体中文

给 Cursor 用的「人在回路」反馈 MCP 服务。AI 每轮干完活，不直接结束，而是弹出一个本地网页向你汇报；你可以在网页里回复、贴图，或者在 AI 干活期间**随时插入临时任务**。一次请求里可以连续多轮对话。

> 网页界面是中文。本项目基于 [sanshao85/mcp-feedback-collector-web](https://github.com/sanshao85/mcp-feedback-collector-web)（MIT）改造，只保留 stdio 模式。

## 工作方式

只使用 **stdio** 传输：Cursor 自己启动子进程，不需要常驻服务、不需要端口转发。

工具是「异步句柄」协议，不会让 MCP 请求长时间挂着：

| 工具 | 作用 |
|---|---|
| `check_pending_instructions` | 取走（先进先出）你在网页里“插入临时任务”留下的指令；没有则返回 `NO_PENDING_INSTRUCTIONS` |
| `collect_feedback` | 创建反馈会话，**立刻返回** `session_id` 和网页地址，并自动打开网页 |
| `wait_feedback` | 等待会话结果，每次最多 45 秒；仍在等返回 `status: waiting` |
| `poll_feedback` | 立即查询会话状态，不等待 |

会话状态：`waiting` / `completed` / `timed_out` / `cancelled` / `not_found` / `error`。

超时与熔断：超过 `MCP_DIALOG_TIMEOUT` 秒没回复 → `timed_out`，服务端自动代答“用户暂时未回复（连续第 N/30 次超时）”，AI 可以重新调用 `collect_feedback` 继续等；连续 30 次（默认，可用 `MCP_MAX_CONSECUTIVE_TIMEOUTS` 调整）都没回复 → 返回“用户长时间未响应，任务结束”，规则会要求 AI 停止。你一回复，计数就清零。

## 安装

需要 Node.js 18+。

```bash
git clone https://github.com/sunyixiu/mcp-feedback-collector.git
cd mcp-feedback-collector
npm ci
npm run build
```

### 1. 配置 MCP

把 [`examples/mcp.json`](examples/mcp.json) 的内容合并到 Cursor 的 MCP 配置（Windows：`%USERPROFILE%\.cursor\mcp.json`），并把 `args` 里的路径改成你本机 `dist/cli.js` 的绝对路径。

**必须**设置 `MCP_TRANSPORT_MODE=stdio`，否则 stdout 不会被保护，协议会被日志污染。不要给启动命令加 `--debug`。

重启 Cursor（或在 Settings → MCP 里刷新），看到 4 个工具即成功。

### 2. 安装规则（让 AI 每轮都调用它）

没有规则，AI 不知道要调用这个工具。三种方式任选：

- **整个项目生效**：把 [`rules/feedback-collector.zh-CN.mdc`](rules/feedback-collector.zh-CN.mdc) 复制到项目的 `.cursor/rules/`（文件头已带 `alwaysApply: true`）。
- **所有项目生效**：打开 Cursor Settings → Rules → User Rules，把该文件去掉头部 `---` 段后的正文粘贴进去。
- **其它工具**：把正文放进项目根目录的 `AGENTS.md`。

英文版见 [`rules/feedback-collector.mdc`](rules/feedback-collector.mdc)。

### 3. （可选）提示音

AI 调用 `collect_feedback` 时播放一声提示音，这样你不用一直盯着屏幕。仅 Windows。

1. 把 `hooks/` 里的三个文件（`feedback-sound.bat`、`feedback-notify.ps1`、`feedback-ding.mp3`）复制到 `%USERPROFILE%\.cursor\hooks\`。
2. 把 [`examples/hooks.json`](examples/hooks.json) 合并进 `%USERPROFILE%\.cursor\hooks.json`。

脚本只用 PowerShell 的 `MediaPlayer` 播放同目录下的 mp3，不联网。想换声音，替换 `feedback-ding.mp3` 即可。

## 网页界面

- 固定地址（默认 `http://localhost:18053`），新会话到来时页面自己切换，并有提示音/标题闪烁。
- 「📥 插入临时任务」按钮：AI 工作期间提交指令，下次它调用 `check_pending_instructions` 时取走。
- 草稿抽屉：保留最近 10 条草稿。
- 已有页面连着时不会重复弹新标签。多个 Cursor 窗口各自启动一个进程，端口被占会自动换端口，真实地址始终在工具返回里。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `MCP_TRANSPORT_MODE` | — | 必须为 `stdio` |
| `MCP_WEB_PORT` | `5000` | 网页端口，被占用时自动换 |
| `MCP_SERVER_HOST` | `127.0.0.1` | 监听地址。网页没有登录，不要对不可信网络开放 |
| `MCP_ALLOWED_HOSTS` | 空 | 额外允许的 Host/Origin（逗号分隔，`host` 或 `host:port`）；`*` 关闭检查（不推荐） |
| `MCP_USE_FIXED_URL` | `false` | 保持固定网址，页面自己切换会话 |
| `MCP_DIALOG_TIMEOUT` | `300` | 单个会话等待秒数（最小 10） |
| `MCP_MAX_CONSECUTIVE_TIMEOUTS` | `30` | 连续多少次超时后熔断，通知 AI 结束任务 |
| `MCP_ENABLE_CHAT` / `MCP_ENABLE_IMAGE_TO_TEXT` | `false` | 可选的 AI 对话 / 图片转文字，需要 `MCP_API_KEY` |
| `MCP_API_KEY` / `MCP_API_BASE_URL` / `MCP_DEFAULT_MODEL` | — | 任意 OpenAI 兼容接口 |
| `MCP_FEEDBACK_DATA_DIR` | `~/.mcp-feedback-collector` | 临时指令队列存放位置 |
| `LOG_LEVEL` | `info` | stdio 模式下日志不会写 stdout |
| `MCP_STDIO_DIAG` | 关 | 仅排障：把进程事件写到 `<临时目录>/mcp-stdio-diag-<pid>.log`，可能含反馈片段，用完请删除 |

完整示例见 [`.env.example`](.env.example)。

## 安全说明

网页没有登录，所以做了这些限制：

- 默认只监听 `127.0.0.1`。
- HTTP 和 Socket.IO 都校验 `Host` / `Origin`，拒绝跨站网页和 DNS 重绑定。否则任何网页都可能往你的 AI 里注入“临时指令”，而 AI 往往能执行命令。
- 如果开启了 AI 对话功能，API Key 会下发给本地网页，所以请保持只监听本机。

## 常见问题

- **工具没出现 / 红点**：确认 `args` 是绝对路径、已经 `npm run build`、`MCP_TRANSPORT_MODE=stdio`。
- **AI 没有弹网页**：检查规则是否生效（新对话里 AI 会在结束前调用工具）。
- **打不开页面**：看 `collect_feedback` 返回里的“反馈页面”地址，端口可能被换了。
- **想用旧的 HTTP 模式**：代码里还保留（`MCP_TRANSPORT_MODE=http`，`/mcp`），但不推荐，也不再维护。

## 开发

```bash
npm run dev      # 开发运行
npm test         # 测试
npm run lint
```

## 许可

MIT。原项目版权归 MCP Feedback Collector Team，本仓库改动版权归 sunyixiu，见 [LICENSE](LICENSE)。
