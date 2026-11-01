# Tunnel-only profile

For a Windows host that **cannot be reached inbound**: no port forward, no VPN, no public
address, typically a machine on a network you do not administer. The host dials out to a
relay you control, and the gateway drives it through that tunnel.

```
  gateway                         relay (public)              remote host
  ───────                         ──────────────              ───────────
  winb-tunnel  ──> 127.0.0.1:5110 ──> relay:port ──tunnel──> 127.0.0.1:5110
                   (local                                                   (winb-tunnel-server.js)
                    forwarder)                                               ← reverse SSH initiated by the host
```

The loopback endpoint on the gateway is the security boundary: only processes on that
machine can reach it, and nothing is published to the internet. The bearer token is a second
line of defence — it matters if the port ever becomes reachable another way (for example the
host later joins a LAN where 5110 is routable).

## When to use this instead of `server.js`

Both bootstraps load the same `api.js`, so the API surface and every fix are identical.
Use this one when:

- the remote machine must present its own service identity (`/health` reports
  `1.3.0-tunnel`), so you can tell which host answered, or
- its launcher (tray app, scheduled task, service wrapper) is managed separately from the
  default one and you want the two deployments to stay visibly distinct.

Otherwise `server.js` with `WINB_PORT` / `WINB_DEFAULT_CWD` / `WINB_ALLOWED_ROOTS` is
enough.

## Files

| File | Purpose |
|---|---|
| `winb-tunnel-server.js` | bootstrap: token auth with loopback trust, 64 mb body limit, `WINB_*` overrides, version `1.3.0-tunnel` |
| `../api.js` | the shared route module — do not fork it for this profile |
| `../../cli/winb-tunnel` | gateway-side wrapper: loopback address, preflight `ping`, refuses `--admin` |

## Deploy on the remote host

Elevated PowerShell, with the v1.3 `api.js` and the bootstrap staged somewhere local:

```powershell
$dir = "$env:USERPROFILE\winb-server"          # adjust to the real install path
$staging = "C:\Temp\winb-v1.3"

# 1. back up what is running now
Copy-Item "$dir\api.js" "$dir\api.js.bak" -Force
Copy-Item "$dir\winb-tunnel-server.js" "$dir\winb-tunnel-server.js.bak" -Force

# 2. stop the old process (tray, service or scheduled task - whichever supervises it)
Get-Process node -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path -like "$dir*" } | Stop-Process

# 3. stage, check, then move into place
Copy-Item "$staging\api.js" "$dir\api.js.new" -Force
Copy-Item "$staging\winb-tunnel-server.js" "$dir\winb-tunnel-server.js.new" -Force
node --check "$dir\api.js.new"
node --check "$dir\winb-tunnel-server.js.new"
Move-Item "$dir\api.js.new" "$dir\api.js" -Force
Move-Item "$dir\winb-tunnel-server.js.new" "$dir\winb-tunnel-server.js" -Force

# 4. token (recommended): 32 bytes of entropy
[Convert]::ToHexString((1..32 | % { Get-Random -Max 256 })) | Set-Content "$dir\.token" -NoNewline

# 5. restart the way that machine normally does
Start-Process -WindowStyle Hidden -FilePath "wscript.exe" -ArgumentList "$dir\start-winb-tunnel.vbs"
```

Environment, set in whatever launches the server:

```powershell
$env:WINB_PORT = 5110
$env:WINB_DEFAULT_CWD = "C:\winb-scratch"       # optional; defaults to the temp area
$env:WINB_ALLOWED_ROOTS = "C:\winb-scratch;C:\Users\<user>"   # widening is explicit
```

Write roots default to the scratch directory plus the system temp area, so set
`WINB_ALLOWED_ROOTS` before using typed file writes for real work.

## Wire up the tunnel

Any reverse-tunnel mechanism works; SSH is the simplest. On the remote host:

```powershell
ssh -N -R 5110:127.0.0.1:5110 <user>@<relay>       # run it as a service / scheduled task
```

On the gateway, forward the relay's side onto loopback and keep it under systemd:

```ini
# /etc/systemd/system/winb-tunnel-bridge.service
[Unit]
Description=Loopback forwarder for the winb tunnel-only host
After=network-online.target

[Service]
ExecStart=/usr/bin/ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
          -L 127.0.0.1:5110:127.0.0.1:5110 <user>@<relay>
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then `systemctl enable --now winb-tunnel-bridge` and point the wrapper at it:

```bash
export WINB_BRIDGE_UNIT=winb-tunnel-bridge.service
winb-tunnel --health                 # expect Version: 1.3.0-tunnel
```

## Verify

```bash
winb-tunnel --health                 # version + workdir as seen on that host
winb-tunnel --manifest               # host, tools, drives, capabilities, allowed roots
winb-tunnel put ./local.txt "C:\Temp\local.txt"
winb-tunnel get "C:\Temp\local.txt" ./back.txt
winb-tunnel ls "C:\Temp"
winb-tunnel -s box "cd"              # sticky session; reuse with -s box
winb-tunnel -t 5 "timeout /t 30"     # must return in ~5 s, not hang
```

## Rollback

Restore the two `.bak` files and restart the server the same way it was started. The wrapper
does not need to be rolled back: `cli/winb-tunnel` drives a pre-v1.3 server fine — it falls
back to the exec/put/get path for transfers and reports "this server does not expose X - it
predates v1.3" for the typed verbs.

## Notes

- `/reload` arrives from the forwarder as `127.0.0.1`, so it is loopback-trusted. A caller
  that reaches the port another way needs the token, on `/reload` as well.
- If a client sends no token to a token-protected server, the response is a plain 401; the
  CLI explains which files it reads (`WINB_TOKEN_FILE`, `~/.winb-token`, `/etc/winb-token`,
  `WINB_TOKEN`).
- Never expose the relay's forwarded port. If you must skip the tunnel, bind the server to
  `127.0.0.1` there and reach it through something else — the token alone is not a
  substitute for a network boundary.