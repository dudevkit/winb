@echo off
chcp 65001 >nul
cd /d "%~dp0"
title WinB - START
color 0B

echo Folder: %CD%
echo.

if not exist "%~dp0server.js" (
  echo [ERROR] This is not the winb-server folder.
  echo Expected path like: Desktop\winb-server
  pause
  exit /b 1
)

if not exist "%~dp0node_modules\" (
  color 0C
  echo [ERROR] Not installed yet.
  echo.
  echo node_modules is missing.
  echo Run INSTALL-SEKALI.bat first ^(not this file^) and wait until it finishes.
  echo.
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  color 0C
  echo [ERROR] Node.js not found in PATH.
  echo Install Node LTS, close all CMD windows, try again.
  pause
  exit /b 1
)

REM --- already up? ---
where curl >nul 2>&1
if not errorlevel 1 (
  curl -s -m 2 http://127.0.0.1:5110/ping >nul 2>&1
  if not errorlevel 1 (
    echo [OK] WinB already running on port 5110.
    curl -s -m 2 http://127.0.0.1:5110/ping
    echo.
    echo No second instance started.
    pause
    exit /b 0
  )
)

echo [OK] node_modules found. Starting WinB...
cscript //nologo "%~dp0start-winb.vbs"
timeout /t 3 >nul

echo.
where curl >nul 2>&1
if not errorlevel 1 (
  echo Check:
  curl -s -m 3 http://127.0.0.1:5110/ping
  echo.
)

echo.
echo If OK, tray icon WinB appears near the clock.
echo Press any key to close...
pause
