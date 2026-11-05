# Deployment settings for the OFFICE PC.
#
# setup-winb-office.ps1 copies this file to server-env.ps1 unless one already exists,
# so local edits survive a re-install. winb-office-tray.ps1 dot-sources server-env.ps1
# before every spawn, so a manual start and a watchdog respawn behave identically.

# --- transport -------------------------------------------------------------------------
# Tunnel-only box: the gateway reaches this server through the reverse SSH tunnel, so the
# listener never has to face the corporate LAN.
$env:WINB_BIND = '127.0.0.1'

# Keeps this machine distinguishable from the home PC in `winb --health` output.
$env:WINB_VERSION_SUFFIX = '-office'

# --- paths -----------------------------------------------------------------------------
# Where commands run when a call passes no working directory.
$env:WINB_DEFAULT_CWD = 'C:\winb-office'

# Typed file writes (fs.write / fs.mkdir / fs.move / fs.rm) are confined to these roots.
# The bridge already runs arbitrary commands, so this is a guard rail against a mistyped
# path, not a security boundary - do not read it as one.
$env:WINB_ALLOWED_ROOTS = 'C:\;D:\'

# --- host context sampler (upstream v1.4, on by default) -------------------------------
# Window titles stay in RAM only on this box.
# $env:WINB_TITLES_PERSIST = '0'
