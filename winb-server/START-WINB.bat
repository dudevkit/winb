@echo off
chcp 65001 >nul
cd /d "%~dp0"
title WinB - START
color 0B

echo Folder: %CD%
echo.

if not exist "%~dp0server.js" (
  echo [ERROR] Bukan folder winb-server yang benar.
  echo Path harus seperti: Desktop\winb-server
  pause
  exit /b 1
)

if not exist "%~dp0node_modules\" (
  color 0C
  echo [ERROR] Belum ter-install.
  echo.
  echo Artinya folder node_modules belum ada.
  echo Solusi: double-click  INSTALL-SEKALI.bat
  echo ^(bukan START-WINB.bat^) sampai selesai, JANGAN ditutup.
  echo.
  echo Kalau INSTALL langsung nutup, download ulang zip dari
  echo files.mysuki.web.id / winb-for-windows / winb-server.zip
  echo.
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  color 0C
  echo [ERROR] Node.js tidak ketemu di PATH.
  echo Install Node LTS, tutup semua CMD, coba lagi.
  pause
  exit /b 1
)

echo [OK] node_modules ada. Menyalakan WinB...
cscript //nologo "%~dp0start-winb.vbs"
timeout /t 3 >nul

echo.
where curl >nul 2>&1
if not errorlevel 1 (
  echo Cek: 
  curl -s http://127.0.0.1:5110/ping
  echo.
)

echo.
echo Kalau OK, icon tray WinB muncul di bawah kanan.
echo Tekan tombol apa saja untuk tutup jendela ini...
pause
