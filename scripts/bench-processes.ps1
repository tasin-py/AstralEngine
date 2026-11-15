<#
  Measures CPU, RAM and GPU use of a set of processes over a time window, so Wallpaper Engine
  and Astral Engine can be compared with exactly the same method. Read-only: it never touches
  either app's files or settings.

  Examples
    # Wallpaper Engine (wallpaper64 + its UI + its web helper processes)
    powershell -File scripts\bench-processes.ps1 -App we -Label "video, UI closed" -Seconds 20
    # Astral Engine (dev build runs as electron.exe, installed build as "Astral Engine.exe")
    powershell -File scripts\bench-processes.ps1 -App astral -Label "video" -Seconds 20
#>
param(
  [ValidateSet('we', 'astral')][string]$App = 'we',
  [string]$Label = '',
  [int]$Seconds = 20,
  [string]$OutDir = (Join-Path $PSScriptRoot '..\benchmarks')
)

$ErrorActionPreference = 'Stop'
if ($App -eq 'we') {
  $procs = Get-Process | Where-Object { $_.ProcessName -match '^(wallpaper32|wallpaper64|wallpaperui|webwallpaper32|wallpaperservice32|wallpaperservice64|applicationwallpaperinject)' }
} else {
  $root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
  $procs = Get-Process | Where-Object {
    ($_.ProcessName -eq 'Astral Engine') -or
    ($_.ProcessName -eq 'electron' -and $_.Path -and $_.Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase))
  }
}
if (-not $procs) { Write-Error "No $App processes are running."; exit 1 }

$cores = [Environment]::ProcessorCount
$ids = $procs.Id
$cpu0 = @{}; foreach ($p in $procs) { try { $cpu0[$p.Id] = $p.TotalProcessorTime.TotalMilliseconds } catch { $cpu0[$p.Id] = 0 } }

# GPU: sum "GPU Engine" utilisation of the 3D/VideoDecode engines owned by these PIDs.
$gpuSamples = @()
$t0 = Get-Date
while (((Get-Date) - $t0).TotalSeconds -lt $Seconds) {
  try {
    $c = Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction SilentlyContinue
    $sum = 0
    foreach ($s in $c.CounterSamples) {
      if ($s.InstanceName -match 'pid_(\d+)_' -and $ids -contains [int]$Matches[1]) { $sum += $s.CookedValue }
    }
    $gpuSamples += $sum
  } catch { }
  Start-Sleep -Milliseconds 900
}
$elapsed = ((Get-Date) - $t0).TotalMilliseconds

$rows = @()
$totCpu = 0; $totWs = 0; $totPriv = 0
foreach ($id in $ids) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if (-not $p) { continue }
  $cpu = (($p.TotalProcessorTime.TotalMilliseconds - $cpu0[$id]) / $elapsed / $cores) * 100
  $ws = [math]::Round($p.WorkingSet64 / 1MB); $pv = [math]::Round($p.PrivateMemorySize64 / 1MB)
  $totCpu += $cpu; $totWs += $ws; $totPriv += $pv
  $rows += [pscustomobject]@{ name = $p.ProcessName; pid = $id; cpuPct = [math]::Round($cpu, 2); workingSetMB = $ws; privateMB = $pv }
}
$gpu = if ($gpuSamples.Count) { [math]::Round(($gpuSamples | Measure-Object -Average).Average, 2) } else { $null }

$result = [pscustomobject]@{
  app = $App; label = $Label; date = (Get-Date).ToString('s'); seconds = $Seconds; cores = $cores
  totals = [pscustomobject]@{ cpuPct = [math]::Round($totCpu, 2); workingSetMB = $totWs; privateMB = $totPriv; gpuPct = $gpu; processes = $rows.Count }
  processes = $rows
}
New-Item -ItemType Directory -Force $OutDir | Out-Null
$safe = ($Label -replace '[^a-zA-Z0-9]+', '-').Trim('-')
$file = Join-Path $OutDir ("{0}-{1}-{2}.json" -f $App, $safe, (Get-Date -Format 'yyyyMMdd-HHmmss'))
$result | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $file
Write-Output ("{0} [{1}]  CPU {2}%  RAM {3} MB (private {4} MB)  GPU {5}%  -> {6}" -f $App, $Label, $result.totals.cpuPct, $totWs, $totPriv, $gpu, $file)
