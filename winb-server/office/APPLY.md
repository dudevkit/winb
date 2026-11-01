# Applying winb v1.3 to the office PC

Prepared 2026-11-01 on the gateway. The office PC was offline at that moment (bastion
the bastion port not connected), so these files are staged and not deployed yet.

## What this fixes

The office PC still runs `api.js` v1.2, which carries every defect found in the audit:

* a spawn error (bad workdir) kills the whole node process and takes the bridge down for
  ~15-20 s until whatever supervises it respawns,
* a timeout kills only `cmd.exe`, so a command that spawns a child can hang the request
  forever,
* multi-line cmd commands silently run only the first line,
* PowerShell output turns non-ASCII into U+FFFD,
* stdin readers hang because the child's stdin pipe is never closed,
* payloads above ~75 KB are rejected by the 100 kb JSON body cap,
* output is unbounded in memory, job records die with the process, and the default cwd is
  the server directory.

## Files in this folder

| File | Purpose |
|---|---|
| `api.js` | the shared v1.3 route module (identical to the home PC's, except that the default cwd, allowed write roots and token path are read from the environment) |
| `winb-office-server.js` | the office bootstrap: 64 mb body limit, token auth with loopback trust, `WINB_PORT` / `WINB_DEFAULT_CWD` support, version `1.3.0-office` |

## Steps on the office PC (elevated PowerShell)

```powershell
$dir = "$env:USERPROFILE\winb-server"      # adjust to the real install path
Get-Process node | Where-Object { $_.Path -and $_.CommandLine -like "*winb-office-server*" } | Stop-Process

Copy-Item "$dir\api.js" "$dir\api.js.v12.bak" -Force
Copy-Item "$dir\winb-office-server.js" "$dir\winb-office-server.js.v12.bak" -Force

# copy the two new files from wherever they were staged
Copy-Item "<staging>\api.js" "$dir\api.js" -Force
Copy-Item "<staging>\winb-office-server.js" "$dir\winb-office-server.js" -Force

node --check "$dir\api.js"
node --check "$dir\winb-office-server.js"

# token (optional but recommended): 64 hex chars
-join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) }) | Set-Content "$dir\.token" -NoNewline

# restart the way the tray does
Start-Process -WindowStyle Hidden -FilePath "wscript.exe" -ArgumentList "$dir\start-winb-office.vbs"
```

Set `WINB_DEFAULT_CWD` in whatever launches the server if the default temp scratch dir does
not exist on that machine; otherwise the server now creates it on demand. If the account
is not allowed to write to `F:\`, also set `WINB_ALLOWED_ROOTS` (semicolon separated).

## Verify from the gateway

```bash
winb-office --health                 # expect Version: 1.3.0-office
winb-office --manifest               # host, tools, drives, capabilities, allowed roots
winb-office put ./local.txt "C:\Temp\local.txt"
winb-office get "C:\Temp\local.txt" ./back.txt
winb-office ls "C:\Temp"
winb-office -s office "cd"           # sticky session, then reuse with -s office
winb-office -t 5 "timeout /t 30"     # must return in ~5 s, not hang
```

## Rollback

Copy `api.js.v12.bak` / `winb-office-server.js.v12.bak` back over the two files and restart
the server the same way. The v1 client wrapper is not needed for rollback: the new
`winb-office` wrapper drives a v1.2 server fine, it just falls back to the exec/put/get
path for file transfer and reports a clear "server predates v1.3" message for the typed
endpoints.

## Notes

* `/reload` on the office server also needs the token once it is non-loopback; over the
  bastion bridge the request arrives from 127.0.0.1, so it is trusted.
* The gateway keeps a reconstruction of the old bash wrapper at
  `/usr/local/bin/winb-office.v1.sh` (see the header comment there).
