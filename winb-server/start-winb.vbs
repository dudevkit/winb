Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File ""F:\AliceWorkspace\winb-server\winb-tray.ps1""", 0, False
