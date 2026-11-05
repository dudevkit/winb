@echo off
chcp 65001 >nul
title WinB-Office - STATUS
color 0E
cd /d "%~dp0"

echo ============================================
echo   winb-office DIAGNOSTICS
echo   (copy all of this and send it to Alice)
echo ============================================
echo.

echo [1] Folder:
echo     %CD%
echo.

echo [2] Files:
if exist "%~dp0server.js"            (echo     server.js              = OK) else (echo     server.js              = MISSING)
if exist "%~dp0api.js"               (echo     api.js                 = OK) else (echo     api.js                 = MISSING)
if exist "%~dp0sampler.js"           (echo     sampler.js             = OK) else (echo     sampler.js             = MISSING)
if exist "%~dp0server-env.ps1"       (echo     server-env.ps1         = OK) else (echo     server-env.ps1         = MISSING - re-run setup)
if exist "%~dp0winb-office-tray.ps1" (echo     winb-office-tray.ps1   = OK) else (echo     winb-office-tray.ps1   = MISSING)
if exist "%~dp0node_modules\express" (echo     node_modules\express   = OK) else (echo     node_modules\express   = MISSING - run setup-winb-office.ps1)
echo.

echo [3] Legacy files from older revisions (should all be MISSING):
if exist "%~dp0winb-office-server.js" (echo     winb-office-server.js  = STILL PRESENT ^(old entry point^)) else (echo     winb-office-server.js  = clean)
if exist "%~dp0routes.js"             (echo     routes.js              = STILL PRESENT ^(old revision^)) else (echo     routes.js              = clean)
echo.

echo [4] Node:
where node 2>nul
node -v 2>nul
echo.

echo [5] Tray running? (powershell holding the tray script)
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -match 'winb-office-tray' } | ForEach-Object { '    tray host pid ' + $_.ProcessId }"
echo.

echo [6] Server listening on 5110?
netstat -ano | findstr /R /C:"LISTENING.*:5110"
echo.

echo [7] Tunnel ssh process (look for 15110)?
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='ssh.exe'\" | Where-Object { $_.CommandLine -match '15110' } | ForEach-Object { '    ssh pid ' + $_.ProcessId }"
echo.

echo [8] Health endpoint (version + bind host):
curl -s -m 3 http://127.0.0.1:5110/health
echo.
echo.

echo [9] Autostart:
if exist "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\winb-office.lnk" (echo     startup shortcut = OK) else (echo     startup shortcut = MISSING)
schtasks /query /tn winb-office-tray >nul 2>&1 && echo     logon task winb-office-tray = EXISTS
schtasks /query /tn winb-office-server >nul 2>&1 && echo     LEGACY task winb-office-server = STILL EXISTS ^(delete it: schtasks /delete /tn winb-office-server /f^)
echo.

echo [10] Log tails:
echo     --- server.log ---
if exist "%~dp0server.log" (powershell -NoProfile -Command "Get-Content '%~dp0server.log' -Tail 6") else (echo     ^(none^))
echo     --- tunnel.log ---
if exist "%~dp0tunnel.log" (powershell -NoProfile -Command "Get-Content '%~dp0tunnel.log' -Tail 8") else (echo     ^(none^))
echo.

echo ============================================
echo Press any key to close...
pause >nul
