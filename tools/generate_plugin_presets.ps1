# ============================================================
# DreamEngine —— 一键生成「含第三方插件的预设」预览
#
# 纯 Windows 内置 PowerShell，不需要 Node / Python / 任何额外安装。
#
# 流程（默认）：
#   1. 检测 AE 是否在运行 —— 在运行就提示用户「保存并关闭 AE」，然后只等待，不代为关闭
#   2. 用户关闭后自动继续：每个专用 AE 实例最多连续渲染 40 条；
#      成功就继续，崩溃 / 超时 / 达到上限才换下一个实例
#   3. 完成后按原状重新打开 AE
#
# 状态：全程把进度写进 <我的文档>\DreamEngineProbe\hub_state.json，
#       供 DreamEngine Hub（独立程序）实时显示，不需要解析控制台输出。
#
# 用法：双击同目录的 bat，或执行：
#   -File .\generate_plugin_presets.ps1
# ============================================================
param(
  [string]$Background = "",
  [int]$Limit = 40,
  [int]$Rounds = 40,
  [int]$Timeout = 240,
  [string]$AE = "",
  [switch]$Force,
  [switch]$NoRestart,
  # 代用户温和关闭 AE（旧行为）。默认不关，只提示并等待用户自己关。
  [switch]$AutoClose,
  # 只重渲一条预设（Hub 右键「单独渲染」）
  [string]$OnlyPreset = "",
  # 选择模式：只渲这个文件里列出的 .ffx（每行一个绝对路径，Hub「渲染所选」）
  [string]$PresetList = "",
  # 新一轮手动渲染时重试上次因 render_error / no_effect 被拉黑的预设
  [switch]$RetryFailed,
  # 等待用户关闭 AE 的最长秒数，超时即放弃
  [int]$WaitAE = 900,
  # 逐条结果账本（Hub 第 5 步读取；默认 <Probe>\preview_run_results.tsv）
  [string]$ResultsFile = ""
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ext  = Join-Path $env:APPDATA "Adobe\CEP\extensions\com.dreamengine.panel"
$data = Join-Path $ext "data"
# 与面板的 Folder.myDocuments / Hub 的 app.getPath("documents") 保持一致：
# OneDrive 把「文档」重定向后，$env:USERPROFILE\Documents 可能不是同一个目录。
$docs = [Environment]::GetFolderPath("MyDocuments")
$probe = Join-Path $docs "DreamEngineProbe"
$presets = Join-Path $docs "DreamEngine\presets"

$todoPath        = Join-Path $probe "next_preset_plugin_batch.tsv"
$bgPath          = Join-Path $probe "preset_plugin_background.txt"
$logPath         = Join-Path $probe "preset_plugin_run.log"
$entriesPath     = Join-Path $probe "preset_plugin_previews.tsv"
$blacklistPath   = Join-Path $probe "preset_plugin_blacklist.tsv"
$pluginIndexPath = Join-Path $data "preset_plugin_manifest.json"
$panelIndexPath  = Join-Path $data "preset_manifest.json"
$forcePath       = Join-Path $probe "preset_plugin_force.txt"
$pendingPath     = Join-Path $probe "preset_plugin_pending_count.txt"
$sourcePathFile  = Join-Path $probe "preset_plugin_preview_script_path.txt"
$renderTemplatePath = Join-Path $probe "preset_render_template_path.txt"

# 允许的 .ffx 路径：DreamEngine 预设库 + 当前 AE 的安装 Presets / User Presets
# （Hub 的外部预设索引只索引不复制，渲染时必须放行这些来源）
function Get-PresetAllowedRoots {
  $roots = @()
  try { $roots += [IO.Path]::GetFullPath($presets) } catch {}
  if ($AE) {
    try {
      $support = Split-Path -Parent $AE
      $roots += (Join-Path $support "Presets")
      $install = Split-Path -Parent $support
      $m = [regex]::Match((Split-Path -Leaf $install), '\d{4}')
      if ($m.Success) {
        $roots += (Join-Path $docs ("Adobe\After Effects " + $m.Value + "\User Presets"))
      }
    } catch {}
  }
  return @($roots |
    Where-Object { $_ } |
    ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\','/').Replace('\','/') } |
    Select-Object -Unique)
}

function Test-PresetPathAllowed {
  param([string]$Path)
  try {
    $full = [IO.Path]::GetFullPath($Path).Replace('\','/')
  } catch {
    return $false
  }
  foreach ($root in (Get-PresetAllowedRoots)) {
    $prefix = $root.TrimEnd('/') + '/'
    if ($full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

$loader = Join-Path $here "run_plugin_preset_loader.jsx"
if (-not (Test-Path $loader)) { $loader = Join-Path $ext "tools\run_plugin_preset_loader.jsx" }
$sourceScript = Join-Path $here "run_plugin_preset_preview.jsx"
if (-not (Test-Path $sourceScript)) { $sourceScript = Join-Path $ext "tools\run_plugin_preset_preview.jsx" }
$renderTemplate = Join-Path $here "DreamEnginePNG.aep"
if (-not (Test-Path $renderTemplate)) { $renderTemplate = Join-Path $ext "tools\DreamEnginePNG.aep" }

$utf8 = New-Object System.Text.UTF8Encoding($false)
function Write-Utf8($path, $text) {
  [System.IO.File]::WriteAllText($path, $text, $utf8)
}
function Read-Lines($path) {
  if (-not (Test-Path $path)) { return @() }
  return @(Get-Content $path -Encoding UTF8 | Where-Object { $_.Trim() -ne "" })
}

# ---------- 逐条结果账本 ----------
# 由启动本次运行的 Hub 先清空；脚本只追加，绝不截断。列：
# time  kind  key  name  status  reason（tab 分隔、无表头、UTF-8 无 BOM、CRLF）。
$resultsPath = if ($ResultsFile) {
  [System.IO.Path]::GetFullPath($ResultsFile)
} else {
  Join-Path $probe "preview_run_results.tsv"
}
$script:resultKeys = @{}
function Get-PresetDisplayName {
  param([string]$PresetPath)
  if (-not $PresetPath) { return "" }
  return [System.IO.Path]::GetFileNameWithoutExtension($PresetPath)
}
function Write-PreviewResult {
  param(
    [string]$Key,
    [string]$Name,
    [string]$Status,
    [string]$Reason = ""
  )
  if (-not $Key -or -not $Status) { return }
  $id = "preset|" + $Key
  if ($script:resultKeys.ContainsKey($id)) { return }
  $script:resultKeys[$id] = $true
  $cells = @(
    (Get-Date).ToString("HH:mm:ss"),
    "preset",
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
    $name = Get-PresetDisplayName $target
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

$watchdogPath = Join-Path $PSScriptRoot "ae_watchdog.ps1"
if (-not (Test-Path $watchdogPath)) { $watchdogPath = Join-Path $ext "tools\ae_watchdog.ps1" }
if (-not (Test-Path $watchdogPath)) { Fail "缺少 AE 报错检测模块：$watchdogPath" }
. $watchdogPath

function Add-PresetBlacklist {
  param(
    [string]$Path,
    [string]$Reason
  )

  $map = [ordered]@{}
  foreach ($line in @(Read-Lines $blacklistPath)) {
    $parts = [string]$line -split "`t", 2
    if ($parts.Count -ge 1 -and $parts[0] -and $parts[0] -ne "matchName") {
      $map[[string]$parts[0]] = if ($parts.Count -ge 2 -and $parts[1]) { [string]$parts[1] } else { "crash" }
    }
  }
  $map[$Path] = $Reason
  $rows = @("matchName`treason")
  foreach ($key in $map.Keys) { $rows += ([string]$key + "`t" + [string]$map[$key]) }
  Write-Utf8 $blacklistPath ($rows -join "`r`n")

  $items = @()
  foreach ($key in $map.Keys) {
    $items += [ordered]@{ matchName = [string]$key; reason = [string]$map[$key] }
  }
  $json = [ordered]@{ version = 1; items = @($items) } | ConvertTo-Json -Depth 4 -Compress
  $panelBlacklist = Join-Path $data "preset_plugin_blacklist.json"
  Write-Utf8 $panelBlacklist $json
}

function Fail-PendingPreset {
  param(
    [string[]]$Lines,
    [string]$Reason,
    [string]$Detail,
    [string]$BlacklistReason = "render_error",
    [switch]$SkipBlacklist
  )

  $unfinished = @(Get-UnfinishedBeginPaths -Lines $Lines)
  if ($unfinished.Count -eq 0) { return $null }
  $path = [string]$unfinished[0]
  $payload = [ordered]@{
    status = "error"
    reason = $Reason
    detail = $Detail
  } | ConvertTo-Json -Depth 3 -Compress
  [System.IO.File]::AppendAllText(
    $logPath,
    ("FAIL|" + $path + "|" + $payload + "`r`n"),
    $utf8
  )
  if (-not $SkipBlacklist) {
    Add-PresetBlacklist -Path $path -Reason $BlacklistReason
  }
  return $path
}

function Get-AERunning {
  return (@(Get-Process -Name AfterFX -ErrorAction SilentlyContinue).Count -gt 0)
}
function Stop-AEProcess {
  param([int]$GraceSeconds = 12)
  if (-not (Get-AERunning)) { return }
  if ($GraceSeconds -gt 0) {
    for ($i = 0; $i -lt $GraceSeconds; $i++) {
      Start-Sleep -Seconds 1
      if (-not (Get-AERunning)) { return }
    }
  }
  # 能走到这里说明 AE 是本脚本启动的专用实例，用户 AE 在开始时已确认关闭。
  Get-Process -Name AfterFX -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 1
}

# ---------- 状态文件：Hub 程序靠它显示进度，不依赖控制台输出 ----------
if (-not (Test-Path $probe)) { New-Item -ItemType Directory -Force -Path $probe | Out-Null }
$statePath = Join-Path $probe "hub_state.json"
$script:state = [ordered]@{
  phase    = "starting"   # starting|waiting-close|rendering|done|failed|cancelled
  message  = ""
  current  = 0
  total    = 0
  ok       = 0
  fail     = 0
  round    = 0
  remaining = 0
  updated  = (Get-Date).ToString("s")
  pid      = $PID
}
function Write-State {
  param([string]$Phase, [string]$Message, [int]$Current = -1, [int]$Total = -1, [int]$Ok = -1, [int]$Fail = -1, [int]$Round = -1, [int]$Remaining = -1)
  if ($Phase)   { $script:state.phase = $Phase }
  if ($Message) { $script:state.message = $Message }
  if ($Current -ge 0) { $script:state.current = $Current }
  if ($Total   -ge 0) { $script:state.total = $Total }
  if ($Ok      -ge 0) { $script:state.ok = $Ok }
  if ($Fail    -ge 0) { $script:state.fail = $Fail }
  if ($Round   -ge 0) { $script:state.round = $Round }
  if ($Remaining -ge 0) { $script:state.remaining = $Remaining }
  $script:state.updated = (Get-Date).ToString("s")
  try { Write-Utf8 $statePath ($script:state | ConvertTo-Json -Compress) } catch {}
}

# ---------- 选择模式：只渲染 Hub 勾选的预设 ----------
$selectedPresets = @()
if ($PresetList) {
  if (-not (Test-Path -LiteralPath $PresetList)) {
    Write-Host "[错误] 找不到预设选择文件：$PresetList" -ForegroundColor Red
    Write-State -Phase "failed" -Message ("找不到预设选择文件：" + $PresetList)
    exit 1
  }
  $presetSelectionSkipped = @()
  foreach ($selectionLine in @(Read-Lines $PresetList)) {
    $selectedRaw = ([string]$selectionLine).Trim()
    if (-not $selectedRaw) { continue }
    $selectedInvalid = $false
    $selectedFull = ""
    try {
      $selectedFull = [IO.Path]::GetFullPath($selectedRaw).Replace('\','/')
    } catch {
      $selectedInvalid = $true
    }
    if (-not $selectedInvalid -and -not (Test-PresetPathAllowed $selectedFull)) { $selectedInvalid = $true }
    if (-not $selectedInvalid -and $selectedFull -notmatch '(?i)\.ffx$') { $selectedInvalid = $true }
    if (-not $selectedInvalid -and -not (Test-Path -LiteralPath $selectedFull)) { $selectedInvalid = $true }
    if ($selectedInvalid) {
      $presetSelectionSkipped += $selectedRaw
      continue
    }
    $selectedPresets += $selectedFull
  }
  # 这些是进到脚本里才判定不可渲染的条目（Hub 只写启动前过滤掉的那些）。
  foreach ($skippedRaw in $presetSelectionSkipped) {
    $skippedKey = [string]$skippedRaw
    try { $skippedKey = [IO.Path]::GetFullPath($skippedRaw).Replace('\','/') } catch {}
    Write-PreviewResult -Key $skippedKey -Name (Get-PresetDisplayName $skippedKey) `
      -Status "skip" -Reason "excluded"
  }
  $selectedPresets = @($selectedPresets | Select-Object -Unique)
  if ($selectedPresets.Count -eq 0) {
    # 没有可渲的所选条目：按“没有待生成”收尾
    if (Test-Path $forcePath) { Remove-Item $forcePath -Force -ErrorAction SilentlyContinue }
    Write-Host "所选预设均不可用，没有待渲染的条目。" -ForegroundColor Yellow
    Write-State -Phase "done" -Message "渲染完成：成功 0，失败 0" -Ok 0 -Fail 0 -Remaining 0
    exit 0
  }
}

# ---------- 定位 AfterFX.exe ----------
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

if (-not $AE) {
  $found = @()
  foreach ($candidate in (Get-AfterFXRegistryPaths)) {
    $supportDir = Split-Path -Parent $candidate
    $installDir = Split-Path -Parent $supportDir
    $name = Split-Path -Leaf $installDir
    $m = [regex]::Match($name, '\d{4}')
    $found += [pscustomobject]@{
      Exe = $candidate
      Version = if ($m.Success) { [int]$m.Value } else { 0 }
    }
  }

  # App Paths 覆盖非默认安装盘；再扫各固定盘的常见 Adobe 目录兜底。
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
    if (-not (Test-Path $adobeRoot)) {
      $adobeRoot = $root
    }
    if (-not (Test-Path $adobeRoot)) { continue }
    foreach ($d in @(Get-ChildItem $adobeRoot -Directory -ErrorAction SilentlyContinue |
                     Where-Object { $_.Name -like "Adobe After Effects*" })) {
      $cand = Join-Path $d.FullName "Support Files\AfterFX.exe"
      if (-not (Test-Path $cand)) { continue }
      $m = [regex]::Match($d.Name, '\d{4}')
      $found += [pscustomobject]@{
        Exe = $cand
        Version = if ($m.Success) { [int]$m.Value } else { 0 }
      }
    }
  }
  $found = @($found | Sort-Object Version -Unique)
  if ($found.Count -gt 0) { $AE = $found[$found.Count - 1].Exe }
}
if (-not $AE -or -not (Test-Path $AE)) {
  Write-Host "[错误] 找不到 AfterFX.exe，请用 -AE 参数指定完整路径。" -ForegroundColor Red
  Write-State -Phase "failed" -Message "找不到 AfterFX.exe"
  exit 1
}
if (-not (Test-Path $loader)) {
  Write-Host "[错误] 找不到预设加载器：$loader" -ForegroundColor Red
  Write-State -Phase "failed" -Message "找不到预设加载器"
  exit 1
}
if (-not (Test-Path $sourceScript)) {
  Write-Host "[错误] 找不到离线渲染脚本：$sourceScript" -ForegroundColor Red
  Write-State -Phase "failed" -Message "找不到离线渲染脚本"
  exit 1
}
if (-not (Test-Path $renderTemplate)) {
  Write-Host "[错误] 找不到 PNG 渲染模板：$renderTemplate" -ForegroundColor Red
  Write-State -Phase "failed" -Message "找不到 PNG 渲染模板"
  exit 1
}
if (-not (Test-Path $ext)) {
  Write-Host "[错误] 没找到已安装的 DreamEngine 扩展：$ext" -ForegroundColor Red
  Write-Host "请先运行安装包里的安装脚本。"
  Write-State -Phase "failed" -Message "未安装 DreamEngine 扩展"
  exit 1
}
if (-not (Test-Path $presets)) {
  Write-Host "[提示] 预设库还是空的：$presets" -ForegroundColor Yellow
  Write-Host "请先在面板的「预设预览」里添加 .ffx 文件。"
  Write-State -Phase "failed" -Message "预设库为空，请先导入 .ffx"
  exit 0
}
if ($OnlyPreset) {
  try {
    $OnlyPreset = [IO.Path]::GetFullPath($OnlyPreset).Replace('\','/')
  } catch {
    Write-State -Phase "failed" -Message "单独渲染路径无效"
    exit 1
  }
  if (-not (Test-PresetPathAllowed $OnlyPreset) -or
      -not (Test-Path -LiteralPath $OnlyPreset) -or
      $OnlyPreset -notmatch '(?i)\.ffx$') {
    Write-State -Phase "failed" -Message "单独渲染只接受预设库或已同步 AE 预设中的 .ffx"
    exit 1
  }
}

if ($RetryFailed -and (Test-Path $blacklistPath)) {
  $rows = @(Read-Lines $blacklistPath)
  $kept = @($rows | Where-Object {
    $cells = $_ -split "`t"
    $cells.Count -lt 2 -or ($cells[1] -ne "render_error" -and $cells[1] -ne "no_effect")
  })
  if ($kept.Count -ne $rows.Count) {
    $text = if ($kept.Count -gt 0) { ($kept -join "`r`n") } else { "" }
    Write-Utf8 $blacklistPath $text
  }
}

$runnerDir = Join-Path $env:TEMP "DreamEnginePluginRunner"
New-Item -ItemType Directory -Force -Path $runnerDir | Out-Null
$runnerLoader = Join-Path $runnerDir "run_plugin_preset_loader.jsx"
$runnerSource = Join-Path $runnerDir "run_plugin_preset_preview.jsx"
$runnerTemplate = Join-Path $runnerDir "DreamEnginePNG.aep"
Copy-Item -Force $loader $runnerLoader
Copy-Item -Force $sourceScript $runnerSource
Copy-Item -Force $renderTemplate $runnerTemplate
$jsx = $runnerLoader
$renderTemplate = $runnerTemplate
Write-Utf8 $sourcePathFile $runnerSource
Write-Utf8 $renderTemplatePath $renderTemplate

# ---------- 背景：未指定就跟随面板最后一次用的 ----------
if (-not $Background) {
  if (Test-Path $panelIndexPath) {
    try {
      $j = Get-Content $panelIndexPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $last = @($j.items) | Select-Object -Last 1
      if ($last.background) { $Background = $last.background }
    } catch {}
  }
  if (-not $Background) { $Background = "photo" }
}

# ---------- 从 TSV 生成面板读的独立索引（无 BOM，浏览器才能 JSON.parse）----------
function Build-PluginIndex {
  $byPath = @{}
  $order = @()
  foreach ($line in (Read-Lines $entriesPath)) {
    if ($line.StartsWith("#")) { continue }
    $r = $line -split "`t"
    if ($r.Count -lt 9) { continue }
    [int]$sheet = 0
    if (-not [int]::TryParse($r[2], [ref]$sheet)) { continue }
    $base = "preset_{0:D3}" -f $sheet
    $plugins = @($r[8].Split(",") | Where-Object { $_ } | Select-Object -Unique)
    $duration = 0.0
    if ($r.Count -ge 10) { [void][double]::TryParse($r[9], [ref]$duration) }
    $fps = 0
    if ($r.Count -ge 11) { [void][int]::TryParse($r[10], [ref]$fps) }
    if (-not $byPath.ContainsKey($r[1])) { $order += $r[1] }
    $byPath[$r[1]] = [ordered]@{
      name = $r[0]
      path = $r[1]
      sheet = $sheet
      src = "thumbs/" + $base + "_0000.png"
      frameSrc = "thumbs/" + $base + "_%04d.png"
      frames = [int]$r[3]
      animated = ($r[4] -eq "true")
      keyStart = [double]$r[5]
      keyEnd = [double]$r[6]
      duration = $duration
      fps = $fps
      background = $r[7]
      plugins = $plugins
      plugin = $true
      sliceColumns = 1
      sliceCellSize = 128
      sliceWidth = 128
      sliceHeight = 128
      x = 0
      y = 0
      width = 128
      height = 128
    }
  }
  $items = @()
  foreach ($path in $order) { $items += $byPath[$path] }
  $json = ([ordered]@{ version = 1; items = $items }) | ConvertTo-Json -Depth 6
  Write-Utf8 $pluginIndexPath $json
  return $items.Count
}

function Get-RemainingCount {
  $complete = @{}
  foreach ($line in (Read-Lines $entriesPath)) {
    if ($line.StartsWith("#")) { continue }
    $r = $line -split "`t"
    if ($r.Count -ge 2 -and $r[1]) { $complete[$r[1]] = $true }
  }
  $blocked = @{}
  foreach ($line in (Read-Lines $blacklistPath)) {
    $r = $line -split "`t"
    if ($r[0] -and $r[0] -ne "matchName") { $blocked[$r[0]] = $true }
  }
  if (-not $Force -and (Test-Path $panelIndexPath)) {
    try {
      $j = Get-Content $panelIndexPath -Raw -Encoding UTF8 | ConvertFrom-Json
      foreach ($it in @($j.items)) {
        if ($it.path) { $complete[$it.path.Replace('\','/')] = $true }
      }
    } catch {}
  }
  if ($OnlyPreset) {
    return $(if ($complete.ContainsKey($OnlyPreset) -or $blocked.ContainsKey($OnlyPreset)) { 0 } else { 1 })
  }
  $missing = 0
  # PresetList 模式只统计所选集合，不把预设库里其它未选的条目算进 remaining
  $all = if ($PresetList) {
    @($selectedPresets | Sort-Object)
  } else {
    @(Get-ChildItem $presets -Recurse -File -Filter *.ffx -ErrorAction SilentlyContinue |
             ForEach-Object { $_.FullName.Replace('\','/') })
  }
  foreach ($path in $all) {
    if (-not $complete.ContainsKey($path) -and -not $blocked.ContainsKey($path)) { $missing++ }
  }
  return $missing
}

# ---------- 前置：检测 AE，提示用户自行关闭（默认不代为关闭）----------
$hadAE = $false
$running = @(Get-Process -Name AfterFX -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
  $hadAE = $true
  Write-Host ""
  Write-Host "检测到 After Effects 正在运行。" -ForegroundColor Yellow
  Write-Host "插件渲染需要独占一个 AE 实例，请在当前 AE 里【保存工程】，然后【关闭 After Effects】。"
  Write-Host ""

  if ($AutoClose) {
    Write-Host "保存完成后按回车，本工具会代为温和关闭 AE（不强制结束、不丢弃未保存内容）。" -ForegroundColor Cyan
    Write-State -Phase "waiting-close" -Message "等待确认后关闭 After Effects"
    Read-Host | Out-Null
    foreach ($p in $running) { try { $p.CloseMainWindow() | Out-Null } catch {} }
  } else {
    Write-Host "关闭 AE 后本工具会自动开始渲染，不需要再按任何键（按 Ctrl+C 可取消）。" -ForegroundColor Cyan
    Write-State -Phase "waiting-close" -Message "等待你关闭 After Effects"
  }

  $deadline = (Get-Date).AddSeconds($WaitAE)
  $closed = $false
  while ((Get-Date) -lt $deadline) {
    if (@(Get-Process -Name AfterFX -ErrorAction SilentlyContinue).Count -eq 0) { $closed = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $closed) {
    Write-Host "[中止] 等待超时：After Effects 仍在运行（可能在等你确认保存）。" -ForegroundColor Red
    Write-Host "请手动关闭 AE 后重新运行本工具。" -ForegroundColor Red
    Write-State -Phase "failed" -Message "等待 After Effects 关闭超时"
    exit 2
  }
  Write-Host "After Effects 已退出，开始渲染。" -ForegroundColor Green
  Write-State -Phase "rendering" -Message "After Effects 已退出，准备渲染"
} else {
  Write-State -Phase "rendering" -Message "准备渲染"
}

Write-Host ""
Write-Host "== DreamEngine 插件预设预览 ==" -ForegroundColor Cyan
Write-Host "AE      : $AE"
Write-Host "背景    : $Background"
Write-Host "预设库  : $presets"
Write-Host ""

$totalOk = 0
$totalFail = 0
$completedByPending = $false
$customBackgroundFallbackTried = $false
$maxRounds = if ($OnlyPreset) { 1 } else { $Rounds }

for ($round = 1; $round -le $maxRounds; $round++) {
  # 等上一轮的专用实例完全退出
  if (@(Get-Process -Name AfterFX -ErrorAction SilentlyContinue).Count -gt 0) {
    for ($i = 0; $i -lt 8; $i++) {
      Start-Sleep -Seconds 2
      if (@(Get-Process -Name AfterFX -ErrorAction SilentlyContinue).Count -eq 0) { break }
    }
    if (@(Get-Process -Name AfterFX -ErrorAction SilentlyContinue).Count -gt 0) {
      # 走到这里说明是本工具启动的专用实例，结束它是安全的
      Get-Process -Name AfterFX -ErrorAction SilentlyContinue | Stop-Process -Force
      Start-Sleep -Seconds 2
    }
  }

  # 已完成 / 崩溃黑名单 / 面板已生成
  $done = @{}
  foreach ($line in (Read-Lines $entriesPath)) {
    if ($line.StartsWith("#")) { continue }
    $r = $line -split "`t"
    if ($r.Count -lt 3 -or -not $r[1]) { continue }
    $done[$r[1]] = $true
  }
  $black = @{}
  foreach ($line in (Read-Lines $blacklistPath)) {
    $r = $line -split "`t"
    if ($r[0] -and $r[0] -ne "matchName") { $black[$r[0]] = $true }
  }
  $panelDone = @{}
  if (-not $Force -and (Test-Path $panelIndexPath)) {
    try {
      $j = Get-Content $panelIndexPath -Raw -Encoding UTF8 | ConvertFrom-Json
      foreach ($it in @($j.items)) {
        if ($it.path) { $panelDone[$it.path.Replace('\','/')] = $true }
      }
    } catch {}
  }

  $all = if ($PresetList -and -not $OnlyPreset) {
    @($selectedPresets | Sort-Object)
  } else {
    @(Get-ChildItem $presets -Recurse -File -Filter *.ffx -ErrorAction SilentlyContinue |
             ForEach-Object { $_.FullName.Replace('\','/') } | Sort-Object)
  }
  if ($OnlyPreset) {
    $cands = @($all | Where-Object { $_ -eq $OnlyPreset })
    Write-Utf8 $forcePath $OnlyPreset
  } elseif ($PresetList) {
    if ($Force -and $round -eq 1) {
      # 首轮强制：忽略已完成/黑名单/面板索引，让 JSX 的 force 通道重渲所选
      if (Test-Path $forcePath) { Remove-Item $forcePath -Force }
      Write-Utf8 $forcePath "selection"
      $cands = @($all)
    } else {
      # 后续轮次恢复正常跳过逻辑
      if (Test-Path $forcePath) { Remove-Item $forcePath -Force }
      $cands = @($all | Where-Object {
        -not $done.ContainsKey($_) -and -not $black.ContainsKey($_) -and
        -not $panelDone.ContainsKey($_)
      })
    }
  } else {
    if (Test-Path $forcePath) { Remove-Item $forcePath -Force }
    $cands = @($all | Where-Object {
      -not $done.ContainsKey($_) -and -not $black.ContainsKey($_) -and
      -not $panelDone.ContainsKey($_)
    })
  }
  # 首轮把“脚本内跳过”的条目补进账本（已生成 / 黑名单），第二轮以后由 OK/FAIL 行负责。
  if ($round -eq 1 -and -not $Force -and -not $OnlyPreset) {
    $candSet = @{}
    foreach ($candidatePath in $cands) { $candSet[$candidatePath] = $true }
    foreach ($presetPath in $all) {
      if ($candSet.ContainsKey($presetPath)) { continue }
      if ($black.ContainsKey($presetPath)) {
        Write-PreviewResult -Key $presetPath -Name (Get-PresetDisplayName $presetPath) `
          -Status "skip" -Reason "blacklisted"
      } else {
        Write-PreviewResult -Key $presetPath -Name (Get-PresetDisplayName $presetPath) `
          -Status "skip" -Reason "already_rendered"
      }
    }
  }
  if ($cands.Count -eq 0) {
    $count = Build-PluginIndex
    Write-Host "没有待生成的预设了，索引共 $count 条。" -ForegroundColor Green
    break
  }

  $batch = @($cands | Select-Object -First $Limit)
  Write-Utf8 $todoPath (($batch -join "`n") + "`n")
  Write-Utf8 $bgPath $Background
  Write-Utf8 $pendingPath ([string]$cands.Count)
  $before = @(Read-Lines $logPath).Count
  $roundTimeout = [Math]::Max($Timeout, $batch.Count * 30)
  Write-Host "第 $round 个实例：本次 $($batch.Count) 条，剩余 $($cands.Count) 条 ..."
  Write-State -Phase "rendering" -Message "第 $round 个实例渲染中，本次 $($batch.Count) 条，剩余 $($cands.Count) 条" `
              -Current 0 -Total $cands.Count -Ok $totalOk -Fail $totalFail -Round $round -Remaining $cands.Count

  # AE 2023 直接执行带路径的 -r JSX 不可靠；先用临时无参数小加载器
  # 进入脚本上下文，再由加载器读取真实脚本路径。
  try {
    $process = Start-Process -FilePath $AE -ArgumentList @("-r", $jsx) -PassThru
  } catch {
    Write-Host "  启动 After Effects 失败：$($_.Exception.Message)" -ForegroundColor Red
    break
  }
  $startAt = Get-Date
  $crashed = $false
  $interruptedPath = $null
  $interruptedReason = ""
  while ($true) {
    Start-Sleep -Seconds 4
    $lines = @(Read-Lines $logPath)
    $newLines = @($lines | Select-Object -Skip $before)
    $okNow = @($newLines | Where-Object { $_.StartsWith("OK|") }).Count
    $failNow = @($newLines | Where-Object { $_.StartsWith("FAIL|") }).Count
    Write-State -Phase "rendering" -Current ($okNow + $failNow) -Total $batch.Count `
                -Ok ($totalOk + $okNow) -Fail ($totalFail + $failNow) -Round $round `
                -Remaining ([Math]::Max(0, $cands.Count - $okNow - $failNow))
    if ($lines.Count -gt $before -and $lines[-1].StartsWith("RESULT")) { break }

    $dialog = Get-AEDialogInfo
    if ($dialog) {
      $detail = "title=$($dialog.Title); text=$($dialog.Text)"
      if ($dialog.Severity -eq "warning") {
        $closed = Close-AEDialogInfo -ProcessId $dialog.ProcessId
        if ($closed) {
          [System.IO.File]::AppendAllText(
            $logPath,
            ("WARN||dismissed|" + $detail.Replace("`r", " ").Replace("`n", " ") + "`r`n"),
            $utf8
          )
          Write-State -Phase "rendering" -Message "已自动关闭 AE 渲染警告并继续" `
                      -Ok $totalOk -Fail ($totalFail + $failNow) -Round $round
          Start-Sleep -Seconds 1
          continue
        }
      }
      $useBackgroundFallback = (
        $Background -match '[\\/]' -and
        -not $customBackgroundFallbackTried
      )
      $interruptedPath = Fail-PendingPreset -Lines $lines -Reason "ae_dialog" -Detail $detail `
        -SkipBlacklist:$useBackgroundFallback
      if ($useBackgroundFallback -and $interruptedPath) {
        $customBackgroundFallbackTried = $true
        $interruptedReason = "background_fallback"
        $Background = "photo"
        Write-Host "  自定义背景触发 AE 导出错误，已改用标准背景重试当前和后续预设。" -ForegroundColor Yellow
        Write-State -Phase "rendering" -Message "自定义背景导出失败，已自动改用标准背景继续" `
                    -Ok $totalOk -Fail ($totalFail + $failNow + 1) -Round $round
      } elseif ($interruptedPath) {
        $interruptedReason = "ae_dialog"
        Write-Host "  检测到 AE 报错弹窗，已跳过当前预设并继续下一条：$interruptedPath" -ForegroundColor Yellow
        Write-State -Phase "rendering" -Message "AE 报错，已跳过当前预设并继续下一条" `
                    -Ok $totalOk -Fail ($totalFail + $failNow + 1) -Round $round
      } else {
        Write-Host "  检测到 AE 报错弹窗，但尚未开始渲染当前预设；本轮停止。" -ForegroundColor Yellow
      }
      Stop-Process -Id $dialog.ProcessId -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 1
      break
    }

    $process.Refresh()
    if ($process.HasExited) {
      $crashed = $true
      $interruptedPath = Fail-PendingPreset -Lines $lines -Reason "crash" `
        -Detail "AfterFX exited before writing RESULT" -BlacklistReason "crash"
      if ($interruptedPath) {
        $interruptedReason = "crash"
        Write-Host "  AE 进程消失，当前预设已拉黑，继续下一条。" -ForegroundColor Yellow
      }
      break
    }
    if (((Get-Date) - $startAt).TotalSeconds -gt $roundTimeout) {
      Write-Host "  实例超时（${roundTimeout}s），结束专用 AE 实例 ..." -ForegroundColor Yellow
      $interruptedPath = Fail-PendingPreset -Lines $lines -Reason "render_timeout" `
        -Detail ("no result after " + $roundTimeout + " seconds")
      if ($interruptedPath) {
        $interruptedReason = "render_timeout"
        Write-Host "  当前超时预设已跳过，继续下一条：$interruptedPath" -ForegroundColor Yellow
      }
      if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
      break
    }
  }

  $fresh = @(Read-Lines $logPath) | Select-Object -Skip $before
  $ok = @($fresh | Where-Object { $_.StartsWith("OK|") }).Count
  $fail = @($fresh | Where-Object { $_.StartsWith("FAIL|") }).Count
  Add-ResultsFromLog -Lines @($fresh)
  $totalOk += $ok
  $totalFail += $fail
  $indexed = Build-PluginIndex
  $note = if ($interruptedReason -eq "ae_dialog") {
    "（已跳过 AE 报错预设并继续下一条）"
  } elseif ($interruptedReason -eq "background_fallback") {
    "（自定义背景失败，已改用标准背景）"
  } elseif ($interruptedReason -eq "render_timeout") {
    "（已跳过超时预设并继续下一条）"
  } elseif ($crashed) {
    "（AE 进程消失，当前预设已跳过）"
  } else {
    ""
  }
  Write-Host "  成功 $ok，失败 $fail，索引累计 $indexed 条$note"
  $resultLine = @($fresh | Where-Object { $_.StartsWith("RESULT") } | Select-Object -Last 1)
  if ($resultLine.Count -gt 0 -and $resultLine[0] -match "pending=(\d+)") {
    $resultPending = [int]$Matches[1]
    if ($resultPending -eq 0) {
      $completedByPending = $true
      break
    }
  }
  if ($ok -eq 0 -and $fail -eq 0) {
    Write-Host "  本轮没有产出，停止以免空转。请查看日志：$logPath" -ForegroundColor Yellow
    break
  }
}

Write-Host ""
if (Test-Path $forcePath) { Remove-Item $forcePath -Force -ErrorAction SilentlyContinue }
# 部分插件预设会在结果写完后卡在退出阶段；专用实例必须有超时兜底。
Stop-AEProcess -GraceSeconds 12
Write-Host "完成：成功 $totalOk，失败 $totalFail" -ForegroundColor Green
Write-Host "索引：$pluginIndexPath"
Write-Host "日志：$logPath"
$remaining = if ($completedByPending) { 0 } else { Get-RemainingCount }
$fallbackNote = if ($customBackgroundFallbackTried) {
  "；自定义背景首次导出失败，后续已使用标准背景"
} else {
  ""
}
if ($remaining -gt 0) {
  Write-State -Phase "failed" -Message "渲染结束：成功 $totalOk，失败 $totalFail，仍有 $remaining 个预设未生成$fallbackNote" `
              -Ok $totalOk -Fail $totalFail -Remaining $remaining
} else {
  Write-State -Phase "done" -Message "渲染完成：成功 $totalOk，失败 $totalFail$fallbackNote" `
              -Ok $totalOk -Fail $totalFail -Remaining 0
}
if ($hadAE -and -not $NoRestart) {
  Write-Host "正在重新打开 After Effects ..." -ForegroundColor Cyan
  Start-Process -FilePath $AE | Out-Null
  Write-Host "请打开刚才的工程，并关闭重开 DreamEngine 面板即可看到新预览。"
} else {
  Write-Host "启动 AE、关闭再重开 DreamEngine 面板即可看到新预览。"
}
if ($remaining -gt 0) { exit 1 }
