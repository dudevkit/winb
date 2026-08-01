Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")
' Folder script ini = Desktop\winb-server
scriptDir = FSO.GetParentFolderName(WScript.ScriptFullName)
ps1 = scriptDir & "\winb-tray.ps1"
WshShell.CurrentDirectory = scriptDir
WshShell.Run "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """", 0, False
