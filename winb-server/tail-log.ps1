$workDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logFile = Join-Path $workDir "server.log"

$Host.UI.RawUI.WindowTitle = "WinB Server - Realtime Log"
Write-Host "Monitoring WinB log: $logFile" -ForegroundColor Cyan
Write-Host "Ctrl+C to close" -ForegroundColor DarkGray
Write-Host "------------------------------------------------------" -ForegroundColor DarkGray

if (-not (Test-Path $logFile)) {
    New-Item -ItemType File -Path $logFile -Force | Out-Null
}

Get-Content -Path $logFile -Wait -Tail 20
