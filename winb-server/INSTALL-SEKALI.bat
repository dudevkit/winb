@echo off
chcp 65001 >nul
cd /d "%~dp0"
title WinB - INSTALL SEKALI
color 0A

echo ============================================
echo   WinB - INSTALL SEKALI
echo   Working folder:
echo   %CD%
echo ============================================
echo.

REM --- correct folder? ---
if not exist "%~dp0server.js" (
  echo [ERROR] server.js not found in this folder.
  echo Double-click INSTALL-SEKALI.bat inside the winb-server folder
  echo ^(for example Desktop\winb-server^).
  echo.
  echo Current folder: %CD%
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0package.json" (
  echo [ERROR] package.json missing. Wrong folder or bad extract.
  pause
  exit /b 1
)

REM --- Node ---
where node >nul 2>&1
if errorlevel 1 (
  color 0C
  echo [ERROR] Node.js is not installed.
  echo.
  echo Steps:
  echo  1. Install LTS from https://nodejs.org
  echo  2. Check "Add to PATH"
  echo  3. Close all CMD / PowerShell windows
  echo  4. Double-click INSTALL-SEKALI.bat again
  echo.
  start https://nodejs.org/en/download
  pause
  exit /b 1
)

echo [OK] Node.js:
node -v
echo [OK] npm:
call npm -v
echo.

echo ============================================
echo   Running: npm install
echo   Wait until finished. Do not close this window.
echo ============================================
echo.

call npm install
set NPM_EXIT=%ERRORLEVEL%

echo.
echo [DEBUG] npm exit code = %NPM_EXIT%

if not "%NPM_EXIT%"=="0" (
  color 0C
  echo.
  echo [ERROR] npm install FAILED.
  echo Scroll up for red error lines. Screenshot and send to support if needed.
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0node_modules\" (
  color 0C
  echo.
  echo [ERROR] npm reported OK but node_modules is missing.
  echo Try again, or send a screenshot to support.
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0node_modules\express\" (
  color 0C
  echo.
  echo [ERROR] express is not in node_modules.
  echo npm install may be incomplete. Run this bat again.
  echo.
  pause
  exit /b 1
)

echo.
echo [OK] node_modules present. Install succeeded.
echo.

REM --- double-start guard ---
where curl >nul 2>&1
if not errorlevel 1 (
  curl -s -m 2 http://127.0.0.1:5110/ping >nul 2>&1
  if not errorlevel 1 (
    echo [OK] WinB already running on port 5110 — skip start.
    goto :done
  )
)

echo Starting WinB in the system tray ^(port 5110^)...
cscript //nologo "%~dp0start-winb.vbs"
timeout /t 4 >nul

echo.
echo Local check port 5110:
where curl >nul 2>&1
if errorlevel 1 (
  echo ^(curl not found — open http://127.0.0.1:5110/ping in a browser^)
) else (
  curl -s -m 3 http://127.0.0.1:5110/ping
  echo.
)

:done
echo.
echo ============================================
echo   DONE
echo   - Tray icon "WinB Server" should appear near the clock
echo   - If Windows Firewall prompts: Allow
echo ============================================
echo.
echo This window stays open on purpose.
echo Read above, then press any key...
pause
