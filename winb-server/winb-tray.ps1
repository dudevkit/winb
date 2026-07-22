Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$workDir = "F:\AliceWorkspace\winb-server"
$logFile = "$workDir\server.log"

# Clear old log slightly by adding a separator
Add-Content -Path $logFile -Value "============================================"
Add-Content -Path $logFile -Value "Winb Server Started at $(Get-Date)"
Add-Content -Path $logFile -Value "============================================"

# Start Node server via CMD so it can append to the log safely without locking it
$procInfo = New-Object System.Diagnostics.ProcessStartInfo
$procInfo.FileName = "cmd.exe"
$procInfo.Arguments = "/c node server.js >> server.log 2>&1"
$procInfo.WorkingDirectory = $workDir
$procInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$procInfo.CreateNoWindow = $true
$proc = [System.Diagnostics.Process]::Start($procInfo)

# Setup Tray Icon
$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon((Get-Process -id $PID).Path)
$notifyIcon.Text = "Winb Server (Port 5110)"
$notifyIcon.Visible = $true

# Setup Context Menu
$contextMenu = New-Object System.Windows.Forms.ContextMenu

$menuLogs = New-Object System.Windows.Forms.MenuItem
$menuLogs.Text = "View Logs"
$menuLogs.add_Click({
    Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -NoExit -File ""$workDir\tail-log.ps1"""
})

$menuRestart = New-Object System.Windows.Forms.MenuItem
$menuRestart.Text = "Restart Server (Hard)"
$menuRestart.add_Click({
    $result = [System.Windows.Forms.MessageBox]::Show(
        "Are you sure you want to hard restart the Winb Server?`n`nWARNING: This will kill ALL currently running background tasks managed by the server.", 
        "Confirm Restart", 
        [System.Windows.Forms.MessageBoxButtons]::YesNo, 
        [System.Windows.Forms.MessageBoxIcon]::Warning
    )
    
    if ($result -eq [System.Windows.Forms.DialogResult]::Yes) {
        # Forcefully kill ALL node.exe processes first (like the manual taskkill)
        # This prevents zombie background tasks from holding port 5110
        Stop-Process -Name "node" -Force -ErrorAction SilentlyContinue
        
        # Kill the cmd wrapper as well
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        
        # Start a new node process
        Add-Content -Path $logFile -Value "============================================"
        Add-Content -Path $logFile -Value "Winb Server (HARD RESTART) at $(Get-Date)"
        Add-Content -Path $logFile -Value "============================================"
        $procInfo = New-Object System.Diagnostics.ProcessStartInfo
        $procInfo.FileName = "cmd.exe"
        $procInfo.Arguments = "/c node server.js >> server.log 2>&1"
        $procInfo.WorkingDirectory = $workDir
        $procInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
        $procInfo.CreateNoWindow = $true
        $proc = [System.Diagnostics.Process]::Start($procInfo)
    }
})

$menuExit = New-Object System.Windows.Forms.MenuItem
$menuExit.Text = "Exit Winb Server"
$menuExit.add_Click({
    # Ensure we kill the node server cleanly on exit
    Stop-Process -Name "node" -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    $notifyIcon.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})

$contextMenu.MenuItems.Add($menuLogs)
$contextMenu.MenuItems.Add($menuRestart)
$contextMenu.MenuItems.Add("-") # Separator line
$contextMenu.MenuItems.Add($menuExit)
$notifyIcon.ContextMenu = $contextMenu

# Double click action
$notifyIcon.add_DoubleClick({
    Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -NoExit -File ""$workDir\tail-log.ps1"""
})

# Cleanup if script exits
Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action {
    Stop-Process -Id $proc.Id -Force
}

# Start the Windows Forms application loop
[System.Windows.Forms.Application]::Run()
