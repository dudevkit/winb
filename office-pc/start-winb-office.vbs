' start-winb-office.vbs
' Silent bootstrap for the winb-office tray on the OFFICE PC.
'
' wscript runs this with no console window, and it launches the tray PowerShell
' in a hidden window. Net effect: no console is ever visible, only the tray icon.
'
' The folder is resolved from this script's own path, so the kit must live at
' its final location (setup-winb-office.ps1 copies it to C:\winb-office).

Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")

scriptDir = FSO.GetParentFolderName(WScript.ScriptFullName)
ps1 = scriptDir & "\winb-office-tray.ps1"

WshShell.CurrentDirectory = scriptDir
WshShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """", 0, False
