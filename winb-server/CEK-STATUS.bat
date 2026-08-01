@echo off
chcp 65001 >nul
cd /d "%~dp0"
title WinB - CEK STATUS
color 0E

echo ============================================
echo   DIAGNOSA WinB (kirim hasil ini ke Ki)
echo ============================================
echo.
echo [1] Folder bat ini:
echo %CD%
echo.

echo [2] File penting:
if exist "%~dp0server.js" (echo   server.js        = ADA) else (echo   server.js        = TIDAK ADA)
if exist "%~dp0package.json" (echo   package.json     = ADA) else (echo   package.json     = TIDAK ADA)
if exist "%~dp0node_modules\" (echo   node_modules\    = ADA) else (echo   node_modules\    = TIDAK ADA  ^<-- ini penyebab "belum di install")
if exist "%~dp0node_modules\express\" (echo   express          = ADA) else (echo   express          = TIDAK ADA)
echo.

echo [3] Node / npm:
where node 2>nul
where npm 2>nul
node -v 2>nul
call npm -v 2>nul
echo.

echo [4] Proses node yang jalan:
tasklist /FI "IMAGENAME eq node.exe" 2>nul
echo.

echo [5] Tes port 5110:
where curl >nul 2>&1
if errorlevel 1 (
  echo curl tidak ada. Coba buka browser: http://127.0.0.1:5110/ping
) else (
  curl -s -m 3 http://127.0.0.1:5110/ping
  echo.
)
echo.

echo ============================================
echo Scroll ke atas, foto / copy teks, kirim Discord.
echo ============================================
pause
