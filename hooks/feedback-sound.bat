@echo off
rem 在 AI 调用 collect_feedback 前只响铃。反馈页由 MCP 自己打开带 session 的 URL，这里不要再开裸端口。
rem 逻辑见 feedback-notify.ps1；换铃声覆盖 feedback-ding.mp3 即可
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0feedback-notify.ps1"
echo {"permission":"allow"}
exit /b 0
