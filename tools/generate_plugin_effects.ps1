# ============================================================
# DreamEngine Hub 插件效果预览生成器
#
# 每次启动一个独立 After Effects 实例，逐条渲染插件效果；
# 状态写入 plugin_effect_state.json，供 Hub 轮询显示。
# 崩溃恢复、黑名单与索引写入仍由 run_plugin_preview.jsx /
# plugin_state.jsx 负责。
# ============================================================
param(
  [string]$Ae = "",
  [string]$Probe = "",
  [string]$Extension = "",
  [string]$Background = "",
  [int]$Limit = 8,
  [int]$MaxItems = 0,
  [int]$Rounds = 200,
  [int]$Timeout = 900,
  # 只扫描插件效果目录（写 plugin_effect_catalog.tsv + meta），不渲染
  [switch]$CatalogOnly,
  # 选择模式：只渲染 -Todo 指向的 next_plugin_batch.tsv（Hub 勾选的效果）
  [string]$Todo = "",
  # 强制重渲：忽略已生成索引与黑名单（配合 -Todo / 全量）
  [switch]$Force,
  # 逐条结果账本（Hub 第 5 步读取；默认 <Probe>\preview_run_results.tsv）
  [string]$ResultsFile = ""
)

$ErrorActionPreference = "Stop"
# plugin_effect_state.json 里的 mode：Hub 靠它区分扫描任务与渲染任务
$stateMode = if ($CatalogOnly) { "catalog" } else { "render" }

function Get-DocsPath {
  return [Environment]::GetFolderPath("MyDocuments")
}

function Write-Utf8NoBom {
  param([string]$Path, [string]$Text)
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $utf8)
}

function Write-State {
  param(
    [string]$Phase,
    [int]$Round,
    [string]$Message,
    [int]$Total = 0,
    [int]$Current = 0,
    [int]$Ok = 0,
    [int]$Fail = 0,
    [int]$Remaining = 0
  )
  $state = @{
    phase = $Phase
    mode = $stateMode
    round = $Round
    message = $Message
    total = $Total
    current = $Current
    ok = $Ok
    fail = $Fail
    remaining = $Remaining
    updatedAt = (Get-Date).ToString("o")
  } | ConvertTo-Json -Compress
  Write-Utf8NoBom -Path $statePath -Text $state
}

function Test-AeRunning {
  try {
    $out = & tasklist /FI "IMAGENAME eq AfterFX.exe" /NH 2>$null
    return (($out -join "`n") -match "AfterFX\.exe")
  } catch {
    return $false
  }
}

function Stop-AeProcess {
  param([System.Diagnostics.Process]$Process)
  if (-not $Process) { return }
  try {
    if (-not $Process.HasExited) {
      & taskkill /T /F /PID $Process.Id 2>$null | Out-Null
    }
  } catch {}
  Start-Sleep -Milliseconds 800
  try {
    $stillRunning = Get-Process -Id $Process.Id -ErrorAction SilentlyContinue
    if ($stillRunning) { Stop-Process -Id $Process.Id -Force }
  } catch {}
}

if (-not $Probe) {
  $Probe = Join-Path (Get-DocsPath) "DreamEngineProbe"
}
if (-not $Extension) {
  $Extension = Join-Path $env:APPDATA "Adobe\CEP\extensions\com.dreamengine.panel"
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
        $candidate = $Matches[1].Trim('"') -replace ',\d+$',''
        if ($candidate -match '(?i)AfterFX\.exe$' -and (Test-Path -LiteralPath $candidate)) {
          $paths += $candidate
        }
      }
    }
  }
  return @($paths | Select-Object -Unique)
}

if (-not $Ae) {
  $found = @()
  foreach ($candidate in (Get-AfterFXRegistryPaths)) {
    $installDir = Split-Path -Parent (Split-Path -Parent $candidate)
    $m = [regex]::Match((Split-Path -Leaf $installDir), '\d{4}')
    $found += [pscustomobject]@{
      Exe = $candidate
      Version = if ($m.Success) { [int]$m.Value } else { 0 }
    }
  }
  $roots = @(${env:ProgramFiles}, ${env:ProgramFiles(x86)}, ${env:ProgramW6432}) |
    Where-Object { $_ } | Select-Object -Unique
  foreach ($letter in [char[]]'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    $drive = "${letter}:\"
    if (Test-Path $drive) {
      $roots += @((Join-Path $drive "Program Files"), (Join-Path $drive "Program Files (x86)"), (Join-Path $drive "Adobe"))
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
        Exe = $exe
        Version = if ($m.Success) { [int]$m.Value } else { 0 }
      }
    }
  }
  $found = @($found | Sort-Object Version -Unique)
  if ($found.Count -gt 0) { $Ae = $found[$found.Count - 1].Exe }
}

New-Item -ItemType Directory -Force -Path $Probe | Out-Null
$statePath = Join-Path $Probe "plugin_effect_state.json"
$logPath = Join-Path $Probe "plugin_run.log"
$autoPath = Join-Path $Probe "plugin_auto_catalog.enabled"
$limitPath = Join-Path $Probe "plugin_limit.txt"
$backgroundPath = Join-Path $Probe "plugin_background.txt"
$maxItemsPath = Join-Path $Probe "plugin_max_items.txt"
$retryErrorsPath = Join-Path $Probe "plugin_retry_errors.enabled"
$sourcePathFile = Join-Path $Probe "plugin_preview_script_path.txt"
$renderTemplatePath = Join-Path $Probe "plugin_render_template_path.txt"
$activeBatchPath = Join-Path $Probe "plugin_active_batch.tsv"
$blacklistPath = Join-Path $Probe "plugin_blacklist.tsv"
$panelBlacklistPath = Join-Path $Extension "data\plugin_blacklist.json"
$scriptPath = Join-Path $PSScriptRoot "run_plugin_preview_loader.jsx"
if (-not (Test-Path $scriptPath)) {
  $scriptPath = Join-Path $Extension "tools\run_plugin_preview_loader.jsx"
}
$sourceScriptPath = Join-Path $PSScriptRoot "run_plugin_preview.jsx"
if (-not (Test-Path $sourceScriptPath)) {
  $sourceScriptPath = Join-Path $Extension "tools\run_plugin_preview.jsx"
}
$renderTemplate = Join-Path $PSScriptRoot "DreamEnginePNG.aep"
if (-not (Test-Path $renderTemplate)) {
  $renderTemplate = Join-Path $Extension "tools\DreamEnginePNG.aep"
}
$watchdogPath = Join-Path $PSScriptRoot "ae_watchdog.ps1"
if (-not (Test-Path $watchdogPath)) {
  $watchdogPath = Join-Path $Extension "tools\ae_watchdog.ps1"
}

# Hub 用这三个标记文件把“本次任务类型”传给 AE 内脚本；每次启动先清掉上次残留。
$selectionMarkerPath = Join-Path $Probe "plugin_selection.enabled"
$forceMarkerPath = Join-Path $Probe "plugin_force.enabled"
$catalogOnlyMarkerPath = Join-Path $Probe "plugin_catalog_only.enabled"
$catalogPath = Join-Path $Probe "plugin_effect_catalog.tsv"
$catalogMetaPath = Join-Path $Probe "plugin_effect_catalog.meta.json"

# ---------- 逐条结果账本 ----------
# 由启动本次运行的 Hub 先清空；脚本只追加，绝不截断。列：
# time  kind  key  name  status  reason（tab 分隔、无表头、UTF-8 无 BOM、CRLF）。
$resultsPath = if ($ResultsFile) {
  [System.IO.Path]::GetFullPath($ResultsFile)
} else {
  Join-Path $Probe "preview_run_results.tsv"
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
$script:resultKeys = @{}
$script:catalogNames = @{}
$script:catalogExcluded = @{}
$script:catalogNoPreview = @{}
$script:catalogLoaded = $false
function Load-EffectCatalogNames {
  if ($script:catalogLoaded) { return }
  $script:catalogLoaded = $true
  if (-not (Test-Path -LiteralPath $catalogPath)) { return }
  foreach ($catalogLine in @(Get-Content -LiteralPath $catalogPath -Encoding UTF8 -ErrorAction SilentlyContinue)) {
    if (-not $catalogLine) { continue }
    $catalogCells = [string]$catalogLine -split "`t"
    if ($catalogCells.Count -lt 7) { continue }
    $catalogName = [string]$catalogCells[0]
    if (-not $catalogName -or $catalogName -eq "matchName") { continue }
    $script:catalogNames[$catalogName] = [string]$catalogCells[1]
    if ($catalogCells[4] -eq "1") { $script:catalogExcluded[$catalogName] = $true }
    if ($catalogCells[6] -eq "1") { $script:catalogNoPreview[$catalogName] = $true }
  }
}
function Get-EffectDisplayName {
  param([string]$MatchName)
  if ($script:catalogNames.ContainsKey($MatchName)) {
    $display = [string]$script:catalogNames[$MatchName]
    if ($display) { return $display }
  }
  return $MatchName
}
function Write-PreviewResult {
  param(
    [string]$Key,
    [string]$Name,
    [string]$Status,
    [string]$Reason = ""
  )
  if (-not $Key -or -not $Status) { return }
  $id = "effect|" + $Key
  if ($script:resultKeys.ContainsKey($id)) { return }
  $script:resultKeys[$id] = $true
  $cells = @(
    (Get-Date).ToString("HH:mm:ss"),
    "effect",
    $Key,
    $Name,
    $Status,
    $Reason
  ) | ForEach-Object { ([string]$_) -replace "[`t`r`n]+", " " }
  try {
    $dir = Split-Path -Parent $resultsPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    [System.IO.File]::AppendAllText($resultsPath, ($cells -join "`t") + "`r`n", $utf8)
  } catch {}
}
function Add-ResultsFromLog {
  param([string[]]$Lines)
  foreach ($line in @($Lines)) {
    if (-not $line) { continue }
    $parts = [string]$line -split '\|', 3
    if ($parts.Count -lt 2) { continue }
    $kind = [string]$parts[0]
    $target = [string]$parts[1]
    if (-not $target) { continue }
    $name = Get-EffectDisplayName $target
    if ($kind -eq "OK") {
      Write-PreviewResult -Key $target -Name $name -Status "ok"
    } elseif ($kind -eq "FAIL") {
      $reason = "render_error"
      if ($parts.Count -ge 3 -and ([string]$parts[2]).StartsWith("{")) {
        try {
          $payload = [string]$parts[2] | ConvertFrom-Json
          $candidate = [string]$payload.reason
          if ($candidate -in @("render_error", "render_timeout", "ae_dialog", "crash")) {
            $reason = $candidate
          }
        } catch {}
      }
      Write-PreviewResult -Key $target -Name $name -Status "fail" -Reason $reason
    } elseif ($kind -eq "SKIP") {
      Write-PreviewResult -Key $target -Name $name -Status "skip" -Reason "blacklisted"
    }
  }
}
Load-EffectCatalogNames
foreach ($staleMarker in @($selectionMarkerPath, $forceMarkerPath, $catalogOnlyMarkerPath)) {
  if (Test-Path -LiteralPath $staleMarker) {
    Remove-Item -LiteralPath $staleMarker -Force -ErrorAction SilentlyContinue
  }
}

if (-not $CatalogOnly -and $Todo) {
  try {
    $Todo = [System.IO.Path]::GetFullPath($Todo)
  } catch {
    Write-State -Phase "failed" -Round 0 -Message "选择文件路径无效"
    exit 1
  }
  if (-not (Test-Path -LiteralPath $Todo)) {
    Write-State -Phase "failed" -Round 0 -Message ("找不到效果选择文件：" + $Todo)
    exit 1
  }
  # 选择模式不写 auto 标志（那会让 JSX 重建目录覆盖 Hub 的选择），先删旧标志。
  if (Test-Path -LiteralPath $autoPath) {
    Remove-Item -LiteralPath $autoPath -Force -ErrorAction SilentlyContinue
  }
  Write-Utf8NoBom -Path $selectionMarkerPath -Text $Todo
  if ($Force) {
    Write-Utf8NoBom -Path $forceMarkerPath -Text "1"
  }

  # 补写“进到脚本里才会跳过”的条目；Hub 只补启动前过滤掉的那些。
  $renderedNames = @{}
  $entriesPath = Join-Path $Extension "data\plugin_previews.tsv"
  if (Test-Path -LiteralPath $entriesPath) {
    foreach ($entryLine in @(Get-Content -LiteralPath $entriesPath -Encoding UTF8 -ErrorAction SilentlyContinue)) {
      $entryCells = [string]$entryLine -split "`t"
      if ($entryCells.Count -ge 1) {
        $entryName = ([string]$entryCells[0]).Trim()
        if ($entryName -and $entryName -ne "matchName" -and -not $entryName.StartsWith("#")) {
          $renderedNames[$entryName] = $true
        }
      }
    }
  }
  $blackNames = @{}
  foreach ($blackLine in @(Get-Content -LiteralPath $blacklistPath -Encoding UTF8 -ErrorAction SilentlyContinue)) {
    $blackCells = [string]$blackLine -split "`t"
    if ($blackCells.Count -ge 1) {
      $blackName = ([string]$blackCells[0]).Trim()
      if ($blackName -and $blackName -ne "matchName") { $blackNames[$blackName] = $true }
    }
  }
  foreach ($todoLine in @(Get-Content -LiteralPath $Todo -Encoding UTF8 -ErrorAction SilentlyContinue)) {
    $todoCells = [string]$todoLine -split "`t"
    $todoName = ([string]$todoCells[0]).Trim()
    if (-not $todoName -or $todoName -eq "matchName" -or $todoName.StartsWith("#")) { continue }
    $todoDisplay = Get-EffectDisplayName $todoName
    if ($script:catalogExcluded.ContainsKey($todoName)) {
      Write-PreviewResult -Key $todoName -Name $todoDisplay -Status "skip" -Reason "excluded"
    } elseif ($script:catalogNoPreview.ContainsKey($todoName)) {
      Write-PreviewResult -Key $todoName -Name $todoDisplay -Status "skip" -Reason "no_preview"
    } elseif (-not $Force -and $renderedNames.ContainsKey($todoName)) {
      Write-PreviewResult -Key $todoName -Name $todoDisplay -Status "skip" -Reason "already_rendered"
    } elseif (-not $Force -and $blackNames.ContainsKey($todoName)) {
      Write-PreviewResult -Key $todoName -Name $todoDisplay -Status "skip" -Reason "blacklisted"
    }
  }
}

if (-not (Test-Path $Ae)) {
  Write-State -Phase "failed" -Round 0 -Message "找不到 AfterFX.exe"
  exit 1
}
if (-not (Test-Path $scriptPath)) {
  Write-State -Phase "failed" -Round 0 -Message "扩展里缺少离线脚本：$scriptPath"
  exit 1
}
if (-not (Test-Path $sourceScriptPath)) {
  Write-State -Phase "failed" -Round 0 -Message "扩展里缺少插件渲染脚本：$sourceScriptPath"
  exit 1
}
if (-not (Test-Path $renderTemplate)) {
  Write-State -Phase "failed" -Round 0 -Message "扩展里缺少 PNG 渲染模板：$renderTemplate"
  exit 1
}
if (-not (Test-Path $watchdogPath)) {
  Write-State -Phase "failed" -Round 0 -Message "扩展里缺少 AE 报错检测模块：$watchdogPath"
  exit 1
}
. $watchdogPath

function Add-PluginBlacklist {
  param(
    [string]$MatchName,
    [string]$Reason
  )

  $map = [ordered]@{}
  if (Test-Path $blacklistPath) {
    foreach ($line in @(Get-Content -LiteralPath $blacklistPath -Encoding UTF8 -ErrorAction SilentlyContinue)) {
      $parts = [string]$line -split "`t", 2
      if ($parts.Count -ge 1 -and $parts[0] -and $parts[0] -ne "matchName") {
        $map[[string]$parts[0]] = if ($parts.Count -ge 2 -and $parts[1]) { [string]$parts[1] } else { "crash" }
      }
    }
  }
  $map[$MatchName] = $Reason
  $rows = @("matchName`treason")
  foreach ($key in $map.Keys) { $rows += ([string]$key + "`t" + [string]$map[$key]) }
  Write-Utf8NoBom -Path $blacklistPath -Text ($rows -join "`r`n")

  $items = @()
  foreach ($key in $map.Keys) {
    $items += [ordered]@{ matchName = [string]$key; reason = [string]$map[$key] }
  }
  $json = [ordered]@{ version = 1; items = @($items) } | ConvertTo-Json -Depth 4 -Compress
  Write-Utf8NoBom -Path $panelBlacklistPath -Text $json
}

function Fail-PluginEffect {
  param(
    [string[]]$Lines,
    [string]$Reason,
    [string]$Detail,
    [switch]$SkipBlacklist
  )

  $unfinished = @(Get-UnfinishedBeginPaths -Lines $Lines)
  if ($unfinished.Count -eq 0) { return $null }
  $matchName = [string]$unfinished[0]
  $payload = [ordered]@{
    status = "error"
    reason = $Reason
    detail = $Detail
  } | ConvertTo-Json -Depth 3 -Compress
  [System.IO.File]::AppendAllText(
    $logPath,
    ("FAIL|" + $matchName + "|" + $payload + "`r`n"),
    (New-Object System.Text.UTF8Encoding($false))
  )
  if (-not $SkipBlacklist) {
    Add-PluginBlacklist -MatchName $matchName -Reason "render_error"
  }
  return $matchName
}

$runnerDir = Join-Path $env:TEMP "DreamEnginePluginRunner"
New-Item -ItemType Directory -Force -Path $runnerDir | Out-Null
$runnerLoader = Join-Path $runnerDir "run_plugin_preview_loader.jsx"
$runnerSource = Join-Path $runnerDir "run_plugin_preview.jsx"
$runnerTemplate = Join-Path $runnerDir "DreamEnginePNG.aep"
Copy-Item -Force $scriptPath $runnerLoader
Copy-Item -Force $sourceScriptPath $runnerSource
Copy-Item -Force $renderTemplate $runnerTemplate
$scriptPath = $runnerLoader
$sourceScriptPath = $runnerSource
$renderTemplate = $runnerTemplate

if (Test-AeRunning) {
  Write-State -Phase "failed" -Round 0 -Message "请先保存工程并关闭 After Effects"
  exit 2
}

Write-Utf8NoBom -Path $limitPath -Text ([string]$Limit)
Write-Utf8NoBom -Path $backgroundPath -Text ([string]$Background)
Write-Utf8NoBom -Path $maxItemsPath -Text ([string]$MaxItems)
Write-Utf8NoBom -Path $sourcePathFile -Text $sourceScriptPath
Write-Utf8NoBom -Path $renderTemplatePath -Text $renderTemplate

# ---------- 只扫描插件效果目录：专用 AE 跑一次，等 RESULT 后写 meta 收尾 ----------
if ($CatalogOnly) {
  Write-State -Phase "starting" -Round 0 -Message "正在启动专用 After Effects 扫描插件目录…"
  Write-Utf8NoBom -Path $catalogOnlyMarkerPath -Text "1"

  $before = @()
  if (Test-Path $logPath) {
    $before = @(Get-Content -LiteralPath $logPath -Encoding UTF8 -ErrorAction SilentlyContinue)
  }
  $beforeCount = $before.Count

  $process = $null
  try {
    $process = Start-Process -FilePath $Ae -ArgumentList @("-r", $scriptPath) -PassThru
  } catch {
    if (Test-Path -LiteralPath $catalogOnlyMarkerPath) {
      Remove-Item -LiteralPath $catalogOnlyMarkerPath -Force -ErrorAction SilentlyContinue
    }
    Write-State -Phase "failed" -Round 0 -Message ("AE 启动失败：" + $_.Exception.Message)
    exit 1
  }

  Write-State -Phase "scanning" -Round 0 -Message "正在读取插件效果目录…"
  $startedAt = Get-Date
  $timedOut = $false
  $dialogInterrupted = $false
  while (-not $process.HasExited) {
    if (((Get-Date) - $startedAt).TotalSeconds -ge $Timeout) {
      $timedOut = $true
      Stop-AeProcess -Process $process
      break
    }
    Start-Sleep -Milliseconds 800
    $process.Refresh()
    $dialog = Get-AEDialogInfo
    if ($dialog) {
      if ($dialog.Severity -eq "warning") {
        $closed = Close-AEDialogInfo -ProcessId $dialog.ProcessId
        if ($closed) {
          Start-Sleep -Seconds 1
          continue
        }
      }
      $dialogInterrupted = $true
      Stop-AeProcess -Process $process
      break
    }
    if (Test-Path $logPath) {
      $during = @(Get-Content -LiteralPath $logPath -Encoding UTF8 -ErrorAction SilentlyContinue)
      if ($during.Count -gt $beforeCount) {
        $newLines = @($during[$beforeCount..($during.Count - 1)])
        if (@($newLines | Where-Object { $_ -like "RESULT|*" }).Count -gt 0) {
          # 给 AE 一点时间自行退出，然后回收专用实例
          Start-Sleep -Milliseconds 800
          $process.Refresh()
          if (-not $process.HasExited) { Stop-AeProcess -Process $process }
          break
        }
      }
    }
  }

  Start-Sleep -Milliseconds 500
  $fresh = @()
  if (Test-Path $logPath) {
    $after = @(Get-Content -LiteralPath $logPath -Encoding UTF8 -ErrorAction SilentlyContinue)
    if ($after.Count -gt $beforeCount) {
      $fresh = @($after[$beforeCount..($after.Count - 1)])
    }
  }
  $resultLine = @($fresh | Where-Object { $_ -like "RESULT|*" } | Select-Object -Last 1)
  if ($resultLine.Count -eq 0) {
    if (Test-Path -LiteralPath $catalogOnlyMarkerPath) {
      Remove-Item -LiteralPath $catalogOnlyMarkerPath -Force -ErrorAction SilentlyContinue
    }
    $reason = if ($timedOut) { "扫描超时" } elseif ($dialogInterrupted) { "AE 报错中断" } else { "AE 未返回结果" }
    Write-State -Phase "failed" -Round 0 -Message ("插件目录扫描失败：" + $reason)
    if ($process -and -not $process.HasExited) { Stop-AeProcess -Process $process }
    exit 1
  }

  # 目录行数（不含表头）即本次扫描到的第三方效果数
  $catalogCount = 0
  if (Test-Path -LiteralPath $catalogPath) {
    foreach ($catalogRow in @(Get-Content -LiteralPath $catalogPath -Encoding UTF8 -ErrorAction SilentlyContinue)) {
      $rowText = [string]$catalogRow
      # ExtendScript 写 UTF-8 时可能带 BOM：只影响首行，先剥掉再认表头
      if ($rowText -and ([int][char]$rowText[0]) -eq 0xFEFF) {
        $rowText = $rowText.Substring(1)
      }
      if (-not $rowText) { continue }
      if ($rowText -like "matchName`t*") { continue }
      $catalogCount++
    }
  }

  $aeVersion = ""
  $aeMajor = 0
  try {
    $versionInfo = (Get-Item -LiteralPath $Ae).VersionInfo
    $rawVersion = [string]$versionInfo.FileVersion
    if (-not $rawVersion) { $rawVersion = [string]$versionInfo.ProductVersion }
    if ($rawVersion) {
      $vm = [regex]::Match($rawVersion, '\d+(\.\d+){0,2}')
      if ($vm.Success) { $aeVersion = $vm.Value }
    }
  } catch {}
  try {
    $installDir = Split-Path -Parent (Split-Path -Parent $Ae)
    $ym = [regex]::Match((Split-Path -Leaf $installDir), '\d{4}')
    if ($ym.Success) { $aeMajor = [int]$ym.Value }
  } catch {}
  if ($aeMajor -eq 0 -and $aeVersion) {
    # 安装目录名里没有年份时按 AE 版本号反推（18→2021 …，23 起直接用版本号 +2000）
    $majorNumber = [int]([regex]::Match($aeVersion, '^\d+').Value)
    if ($majorNumber -ge 23) { $aeMajor = $majorNumber + 2000 }
    elseif ($majorNumber -ge 14) { $aeMajor = $majorNumber + 2003 }
  }

  $meta = [ordered]@{
    version = 1
    aeExe = $Ae
    aeVersion = $aeVersion
    aeMajor = $aeMajor
    scannedAt = (Get-Date).ToString("o")
    count = $catalogCount
  } | ConvertTo-Json -Compress
  Write-Utf8NoBom -Path $catalogMetaPath -Text $meta

  Write-State -Phase "done" -Round 1 -Message ("插件目录已更新（" + $catalogCount + " 条）") `
    -Total $catalogCount -Current $catalogCount -Remaining 0
  exit 0
}

$sessionOk = 0
$sessionFail = 0
$failedRounds = 0
$lastProgress = @{ total = 0; current = 0; remaining = 0 }
$fatalReason = ""
$customBackgroundFallbackTried = $false

for ($round = 1; $round -le $Rounds; $round++) {
  if ($Todo) {
    # 选择模式：绝不写 auto 标志（会触发 JSX 重建目录覆盖 Hub 的选择）
    if (Test-Path -LiteralPath $autoPath) {
      Remove-Item -LiteralPath $autoPath -Force -ErrorAction SilentlyContinue
    }
  } else {
    Write-Utf8NoBom -Path $autoPath -Text "1"
  }
  # Retry prior render_error items once at the start of this job. Re-writing
  # this flag every round would retry the same failing effect forever.
  if ($round -eq 1) { Write-Utf8NoBom -Path $retryErrorsPath -Text "1" }
  Write-State -Phase "starting" -Round $round `
    -Message "正在启动专用 After Effects（第 $round 轮）…" `
    -Total $lastProgress.total -Current $lastProgress.current `
    -Ok $sessionOk -Fail $sessionFail -Remaining $lastProgress.remaining

  $before = @()
  if (Test-Path $logPath) {
    $before = @(Get-Content -LiteralPath $logPath -Encoding UTF8 -ErrorAction SilentlyContinue)
  }
  $beforeCount = $before.Count

  $process = $null
  try {
    $process = Start-Process -FilePath $Ae -ArgumentList @("-r", $scriptPath) -PassThru
  } catch {
    Write-State -Phase "failed" -Round $round -Message ("AE 启动失败：" + $_.Exception.Message)
    exit 1
  }

  $startedAt = Get-Date
  $dialogInterrupted = $false
  $timedOut = $false
  $dialogFailureName = $null
  $timeoutFailureName = $null
  while (-not $process.HasExited) {
    if (((Get-Date) - $startedAt).TotalSeconds -ge $Timeout) {
      $timedOut = $true
      $during = @()
      if (Test-Path $logPath) {
        $during = @(Get-Content -LiteralPath $logPath -Encoding UTF8 -ErrorAction SilentlyContinue)
      }
      $newLines = if ($during.Count -gt $beforeCount) {
        @($during[$beforeCount..($during.Count - 1)])
      } else {
        @()
      }
      if (-not (Test-Path $activeBatchPath)) {
        $timeoutFailureName = Fail-PluginEffect -Lines $newLines -Reason "render_timeout" `
          -Detail ("no result after " + $Timeout + " seconds")
      }
      Stop-AeProcess -Process $process
      break
    }
    Start-Sleep -Milliseconds 800
    $process.Refresh()
    $dialog = Get-AEDialogInfo
    if ($dialog) {
      if ($dialog.Severity -eq "warning") {
        $closed = Close-AEDialogInfo -ProcessId $dialog.ProcessId
        if ($closed) {
          [System.IO.File]::AppendAllText(
            $logPath,
            ("WARN||dismissed|title=" + $dialog.Title +
              "; text=" + ($dialog.Text -replace "`r|`n", " ") + "`r`n"),
            (New-Object System.Text.UTF8Encoding($false))
          )
          Write-State -Phase "rendering" -Round $round `
            -Message "已自动关闭 AE 渲染警告并继续"
          Start-Sleep -Seconds 1
          continue
        }
      }
      $during = @()
      if (Test-Path $logPath) {
        $during = @(Get-Content -LiteralPath $logPath -Encoding UTF8 -ErrorAction SilentlyContinue)
      }
      $newLines = if ($during.Count -gt $beforeCount) {
        @($during[$beforeCount..($during.Count - 1)])
      } else {
        @()
      }
      $currentBackground = if (Test-Path $backgroundPath) {
        [string](Get-Content -LiteralPath $backgroundPath -Raw -Encoding UTF8 -ErrorAction SilentlyContinue)
      } else {
        ""
      }
      $useBackgroundFallback = (
        $currentBackground -match '[\\/]' -and
        -not $customBackgroundFallbackTried
      )
      $hasIsolatedBegin = @(Get-UnfinishedBeginPaths -Lines $newLines).Count -gt 0
      if (-not (Test-Path $activeBatchPath) -and $hasIsolatedBegin) {
        $dialogFailureName = Fail-PluginEffect -Lines $newLines -Reason "ae_dialog" `
          -Detail ("title=" + $dialog.Title + "; text=" + $dialog.Text) `
          -SkipBlacklist:$useBackgroundFallback
      }
      if ($useBackgroundFallback) {
        $customBackgroundFallbackTried = $true
        Write-Utf8NoBom -Path $backgroundPath -Text "photo"
        Write-State -Phase "rendering" -Round $round `
          -Message "自定义背景触发 AE 导出错误，已改用标准背景继续"
      } elseif ($dialogFailureName) {
        Write-State -Phase "rendering" -Round $round `
          -Message ("AE 报错，已跳过当前效果并继续：" + $dialogFailureName)
      } else {
        Write-State -Phase "rendering" -Round $round `
          -Message "混合批次触发 AE 报错，下一轮将逐条隔离并继续"
      }
      $dialogInterrupted = $true
      Stop-AeProcess -Process $process
      break
    }
    if (Test-Path $logPath) {
      $during = @(Get-Content -LiteralPath $logPath -Encoding UTF8 -ErrorAction SilentlyContinue)
      if ($during.Count -gt $beforeCount) {
        $newLines = @($during[$beforeCount..($during.Count - 1)])
        $lastRun = @($newLines | Where-Object { $_ -like "RUN|*" } | Select-Object -Last 1)
        if ($lastRun.Count -gt 0 -and
            $lastRun[0] -match "todo=(\d+)\s+pending=(\d+)\s+done=(\d+)\s+blacklisted=(\d+)") {
          $liveTotal = [int]$Matches[1]
          $livePending = [int]$Matches[2]
          $liveDone = [int]$Matches[3]
          $liveBlocked = [int]$Matches[4]
          $liveOk = @($newLines | Where-Object { $_ -like "OK|*" }).Count
          $liveFail = @($newLines | Where-Object { $_ -like "FAIL|*" }).Count
          Write-State -Phase "rendering" -Round $round `
            -Message ("已完成 {0} / {1}，剩余 {2}" -f [Math]::Min($liveTotal, $liveDone + $liveBlocked), $liveTotal, $livePending) `
            -Total $liveTotal -Current ([Math]::Min($liveTotal, $liveDone + $liveBlocked)) `
            -Ok ($sessionOk + $liveOk) -Fail ($sessionFail + $liveFail) -Remaining $livePending
        }
        if (@($newLines | Where-Object { $_ -like "RESULT|*" }).Count -gt 0) {
          # Give AE a short grace period to close itself, then terminate this
          # dedicated instance. A finished render must never hold the Hub.
          Start-Sleep -Milliseconds 800
          $process.Refresh()
          if (-not $process.HasExited) { Stop-AeProcess -Process $process }
          break
        }
      }
    }
  }

  Start-Sleep -Milliseconds 500
  $after = @()
  if (Test-Path $logPath) {
    $after = @(Get-Content -LiteralPath $logPath -Encoding UTF8 -ErrorAction SilentlyContinue)
  }
  $fresh = @()
  if ($after.Count -gt $beforeCount) {
    $fresh = @($after[$beforeCount..($after.Count - 1)])
  }
  Add-ResultsFromLog -Lines @($fresh)

  $resultLine = @($fresh | Where-Object { $_ -like "RESULT|*" } | Select-Object -Last 1)
  $fatalLine = @($fresh | Where-Object { $_ -match "fatal=([^\s]+)" } | Select-Object -Last 1)
  $runLine = @($fresh | Where-Object { $_ -like "RUN|*" } | Select-Object -Last 1)
  $okThisRound = @($fresh | Where-Object { $_ -like "OK|*" }).Count
  $failThisRound = @($fresh | Where-Object { $_ -like "FAIL|*" }).Count
  $sessionOk += $okThisRound
  $sessionFail += $failThisRound

  if ($runLine.Count -gt 0) {
    if ($runLine[0] -match "todo=(\d+)\s+pending=(\d+)\s+done=(\d+)\s+blacklisted=(\d+)") {
      $total = [int]$Matches[1]
      $pending = [int]$Matches[2]
      $done = [int]$Matches[3]
      $blocked = [int]$Matches[4]
      $lastProgress = @{
        total = $total
        current = [Math]::Min($total, $done + $blocked)
        remaining = $pending
      }
    }
  }

  if ($resultLine.Count -eq 0) {
    $recoverableInterrupt = (
      ($dialogInterrupted -and ($dialogFailureName -or (Test-Path $activeBatchPath))) -or
      ($timedOut -and ($timeoutFailureName -or (Test-Path $activeBatchPath)))
    )
    if ($recoverableInterrupt) {
      $interruptLabel = if ($dialogInterrupted) { "AE 报错" } else { "当前效果超时" }
      Write-State -Phase "rendering" -Round $round `
        -Message "$interruptLabel；已跳过当前类别并继续下一轮" `
        -Total $lastProgress.total -Current $lastProgress.current `
        -Ok $sessionOk -Fail $sessionFail -Remaining $lastProgress.remaining
      continue
    }
    $failedRounds++
    $processLabel = if ($process.HasExited) { "AE 进程已退出" } else { "AE 未返回结果" }
    Write-State -Phase "rendering" -Round $round `
      -Message "$processLabel；下一轮会跳过崩溃条目并继续" `
      -Total $lastProgress.total -Current $lastProgress.current `
      -Ok $sessionOk -Fail $sessionFail -Remaining $lastProgress.remaining
    if ($failedRounds -ge 2) {
      Write-State -Phase "failed" -Round $round -Message "连续两轮没有返回结果，已停止"
      exit 1
    }
    continue
  }
  $failedRounds = 0

  if ($fatalLine.Count -gt 0) {
    [void]($fatalLine[0] -match "fatal=([^\s]+)")
    $fatalReason = $Matches[1]
    break
  }

  if ($resultLine[0] -match "pending=(\d+)") {
    $resultPending = [int]$Matches[1]
    if ($resultPending -eq 0) {
      $fallbackNote = if ($customBackgroundFallbackTried) {
        "；自定义背景已自动替换为标准背景"
      } else {
        ""
      }
      Write-State -Phase "done" -Round $round `
        -Message ("插件效果预览已全部生成" + $fallbackNote) `
        -Total $lastProgress.total -Current $lastProgress.total `
        -Ok $sessionOk -Fail $sessionFail -Remaining 0
      exit 0
    }
  }

  if ($resultLine[0] -match "nothing_to_do|no_todo_file") {
    $fallbackNote = if ($customBackgroundFallbackTried) {
      "；自定义背景已自动替换为标准背景"
    } else {
      ""
    }
    Write-State -Phase "done" -Round $round `
      -Message ("插件效果预览已全部生成" + $fallbackNote) `
      -Total $lastProgress.total -Current $lastProgress.total `
      -Ok $sessionOk -Fail $sessionFail -Remaining 0
    exit 0
  }

  Write-State -Phase "rendering" -Round $round `
    -Message ("本轮成功 {0}，失败 {1}，剩余 {2}" -f $okThisRound, $failThisRound, $lastProgress.remaining) `
    -Total $lastProgress.total -Current $lastProgress.current `
    -Ok $sessionOk -Fail $sessionFail -Remaining $lastProgress.remaining
}

if ($fatalReason) {
  Write-State -Phase "failed" -Round $round `
    -Message ("插件效果输出配置失败：" + $fatalReason + "。已停止运行并保留待渲染条目") `
    -Total $lastProgress.total -Current $lastProgress.current `
    -Ok $sessionOk -Fail $sessionFail -Remaining $lastProgress.remaining
} else {
  Write-State -Phase "paused" -Round $Rounds `
    -Message "已达到轮数上限，可再次开始继续生成" `
    -Total $lastProgress.total -Current $lastProgress.current `
    -Ok $sessionOk -Fail $sessionFail -Remaining $lastProgress.remaining
}
exit 0
