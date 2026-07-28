@echo off
chcp 65001 >nul
cd /d "%~dp0"
title WinB - INSTALL SEKALI
color 0A

echo ============================================
echo   WinB - INSTALL SEKALI
echo   Folder kerja:
echo   %CD%
echo ============================================
echo.

REM --- cek kita di folder yang benar ---
if not exist "%~dp0server.js" (
  echo [ERROR] File server.js tidak ada di folder ini.
  echo Pastikan lo double-click INSTALL-SEKALI.bat
  echo di dalam folder: Desktop\winb-server
  echo.
  echo Folder sekarang: %CD%
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0package.json" (
  echo [ERROR] package.json tidak ada. Folder salah / extract rusak.
  pause
  exit /b 1
)

REM --- cek Node ---
where node >nul 2>&1
if errorlevel 1 (
  color 0C
  echo [ERROR] Node.js BELUM terpasang di Windows.
  echo.
  echo Lakukan:
  echo  1. Install dari https://nodejs.org  ^(pilih LTS^)
  echo  2. Centang "Add to PATH"
  echo  3. TUTUP semua jendela CMD / PowerShell
  echo  4. Double-click INSTALL-SEKALI.bat lagi
  echo.
  start https://nodejs.org/en/download
  pause
  exit /b 1
)

echo [OK] Node.js ketemu:
node -v
echo [OK] npm:
call npm -v
echo.

echo ============================================
echo   Menjalankan: npm install
echo   Tunggu sampai selesai. JANGAN ditutup.
echo ============================================
echo.

call npm install
set NPM_EXIT=%ERRORLEVEL%

echo.
echo [DEBUG] npm exit code = %NPM_EXIT%

if not "%NPM_EXIT%"=="0" (
  color 0C
  echo.
  echo [ERROR] npm install GAGAL.
  echo Scroll ke atas, lihat baris merah / error.
  echo Screenshot error itu, kirim ke Ki di Discord.
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0node_modules\" (
  color 0C
  echo.
  echo [ERROR] npm bilang OK tapi folder node_modules TIDAK ADA.
  echo Coba lagi, atau kirim screenshot ke Ki.
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0node_modules\express\" (
  color 0C
  echo.
  echo [ERROR] express belum terinstall di node_modules.
  echo npm install mungkin tidak lengkap. Coba jalankan lagi.
  echo.
  pause
  exit /b 1
)

echo.
echo [OK] node_modules ADA. Install sukses.
echo.
echo Menyalakan WinB di system tray (port 5110)...
cscript //nologo "%~dp0start-winb.vbs"
timeout /t 4 >nul

echo.
echo Cek lokal port 5110:
where curl >nul 2>&1
if errorlevel 1 (
  echo ^(curl tidak ada - skip cek otomatis^)
  echo Buka browser: http://127.0.0.1:5110/ping
) else (
  curl -s http://127.0.0.1:5110/ping
  echo.
)

echo.
echo ============================================
echo   SELESAI
echo   - Harus ada icon tray "WinB Server" bawah kanan
echo   - Kalau Firewall popup: klik ALLOW / Izinkan
echo   - Balas Discord: winb nyala
echo ============================================
echo.
echo Jendela ini SENGAJA tidak auto-close.
echo Baca dulu, baru tekan tombol apa saja...
pause
