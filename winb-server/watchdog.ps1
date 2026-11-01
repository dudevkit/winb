# Watchdog for winb-server: poll /health, respawn node when the port is genuinely free.
#
# Started by winb-tray.ps1 (idempotent) and tied to it: it exits when the owner PID recorded
# in watchdog.owner is gone. That file is written by the tray, so a tray "Exit" stops both
# and a tray "Hard Restart" keeps both.
#
# Deployment variables (WINB_PORT, WINB_DEFAULT_CWD, WINB_ALLOWED_ROOTS, WINB_TRACK, ...) are
# read from server-env.ps1 next to this script, if present. This matters: the watchdog is the
# process that respawns node, so without it a respawned server would come back with default
# settings while a tray-launched one had the configured ones.
#
# Portability notes:
#   - the server directory defaults to the folder holding this script ($PSScriptRoot), so the
#     same file works from a Desktop copy or from a service directory without edits
#   - WINB_SERVER_DIR overrides that when the scripts and the working copy are separated

param(
    [int]$Port = 0,
    [int]$IntervalSec = 15,
    [int]$HangStrikes = 4
)

$workDir = if ($env:WINB_SERVER_DIR) { $env:WINB_SERVER_DIR } else { $PSScriptRoot }
$envFile = Join-Path $workDir 'server-env.ps1'
$ownerFile = Join-Path $workDir 'watchdog.owner'
$logFile = Join-Path $workDir 'server.log'
$script:healthStrikes = 0

function Import-ServerEnv {
    if (Test-Path $envFile) { . $envFile }
}

function Get-ServerPort {
    if ($Port -gt 0) { return $Port }
    if ($env:WINB_PORT) { return [int]$env:WINB_PORT }
    return 5110
}

function Start-ServerNode {
    Import-ServerEnv
    # cmd.exe wrapper so the log keeps being appended without holding a lock on it
    $procInfo = New-Object System.Diagnostics.ProcessStartInfo
    $procInfo.FileName = 'cmd.exe'
    $procInfo.Arguments = '/c node server.js >> server.log 2>&1'
    $procInfo.WorkingDirectory = $workDir
    $procInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $procInfo.CreateNoWindow = $true
    [System.Diagnostics.Process]::Start($procInfo) | Out-Null
}

while ($true) {
    Start-Sleep -Seconds $IntervalSec

    if (Test-Path $ownerFile) {
        $ownerPid = 0
        $ownerRaw = Get-Content $ownerFile -ErrorAction SilentlyContinue | Select-Object -First 1
        [void][int]::TryParse("$ownerRaw", [ref]$ownerPid)
        if ($ownerPid -gt 0 -and -not (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)) {
            Add-Content -Path $logFile -Value "[WATCHDOG] $(Get-Date) - owner tray exited; watchdog stopping"
            exit
        }
    }

    $up = $false
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$(Get-ServerPort)/health" -UseBasicParsing -TimeoutSec 5
        if ($resp.StatusCode -eq 200) { $up = $true }
    } catch {
        $up = $false
    }
    if ($up) {
        if ($script:healthStrikes -gt 0) {
            Add-Content -Path $logFile -Value "[WATCHDOG] $(Get-Date) - health recovered after $($script:healthStrikes) failed check(s)"
        }
        $script:healthStrikes = 0
        continue
    }

    $port = Get-ServerPort
    # Health failed: only restart when the port is actually free, so a slow or half-dead server
    # (HMR churn, a long reload) is not killed out from under its own recovery.
    $listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($listening) {
        $script:healthStrikes++
        if ($script:healthStrikes -lt $HangStrikes) {
            Add-Content -Path $logFile -Value "[WATCHDOG] $(Get-Date) - port $port listening but health failed (strike $($script:healthStrikes)/$HangStrikes); skipping restart"
            continue
        }

        # Health has failed for ~$HangStrikes intervals while something still holds the port.
        # That is a hung event loop, not a starting server: it will never recover on its own and
        # no restart can bind the port while it is held. Kill the node listener and respawn.
        $killed = $false
        foreach ($conn in $listening) {
            $owner = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
            if ($owner -and $owner.ProcessName -eq 'node') {
                Add-Content -Path $logFile -Value "[WATCHDOG] $(Get-Date) - health failed $($script:healthStrikes)x with node pid $($owner.Id) holding $port; killing the hung process"
                Start-Process -FilePath 'taskkill.exe' -ArgumentList '/PID', $owner.Id, '/T', '/F' -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue | Out-Null
                $killed = $true
            } else {
                $name = if ($owner) { $owner.ProcessName } else { 'unknown' }
                Add-Content -Path $logFile -Value "[WATCHDOG] $(Get-Date) - port $port is held by '$name', not node; refusing to kill it"
                $script:healthStrikes = 0
            }
        }
        if (-not $killed) { continue }
        Start-Sleep -Seconds 2
        Add-Content -Path $logFile -Value "[WATCHDOG] $(Get-Date) - restarting node after hang recovery"
        Start-ServerNode
        $script:healthStrikes = 0
        continue
    }

    $script:healthStrikes = 0
    Add-Content -Path $logFile -Value "[WATCHDOG] $(Get-Date) - server down; restarting node"
    Start-ServerNode
}
