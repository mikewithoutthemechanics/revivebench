<#
  ReviveBench - sync the Linux-side bench GUI into the desktop app's resources.

  PRODUCT.md repo layout:
      desktop/resources/bench/...   (copied at build time)
      bench/                        Linux-side (Agent B)

  This script performs that copy so `electron-builder` ships bench_gui.py + static/
  and `write_stick.ps1` can robocopy them to the stick as /bench.  It is run by
  `npm run pack:win` / `npm run pack:dir` before electron-builder starts.

  Rules:
    - source of truth is <repo>/bench  (never edited here)
    - __pycache__, *.pyc and other junk are never copied
    - desktop/resources/bench/README.md (this folder's own doc) is left alone
    - a missing/empty source is a warning, not a build failure, so the desktop
      half can still be built before the Linux half lands
    - -Required turns those warnings into a hard failure (use in CI/release)

  Manual use:
      powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sync_bench.ps1
#>
[CmdletBinding()]
param(
    [switch]$Required
)

$ErrorActionPreference = 'Stop'

$here     = $PSScriptRoot
$srcRoot  = [System.IO.Path]::GetFullPath((Join-Path $here '..\..\bench'))
$dstRoot  = [System.IO.Path]::GetFullPath((Join-Path $here '..\resources\bench'))
$keepName = 'README.md'

# extensions that belong on the stick / are part of the bench app
$allowed = @('.py', '.html', '.js', '.css', '.json', '.txt', '.md')

function Fail([string]$msg) {
    if ($Required) { throw $msg }
    Write-Warning $msg
    exit 0
}

if (-not (Test-Path -LiteralPath $srcRoot -PathType Container)) {
    Fail "bench source not found: $srcRoot (keeping whatever is already in $dstRoot)"
}

$files = @(
    Get-ChildItem -LiteralPath $srcRoot -Recurse -File -Force -ErrorAction SilentlyContinue |
        Where-Object {
            $allowed -contains $_.Extension -and
            $_.FullName -notmatch '[\\/](node_modules|__pycache__|\.git)[\\/]' -and
            $_.Name -notmatch '\.pyc$'
        }
)

if ($files.Count -eq 0) {
    Fail "no usable bench files under $srcRoot (keeping whatever is already in $dstRoot)"
}

# start from a clean copy of what we manage: all .py at the root and the static/ tree
Get-ChildItem -LiteralPath $dstRoot -File -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -eq '.py' -and $_.Name -ne $keepName } |
    Remove-Item -Force -ErrorAction SilentlyContinue
$dstStatic = Join-Path $dstRoot 'static'
if (Test-Path -LiteralPath $dstStatic) {
    Remove-Item -LiteralPath $dstStatic -Recurse -Force -ErrorAction SilentlyContinue
}

$copied = 0
foreach ($f in $files) {
    $rel = $f.FullName.Substring($srcRoot.Length).TrimStart('\', '/')
    $target = Join-Path $dstRoot $rel
    $dir = Split-Path -Parent $target
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    Copy-Item -LiteralPath $f.FullName -Destination $target -Force
    $copied++
}

# sanity: the writer refuses an empty /bench and start-bench.sh needs this file
$entry = Join-Path $dstRoot 'bench_gui.py'
if (-not (Test-Path -LiteralPath $entry)) {
    Fail "sync finished but bench_gui.py is missing from $dstRoot"
}

Write-Output ("sync_bench: {0} file(s) copied from {1} -> {2}" -f $copied, $srcRoot, $dstRoot)
exit 0
