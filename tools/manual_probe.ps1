# ============================================================
# manual_probe.ps1 -- AE runner for the Hub manual-tuning dialog.
#
# Starts one isolated After Effects instance and runs manual_probe.jsx:
#   dump      -> read-only parameter tree
#   fastdump  -> one isolated effect, read-only parameter tree
#   multidump -> read parameter trees for a list of effects (parameter cache)
#   baseline  -> render one baseline frame without overrides
#   verify    -> apply effect_overrides.tsv, then render one frame
#
# Writes <OutDir>/manual_result.json for the Hub to display/compare.
# Only used by manual tuning; batch rendering still uses
# generate_plugin_effects.ps1.
# ============================================================
param(
  [string]$Ae = "",
  [string]$Extension = "",
  [string]$Target = "",
  # 批量取参（multidump）：matchName 列表，与 -TargetsFile 二选一
  [string[]]$Targets = @(),
  [string]$TargetsFile = "",
  [ValidateSet("dump", "fastdump", "multidump", "baseline", "verify")]
  [string]$Mode = "dump",
  [string]$OutDir = "",
  [string]$Template = "",
  [string]$Probe = "",
  [int]$TimeoutSec = 240
)

$ErrorActionPreference = "Stop"

function Write-Utf8NoBom {
  param([string]$Path, [string]$Text)
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $utf8)
}

function Read-TextSafe {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return "" }
  try { return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) } catch { return "" }
}

function Get-StatusMap {
  param([string]$Path)
  $map = @{}
  foreach ($line in ((Read-TextSafe -Path $Path) -split "`r?`n")) {
    if (-not $line) { continue }
    $eq = $line.IndexOf("=")
    if ($eq -le 0) { continue }
    $map[$line.Substring(0, $eq)] = $line.Substring($eq + 1)
  }
  return $map
}

if (-not $OutDir) {
  $stamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
  $OutDir = Join-Path (Join-Path $env:TEMP "DreamEngineManual") ("job-" + $stamp)
}
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$resultPath = Join-Path $OutDir "manual_result.json"

function Write-Result {
  param([string]$Status, [string]$Phase, [string]$Detail = "")
  $statusPath = Join-Path $OutDir "p0_status.txt"
  $map = Get-StatusMap -Path $statusPath
  $png = Get-ChildItem -Path (Join-Path $OutDir "data\thumbs") -Filter "batch_900_*.png" -ErrorAction SilentlyContinue |
    Select-Object -First 1
  $dumpPath = Join-Path $OutDir "p0_dump.tsv"
  $result = [ordered]@{
    ok = ($Status -eq "ok")
    status = $Status
    phase = $Phase
    mode = $Mode
    target = $Target
    message = $Detail
    outDir = $OutDir
    dump = if (Test-Path -LiteralPath $dumpPath) { $dumpPath } else { "" }
    png = if ($png) { $png.FullName } else { "" }
    leaves = if ($map.ContainsKey("leaves")) { $map["leaves"] } else { "" }
    writes = if ($map.ContainsKey("writes")) { $map["writes"] } else { "" }
    fails = if ($map.ContainsKey("fails")) { $map["fails"] } else { "" }
    renderOk = if ($map.ContainsKey("renderOk")) { $map["renderOk"] } else { "0" }
    updatedAt = (Get-Date).ToString("o")
  }
  Write-Utf8NoBom -Path $resultPath -Text ($result | ConvertTo-Json -Compress)
}

$base = Join-Path $env:TEMP "DreamEngineManual"
New-Item -ItemType Directory -Force -Path $base | Out-Null
$configPath = Join-Path $base "config.tsv"

# multidump 的目标列表：优先 -TargetsFile（绝对路径），否则把 -Targets 落到临时文件。
$targetsFileAbs = ""
if ($Mode -eq "multidump") {
  if (-not $TargetsFile -and $Targets.Count -gt 0) {
    $TargetsFile = Join-Path $base ("targets-" + [Guid]::NewGuid().ToString("N") + ".tsv")
    $rows = @()
    foreach ($name in $Targets) {
      $text = ([string]$name).Trim()
      if ($text) { $rows += $text }
    }
    Write-Utf8NoBom -Path $TargetsFile -Text (($rows -join "`r`n") + "`r`n")
  }
  if ($TargetsFile) {
    if (-not [System.IO.Path]::IsPathRooted($TargetsFile)) { $TargetsFile = Join-Path $base $TargetsFile }
    $targetsFileAbs = [System.IO.Path]::GetFullPath($TargetsFile)
  }
  if (-not $targetsFileAbs -or -not (Test-Path -LiteralPath $targetsFileAbs)) {
    Write-Result -Status "no_targets" -Phase "launch" -Detail "multidump needs -TargetsFile or -Targets"
    exit 2
  }
}

if (-not $Ae -or -not (Test-Path -LiteralPath $Ae)) {
  Write-Result -Status "no_ae" -Phase "launch" -Detail "AfterFX.exe not found"
  exit 2
}
if (-not (Test-Path -LiteralPath $Probe)) {
  Write-Result -Status "no_probe" -Phase "launch" -Detail $Probe
  exit 2
}

$existing = @(Get-Process AfterFX -ErrorAction SilentlyContinue)
if ($existing.Count -gt 0) {
  Write-Result -Status "ae_running" -Phase "launch" -Detail "Close After Effects before manual tuning."
  exit 2
}

$configLines = @(
  "mode=$Mode",
  "target=$Target",
  "outDir=$($OutDir.Replace('\', '/'))",
  "moduleRoot=$($Extension.Replace('\', '/'))",
  "template=$($Template.Replace('\', '/'))",
  "base=$($base.Replace('\', '/'))"
)
if ($targetsFileAbs) {
  $configLines += ("targetsFile=" + $targetsFileAbs.Replace('\', '/'))
}
Write-Utf8NoBom -Path $configPath -Text ($configLines -join "`r`n")

$started = Get-Date
$proc = $null
$statusText = "not_started"
try {
  $proc = Start-Process -FilePath $Ae -ArgumentList @("-r", $Probe) -PassThru
} catch {
  Write-Result -Status "launch_failed" -Phase "launch" -Detail $_.Exception.Message
  exit 1
}

# AE may show its Crash Repair Options dialog before running -r. Its default
# button is Continue; activate the dedicated AE process and press Enter.
try {
  $shell = New-Object -ComObject WScript.Shell
  for ($i = 0; $i -lt 8; $i++) {
    if ($proc.HasExited) { break }
    if ($shell.AppActivate($proc.Id)) { $shell.SendKeys("{ENTER}") }
    Start-Sleep -Milliseconds 800
  }
} catch {}

while (-not $proc.HasExited) {
  Start-Sleep -Milliseconds 500
  try { $proc.Refresh() } catch {}
  $phaseNow = (Get-StatusMap -Path (Join-Path $OutDir "p0_status.txt")).ContainsKey("phase")
  $phaseText = ""
  if ($phaseNow) {
    $phaseText = (Get-StatusMap -Path (Join-Path $OutDir "p0_status.txt"))["phase"]
  }
  if ($phaseText -match "^(dump_done|render_done|target_missing|fatal)$") {
    Start-Sleep -Milliseconds 1000
    try { & taskkill /T /F /PID $proc.Id 2>$null | Out-Null } catch {}
    break
  }
  if (((Get-Date) - $started).TotalSeconds -ge $TimeoutSec) {
    $statusText = "timeout"
    try { & taskkill /T /F /PID $proc.Id 2>$null | Out-Null } catch {}
    break
  }
}

Start-Sleep -Milliseconds 500
$map = Get-StatusMap -Path (Join-Path $OutDir "p0_status.txt")
$phase = if ($map.ContainsKey("phase")) { [string]$map["phase"] } else { "" }
$renderOk = if ($map.ContainsKey("renderOk")) { [string]$map["renderOk"] } else { "0" }

if ($statusText -eq "timeout") {
  Write-Result -Status "timeout" -Phase $phase -Detail ("exceeded {0}s" -f $TimeoutSec)
} elseif ($phase -eq "dump_done") {
  Write-Result -Status "ok" -Phase $phase
} elseif ($phase -eq "render_done" -and $renderOk -eq "1") {
  Write-Result -Status "ok" -Phase $phase
} elseif ($phase -eq "target_missing") {
  Write-Result -Status "target_missing" -Phase $phase
} elseif ($phase -eq "fatal") {
  $detail = if ($map.ContainsKey("error")) { [string]$map["error"] } else { "fatal" }
  Write-Result -Status "fatal" -Phase $phase -Detail $detail
} else {
  Write-Result -Status "incomplete" -Phase $phase
}
exit 0
