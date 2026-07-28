Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Folder ini = folder tempat script berada (Desktop\winb-server)
$workDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $workDir
$logFile = Join-Path $workDir "server.log"

function Write-LogSep([string]$msg) {
    Add-Content -Path $logFile -Value "============================================"
    Add-Content -Path $logFile -Value $msg
    Add-Content -Path $logFile -Value "============================================"
}

function Start-WinbNode {
    $procInfo = New-Object System.Diagnostics.ProcessStartInfo
    $procInfo.FileName = "cmd.exe"
    $procInfo.Arguments = "/c node server.js >> server.log 2>&1"
    $procInfo.WorkingDirectory = $workDir
    $procInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $procInfo.CreateNoWindow = $true
    return [System.Diagnostics.Process]::Start($procInfo)
}

# Cek node
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    [System.Windows.Forms.MessageBox]::Show(
        "Node.js belum terpasang.`nInstall dulu dari https://nodejs.org (LTS), lalu jalankan INSTALL-SEKALI.bat lagi.",
        "WinB - Node.js missing",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    )
    exit 1
}

# Cek dependencies
if (-not (Test-Path (Join-Path $workDir "node_modules"))) {
    [System.Windows.Forms.MessageBox]::Show(
        "Folder node_modules belum ada.`nJalankan dulu INSTALL-SEKALI.bat (double-click).",
        "WinB - Belum di-install",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Warning
    )
    exit 1
}

Write-LogSep "Winb Server Started at $(Get-Date)  dir=$workDir"
$proc = Start-WinbNode

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon((Get-Process -Id $PID).Path)
$notifyIcon.Text = "WinB Server (Port 5110)"
$notifyIcon.Visible = $true

$contextMenu = New-Object System.Windows.Forms.ContextMenu

$menuLogs = New-Object System.Windows.Forms.MenuItem
$menuLogs.Text = "View Logs"
$menuLogs.add_Click({
    $tail = Join-Path $workDir "tail-log.ps1"
    Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -NoExit -File `"$tail`""
})

$menuRestart = New-Object System.Windows.Forms.MenuItem
$menuRestart.Text = "Restart Server (Hard)"
$menuRestart.add_Click({
    $result = [System.Windows.Forms.MessageBox]::Show(
        "Restart WinB Server?`n`nWARNING: background jobs managed by WinB will be killed.",
        "Confirm Restart",
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Warning
    )
    if ($result -eq [System.Windows.Forms.DialogResult]::Yes) {
        Stop-Process -Name "node" -Force -ErrorAction SilentlyContinue
        if ($proc -and -not $proc.HasExited) {
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        }
        Write-LogSep "Winb Server (HARD RESTART) at $(Get-Date)"
        $proc = Start-WinbNode
    }
})

$menuExit = New-Object System.Windows.Forms.MenuItem
$menuExit.Text = "Exit WinB Server"
$menuExit.add_Click({
    Stop-Process -Name "node" -Force -ErrorAction SilentlyContinue
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
    $notifyIcon.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})

$contextMenu.MenuItems.Add($menuLogs) | Out-Null
$contextMenu.MenuItems.Add($menuRestart) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null
$contextMenu.MenuItems.Add($menuExit) | Out-Null
$notifyIcon.ContextMenu = $contextMenu

$notifyIcon.add_DoubleClick({
    $tail = Join-Path $workDir "tail-log.ps1"
    Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -NoExit -File `"$tail`""
})

Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
} | Out-Null

[System.Windows.Forms.Application]::Run()
