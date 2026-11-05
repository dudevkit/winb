# winb-office-tray.ps1
# System-tray launcher for the winb bridge on the OFFICE PC.
#
# Runs windowless: the Node server and the reverse-SSH tunnel keeper are started
# as hidden child processes (CreateNoWindow), so nothing pops up on the desktop.
# A tray icon provides View Logs / Restart / Exit, and a watchdog timer restarts
# either child if it dies.
#
# Launched by start-winb-office.vbs, which wscript runs with no console.
#
# This kit runs the UPSTREAM server (server.js + api.js + sampler.js) unchanged;
# everything office-specific lives in this folder and in server-env.ps1.
#
# Only ever kills processes it owns or that hold the server port / the tunnel port -
# never a blanket "kill all node.exe", because this machine also runs 9router,
# 9remote and other Node tooling.

$ErrorActionPreference = "Continue"

$WorkDir      = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $WorkDir

$ServerScript = Join-Path $WorkDir "server.js"
$EnvFile      = Join-Path $WorkDir "server-env.ps1"
$LogFile      = Join-Path $WorkDir "server.log"
$TunnelLog    = Join-Path $WorkDir "tunnel.log"
$TunnelScript = Join-Path $WorkDir "winb-office-tunnel.ps1"
$TunnelPort   = 15110

$script:nodeProc   = $null
$script:tunnelProc = $null
$script:mutex      = $null

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Deployment settings (WINB_PORT, WINB_BIND, WINB_VERSION_SUFFIX, WINB_ALLOWED_ROOTS, ...)
# live in server-env.ps1 next to this script. It is dot-sourced before every spawn, so a
# manually started server and a watchdog respawn carry identical settings.
function Import-ServerEnv {
    if (Test-Path $EnvFile) { . $EnvFile }
}

function Get-ServerPort {
    if ($env:WINB_PORT) { return [int]$env:WINB_PORT }
    return 5110
}

Import-ServerEnv
if (-not $env:WINB_VERSION_SUFFIX) { $env:WINB_VERSION_SUFFIX = '-office' }

$ServerPort   = Get-ServerPort
$ServerURL    = "http://127.0.0.1:$ServerPort"

# --- single instance -------------------------------------------------------
# Two trays would start two Node servers and fight over the port.
try {
    $script:mutex = New-Object System.Threading.Mutex($false, "Global\winb-office-tray")
    if (-not $script:mutex.WaitOne(0)) {
        exit 0
    }
} catch {
    # Fall through: a mutex failure is not worth refusing to start over.
}

function Write-Log([string]$msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [TRAY] $msg"
    try { Add-Content -Path $LogFile -Value $line } catch { }
    Write-Output $line
}

function Start-NodeServer {
    Import-ServerEnv
    if (-not $env:WINB_VERSION_SUFFIX) { $env:WINB_VERSION_SUFFIX = '-office' }
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName               = "cmd.exe"
        $psi.Arguments              = "/c node server.js >> server.log 2>&1"
        $psi.WorkingDirectory       = $WorkDir
        $psi.WindowStyle            = [System.Diagnostics.ProcessWindowStyle]::Hidden
        $psi.CreateNoWindow         = $true
        $psi.UseShellExecute        = $false
        $script:nodeProc = [System.Diagnostics.Process]::Start($psi)
        Write-Log "node server started (pid $($script:nodeProc.Id)) port $(Get-ServerPort) bind $($env:WINB_BIND) suffix $($env:WINB_VERSION_SUFFIX)"
    } catch {
        Write-Log "failed to start node server: $($_.Exception.Message)"
    }
}

function Start-TunnelKeeper {
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName        = "powershell.exe"
        $psi.Arguments       = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$TunnelScript`""
        $psi.WorkingDirectory = $WorkDir
        $psi.WindowStyle     = [System.Diagnostics.ProcessWindowStyle]::Hidden
        $psi.CreateNoWindow  = $true
        $psi.UseShellExecute = $false
        $script:tunnelProc = [System.Diagnostics.Process]::Start($psi)
        Write-Log "tunnel keeper started (pid $($script:tunnelProc.Id))"
    } catch {
        Write-Log "failed to start tunnel keeper: $($_.Exception.Message)"
    }
}

function Stop-Tree($proc) {
    if ($proc -and -not $proc.HasExited) {
        Start-Process -FilePath "taskkill.exe" -ArgumentList "/PID",$proc.Id,"/T","/F" `
            -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue | Out-Null
    }
}

function Get-ListenerOwners {
    Get-NetTCPConnection -LocalPort $ServerPort -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
}

function Get-TunnelSshProcesses {
    Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match "$TunnelPort" }
}

function Test-ServerUp {
    try {
        $r = Invoke-WebRequest -Uri "$ServerURL/ping" -UseBasicParsing -TimeoutSec 3
        return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300)
    } catch {
        return $false
    }
}

function Restart-Server {
    Stop-Tree $script:nodeProc
    foreach ($owner in Get-ListenerOwners) {
        if ($owner) {
            Start-Process -FilePath "taskkill.exe" -ArgumentList "/PID",$owner,"/T","/F" `
                -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue | Out-Null
        }
    }
    Start-Sleep -Milliseconds 700
    Start-NodeServer
}

function Restart-Tunnel {
    Stop-Tree $script:tunnelProc
    foreach ($p in Get-TunnelSshProcesses) {
        Start-Process -FilePath "taskkill.exe" -ArgumentList "/PID",$p.ProcessId,"/T","/F" `
            -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue | Out-Null
    }
    Start-Sleep -Milliseconds 700
    Start-TunnelKeeper
}

# --- preflight -------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    [System.Windows.Forms.MessageBox]::Show(
        "Node.js is not installed.`nInstall LTS from https://nodejs.org, then re-run setup-winb-office.ps1.",
        "winb-office - Node.js missing",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    exit 1
}

if (-not (Test-Path $ServerScript)) {
    [System.Windows.Forms.MessageBox]::Show(
        "server.js is missing from $WorkDir.`n`nRe-run setup-winb-office.ps1 with a full kit.",
        "winb-office - incomplete kit",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    exit 1
}

if (-not (Test-Path (Join-Path $WorkDir "node_modules"))) {
    [System.Windows.Forms.MessageBox]::Show(
        "node_modules is missing.`n`nRun: powershell -ExecutionPolicy Bypass -File setup-winb-office.ps1",
        "winb-office - not installed yet",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Warning
    ) | Out-Null
    exit 1
}

Write-Log "tray starting in $WorkDir"

# --- start children --------------------------------------------------------
# Attach instead of double-starting when a server already answers on the port.
if (Test-ServerUp) {
    Write-Log "server already answering on :$ServerPort - attaching"
} else {
    Start-NodeServer
}

Start-TunnelKeeper

# --- tray icon -------------------------------------------------------------
$notifyIcon            = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon       = [System.Drawing.Icon]::ExtractAssociatedIcon((Get-Process -Id $PID).Path)
$notifyIcon.Text       = "winb-office (port $ServerPort) + tunnel $TunnelPort"
$notifyIcon.Visible    = $true

$menu          = New-Object System.Windows.Forms.ContextMenu

$miServerLog   = New-Object System.Windows.Forms.MenuItem
$miServerLog.Text = "View Server Log"
$miServerLog.add_Click({
    Start-Process powershell -ArgumentList "-NoExit -ExecutionPolicy Bypass -Command Get-Content -Path '$LogFile' -Wait -Tail 60"
})

$miTunnelLog   = New-Object System.Windows.Forms.MenuItem
$miTunnelLog.Text = "View Tunnel Log"
$miTunnelLog.add_Click({
    Start-Process powershell -ArgumentList "-NoExit -ExecutionPolicy Bypass -Command Get-Content -Path '$TunnelLog' -Wait -Tail 60"
})

$miRestartSrv  = New-Object System.Windows.Forms.MenuItem
$miRestartSrv.Text = "Restart Server"
$miRestartSrv.add_Click({
    if ([System.Windows.Forms.MessageBox]::Show(
            "Restart the winb server?`n`nBackground jobs started through it will be killed.",
            "Confirm Restart",
            [System.Windows.Forms.MessageBoxButtons]::YesNo,
            [System.Windows.Forms.MessageBoxIcon]::Warning) -eq [System.Windows.Forms.DialogResult]::Yes) {
        Restart-Server
    }
})

$miRestartTun  = New-Object System.Windows.Forms.MenuItem
$miRestartTun.Text = "Restart Tunnel"
$miRestartTun.add_Click({
    Restart-Tunnel
})

$miStatus      = New-Object System.Windows.Forms.MenuItem
$miStatus.Text = "Copy Status to Clipboard"
$miStatus.add_Click({
    $lines = @(
        "winb-office status $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
        "server up      : $(Test-ServerUp)",
        "listener pids  : $((Get-ListenerOwners) -join ',')",
        "node pid       : $(if ($script:nodeProc) { $script:nodeProc.Id } else { 'n/a' })",
        "keeper pid     : $(if ($script:tunnelProc) { $script:tunnelProc.Id } else { 'n/a' })",
        "tunnel ssh pids: $((Get-TunnelSshProcesses | Select-Object -ExpandProperty ProcessId) -join ',')",
        "tunnel log     : $TunnelLog"
    )
    Set-Clipboard -Value ($lines -join [Environment]::NewLine)
})

$miOpenHealth  = New-Object System.Windows.Forms.MenuItem
$miOpenHealth.Text = "Open Health in Browser"
$miOpenHealth.add_Click({
    Start-Process "$ServerURL/health"
})

$miExit        = New-Object System.Windows.Forms.MenuItem
$miExit.Text   = "Exit winb-office"
$miExit.add_Click({
    Write-Log "tray exit requested - stopping children"
    Stop-Tree $script:tunnelProc
    foreach ($p in Get-TunnelSshProcesses) {
        Start-Process -FilePath "taskkill.exe" -ArgumentList "/PID",$p.ProcessId,"/T","/F" `
            -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue | Out-Null
    }
    Stop-Tree $script:nodeProc
    foreach ($owner in Get-ListenerOwners) {
        if ($owner) {
            Start-Process -FilePath "taskkill.exe" -ArgumentList "/PID",$owner,"/T","/F" `
                -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue | Out-Null
        }
    }
    $notifyIcon.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})

foreach ($mi in @($miServerLog, $miTunnelLog, $miRestartSrv, $miRestartTun, $miStatus, $miOpenHealth)) {
    $menu.MenuItems.Add($mi) | Out-Null
}
$menu.MenuItems.Add("-") | Out-Null
$menu.MenuItems.Add($miExit) | Out-Null
$notifyIcon.ContextMenu = $menu

$notifyIcon.add_DoubleClick({
    Start-Process powershell -ArgumentList "-NoExit -ExecutionPolicy Bypass -Command Get-Content -Path '$LogFile' -Wait -Tail 60"
})

# --- watchdog --------------------------------------------------------------
# Every 20 s: restart the server only when it is both unresponsive AND the port
# is free (avoids fighting HMR flakiness). Restart the tunnel only when the
# keeper process itself has exited - a keeper whose ssh attempt is rejected
# (key not trusted yet) stays alive on purpose and must not be churned.
$timer          = New-Object System.Windows.Forms.Timer
$timer.Interval = 20000
$timer.add_Tick({
    if (-not (Test-ServerUp)) {
        if (-not (Get-ListenerOwners)) {
            Write-Log "watchdog: server down and port free - restarting node"
            Start-NodeServer
        } else {
            Write-Log "watchdog: port held but /ping failed - leaving it alone"
        }
    }

    if (-not $script:tunnelProc -or $script:tunnelProc.HasExited) {
        Write-Log "watchdog: tunnel keeper is gone - restarting it"
        Start-TunnelKeeper
    }
})
$timer.Start()

# When the tray process goes away for any reason, clean up the children.
Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action {
    Stop-Tree $script:tunnelProc
    Stop-Tree $script:nodeProc
} | Out-Null

[System.Windows.Forms.Application]::Run()
