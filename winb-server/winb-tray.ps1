Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Folder = directory containing this script (e.g. Desktop\winb-server)
$workDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $workDir
$logFile = Join-Path $workDir "server.log"
$script:proc = $null

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

function Stop-WinbTree {
    # Kill only the WinB-spawned cmd wrapper + its child tree (not every node.exe on the machine)
    if ($script:proc -and -not $script:proc.HasExited) {
        $pidToKill = $script:proc.Id
        Start-Process -FilePath "taskkill.exe" -ArgumentList "/PID",$pidToKill,"/T","/F" -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue | Out-Null
        try { Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue } catch {}
    }
    $script:proc = $null
}

# Check Node
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    [System.Windows.Forms.MessageBox]::Show(
        "Node.js is not installed.`nInstall LTS from https://nodejs.org, then run INSTALL-SEKALI.bat again.",
        "WinB - Node.js missing",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    )
    exit 1
}

# Check dependencies
if (-not (Test-Path (Join-Path $workDir "node_modules"))) {
    [System.Windows.Forms.MessageBox]::Show(
        "node_modules is missing.`nRun INSTALL-SEKALI.bat first (double-click).",
        "WinB - Not installed yet",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Warning
    )
    exit 1
}

# If server already answering on 5110, do not start a second Node (avoid EADDRINUSE / dual tray chaos)
$alreadyUp = $false
try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:5110/ping" -UseBasicParsing -TimeoutSec 2
    if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300) { $alreadyUp = $true }
} catch { $alreadyUp = $false }

if ($alreadyUp) {
    Write-LogSep "WinB tray attached; server already up on :5110 at $(Get-Date) dir=$workDir"
} else {
    Write-LogSep "Winb Server Started at $(Get-Date)  dir=$workDir"
    $script:proc = Start-WinbNode
}

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
        "Restart WinB Server?`n`nWARNING: background jobs managed by this WinB instance will be killed.",
        "Confirm Restart",
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Warning
    )
    if ($result -eq [System.Windows.Forms.DialogResult]::Yes) {
        Stop-WinbTree
        # Also free port 5110 if a stray node from a previous tray still holds it
        try {
            $conns = Get-NetTCPConnection -LocalPort 5110 -State Listen -ErrorAction SilentlyContinue
            foreach ($c in $conns) {
                if ($c.OwningProcess) {
                    Start-Process -FilePath "taskkill.exe" -ArgumentList "/PID",$c.OwningProcess,"/T","/F" -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue | Out-Null
                }
            }
        } catch {}
        Write-LogSep "Winb Server (HARD RESTART) at $(Get-Date)"
        $script:proc = Start-WinbNode
    }
})

$menuExit = New-Object System.Windows.Forms.MenuItem
$menuExit.Text = "Exit WinB Server"
$menuExit.add_Click({
    Stop-WinbTree
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
    if ($script:proc -and -not $script:proc.HasExited) {
        Start-Process -FilePath "taskkill.exe" -ArgumentList "/PID",$script:proc.Id,"/T","/F" -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue | Out-Null
    }
} | Out-Null

[System.Windows.Forms.Application]::Run()
