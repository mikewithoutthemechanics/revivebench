# =====================================================================
# ReviveBench USB stick writer (adapted from the proven write_usb.ps1)
#
#   Part 1: raw (dd-style) write of the product ISO to the USB disk
#           - certutil SHA-256 verify first (this box has no Get-FileHash)
#           - 1 MB buffer FileStream to \\.\PhysicalDriveN, Flush($true)
#           - byte-count equality check
#   Part 2: FAT32 tail partition labeled REVBENCH, then robocopy
#           resources\bench  -> <letter>:\bench
#           resources\payload-> <letter>:\payload
#           + AUTORUN.txt / start-bench.sh at the partition root
#
# Guards (ALL abort before touching any disk):
#   ISO exists -> certutil hash vs pin -> target exists -> Disk 0 refused ->
#   BusType must be USB (re-checked immediately before the write) ->
#   ISO must fit -> >= 6 GB -> boot/system volume refused ->
#   tail >= 64 MB -> bench/payload resources present + payload hash pin
#
# Modes:
#   no args                 : list USB candidates + usage (READ-ONLY)
#   -DryRun / -WhatIf       : run every guard + print the plan, touch nothing
#   not elevated, real run  : run every guard, print them, exit 2 (no changes)
#   elevated, real run      : full write
#
# Log: -LogPath, default $env:TEMP\revivebench_write_log.txt
#      machine lines (no timestamp): PROGRESS n / PHASE text / ABORT: ... /
#      RESULT OK|FAIL  -- everything else is timestamped.
# =====================================================================

param(
    [string]$IsoPath = '',
    [int]$DiskNumber = -1,
    [string]$ExpectedSha256 = '',
    [string]$BenchDir = '',
    [string]$PayloadDir = '',
    [string]$LogPath = '',
    [switch]$SkipHashCheck,
    [switch]$SkipPayloadHash,
    [switch]$DryRun,
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # keep CLIXML progress records out of the log

# pinned sha256 of resources\payload\Legacy-iOS-Activator2-7.tar.gz (spec 3/6)
$script:PayloadPin = '97ac871064c944845816d004a5aebe340670dd48545cd15733bf13d59ceed783'
$script:TarName = 'Legacy-iOS-Activator2-7.tar.gz'
$script:LogFile = if ($LogPath) { $LogPath } else { Join-Path $env:TEMP 'revivebench_write_log.txt' }
$script:Dry = [bool]($DryRun -or $WhatIf)
$script:ExitCode = 0

function Append-Line([string]$text) {
    try {
        [System.IO.File]::AppendAllText(
            $script:LogFile,
            $text + "`r`n",
            (New-Object System.Text.UTF8Encoding($false))
        )
    } catch { }
}

# human line (timestamped)
function Log([string]$m) {
    $line = ('{0}  {1}' -f (Get-Date -Format 'HH:mm:ss'), $m)
    Append-Line $line
    Write-Output $line
}

# machine line (raw, parsed by the app)
function M([string]$m) {
    Append-Line $m
    Write-Output $m
}

function Phase([string]$m) { M ('PHASE ' + $m) }
function Prog([int]$p) { if ($p -gt 100) { $p = 100 }; M ('PROGRESS ' + $p) }

# throws -> caught at the bottom -> RESULT FAIL + exit 1
function Abort([string]$m) { throw (New-Object System.Exception $m) }

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-FreeDriveLetter {
    $used = @{}
    foreach ($di in [System.IO.DriveInfo]::GetDrives()) {
        $used[[string]($di.Name.TrimEnd('\').TrimEnd(':').ToUpper())] = $true
    }
    foreach ($c in 'R', 'Q', 'P', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'M', 'N', 'O') {
        if (-not $used.ContainsKey($c)) { return $c }
    }
    return $null
}

function Get-UsbDisks {
    $list = @()
    foreach ($d in @(Get-Disk)) {
        if ($d.BusType -eq 'USB') { $list += $d }
    }
    return $list
}

function Show-UsbListing {
    Log 'USB disks detected (read-only listing):'
    $any = $false
    foreach ($d in Get-UsbDisks) {
        $any = $true
        $parts = @(Get-Partition -DiskNumber $d.Number -ErrorAction SilentlyContinue).Count
        $suffix = ''
        if ($d.IsReadOnly) { $suffix = ' | READ-ONLY' }
        $vol = Get-Partition -DiskNumber $d.Number -ErrorAction SilentlyContinue |
               Get-Volume -ErrorAction SilentlyContinue |
               Where-Object { $_.FileSystemLabel } | Select-Object -First 1
        if ($vol) { $suffix = $suffix + ' | label=' + $vol.FileSystemLabel }
        Log ('  Disk {0}: {1} | {2} GB | {3} | partitions={4}{5}' -f `
            $d.Number, $d.FriendlyName, [math]::Round($d.Size / 1GB, 1), $d.PartitionStyle, $parts, $suffix)
    }
    if (-not $any) { Log '  (none found)' }
}

function Show-Usage {
    Log 'Usage:'
    Log '  write_stick.ps1 -IsoPath <file.iso> -DiskNumber <n> [-ExpectedSha256 <sha256>]'
    Log '                  [-BenchDir <dir>] [-PayloadDir <dir>] [-LogPath <file>]'
    Log '                  [-SkipHashCheck] [-DryRun|-WhatIf]'
    Log '  write_stick.ps1            (no args: list USB candidates + usage, no changes)'
}

function Copy-Tree([string]$src, [string]$dst, [string]$what, [int]$pct) {
    Phase ('copy ' + $what)
    Prog $pct
    if (-not (Test-Path -LiteralPath $dst)) {
        New-Item -ItemType Directory -Path $dst -Force | Out-Null
    }
    $out = robocopy $src $dst /E /R:2 /W:2 /NFL /NDL /NP 2>&1 | Out-String
    $code = $LASTEXITCODE
    foreach ($line in ($out -split "`r?`n" | Where-Object { $_ -match '\S' })) { Log ('  ' + $line.TrimEnd()) }
    if ($code -ge 8) { Abort ('robocopy ' + $what + ' failed with exit code ' + $code) }
    if ($code -ge 4) { Log ('WARNING: robocopy ' + $what + ' reported skipped/mismatched items (exit ' + $code + ')') }
    $count = @(Get-ChildItem -LiteralPath $dst -Recurse -Force -ErrorAction SilentlyContinue).Count
    if ($count -eq 0) { Abort ('robocopy ' + $what + ' left the destination empty: ' + $dst) }
    Log ('  ' + $what + ': ' + $count + ' item(s) copied')
}

function Main {
    $admin = Test-IsAdmin

    M ('=== ReviveBench write session ' + (Get-Date -Format s) + ' | elevated=' + $admin + ' | dryRun=' + $script:Dry)
    M ('=== log: ' + $script:LogFile)

    Show-UsbListing

    # ---- no parameters: listing + usage only (safe in any elevation) -------
    if ($IsoPath -eq '' -or $DiskNumber -lt 0) {
        Show-Usage
        if (-not $admin) {
            Log 'NOT ELEVATED - listing/guard output only, no disk changes were made.'
            M 'RESULT LISTING'
            $script:ExitCode = 2
        } else {
            M 'RESULT LISTING'
            $script:ExitCode = 0
        }
        return
    }

    # ===================== GUARDS (all read-only) ========================

    Phase 'guard: ISO present'
    if (-not (Test-Path -LiteralPath $IsoPath)) { Abort ('ISO not found at ' + $IsoPath) }
    $isoLen = [int64](Get-Item -LiteralPath $IsoPath).Length
    if ($isoLen -le 0) { Abort 'ISO file is empty' }
    Log ('ISO: ' + $IsoPath + ' (' + $isoLen + ' bytes)')
    Prog 2

    Phase 'guard: ISO sha256 (certutil)'
    try {
        $hash = [string]((certutil -hashfile $IsoPath SHA256)[1]).Trim()
        $hash = $hash.ToLower()
    } catch {
        Abort ('certutil hash failed: ' + $_.Exception.Message)
    }
    if ($hash -notmatch '^[0-9a-f]{64}$') { Abort ('unexpected certutil output: ' + $hash) }
    Log ('ISO sha256: ' + $hash)
    $expected = ''
    if ($ExpectedSha256) { $expected = $ExpectedSha256.Trim().ToLower() }
    if (-not $expected) {
        Log 'WARNING: no expected sha256 supplied - ISO integrity is not pinned'
    } elseif ($SkipHashCheck) {
        if ($hash -ne $expected) {
            Log ('WARNING: hash pin BYPASSED by operator confirm (computed ' + $hash + ', pinned ' + $expected + ')')
        } else {
            Log 'Hash matches the pin (check bypassed anyway)'
        }
    } elseif ($hash -ne $expected) {
        Abort ('SHA256 MISMATCH - computed ' + $hash + ' != pinned ' + $expected + ' (wrong or corrupt ISO)')
    } else {
        Log 'Hash verified OK'
    }
    Prog 5

    Phase 'guard: target disk'
    if ($DiskNumber -eq 0) { Abort 'refusing Disk 0 (the system disk)' }
    try { $d = Get-Disk -Number $DiskNumber -ErrorAction Stop }
    catch { Abort ('Disk ' + $DiskNumber + ' not found: ' + $_.Exception.Message) }
    if ($d.BusType -ne 'USB') { Abort ('Disk ' + $DiskNumber + ' BusType=' + $d.BusType + ', not USB') }
    if ([int64]$d.Size -lt [int64]6442450944) { Abort ('Disk ' + $DiskNumber + ' is smaller than 6 GB') }
    if ($isoLen -gt [int64]$d.Size) { Abort ('ISO (' + $isoLen + ' bytes) is larger than Disk ' + $DiskNumber + ' (' + $d.Size + ' bytes)') }
    $bootPart = Get-Partition -DiskNumber $DiskNumber -ErrorAction SilentlyContinue |
                Where-Object { $_.IsBoot -or $_.IsSystem }
    if ($bootPart) { Abort ('Disk ' + $DiskNumber + ' hosts a boot/system volume - refusing to touch it') }
    $tailBytes = [int64]$d.Size - $isoLen
    if ($tailBytes -lt 67108864) {
        Abort ('only ' + $tailBytes + ' bytes of free tail after the ISO - need >= 64 MB for the REVBENCH partition')
    }
    Log ('Target OK: Disk {0} {1} | {2} GB USB | tail after ISO: {3} GB' -f `
        $d.Number, $d.FriendlyName, [math]::Round($d.Size / 1GB, 1), [math]::Round($tailBytes / 1GB, 2))
    Prog 6

    Phase 'guard: bench + payload resources'
    if (-not $BenchDir) { $BenchDir = Join-Path $PSScriptRoot '..\resources\bench' }
    if (-not $PayloadDir) { $PayloadDir = Join-Path $PSScriptRoot '..\resources\payload' }
    $BenchDir = [System.IO.Path]::GetFullPath($BenchDir)
    $PayloadDir = [System.IO.Path]::GetFullPath($PayloadDir)
    if (-not (Test-Path -LiteralPath $BenchDir)) { Abort ('bench resources not found: ' + $BenchDir) }
    if (-not (Test-Path -LiteralPath $PayloadDir)) { Abort ('payload resources not found: ' + $PayloadDir) }
    $benchCount = @(Get-ChildItem -LiteralPath $BenchDir -Recurse -Force -ErrorAction SilentlyContinue).Count
    $payloadCount = @(Get-ChildItem -LiteralPath $PayloadDir -Recurse -Force -ErrorAction SilentlyContinue).Count
    if ($benchCount -eq 0) { Abort ('bench resources dir is empty: ' + $BenchDir) }
    if ($payloadCount -eq 0) { Abort ('payload resources dir is empty: ' + $PayloadDir) }
    Log ('bench: ' + $benchCount + ' item(s) in ' + $BenchDir)
    Log ('payload: ' + $payloadCount + ' item(s) in ' + $PayloadDir)
    Prog 7

    Phase 'guard: payload tarball sha256'
    $tarPath = Join-Path $PayloadDir $script:TarName
    if (-not (Test-Path -LiteralPath $tarPath)) { Abort ('payload tarball missing: ' + $tarPath) }
    try {
        $tarHash = ([string]((certutil -hashfile $tarPath SHA256)[1])).Trim().ToLower()
    } catch {
        Abort ('payload hash failed: ' + $_.Exception.Message)
    }
    if ($SkipPayloadHash) {
        Log ('WARNING: payload hash pin bypassed (computed ' + $tarHash + ')')
    } elseif ($tarHash -ne $script:PayloadPin) {
        Abort ('payload tarball sha256 mismatch: ' + $tarHash + ' != pinned ' + $script:PayloadPin)
    } else {
        Log 'Payload hash verified OK'
    }
    Prog 8

    # ===================== DRY RUN: report, touch nothing ================
    if ($script:Dry) {
        Phase 'dry run plan'
        Log 'DRY RUN - no disk was or will be modified.'
        Log ('  1. diskpart: select disk ' + $DiskNumber + ' ; clean')
        Log ('  2. raw write ' + $isoLen + ' bytes -> \\.\PhysicalDrive' + $DiskNumber + ' (1 MB buffer, write-through), byte-count verify')
        $freeMB = [int64][math]::Floor($tailBytes / 1MB) - 16
        $createWhat = 'create partition primary (all free tail)'
        if ($freeMB -gt 32760) { $createWhat = 'create partition primary size=32767 (FAT32 cap)' }
        Log ('  3. diskpart: ' + $createWhat + ' ; format fs=fat32 quick label=REVBENCH ; assign letter=<free>')
        Log ('  4. robocopy ' + $BenchDir + '  -> <letter>:\bench   (' + $benchCount + ' items)')
        Log ('  5. robocopy ' + $PayloadDir + ' -> <letter>:\payload (' + $payloadCount + ' items, tarball sha256 ' + $tarHash + ')')
        Log '  6. write AUTORUN.txt + start-bench.sh at the partition root'
        Log '  7. diskpart rescan + partition report'
        Log ('Current partition table of Disk ' + $DiskNumber + ' (informational):')
        foreach ($line in ((Get-Partition -DiskNumber $DiskNumber -ErrorAction SilentlyContinue |
                Format-Table PartitionNumber, Type, DriveLetter, @{n = 'SizeMB'; e = { [math]::Round($_.Size / 1MB, 0) }} |
                Out-String) -split "`r?`n")) {
            if ($line.Trim()) { Log ('  ' + $line.TrimEnd()) }
        }
        Prog 100
        M 'RESULT OK'
        Log 'DRYRUN OK - all guards passed, no disk changes performed'
        $script:ExitCode = 0
        return
    }

    # ===================== REAL RUN: needs elevation =====================
    if (-not $admin) {
        Log 'ELEVATION REQUIRED - every guard above passed, but the write step needs'
        Log 'administrator rights (UAC). Re-run elevated or launch from the app.'
        M 'RESULT NEED-ELEVATION'
        $script:ExitCode = 2
        return
    }

    # ---- 3) clean the target disk (diskpart, one specific disk) ----------
    Phase 'clean target disk'
    Prog 10
    $dpClean = Join-Path $env:TEMP 'rb_dp_clean.txt'
    @"
select disk $DiskNumber
clean
exit
"@ | Set-Content -LiteralPath $dpClean -Encoding ascii
    $out = diskpart /s $dpClean 2>&1 | Out-String
    foreach ($line in ($out -split "`r?`n" | Where-Object { $_ -match '\S' })) { Log ('  ' + $line.TrimEnd()) }
    if ($LASTEXITCODE -ne 0 -or $out -notmatch 'cleaned') {
        Abort ('diskpart clean failed on Disk ' + $DiskNumber)
    }
    try { Set-Disk -Number $DiskNumber -IsReadOnly $false -ErrorAction Stop }
    catch { Log ('Note: IsReadOnly: ' + $_.Exception.Message) }

    # spec 6: re-verify USB at execution time, immediately before the write
    try { $d2 = Get-Disk -Number $DiskNumber -ErrorAction Stop }
    catch { Abort ('Disk ' + $DiskNumber + ' vanished before write: ' + $_.Exception.Message) }
    if ($d2.BusType -ne 'USB') {
        Abort ('pre-write re-check failed: Disk ' + $DiskNumber + ' BusType=' + $d2.BusType)
    }

    # ---- 4) raw ISO write (proven write_usb.ps1 logic) -------------------
    Phase 'raw ISO write'
    Prog 11
    try {
        $src = [System.IO.File]::Open($IsoPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
        $dst = [System.IO.File]::Open(('\\.\PhysicalDrive' + $DiskNumber), [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    } catch {
        Abort ('cannot open device: ' + $_.Exception.Message)
    }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $buf = New-Object byte[] (1MB)
    $written = [int64]0
    $lastPct = 11
    $fail = $null
    try {
        while (($read = $src.Read($buf, 0, $buf.Length)) -gt 0) {
            $dst.Write($buf, 0, $read)
            $written += $read
            $pct = 11 + [int](64.0 * $written / $isoLen)
            if ($pct -gt 75) { $pct = 75 }
            if ($pct -gt $lastPct) { $lastPct = $pct; Prog $pct }
        }
        $dst.Flush($true)   # force write-through to the device
    } catch {
        $fail = $_.Exception.Message
    } finally {
        $src.Close()
        $dst.Close()
    }
    $sw.Stop()

    Log ('Wrote ' + $written + ' bytes in ' + [math]::Round($sw.Elapsed.TotalSeconds, 1) + 's (' +
        [math]::Round(($written / 1MB) / [math]::Max($sw.Elapsed.TotalSeconds, 0.001), 1) + ' MB/s)')
    if ($fail) { Abort ('write error: ' + $fail) }
    if ($written -ne $isoLen) { Abort ('wrote ' + $written + ' != iso size ' + $isoLen) }
    Log 'Byte-count verify OK'
    Prog 78

    # ---- rescan so Windows re-reads the new partition table ---------------
    Phase 'rescan'
    $dpRescan = Join-Path $env:TEMP 'rb_dp_rescan.txt'
    @"
rescan
exit
"@ | Set-Content -LiteralPath $dpRescan -Encoding ascii
    $null = diskpart /s $dpRescan 2>&1
    Start-Sleep -Seconds 2
    Update-Disk -Number $DiskNumber -ErrorAction SilentlyContinue

    # ---- 5) tail partition: FAT32, label REVBENCH ------------------------
    Phase 'create REVBENCH tail partition'
    Prog 80
    $letter = Get-FreeDriveLetter
    if (-not $letter) { Abort 'no free drive letter available for the REVBENCH partition' }

    $tailBytes2 = [int64](Get-Disk -Number $DiskNumber).Size - $isoLen
    $freeMB = [int64][math]::Floor($tailBytes2 / 1MB) - 16
    if ($freeMB -lt 64) { Abort ('tail space shrank to ' + $freeMB + ' MB after clean - cannot create REVBENCH') }
    if ($freeMB -gt 32760) {
        $createLine = 'create partition primary size=32767'   # FAT32 quick-format ceiling
    } else {
        $createLine = 'create partition primary'              # take all free tail (no rounding risk)
    }

    $dpTail = Join-Path $env:TEMP 'rb_dp_tail.txt'
    @"
select disk $DiskNumber
$createLine
format fs=fat32 quick label=REVBENCH
assign letter=$letter
exit
"@ | Set-Content -LiteralPath $dpTail -Encoding ascii
    $out = diskpart /s $dpTail 2>&1 | Out-String
    foreach ($line in ($out -split "`r?`n" | Where-Object { $_ -match '\S' })) { Log ('  ' + $line.TrimEnd()) }
    if ($LASTEXITCODE -ne 0 -or $out -notmatch 'successfully') {
        Abort ('creating/formatting the REVBENCH partition failed (see diskpart output above)')
    }
    Start-Sleep -Seconds 2

    $vol = Get-Volume -DriveLetter $letter -ErrorAction SilentlyContinue
    if (-not $vol) { Abort ('volume ' + $letter + ': not visible after format') }
    if ($vol.FileSystemLabel -ne 'REVBENCH') {
        try {
            Set-Volume -DriveLetter $letter -NewFileSystemLabel 'REVBENCH' -ErrorAction Stop
            Log 'Label corrected to REVBENCH'
        } catch {
            Log ('WARNING: could not set label REVBENCH: ' + $_.Exception.Message)
        }
    }
    Log ('REVBENCH volume ready on ' + $letter + ': | ' + [math]::Round($vol.Size / 1GB, 1) + ' GB | ' + $vol.FileSystem)
    Prog 82

    # ---- 6) payload copy --------------------------------------------------
    Copy-Tree $BenchDir ($letter + ':\bench') 'bench' 86
    Copy-Tree $PayloadDir ($letter + ':\payload') 'payload' 95

    # verify the pinned tarball actually landed
    $onStick = Join-Path ($letter + ':\payload') $script:TarName
    if (-not (Test-Path -LiteralPath $onStick)) { Abort ('payload tarball missing after copy: ' + $onStick) }
    $stickHash = ([string]((certutil -hashfile $onStick SHA256)[1])).Trim().ToLower()
    if ($stickHash -ne $script:PayloadPin) {
        Abort ('payload tarball corrupted on the stick: ' + $stickHash)
    }
    Log 'Payload verified on the stick'

    # ---- launcher files at the partition root -----------------------------
    Phase 'launcher files'
    Prog 97
    $newline = "`n"
    $autorun = @"
ReviveBench bench stick
=======================

This stick has two parts:
  Part 1  the bootable Linux image (written raw, do not delete)
  Part 2  this drive, labelled REVBENCH - bench tool + repair payload

Start the bench
--------------
1. Boot the stick: restart -> spam F12 -> pick "UEFI: <stick name>" ->
   "Start Linux Mint".
2. On the Mint desktop open the REVBENCH drive in Files.
3. Double-click  start-bench.sh
   Fallback: right-click it -> "Run in terminal", or run:
       sh /media/mint/REVBENCH/start-bench.sh
   (the mount point may differ; check  lsblk  or  df )
4. The bench opens at  http://127.0.0.1:8777

Contents
--------
  bench/     Bench GUI (python3 stdlib only, no pip needed)
  payload/   $($script:TarName) (sha256 pinned) + legacy-ios-kit bundle

If Mint refuses to boot or the boot menu is missing: F2 BIOS -> Secure Boot
-> Disabled -> Save & Exit -> retry F12.
"@
    [System.IO.File]::WriteAllText(($letter + ':\AUTORUN.txt'), ($autorun -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding($false)))

    $startSh = @'
#!/bin/sh
# ReviveBench bench launcher (generated by write_stick.ps1)
# Starts the bench GUI from the REVBENCH partition.
# Fallback if double-click does nothing:  sh start-bench.sh
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec python3 "$DIR/bench/bench_gui.py" "$@"
'@
    [System.IO.File]::WriteAllText(($letter + ':\start-bench.sh'), ($startSh -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding($false)))
    Log ('Wrote ' + $letter + ':\AUTORUN.txt and ' + $letter + ':\start-bench.sh')
    Log 'Note: FAT32 has no unix exec bit; Mint mounts vfat with exec, and the'
    Log '      AUTORUN.txt fallback (right-click -> Run in terminal) is documented.'

    # ---- 7) rescan + final report ----------------------------------------
    Phase 'rescan + report'
    Prog 98
    $null = diskpart /s $dpRescan 2>&1
    Start-Sleep -Seconds 1
    Update-Disk -Number $DiskNumber -ErrorAction SilentlyContinue

    Log ('Partitions on Disk ' + $DiskNumber + ':')
    foreach ($line in ((Get-Partition -DiskNumber $DiskNumber -ErrorAction SilentlyContinue |
            Format-Table PartitionNumber, Type, DriveLetter, @{n = 'SizeMB'; e = { [math]::Round($_.Size / 1MB, 0) }} |
            Out-String) -split "`r?`n")) {
        if ($line.Trim()) { Log ('  ' + $line.TrimEnd()) }
    }
    Log ('Root of ' + $letter + ':\')
    foreach ($item in @(Get-ChildItem -LiteralPath ($letter + ':\') -Force -ErrorAction SilentlyContinue)) {
        Log ('  ' + $item.Name + $(if ($item.PSIsContainer) { '\' } else { '' }))
    }
    Log ('  bench\  ' + @(Get-ChildItem -LiteralPath ($letter + ':\bench') -Force -ErrorAction SilentlyContinue).Count + ' item(s)')
    Log ('  payload\' + @(Get-ChildItem -LiteralPath ($letter + ':\payload') -Force -ErrorAction SilentlyContinue).Count + ' item(s)')

    Prog 100
    M 'RESULT OK'
    Log 'WRITE OK - bootable USB ready (part 1 = ISO, part 2 = REVBENCH)'
    $script:ExitCode = 0
}

try {
    Main
} catch {
    M ('ABORT: ' + $_.Exception.Message)
    M 'RESULT FAIL'
    $script:ExitCode = 1
}

exit $script:ExitCode
