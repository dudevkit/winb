# setup-winb-office.ps1
# One-shot installer for the winb execution bridge on the OFFICE PC.
#
#   powershell -ExecutionPolicy Bypass -File setup-winb-office.ps1
#
# Administrator is only needed when a leftover scheduled task from the very first
# revision is still registered and has to be removed.
#
# Installs:
#   1. Node.js check + kit completeness check
#   2. copy kit -> C:\winb-office (upstream server.js/api.js/sampler.js + office scaffolding)
#   3. seed server-env.ps1 from server-env.office.ps1 (only when missing)
#   4. npm install (production deps only)
#   5. tunnel SSH key (generated locally; only the public half is printed)
#   6. Startup shortcut -> start-winb-office.vbs  (NO console window, tray only)
#   7. start now + verify (listener, /health version, tunnel)
#
# Autostart note: an earlier design used scheduled tasks running cmd.exe, which
# always leaves a console visible. This uses a Startup-folder shortcut instead,
# matching the upstream winb tray design: nothing is visible but the tray icon.

$ErrorActionPreference = "Continue"
$KitDir     = Split-Path -Parent $MyInvocation.MyCommand.Path
$TargetDir  = "C:\winb-office"
$StartupDir = [Environment]::GetFolderPath("Startup")
$Shortcut   = Join-Path $StartupDir "winb-office.lnk"
$LegacyTasks = @("winb-office-server", "winb-office-tunnel")
# Files that belonged to older revisions and must not survive: the pre-v1.4 entry point
# (winb-office-server.js), the cmd.exe-era launcher, and its README.
# NOTE: server.js itself is NOT in this list - it is the upstream entry point the kit ships.
$LegacyFiles = @("winb-office-server.js", "routes.js", "run-server.cmd", "run-tunnel.cmd", "README.md")
$RequiredKit = @("server.js", "api.js", "sampler.js", "sampler-probe.ps1", "package.json", "winb-office-tray.ps1", "start-winb-office.vbs")

function Section($t) { Write-Output ""; Write-Output "=== $t ===" }

Section "1. Node.js + kit check"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Output "FAIL: node.exe not on PATH."
  Write-Output "Install Node.js LTS (winget install OpenJS.NodeJS.LTS, or https://nodejs.org) then re-run."
  exit 1
}
Write-Output ("node: " + (& node --version) + "  (" + $node.Source + ")")
Write-Output ("npm : " + (& npm --version))

$missing = @($RequiredKit | Where-Object { -not (Test-Path (Join-Path $KitDir $_)) })
if ($missing.Count -gt 0) {
  Write-Output ("FAIL: kit is incomplete, missing: " + ($missing -join ', '))
  Write-Output "Use the full winb-office-kit (build it with office-pc/build-office-kit.sh)."
  exit 1
}
Write-Output "kit complete"

Section "2. Copy kit to $TargetDir"
if ($KitDir.TrimEnd('\') -ne $TargetDir) {
  New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
  Copy-Item -Path (Join-Path $KitDir '*') -Destination $TargetDir -Recurse -Force
  Write-Output "copied from $KitDir"
} else {
  Write-Output "already at $TargetDir"
}

Section "3. Deployment settings"
$envTarget = Join-Path $TargetDir "server-env.ps1"
$envSeed   = Join-Path $TargetDir "server-env.office.ps1"
if (Test-Path $envTarget) {
  Write-Output "server-env.ps1 already present - left untouched"
} elseif (Test-Path $envSeed) {
  Copy-Item -Path $envSeed -Destination $envTarget -Force
  Write-Output "seeded server-env.ps1 from server-env.office.ps1"
} else {
  Write-Output "WARN: no server-env.office.ps1 in the kit; the server will use built-in defaults"
}

Section "4. npm install"
Push-Location $TargetDir
& npm install --omit=dev --no-audit --no-fund 2>&1 | Select-Object -Last 4
Pop-Location
if (Test-Path (Join-Path $TargetDir "node_modules\express")) {
  Write-Output "express OK"
} else {
  Write-Output "FAIL: express missing after npm install"
  exit 1
}

Section "5. Tunnel key"
$sshDir = "$env:USERPROFILE\.ssh"
New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
$keyDst = Join-Path $sshDir "winb-office-tunnel"

if (Test-Path $keyDst) {
  Write-Output "key already present: $keyDst"
} else {
  & ssh-keygen -t ed25519 -f $keyDst -N '""' -C "winb-office-pc" | Out-Null
  Write-Output "generated: $keyDst"
}

# OpenSSH refuses keys with loose ACLs.
& icacls $keyDst /inheritance:r /grant:r "$($env:USERNAME):(R)" 2>&1 | Select-Object -Last 1
& ssh-keygen -lf $keyDst
Write-Output ""
Write-Output "----- SEND THIS ONE LINE TO ALICE -----"
Get-Content "$keyDst.pub"
Write-Output "----- END -----"
Write-Output ""
Write-Output "Until Alice confirms it is trusted on the bastion, the tunnel keeper retries"
Write-Output "every 15 s. Nothing is broken while it waits."

Section "6. Stop the previous install"
# Stop any running instance from a previous revision FIRST. An older revision ran the
# keeper through cmd.exe; deleting the scheduled task does not stop those processes, so
# an orphan would survive and keep a second tunnel fighting for the bastion port.
$trayPids = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match "winb-office-tray\.ps1" } |
  Select-Object -ExpandProperty ProcessId)
foreach ($tpid in $trayPids) {
  Write-Output "stopping previous tray (pid $tpid)"
  & taskkill /PID $tpid /T /F 2>&1 | Out-Null
}
if ($trayPids.Count -gt 0) { Start-Sleep -Seconds 3 }
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.CommandLine -and $_.CommandLine -match "run-(server|tunnel)\.cmd") {
    Write-Output "stopping orphan from a previous revision (cmd pid $($_.ProcessId))"
    & taskkill /PID $_.ProcessId /T /F 2>&1 | Out-Null
  }
}
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.CommandLine -and $_.CommandLine -match "winb-office-tunnel\.ps1" -and $trayPids -notcontains $_.ParentProcessId) {
    Write-Output "stopping stale keeper (pid $($_.ProcessId))"
    & taskkill /PID $_.ProcessId /T /F 2>&1 | Out-Null
  }
}
foreach ($t in $LegacyTasks) {
  # Old scheduled tasks ran cmd.exe, which always shows a console.
  $existing = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
  if ($existing) {
    & schtasks /delete /tn $t /f 2>&1 | Select-Object -Last 1
  } else {
    Write-Output "no legacy task '$t' (ok)"
  }
}

Section "7. Autostart (Startup shortcut, no console window)"
$sh = New-Object -ComObject WScript.Shell
$lnk = $sh.CreateShortcut($Shortcut)
$lnk.TargetPath       = "wscript.exe"
$lnk.Arguments        = '"' + (Join-Path $TargetDir "start-winb-office.vbs") + '"'
$lnk.WorkingDirectory = $TargetDir
$lnk.WindowStyle      = 7
$lnk.Description      = "winb-office execution bridge (tray)"
$lnk.Save()
if (Test-Path $Shortcut) {
  Write-Output "startup shortcut created: $Shortcut"
} else {
  # Fallback for locked-down images that ignore the Startup folder: a logon task
  # that also launches wscript (still windowless - no cmd, no console).
  Write-Output "WARN: startup shortcut failed; falling back to a logon task"
  & schtasks /create /tn "winb-office-tray" /tr "wscript.exe `"$TargetDir\start-winb-office.vbs`"" /sc onlogon /f 2>&1 | Select-Object -Last 1
}

Section "8. Start now (no window)"
# Free the port first so the tray does not attach to a half-dead previous install.
$port = 5110
if (Test-Path $envTarget) {
  . $envTarget
  if ($env:WINB_PORT) { $port = [int]$env:WINB_PORT }
}
$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
  Write-Output "port $port already held (PID $($listener.OwningProcess)) - stopping it first"
  foreach ($owner in ($listener | Select-Object -ExpandProperty OwningProcess -Unique)) {
    & taskkill /PID $owner /T /F 2>&1 | Select-Object -Last 1
  }
  Start-Sleep -Seconds 2
}

# Legacy files can only be deleted once nothing holds them open.
foreach ($f in $LegacyFiles) {
  $p = Join-Path $TargetDir $f
  if (Test-Path $p) {
    Remove-Item $p -Force -ErrorAction SilentlyContinue
    if (Test-Path $p) { Write-Output "could not remove legacy file (still locked): $f" }
    else { Write-Output "removed legacy file: $f" }
  }
}

& wscript.exe (Join-Path $TargetDir "start-winb-office.vbs")
Start-Sleep -Seconds 12

Section "9. Verify"
$listen = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listen) { Write-Output "winb server LISTENING on $port (PID $($listen.OwningProcess))" }
else { Write-Output "WARN: nothing on $port - check $TargetDir\server.log" }

try {
  $health = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 5
  Write-Output "health: $($health.Content)"
} catch {
  Write-Output "WARN: /health did not answer: $($_.Exception.Message)"
}

$ssh = Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match "15110" }
if ($ssh) { Write-Output ("tunnel ssh running (PID " + (($ssh | Select-Object -ExpandProperty ProcessId) -join ',') + ")") }
else {
  Write-Output "tunnel ssh NOT running yet - normal until the key above is trusted on the bastion."
  Write-Output "See $TargetDir\tunnel.log"
}

Section "10. Reachability self-test"
# On a fresh install nothing holds the bastion port yet, so a probe tunnel is the only way
# to learn whether the key is trusted. On an upgrade the tray keeper is already connected,
# and a second -R to the same port dies with ExitOnForwardFailure - the port being taken is
# proof the tunnel works, not a failure. Report that instead of a misleading "accepted".
$existing = Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match "15110" }
if ($existing) {
  Write-Output ("tunnel already established by the keeper (ssh pid " + (($existing | Select-Object -ExpandProperty ProcessId) -join ',') + ") - self-test skipped")
} else {
  & ssh -N -i $keyDst -R "127.0.0.1:15110:127.0.0.1:$port" `
    -o ExitOnForwardFailure=yes -o ConnectTimeout=20 -o BatchMode=yes `
    -o StrictHostKeyChecking=accept-new ubuntu@43.156.65.16 -f
  Start-Sleep -Seconds 4
  $test = Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match "15110" }
  if ($test) {
    Write-Output "tunnel accepted by the bastion - the gateway can now drive this PC"
    Write-Output "NOTE: this extra test tunnel is temporary; the tray keeps a permanent one."
  } else {
    Write-Output "tunnel refused. Either outbound TCP 22 is blocked by the corporate network,"
    Write-Output "or the key above is not trusted on the bastion yet. Send Alice the key line."
  }
}

Write-Output ""
Write-Output "=== DONE ==="
Write-Output "Tray icon 'winb-office' should be next to the clock. No console window is expected."
Write-Output "Nothing else to keep open - closing this window does not stop the bridge."
