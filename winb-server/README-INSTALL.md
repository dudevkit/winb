# winB Windows one-click install (Desktop)

## For non-technical users

1. Copy `winb-server/` to the Windows **Desktop** (or extract the release zip there).
2. Double-click **`INSTALL-SEKALI.bat`** once.
3. If Node.js is missing, install LTS from https://nodejs.org (Add to PATH), then run the bat again.
4. Allow Windows Firewall if prompted.
5. Confirm tray icon **WinB Server (Port 5110)** and `http://127.0.0.1:5110/ping` returns JSON ok.

Daily start: double-click **`START-WINB.bat`**.

Diagnostics: double-click **`CEK-STATUS.bat`** and share the output.

## What changed vs hard-coded Alice paths

- `winb-tray.ps1`, `start-winb.vbs`, `tail-log.ps1` resolve paths from the script directory (no fixed `F:\AliceWorkspace\...`).
- Install/start bats wait for user input so errors are visible.
- Linux CLI (`cli/winb`) supports `WINB_HOST` / `WINB_PORT` / `WINB_URL`, curl timeouts, and optional SOCKS via `ALL_PROXY` for userspace Tailscale gateways.
