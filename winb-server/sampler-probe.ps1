# Persistent probe helper for sampler.js.
#
# Two modes:
#   -Once [-Events] [-Hours N]   gather one payload and exit (used when the persistent child
#                                cannot start)
#   (no parameters)              stay alive: read a command per line on stdin, write one JSON
#                                line per command on stdout. Keeps the Add-Type compilation paid
#                                once instead of per call.
#
# Commands: "tick" -> host sample, "events [hours]" -> recent OS event-log entries,
#           "quit" -> exit.
#
# Cost notes (measured on a 16-core host with 373 processes):
#   Get-Process raw ................  31 ms
#   WorkingSet64 for every process .  24 ms
#   .CPU for every process ......... 1732 ms   <-- why the CPU list is built from candidates
#   MainWindowTitle scan ...........  171 ms
#   CIM boot/memory ................   69 ms
#   event-log sweep (4 ids) ........ 165 ms
# Reading .CPU is a performance-counter lookup per process, so it is done only for the
# processes worth ranking (top 25 by working set). A CPU-heavy process with a tiny
# footprint can therefore be missed - documented, and the price of a 0.5 s tick.
#
# Everything is best effort: PowerShell 5.1 on Windows 10/11, no elevation, no module
# imports beyond what ships with the OS. A failure produces {"error": "..."} instead of no
# output, so the sampler can report a reason rather than just going quiet.

param([switch]$Once, [switch]$Events, [int]$Hours = 3)

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$cs = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class WinbProbe {
    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    public static uint IdleSeconds() {
        LASTINPUTINFO li = new LASTINPUTINFO();
        li.cbSize = (uint)Marshal.SizeOf(li);
        if (!GetLastInputInfo(ref li)) return 0;
        return ((uint)Environment.TickCount - li.dwTime) / 1000;
    }
}
'@

$nativeReady = $true
try { Add-Type -TypeDefinition $cs -ErrorAction Stop } catch { $nativeReady = $false }

function Get-Tick {
    $out = [ordered]@{ t = (Get-Date).ToString('o'); platform = 'win32'; error = $null }

    $all = @(Get-Process)
    $out.procCount = $all.Count

    # Rank only processes with a real footprint: .CPU is the expensive property.
    $candidates = @($all | Where-Object { $null -ne $_.WorkingSet64 } |
        Sort-Object WorkingSet64 -Descending | Select-Object -First 25)
    $out.procs = @($candidates | Where-Object { $null -ne $_.CPU } | Sort-Object CPU -Descending |
        Select-Object -First 8 | ForEach-Object {
            [pscustomobject]@{ name = $_.ProcessName; cpuSec = [math]::Round($_.CPU, 1); wsMb = [math]::Round($_.WorkingSet64 / 1MB, 0) }
        })

    $out.windows = @($all | Where-Object { $_.MainWindowTitle } | Sort-Object CPU -Descending |
        Select-Object -First 12 | ForEach-Object {
            [pscustomobject]@{ app = "$($_.ProcessName).exe"; title = $_.MainWindowTitle; cpuSec = [math]::Round($_.CPU, 1) }
        })

    $out.fg = $null
    if ($nativeReady) {
        try {
            $h = [WinbProbe]::GetForegroundWindow()
            if ($h -ne [IntPtr]::Zero) {
                $sb = New-Object System.Text.StringBuilder 512
                [void][WinbProbe]::GetWindowText($h, $sb, 512)
                $fgPid = 0
                [void][WinbProbe]::GetWindowThreadProcessId($h, [ref]$fgPid)
                $name = $null
                if ($fgPid -gt 0) { $name = (Get-Process -Id $fgPid).ProcessName }
                if ($name) { $out.fg = [pscustomobject]@{ app = "$name.exe"; title = $sb.ToString() } }
            }
        } catch { }
    }

    $idle = $null
    if ($nativeReady) { try { $idle = [int][WinbProbe]::IdleSeconds() } catch { } }
    $out.idleSec = $idle

    $boot = $null
    try {
        $os = Get-CimInstance Win32_OperatingSystem -Property LastBootUpTime, FreePhysicalMemory, TotalVisibleMemorySize
        if ($os) {
            $boot = $os.LastBootUpTime.ToString('o')
            $out.memFreeMb = [math]::Round($os.FreePhysicalMemory / 1024, 0)
            $out.memTotalMb = [math]::Round($os.TotalVisibleMemorySize / 1024, 0)
        }
    } catch { }
    $out.boot = $boot

    # Flat objects only: DriveInfo / NetworkInterface serialize into megabytes when passed
    # straight to ConvertTo-Json.
    $out.disks = @([System.IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady -and $_.TotalSize -gt 0 } | ForEach-Object {
            [pscustomobject]@{
                drive   = $_.Name.TrimEnd('\')
                freeGb  = [math]::Round($_.AvailableFreeSpace / 1GB, 1)
                totalGb = [math]::Round($_.TotalSize / 1GB, 1)
                pct     = [math]::Round(100 * $_.AvailableFreeSpace / $_.TotalSize, 1)
            }
        })

    $out.net = @([System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
        Where-Object { $_.NetworkInterfaceType -ne 'Loopback' } | ForEach-Object {
            $addr = @($_.GetIPProperties().UnicastAddresses | Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' } |
                ForEach-Object { $_.Address.ToString() }) -join ','
            [pscustomobject]@{ iface = $_.Name; state = "$($_.OperationalStatus)"; speedMbps = [math]::Round($_.Speed / 1MB, 0); address = $addr }
        })

    # user + session type are instant env reads, no CIM round trip
    $out.session = [pscustomobject]@{
        user   = "$env:USERDOMAIN\$env:USERNAME"
        name   = $env:SESSIONNAME
        locked = [bool](@(Get-Process -Name LogonUI).Count)
    }

    [pscustomobject]$out
}

function Get-RecentEvents {
    param([int]$LookbackHours = 3)
    if ($LookbackHours -le 0) { $LookbackHours = 3 }
    $rows = New-Object System.Collections.ArrayList
    foreach ($spec in @(@{ log = 'System'; ids = @(6005, 6006, 6008, 1074) },
            @{ log = 'Application'; ids = @(1000, 1002) })) {
        try {
            $found = Get-WinEvent -FilterHashtable @{ LogName = $spec.log; Id = $spec.ids; StartTime = (Get-Date).AddHours(-$LookbackHours) } -MaxEvents 25 -ErrorAction Stop
            foreach ($e in $found) {
                $first = ($e.Message -split "`r?`n")[0]
                if ($null -eq $first) { $first = '' }
                if ($first.Length -gt 200) { $first = $first.Substring(0, 200) }
                [void]$rows.Add([pscustomobject]@{ log = $spec.log; id = $e.Id; time = $e.TimeCreated.ToString('o'); msg = $first })
            }
        } catch { }
    }
    # Force an array: an empty result must serialize as [] and never as null or {}.
    # No leading comma here: ,@() would nest the array one level deeper ([[...]]).
    return @($rows | Sort-Object time | Select-Object -Last 40)
}

function Invoke-Mode {
    param([switch]$EventsOnly, [int]$LookbackHours = 3)
    $payload = $null
    try {
        if ($EventsOnly) {
            $payload = [pscustomobject]@{ t = (Get-Date).ToString('o'); events = @(Get-RecentEvents -LookbackHours $LookbackHours) }
        } else {
            $payload = Get-Tick
        }
    } catch {
        $payload = [pscustomobject]@{ t = (Get-Date).ToString('o'); error = $_.Exception.Message }
    }
    ($payload | ConvertTo-Json -Depth 5 -Compress)
}

if ($Once) {
    Invoke-Mode -EventsOnly:$Events -LookbackHours $Hours
    exit 0
}

while ($true) {
    $line = $null
    try { $line = [Console]::In.ReadLine() } catch { break }
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -eq '') { continue }
    if ($line -eq 'quit') { break }
    if ($line -like 'events*') {
        $hours = 3
        $parts = $line.Split(' ')
        if ($parts.Count -gt 1) { [void][int]::TryParse($parts[1], [ref]$hours) }
        Invoke-Mode -EventsOnly -LookbackHours $hours
    } else {
        Invoke-Mode
    }
    [Console]::Out.Flush()
}
