# Changelog

## 2.3.0

- stdio only; async `collect_feedback` / `wait_feedback` / `poll_feedback` protocol and `check_pending_instructions`.
- Security: bind to `127.0.0.1` by default; `Host` / `Origin` allow-list for HTTP and Socket.IO (`MCP_ALLOWED_HOSTS`).
- The stdio diagnostic log is now off by default (`MCP_STDIO_DIAG=true` to enable) and redacts secrets.
- Removed hard-coded server addresses, promo links and Windows-service scripts.
- Added rules, example configs and an optional Windows sound-alert hook.
