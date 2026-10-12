# MCP Feedback Collector

English | [简体中文](README.zh-CN.md)

A human-in-the-loop feedback MCP server for Cursor. Instead of ending a turn, the AI opens a local web page, reports what it did, and waits for you. You can reply, paste images, or **insert new instructions while the AI is still working**. One request can carry many rounds of conversation.

> The web UI is in Chinese. Derived from [sanshao85/mcp-feedback-collector-web](https://github.com/sanshao85/mcp-feedback-collector-web) (MIT); this fork keeps only the stdio mode.

## How it works

**stdio only**: Cursor spawns the process itself. No resident service, no port forwarding.

The tools follow an async-handle protocol so no MCP request hangs for long:

| Tool | Purpose |
|---|---|
| `check_pending_instructions` | Take (FIFO) instructions you queued from the web page; returns `NO_PENDING_INSTRUCTIONS` if none |
| `collect_feedback` | Create a session and **return immediately** with `session_id` and the page URL; opens the page |
| `wait_feedback` | Wait for the result, at most 45 s per call; `status: waiting` means call again |
| `poll_feedback` | Query the session right now without waiting |

Statuses: `waiting` / `completed` / `timed_out` / `cancelled` / `not_found` / `error`.

Timeout and circuit breaker: after `MCP_DIALOG_TIMEOUT` seconds the session becomes `timed_out` with an automatic reply; three in a row return "the user has been unresponsive, task over", and the rule tells the AI to stop.

## Install

Node.js 18+.

```bash
git clone https://github.com/sunyixiu/mcp-feedback-collector.git
cd mcp-feedback-collector
npm ci
npm run build
```

### 1. MCP config

Merge [`examples/mcp.json`](examples/mcp.json) into Cursor's MCP config (Windows: `%USERPROFILE%\.cursor\mcp.json`) and set `args` to the absolute path of `dist/cli.js`.

`MCP_TRANSPORT_MODE=stdio` is **required**; without it stdout is not protected and logs corrupt the protocol. Never add `--debug` to the command.

Restart Cursor (or refresh in Settings → MCP). Four tools should appear.

### 2. Install the rule

Without the rule the AI does not know it should call the tool. Pick one:

- **One project**: copy [`rules/feedback-collector.mdc`](rules/feedback-collector.mdc) to `.cursor/rules/` (it already has `alwaysApply: true`).
- **All projects**: Cursor Settings → Rules → User Rules, paste the body of the file (without the front matter).
- **Other tools**: put the body in `AGENTS.md` at the project root.

A Chinese version is in [`rules/feedback-collector.zh-CN.mdc`](rules/feedback-collector.zh-CN.mdc).

### 3. Optional: sound alert (Windows)

Plays a ding when the AI calls `collect_feedback`, so you do not have to watch the screen.

1. Copy the three files in `hooks/` (`feedback-sound.bat`, `feedback-notify.ps1`, `feedback-ding.mp3`) to `%USERPROFILE%\.cursor\hooks\`.
2. Merge [`examples/hooks.json`](examples/hooks.json) into `%USERPROFILE%\.cursor\hooks.json`.

The script only plays the mp3 next to it with PowerShell's `MediaPlayer`; it makes no network calls. Replace `feedback-ding.mp3` to change the sound.

## Web UI

- Fixed URL (default `http://localhost:18053`) that switches to each new session by itself, with sound and title flash.
- "Insert instruction" button: submit while the AI works; it is taken on the next `check_pending_instructions`.
- Drafts drawer (last 10).
- No new tab is opened if a page is already connected. Each Cursor window runs its own process; if the port is taken another one is used, and the real URL is always in the tool result.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `MCP_TRANSPORT_MODE` | — | must be `stdio` |
| `MCP_WEB_PORT` | `5000` | web port, falls back if taken |
| `MCP_SERVER_HOST` | `127.0.0.1` | bind address; the page has no login |
| `MCP_ALLOWED_HOSTS` | empty | extra allowed Host/Origin values (comma separated); `*` disables the check (not advised) |
| `MCP_USE_FIXED_URL` | `false` | keep one stable URL |
| `MCP_DIALOG_TIMEOUT` | `300` | seconds per session (min 10) |
| `MCP_ENABLE_CHAT` / `MCP_ENABLE_IMAGE_TO_TEXT` | `false` | optional features, need `MCP_API_KEY` |
| `MCP_API_KEY` / `MCP_API_BASE_URL` / `MCP_DEFAULT_MODEL` | — | any OpenAI-compatible API |
| `MCP_FEEDBACK_DATA_DIR` | `~/.mcp-feedback-collector` | pending-instruction queue |
| `LOG_LEVEL` | `info` | nothing is written to stdout in stdio mode |
| `MCP_STDIO_DIAG` | off | troubleshooting only: writes `<tmpdir>/mcp-stdio-diag-<pid>.log`, may contain feedback fragments; delete afterwards |

See [`.env.example`](.env.example).

## Security

The page has no login, so:

- It listens on `127.0.0.1` by default.
- HTTP and Socket.IO check `Host` / `Origin`, rejecting cross-site pages and DNS rebinding. Otherwise any web page could inject instructions into an AI that can often run commands.
- If you enable the AI chat feature the API key is served to the local page, so keep the server on localhost.

## Troubleshooting

- **No tools / red dot**: `args` must be an absolute path, run `npm run build`, set `MCP_TRANSPORT_MODE=stdio`.
- **Page never opens**: check the rule is active; use the URL in the `collect_feedback` result (the port may have changed).
- **HTTP mode**: still in the code (`MCP_TRANSPORT_MODE=http`, `/mcp`) but legacy and unsupported.

## Development

```bash
npm run dev
npm test
npm run lint
```

## License

MIT. Original © MCP Feedback Collector Team; changes © sunyixiu. See [LICENSE](LICENSE).
