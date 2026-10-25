# ReviveBench - list candidate USB disks for the wizard (READ-ONLY).
# Outputs a JSON array on stdout. Never lists anything but BusType=USB,
# never touches disk contents, needs no elevation.
#
# Fields: number, model, sizeBytes, sizeGB, bus, partitionStyle, readOnly,
#         label, partitions, operational

$ErrorActionPreference = 'SilentlyContinue'
$minBytes = 6442450944   # 6 GB

try {
    $all = @(Get-Disk)
} catch {
    Write-Output ('{"error":' + (ConvertTo-Json -InputObject $_.Exception.Message) + '}')
    exit 1
}

$out = @()
foreach ($d in $all) {
    if ($d.BusType -ne 'USB') { continue }          # spec: never list non-USB disks
    if ($d.Size -lt $minBytes) { continue }         # spec: >= 6 GB

    $label = ''
    $parts = 0
    try {
        $parts = @(Get-Partition -DiskNumber $d.Number -ErrorAction SilentlyContinue).Count
        $vol = Get-Partition -DiskNumber $d.Number -ErrorAction SilentlyContinue |
               Get-Volume -ErrorAction SilentlyContinue |
               Where-Object { $_.FileSystemLabel } |
               Select-Object -First 1
        if ($vol) { $label = [string]$vol.FileSystemLabel }
    } catch { }

    $out += [pscustomobject]@{
        number         = [int]$d.Number
        model          = [string]$d.FriendlyName
        sizeBytes      = [int64]$d.Size
        sizeGB         = [math]::Round($d.Size / 1GB, 1)
        bus            = [string]$d.BusType
        partitionStyle = [string]$d.PartitionStyle
        readOnly       = [bool]$d.IsReadOnly
        label          = $label
        partitions     = [int]$parts
        operational    = [string]$d.OperationalStatus
    }
}

Write-Output (ConvertTo-Json -InputObject @($out) -Compress)
exit 0
