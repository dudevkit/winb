# winB Windows one-click install (Desktop)

## For non-technical users

1. Copy `winb-server/` to the Windows **Desktop** (or extract a release zip there).
2. Double-click **`INSTALL-SEKALI.bat`** once.
3. If Node.js is missing, install LTS from https://nodejs.org (Add to PATH), then run the bat again.
4. Allow Windows Firewall if prompted.
5. Confirm tray icon **WinB Server (Port 5110)** and `http://127.0.0.1:5110/ping` returns JSON ok.

Daily start: double-click **`START-WINB.bat`** (skips start if port 5110 already answers).

Diagnostics: double-click **`CEK-STATUS.bat`** and share the output.

## What changed vs hard-coded Alice paths

- `winb-tray.ps1`, `start-winb.vbs`, `tail-log.ps1` resolve paths from the script directory (no fixed `F:\AliceWorkspace\...`).
- Install/start bats wait for user input so errors are visible; they refuse a second start if `:5110` is already up.
- Tray restart/exit kills only the WinB process tree (`taskkill /T`), not every `node.exe` on the PC.
- Linux CLI (`cli/winb`) uses portable defaults (`WINB_HOST=192.168.1.100`). Optional `WINB_SOCKS` is **opt-in** for userspace Tailscale gateways — never auto-set in the published script.

## Gateway env examples

```bash
export WINB_HOST=192.168.1.100
export WINB_PORT=5110
# Tailscale userspace SOCKS (only if your gateway needs it):
# export WINB_SOCKS=socks5h://127.0.0.1:1055
winb --health
```
