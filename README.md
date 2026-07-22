# winB

Hybrid Windows remote execution bridge for Hermes Agent.

`winB` lets a Linux gateway drive a Windows PC over a local HTTP API (default port **5110**): run commands, PowerShell, background processes, kill jobs, and health-check — without SSH on every call.

## Layout

```
winb-server/     # Node.js Express server (runs on Windows)
  server.js      # entrypoint, port 5110
  api.js         # HTTP API surface
  routes.js      # /run /kill /ping /list
  winb-tray.ps1  # system-tray launcher + hard restart
  start-winb.vbs # silent tray bootstrap
  tail-log.ps1   # live log tail
cli/
  winb           # Linux CLI wrapper (gateway side)
```

## Features (current)

- HTTP remote shell on Windows (`POST /run`)
- PowerShell mode (`powershell: true`)
- Background process registry + kill
- Health endpoints (`/ping`, `/list`)
- Tray app with View Logs / Hard Restart / Exit
- Gateway CLI: `winb -c`, `winb -p`, `winb --health`, file helpers

## Quick start (Windows server)

```powershell
cd F:\AliceWorkspace\winb-server
npm install
# option A: foreground
node server.js
# option B: tray (recommended)
wscript start-winb.vbs
```

Server listens on `0.0.0.0:5110`.

## Quick start (Linux CLI)

```bash
# point at the Windows host
export WINB_HOST=192.168.1.100
export WINB_PORT=5110

winb --health
winb -c "whoami"
winb -p "Get-Process | Select-Object -First 5"
```

## API sketch

| Method | Path | Body | Notes |
|--------|------|------|-------|
| POST | `/run` | `{command, workdir?, background?, powershell?, timeout?, processId?}` | run command |
| POST | `/kill` | `{processId}` | kill background job |
| GET | `/ping` | — | health + active process count |
| GET | `/list` | — | list background processes |

## Related Hermes skills

- `windows-remote-execution-bridge`
- `winb-execution` (user workflow)

## License

Private / internal tooling unless stated otherwise.
