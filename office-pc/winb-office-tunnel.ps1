# winb-office-tunnel.ps1
# Keeps a reverse SSH tunnel from this Windows PC to the bastion alive.
#
# Result: on the bastion, 127.0.0.1:<BastionPort> reaches this machine's winb server
# (127.0.0.1:<LocalPort>). The gateway bridges that bastion port to its own localhost,
# so the gateway can drive this PC with the `winb-office` wrapper.
#
# Started by winb-office-tray.ps1 (hidden). It is deliberately NOT a scheduled
# task: a console window would be visible.
#
# Requires: the tunnel key at %USERPROFILE%\.ssh\winb-office-tunnel is trusted
# in the bastion's ~/.ssh/authorized_keys (setup-winb-office.ps1 prints the
# public half; Alice has to install it).

$ErrorActionPreference = "Continue"

# Everything below can be overridden from server-env.ps1 / the environment, so the same
# keeper can serve a second box or a second bastion port without editing the script.
$EnvFile     = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "server-env.ps1"
if (Test-Path $EnvFile) { . $EnvFile }

$Bastion     = if ($env:WINB_BASTION)      { $env:WINB_BASTION }      else { "ubuntu@43.156.65.16" }
$Key         = if ($env:WINB_TUNNEL_KEY)   { $env:WINB_TUNNEL_KEY }   else { "$env:USERPROFILE\.ssh\winb-office-tunnel" }
$WorkDir     = Split-Path -Parent $MyInvocation.MyCommand.Path
$Log         = Join-Path $WorkDir "tunnel.log"
$BastionPort = if ($env:WINB_BASTION_PORT) { [int]$env:WINB_BASTION_PORT } else { 15110 }
$LocalPort   = if ($env:WINB_PORT)         { [int]$env:WINB_PORT }         else { 5110 }

function Write-Log($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [TUNNEL] $msg"
  try { Add-Content -Path $Log -Value $line } catch { }
  Write-Output $line
}

Write-Log "keeper started (bastion=$Bastion bastionPort=$BastionPort localPort=$LocalPort)"

$attempt = 0
while ($true) {
  $attempt++
  try {
    # -N: no remote command, the forward is the whole session.
    # ExitOnForwardFailure: if the bastion port is taken, exit immediately
    # instead of idling in a session that carries no tunnel.
    # ServerAlive*: corporate firewalls drop idle TCP; this keeps it warm.
    & ssh -N `
      -i "$Key" `
      -R "127.0.0.1:${BastionPort}:127.0.0.1:${LocalPort}" `
      -o ExitOnForwardFailure=yes `
      -o ServerAliveInterval=30 `
      -o ServerAliveCountMax=3 `
      -o ConnectTimeout=22 `
      -o BatchMode=yes `
      -o StrictHostKeyChecking=accept-new `
      "$Bastion"

    $code = $LASTEXITCODE
    Write-Log "attempt $attempt - ssh exited (code $code); retrying in 15s"
  } catch {
    Write-Log "attempt $attempt - ssh error: $($_.Exception.Message); retrying in 15s"
  }
  Start-Sleep -Seconds 15
}
