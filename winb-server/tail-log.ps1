$logFile = "F:\AliceWorkspace\winb-server\server.log"

$Host.UI.RawUI.WindowTitle = "Winb Server - Realtime Log"

Write-Host "Monitoring Winb Server Log... (Press Ctrl+C to close)" -ForegroundColor Cyan
Write-Host "------------------------------------------------------" -ForegroundColor DarkGray

Get-Content -Path $logFile -Wait -Tail 20
