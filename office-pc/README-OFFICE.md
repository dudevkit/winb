# winb on the OFFICE PC (kit)

Execution bridge that lets the gateway (Alice) run commands on Ravi's office Windows
machine. It runs the **upstream winb server unchanged** plus a small amount of
office scaffolding (tray, tunnel keeper, installer) in this folder.

Runs in the **system tray with no console window**. Once installed, the only visible
trace is a small tray icon next to the clock.

## WHY THIS SHAPE

The office PC sits behind a corporate NAT/firewall: the gateway cannot POST to it, and
nothing on the internet can reach in. So the connection is inverted - the office PC dials
OUT to a bastion, and the gateway bridges into that.

```
office PC (winb server :5110, bound to 127.0.0.1)
   |  ssh -R 127.0.0.1:15110 -> 127.0.0.1:5110        (outbound 22)
   v
tencent bastion 43.156.65.16  (ubuntu)   <- port bound to loopback ONLY
   ^  ssh -L 127.0.0.1:5110 -> 127.0.0.1:15110        (gateway outbound 22)
   |
gateway  ->  http://127.0.0.1:5110  ->  winb-office wrapper
```

Both hops are outbound SSH, so no inbound firewall rule is needed on either side.

## NOT A FORK ANYMORE

Older revisions shipped a trimmed copy of the server (`winb-office-server.js` + a 13 KB
`api.js`), which drifted: the office box stayed on v1.2 while the home box moved to v1.4,
so it never had typed file ops (`/fs/*`), token auth or the host-context sampler.

The kit now takes upstream files verbatim and expresses everything office-specific as
**deployment settings** in `server-env.office.ps1`:

| Setting | Value here | Why |
|---|---|---|
| `WINB_BIND` | `127.0.0.1` | the box is reached through the tunnel; the office LAN has no business reaching an unauthenticated bridge |
| `WINB_VERSION_SUFFIX` | `-office` | `winb-office --health` must be distinguishable from the home PC's `1.4.0` |
| `WINB_ALLOWED_ROOTS` | `C:\;D:\` | typed writes work across both drives (a guard rail - `/run` already executes anything) |
| `WINB_DEFAULT_CWD` | `C:\winb-office` | predictable working directory for calls without one |

Consequence: **updating the office box is re-cutting the kit**, not porting a patch.

## FILES

| File | Purpose |
|---|---|
| `server.js`, `api.js`, `sampler.js`, `sampler-probe.ps1` | upstream, unmodified |
| `setup-winb-office.ps1` | one-shot installer (copy, env seed, npm install, key, autostart, verify) |
| `winb-office-tray.ps1` | tray app: starts + watches the server and the tunnel keeper, no console |
| `start-winb-office.vbs` | silent bootstrap (`wscript`), so nothing flashes on screen |
| `winb-office-tunnel.ps1` | keeps the reverse SSH tunnel alive (reconnect loop) |
| `server-env.office.ps1` | deployment settings; the installer copies it to `server-env.ps1` if absent |
| `STATUS-WINB-OFFICE.cmd` | diagnostics: double-click and paste the output to Alice |
| `build-office-kit.sh` | assembles the flat kit + zip for delivery |

## BUILD

```bash
office-pc/build-office-kit.sh          # -> dist/winb-office-kit.zip
```

## SETUP (run once)

1. Extract `winb-office-kit.zip` on the office PC (anywhere; the installer copies it).
2. PowerShell in that folder:

   ```powershell
   powershell -ExecutionPolicy Bypass -File setup-winb-office.ps1
   ```

   Administrator is only needed when a legacy scheduled task has to be removed.
3. The script prints a **public key**. Send that one line to Alice; it has to be appended
   to the bastion's `~/.ssh/authorized_keys`. Until then the keeper retries every 15 s -
   nothing is broken.
4. Confirm the last lines: `winb server LISTENING on 5110` and a `/health` line showing
   `"version":"1.4.0-office"`.

The kit deliberately carries **no private key**: the installer generates one locally and
prints only its public half.

## AUTOSTART - and why there is no console window

Autostart is a shortcut in the Startup folder that runs `wscript.exe` on
`start-winb-office.vbs`. `wscript` has no console, and it launches the tray PowerShell
with `-WindowStyle Hidden`; the tray starts Node and the tunnel keeper with
`CreateNoWindow`. Nothing is visible.

An earlier revision used scheduled tasks whose action was `cmd.exe /c run-server.cmd`.
`cmd.exe` **always** allocates a console, and with `/rl highest` it is shown rather than
hidden - a blank black window appeared on every logon. That design is gone; the installer
deletes those tasks and their files.

**Autostart is logon-triggered, not boot-triggered.** The Startup folder fires after a
user logs in and the machine has `AutoAdminLogon = 0`, so a PC that reboots and parks at
the login screen is offline until someone logs in. This is deliberate: a boot-level
task was reviewed and declined.

## TRAY MENU

- **View Server Log** / **View Tunnel Log**
- **Restart Server** - kills the listener, starts a fresh one
- **Restart Tunnel** - kills the keeper and its `ssh`, starts a fresh keeper
- **Copy Status to Clipboard** - one paste for diagnostics
- **Open Health in Browser**
- **Exit winb-office** - stops both children and removes the icon

## TROUBLESHOOTING

Double-click **`STATUS-WINB-OFFICE.cmd`** first; it answers most of these.

| Symptom | Cause | Fix |
|---|---|---|
| Nothing listening on 5110 | server not started | `Start-Process wscript.exe start-winb-office.vbs`, then read `server.log` |
| A blank console window on logon | a legacy `winb-office-server` task | `schtasks /delete /tn winb-office-server /f`, then re-run setup |
| `/health` shows the bare `1.4.0` | `server-env.ps1` missing or the suffix is unset | re-run setup; check `server-env.ps1` |
| Server up, gateway sees nothing | tunnel key not trusted on the bastion yet | send the printed public key over; the keeper retries by itself |
| `remote port forwarding failed for listen port 15110` | a stale `sshd` still holds the bastion port | kill that session on the bastion; the keeper re-establishes within 15 s |
| Tunnel dies after a few minutes | corporate firewall drops idle SSH | already handled: `ServerAliveInterval=30` plus the keeper's reconnect loop |
| Nothing works after a reboot | the Startup shortcut needs a login | log in once per session; the tray starts itself |
| Two tray icons | started twice | the tray holds a single-instance mutex; the second exits silently |

## NOTES

- The gateway reaches the server over loopback (the SSH client makes the last hop), so the
  bridge needs no bearer token. Do **not** widen `WINB_BIND` - winb-server executes
  arbitrary commands by design and is not meant to be reachable from the network.
- The bastion port `15110` is bound to loopback only; do not add a public listener for it.
- Every HTTP request is logged to stdout, so `server.log` doubles as an audit trail.
- The tray only ever kills processes it owns, or whatever holds port 5110 / the tunnel
  port - never a blanket `taskkill` on `node.exe`, because this machine also runs other
  Node tooling (9router, 9remote).
