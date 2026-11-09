# ============================================================
# DreamEngine —— 批量读取插件效果参数树（属性缓存的数据来源）
#
# 与 generate_plugin_effects.ps1 同构：按批启动独立的 After Effects 实例
# （经由 manual_probe.ps1 的 multidump 模式），崩溃 / 超时后重启 AE，
# 从剩余条目继续；轮数由 -Rounds 兜底。只写状态 / 原始 dump / 元数据，
# 不渲染、不改 AE 配置。
#
# 契约（与 hub/core/effect_dump.js、effect_param_cache.js 一致）：
#   输入  -Targets <probe>\next_effect_dump.tsv
#         每行 matchName[<TAB>plugin[<TAB>category]]
#   状态  <Probe>\effect_dump_state.json
#         {phase,message,round,total,current,currentName,ok,fail,outputDir,updatedAt}
#   原始  <RawDir>\<stamp>\<safe matchName>\p0_dump.tsv
#   元数据 <RawDir>\<stamp>\<safe matchName>\meta.json
#         {matchName,plugin,category,safe,aeVersion,leaves,fetchedAt}
#   失败  <Probe>\effect_dump_blacklist.tsv（只追加：matchName<TAB>reason）
#   日志  <Probe>\effect_dump.log（只追加）
#
# phase: starting | waiting-close | dumping | done | failed | cancelled
# （cancelled 由 Hub 的 stop() 写入状态文件）
# ============================================================
param(
  [string]$Ae = "",
  [string]$Probe = "",
  [string]$Extension = "",
  # matchName 列表文件（可再跟 plugin / category 两列）；也可直接传 matchName 数组
  [string[]]$Targets = @(),
  [int]$Limit = 20,
  [int]$Rounds = 50,
  [int]$TimeoutSec = 600,
  [string]$RawDir = "",
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$manualProbe = Join-Path $here "manual_probe.ps1"
$manualProbeJsx = Join-Path $here "manual_probe.jsx"

function Get-DocsPath {
  return [Environment]::GetFolderPath("MyDocuments")
}

function Write-Utf8NoBom {
  param([string]$Path, [string]$Text)
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
  [System.IO.File]::WriteAllText($Path, $Text, $utf8)
}

function Read-TextSafe {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return "" }
  try { return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) } catch { return "" }
}

function Read-Lines {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return @() }
  return @(Get-Content -LiteralPath $Path -Encoding UTF8 -ErrorAction SilentlyContinue |
    Where-Object { $_.Trim() -ne "" })
}

# 与 manual_probe.jsx 的 safeLabel 完全一致（原始 dump 目录名）。
function Get-SafeName {
  param([string]$Value)
  return ([string]$Value) -replace '[^A-Za-z0-9_.-]', '_'
}

function Get-AeVersion {
  param([string]$Exe)
  try {
    $vi = (Get-Item -LiteralPath $Exe).VersionInfo
    if ($vi.FileVersion) { return [string]$vi.FileVersion }
    if ($vi.ProductVersion) { return [string]$vi.ProductVersion }
  } catch {}
  return ""
}

function Test-AeRunning {
  try {
    $out = & tasklist /FI "IMAGENAME eq AfterFX.exe" /NH 2>$null
    return (($out -join "`n") -match "AfterFX\.exe")
  } catch {
    return $false
  }
}

# 上一轮崩溃 / 超时可能留下专用 AE 实例；先等它自己退出。仍不退出时，
# 只结束命令行里带 DreamEngineProbe 的实例，绝不动用户自己打开的 AE。
function Close-AeIfRunning {
  param([int]$WaitSeconds = 15)
  if (-not (Test-AeRunning)) { return }
  for ($i = 0; $i -lt $WaitSeconds; $i++) {
    Start-Sleep -Seconds 1
    if (-not (Test-AeRunning)) { return }
  }
  $ours = @()
  try {
    $ours = @(Get-CimInstance Win32_Process -Filter "Name = 'AfterFX.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and ([string]$_.CommandLine) -match '(?i)DreamEngineProbe' })
  } catch {
    $ours = @()
  }
  foreach ($stale in $ours) {
    Write-Log ("KILL_STALE|pid=" + $stale.ProcessId)
    & taskkill /T /F /PID $stale.ProcessId 2>$null | Out-Null
  }
  if ($ours.Count -gt 0) { Start-Sleep -Seconds 1 }
}

function Test-DumpFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  try { return ((Get-Item -LiteralPath $Path).Length -gt 64) } catch { return $false }
}

function Get-DumpLeafCount {
  param([string]$Path)
  try {
    $count = @([System.IO.File]::ReadAllLines($Path, [System.Text.Encoding]::UTF8)).Count
    if ($count -le 1) { return 0 }
    return $count - 1
  } catch {
    return 0
  }
}

# Windows PowerShell 5.1 的 Start-Process -ArgumentList 数组不会自动给带空格的
# 参数加引号，这里自己拼命令行。
function Quote-ProcessArg {
  param([string]$Value)
  if ($Value -match '[\s"]') {
    return '"' + ($Value -replace '"', '\"') + '"'
  }
  return $Value
}

function Get-AfterFXRegistryPaths {
  $keys = @(
    "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\AfterFX.exe",
    "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\AfterFX.exe",
    "HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\AfterFX.exe",
    "HKCU\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\AfterFX.exe"
  )
  $paths = @()
  foreach ($key in $keys) {
    try {
      $output = @(& reg.exe query $key /ve 2>$null)
    } catch {
      continue
    }
    foreach ($line in $output) {
      if ($line -match "REG_SZ\s+(.+?)\s*$") {
        $candidate = $Matches[1].Trim('"') -replace ',\d+$', ''
        if ($candidate -match '(?i)AfterFX\.exe$' -and (Test-Path -LiteralPath $candidate)) {
          $paths += $candidate
        }
      }
    }
  }
  return @($paths | Select-Object -Unique)
}

function Resolve-AeExe {
  param([string]$Hint)
  if ($Hint -and (Test-Path -LiteralPath $Hint)) {
    return (Get-Item -LiteralPath $Hint).FullName
  }
  $found = @()
  foreach ($candidate in (Get-AfterFXRegistryPaths)) {
    $installDir = Split-Path -Parent (Split-Path -Parent $candidate)
    $m = [regex]::Match((Split-Path -Leaf $installDir), '\d{4}')
    $found += [pscustomobject]@{
      Exe     = $candidate
      Version = if ($m.Success) { [int]$m.Value } else { 0 }
    }
  }
  $roots = @(${env:ProgramFiles}, ${env:ProgramFiles(x86)}, ${env:ProgramW6432}) |
    Where-Object { $_ } | Select-Object -Unique
  foreach ($letter in [char[]]'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    $drive = "${letter}:\"
    if (Test-Path $drive) {
      $roots += @(
        (Join-Path $drive "Program Files"),
        (Join-Path $drive "Program Files (x86)"),
        (Join-Path $drive "Adobe")
      )
    }
  }
  foreach ($root in $roots) {
    $adobeRoot = Join-Path $root "Adobe"
    if (-not (Test-Path $adobeRoot)) { $adobeRoot = $root }
    if (-not (Test-Path $adobeRoot)) { continue }
    foreach ($entry in @(Get-ChildItem $adobeRoot -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like "Adobe After Effects*" })) {
      $exe = Join-Path $entry.FullName "Support Files\AfterFX.exe"
      if (-not (Test-Path $exe)) { continue }
      $m = [regex]::Match($entry.Name, '\d{4}')
      $found += [pscustomobject]@{
        Exe     = $exe
        Version = if ($m.Success) { [int]$m.Value } else { 0 }
      }
    }
  }
  $found = @($found | Sort-Object Version -Unique)
  if ($found.Count -gt 0) { return [string]$found[$found.Count - 1].Exe }
  return ""
}

# ---------- 路径 ----------
if (-not $Probe) {
  $Probe = Join-Path (Get-DocsPath) "DreamEngineProbe"
}
New-Item -ItemType Directory -Force -Path $Probe | Out-Null
if (-not $Extension) {
  $Extension = Join-Path $env:APPDATA "Adobe\CEP\extensions\com.dreamengine.panel"
}
if (-not $RawDir) {
  $RawDir = Join-Path $Probe "effect_params_raw"
}
$RawDir = [System.IO.Path]::GetFullPath($RawDir)
New-Item -ItemType Directory -Force -Path $RawDir | Out-Null

$statePath = Join-Path $Probe "effect_dump_state.json"
$blacklistPath = Join-Path $Probe "effect_dump_blacklist.tsv"
$logPath = Join-Path $Probe "effect_dump.log"

function Write-Log {
  param([string]$Text)
  try {
    [System.IO.File]::AppendAllText(
      $logPath,
      ("[" + (Get-Date).ToString("HH:mm:ss") + "] " + $Text + "`r`n"),
      $utf8
    )
  } catch {}
}

function Write-State {
  param(
    [string]$Phase,
    [string]$Message,
    [int]$Round = 0,
    [int]$Total = 0,
    [int]$Current = 0,
    [string]$CurrentName = "",
    [int]$Ok = 0,
    [int]$Fail = 0,
    [string]$OutputDir = ""
  )
  $state = [ordered]@{
    phase       = $Phase
    message     = $Message
    round       = $Round
    total       = $Total
    current     = $Current
    currentName = $CurrentName
    ok          = $Ok
    fail        = $Fail
    outputDir   = $OutputDir
    updatedAt   = (Get-Date).ToString("o")
  } | ConvertTo-Json -Compress
  Write-Utf8NoBom -Path $statePath -Text $state
}

# 只追加；文件不存在时先写表头。
function Add-DumpBlacklist {
  param([string]$MatchName, [string]$Reason)
  if (-not $Reason) { $Reason = "dump_error" }
  $Reason = ([string]$Reason) -replace "[`t`r`n]+", " "
  if (-not (Test-Path -LiteralPath $blacklistPath)) {
    Write-Utf8NoBom -Path $blacklistPath -Text "matchName`treason`r`n"
  }
  [System.IO.File]::AppendAllText(
    $blacklistPath,
    ([string]$MatchName + "`t" + $Reason + "`r`n"),
    $utf8
  )
}

function Read-MultidumpSummary {
  param([string]$OutDir)
  $map = @{}
  $path = Join-Path $OutDir "multidump_summary.tsv"
  if (-not (Test-Path -LiteralPath $path)) { return $map }
  foreach ($line in @(Read-Lines $path)) {
    $cells = [string]$line -split "`t", 4
    if ($cells.Count -lt 2) { continue }
    $name = ([string]$cells[0]).Trim()
    if (-not $name -or $name -eq "matchName") { continue }
    $leaves = 0
    try { $leaves = [int]$cells[1] } catch { $leaves = 0 }
    $safe = if ($cells.Count -ge 3) { [string]$cells[2] } else { "" }
    $errorText = if ($cells.Count -ge 4) { [string]$cells[3] } else { "" }
    $map[$name] = @{ leaves = $leaves; safe = $safe; error = $errorText }
  }
  return $map
}

function Read-ManualResult {
  param([string]$OutDir)
  $path = Join-Path $OutDir "manual_result.json"
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try {
    $text = (Read-TextSafe $path).TrimStart([char[]](0xFEFF))
    return ($text | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Invoke-ManualProbe {
  param([string]$OutDir, [string]$BatchFile)
  $powershellExe = Join-Path $PSHOME "powershell.exe"
  if (-not (Test-Path -LiteralPath $powershellExe)) { $powershellExe = "powershell.exe" }
  $argList = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $manualProbe,
    "-Ae", $Ae,
    "-Probe", $manualProbeJsx,
    "-Mode", "multidump",
    "-TargetsFile", $BatchFile,
    "-OutDir", $OutDir,
    "-TimeoutSec", [string]$TimeoutSec
  )
  if ($Extension) {
    $argList += @("-Extension", $Extension)
  }
  $argText = ($argList | ForEach-Object { Quote-ProcessArg ([string]$_) }) -join " "
  Write-Log ("RUN|" + $argText)
  try {
    Start-Process -FilePath $powershellExe -ArgumentList $argText -Wait -WindowStyle Hidden | Out-Null
  } catch {
    Write-Log ("LAUNCH_FAIL|" + $_.Exception.Message)
    return "launch_failed"
  }
  $result = Read-ManualResult -OutDir $OutDir
  if (-not $result) { return "no_result" }
  $status = [string]$result.status
  if ($status) { return $status }
  return "incomplete"
}

# 新建 <RawDir>\<yyyyMMdd-HHmmss> 批次目录（同秒冲突时加后缀）。
function New-BatchDir {
  $stamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
  $dir = Join-Path $RawDir $stamp
  $index = 1
  while (Test-Path -LiteralPath $dir) {
    $index++
    $dir = Join-Path $RawDir ($stamp + "-" + $index)
  }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  return $dir
}

function Write-EffectMeta {
  param(
    [string]$Dir,
    [string]$MatchName,
    [string]$Plugin,
    [string]$Category,
    [string]$Safe,
    [int]$Leaves
  )
  $meta = [ordered]@{
    matchName = $MatchName
    plugin    = $Plugin
    category  = $Category
    safe      = $Safe
    aeVersion = $script:aeVersion
    leaves    = $Leaves
    fetchedAt = (Get-Date).ToString("o")
  } | ConvertTo-Json -Compress
  Write-Utf8NoBom -Path (Join-Path $Dir "meta.json") -Text $meta
}

# ---------- 参数与前置检查 ----------
if (-not (Test-Path -LiteralPath $manualProbe)) {
  Write-State -Phase "failed" -Message ("找不到 manual_probe.ps1：" + $manualProbe)
  exit 1
}
if (-not (Test-Path -LiteralPath $manualProbeJsx)) {
  Write-State -Phase "failed" -Message ("找不到 manual_probe.jsx：" + $manualProbeJsx)
  exit 1
}

$script:aeVersion = ""
if (-not $Ae) { $Ae = Resolve-AeExe -Hint "" }
if (-not $Ae -or -not (Test-Path -LiteralPath $Ae)) {
  Write-State -Phase "failed" -Message "找不到 After Effects，请先在设置中选择 AfterFX.exe"
  Write-Log "FAILED|no_ae"
  exit 1
}
$Ae = (Get-Item -LiteralPath $Ae).FullName
$script:aeVersion = Get-AeVersion -Exe $Ae
Write-Log ("START|ae=" + $Ae + "|probe=" + $Probe + "|raw=" + $RawDir)

# 目标清单：-Targets 是文件路径（Hub 的约定），也兼容直接传 matchName。
$sourceLines = @()
if ($Targets.Count -gt 0) {
  $asFile = ""
  if ($Targets.Count -eq 1) {
    $candidate = [string]$Targets[0]
    if (Test-Path -LiteralPath $candidate) { $asFile = $candidate }
  }
  if ($asFile) {
    $sourceLines = @(Read-Lines $asFile)
  } else {
    $sourceLines = @($Targets)
  }
} else {
  $defaultTargets = Join-Path $Probe "next_effect_dump.tsv"
  if (-not (Test-Path -LiteralPath $defaultTargets)) {
    Write-State -Phase "failed" -Message ("找不到待取参列表：" + $defaultTargets)
    Write-Log "FAILED|no_targets"
    exit 1
  }
  $sourceLines = @(Read-Lines $defaultTargets)
}

$targetItems = @()
$seen = @{}
foreach ($line in $sourceLines) {
  $text = ([string]$line).Trim()
  if (-not $text -or $text.StartsWith("#")) { continue }
  $cells = $text -split "`t"
  $name = ([string]$cells[0]).Trim()
  if (-not $name -or $seen.ContainsKey($name)) { continue }
  $seen[$name] = $true
  $plugin = if ($cells.Count -ge 2) { ([string]$cells[1]).Trim() } else { "" }
  $category = if ($cells.Count -ge 3) { ([string]$cells[2]).Trim() } else { "" }
  $targetItems += [pscustomobject]@{
    MatchName = $name
    Plugin    = $plugin
    Category  = $category
    Safe      = Get-SafeName $name
  }
}
if ($targetItems.Count -eq 0) {
  Write-State -Phase "done" -Message "没有待读取参数的效果"
  Write-Log "DONE|empty"
  exit 0
}

$blacklist = @{}
foreach ($line in @(Read-Lines $blacklistPath)) {
  $cells = [string]$line -split "`t", 2
  if ($cells.Count -ge 1 -and $cells[0] -and $cells[0] -ne "matchName") {
    $blacklist[([string]$cells[0]).Trim()] = $true
  }
}

# 断点续做：<RawDir> 里已有 meta.json + p0_dump.tsv 的效果算已完成。
$doneNames = @{}
foreach ($batchDir in @(Get-ChildItem -LiteralPath $RawDir -Directory -ErrorAction SilentlyContinue)) {
  foreach ($effectDir in @(Get-ChildItem -LiteralPath $batchDir.FullName -Directory -ErrorAction SilentlyContinue)) {
    $metaPath = Join-Path $effectDir.FullName "meta.json"
    $dumpPath = Join-Path $effectDir.FullName "p0_dump.tsv"
    if (-not (Test-Path -LiteralPath $metaPath) -or -not (Test-DumpFile $dumpPath)) { continue }
    try {
      $meta = (Read-TextSafe $metaPath).TrimStart([char[]](0xFEFF)) | ConvertFrom-Json
      if ($meta -and $meta.matchName) { $doneNames[[string]$meta.matchName] = $true }
    } catch {}
  }
}

$pending = @()
foreach ($target in $targetItems) {
  if ($doneNames.ContainsKey($target.MatchName)) { continue }
  if (-not $Force -and $blacklist.ContainsKey($target.MatchName)) { continue }
  $pending += $target
}
$total = $pending.Count
$okCount = 0
$failCount = 0

Write-State -Phase "starting" -Message ("准备读取 {0} 个效果的参数…" -f $total) -Total $total -Current 0
Write-Log ("PLAN|targets=" + $targetItems.Count + "|pending=" + $total + "|done=" + $doneNames.Count)

if ($pending.Count -eq 0) {
  Write-State -Phase "done" -Message "没有待读取参数的效果（已缓存或已列入黑名单）" -Total 0 -Current 0
  Write-Log "DONE|nothing_to_do"
  exit 0
}

# 用户自己的 AE 还开着时先等待，避免在别人的工程上启动 dump。
if (Test-AeRunning) {
  Write-State -Phase "waiting-close" -Message "请先保存工程并关闭 After Effects" -Total $total
  $waited = 0
  while ((Test-AeRunning) -and $waited -lt 60) {
    Start-Sleep -Seconds 1
    $waited++
  }
  if (Test-AeRunning) {
    Write-State -Phase "failed" -Message "请先保存工程并关闭 After Effects" -Total $total
    Write-Log "FAILED|ae_running"
    exit 2
  }
}

$retryableStatuses = @("timeout", "ae_running", "incomplete", "no_result", "crash", "target_missing")
$terminalStatuses = @("no_ae", "no_probe", "no_targets", "launch_failed", "fatal")

$round = 0
$launches = 0
$outputDir = ""
$fatalReason = ""

try {
  while ($pending.Count -gt 0) {
    if ($launches -ge $Rounds) {
      $fatalReason = "rounds"
      break
    }
    $round++
    $batch = @($pending | Select-Object -First $Limit)
    $batchDir = New-BatchDir
    $outputDir = $batchDir

    $items = @{}
    $retryList = @($batch)
    $attempt = 0
    $lastStatus = "ok"

    while ($retryList.Count -gt 0 -and $attempt -lt 2 -and $launches -lt $Rounds) {
      $attempt++
      $launches++
      $attemptDir = $batchDir
      if ($attempt -gt 1) {
        $attemptDir = New-BatchDir
        $outputDir = $attemptDir
      }
      $batchFile = Join-Path $attemptDir "targets.tsv"
      $batchText = (($retryList | ForEach-Object { $_.MatchName }) -join "`r`n")
      if ($batchText) { $batchText += "`r`n" }
      Write-Utf8NoBom -Path $batchFile -Text $batchText

      Write-Log ("ROUND|" + $round + "|attempt=" + $attempt + "|targets=" + $retryList.Count + "|out=" + $attemptDir)
      Write-State -Phase "dumping" `
        -Message ("第 {0} 批第 {1} 次：{2} 条" -f $round, $attempt, $retryList.Count) `
        -Round $round -Total $total -Current ($okCount + $failCount) `
        -CurrentName ([string]$retryList[0].MatchName) -Ok $okCount -Fail $failCount -OutputDir $attemptDir

      Close-AeIfRunning
      $lastStatus = Invoke-ManualProbe -OutDir $attemptDir -BatchFile $batchFile
      Write-Log ("ATTEMPT_DONE|" + $round + "|attempt=" + $attempt + "|status=" + $lastStatus)
      if ($terminalStatuses -contains $lastStatus) { break }

      $summary = Read-MultidumpSummary -OutDir $attemptDir
      $nextRetry = @()
      foreach ($target in $retryList) {
        $name = [string]$target.MatchName
        $safe = Get-SafeName $name
        $effectDir = Join-Path $attemptDir $safe
        $dumpPath = Join-Path $effectDir "p0_dump.tsv"
        $summaryItem = $null
        if ($summary.ContainsKey($name)) { $summaryItem = $summary[$name] }
        $errorText = if ($summaryItem -and $summaryItem.error) { [string]$summaryItem.error } else { "" }
        $leaves = if ($summaryItem) { [int]$summaryItem.leaves } else { 0 }

        if ((Test-DumpFile $dumpPath) -and -not $errorText) {
          if ($leaves -le 0) { $leaves = Get-DumpLeafCount $dumpPath }
          $items[$name] = @{ ok = $true; error = "" }
          Write-EffectMeta -Dir $effectDir -MatchName $name -Plugin $target.Plugin `
            -Category $target.Category -Safe $safe -Leaves $leaves
        } else {
          if (-not $errorText) {
            $errorText = if ($lastStatus -eq "ok") { "no_dump" } else { $lastStatus }
          }
          $items[$name] = @{ ok = $false; error = $errorText }
          $nextRetry += $target
        }
      }
      $retryList = @($nextRetry)
    }

    if ($terminalStatuses -contains $lastStatus) {
      $fatalReason = $lastStatus
      break
    }

    $infra = ($retryableStatuses -contains $lastStatus)
    $stillPending = @()
    $okThisRound = 0
    $failThisRound = 0
    foreach ($target in $batch) {
      $name = [string]$target.MatchName
      if ($items.ContainsKey($name) -and $items[$name].ok) {
        $okCount++
        $okThisRound++
        continue
      }
      if ($infra) {
        $stillPending += $target
        continue
      }
      $failCount++
      $failThisRound++
      $reason = if ($items.ContainsKey($name)) { [string]$items[$name].error } else { $lastStatus }
      Add-DumpBlacklist -MatchName $name -Reason $reason
      Write-Log ("BLACKLIST|" + $name + "|" + $reason)
    }

    $pending = @($stillPending + @($pending | Select-Object -Skip $batch.Count))
    Write-Log ("ROUND_DONE|" + $round + "|ok=" + $okThisRound + "|fail=" + $failThisRound +
      "|pending=" + $pending.Count + "|status=" + $lastStatus)

    if ($pending.Count -gt 0) {
      Write-State -Phase "dumping" `
        -Message ("已完成 {0}/{1}，继续下一批…" -f ($okCount + $failCount), $total) `
        -Round $round -Total $total -Current ($okCount + $failCount) `
        -CurrentName ([string]$batch[$batch.Count - 1].MatchName) `
        -Ok $okCount -Fail $failCount -OutputDir $outputDir
    }
  }
} catch {
  $fatalReason = "exception"
  Write-Log ("EXCEPTION|" + $_.Exception.Message)
}

if ($fatalReason) {
  $messages = @{
    rounds    = "已达到重启上限，可再次开始从断点继续"
    exception = "批量读取参数时出错：" + $fatalReason
  }
  $message = if ($messages.ContainsKey($fatalReason)) { $messages[$fatalReason] } else { "批量读取参数失败：" + $fatalReason }
  Write-State -Phase "failed" -Message $message -Round $round -Total $total `
    -Current ($okCount + $failCount) -Ok $okCount -Fail $failCount -OutputDir $outputDir
  Write-Log ("FAILED|" + $fatalReason)
  exit 1
}

Write-State -Phase "done" `
  -Message ("参数读取完成：成功 {0}，失败 {1}" -f $okCount, $failCount) `
  -Round $round -Total $total -Current ($okCount + $failCount) `
  -Ok $okCount -Fail $failCount -OutputDir $outputDir
Write-Log ("DONE|ok=" + $okCount + "|fail=" + $failCount + "|rounds=" + $round)
exit 0
