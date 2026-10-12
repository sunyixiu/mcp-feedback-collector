# collect_feedback 通知：只播提示音，不开浏览器。
# 真实反馈页由 MCP collect_feedback 自己打开（带 session_id 的完整 URL）。
# 以前这里 Start-Process 裸端口首页，会多开一个无 session 的空白页。

Add-Type -AssemblyName presentationCore
$player = New-Object System.Windows.Media.MediaPlayer
$player.Open([uri]"$PSScriptRoot\feedback-ding.mp3")
$player.Volume = 1
$player.Play()
Start-Sleep -Seconds 5
