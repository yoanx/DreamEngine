# ============================================================
# migrate_previews.ps1 —— 把旧预览迁移到统一预览根目录
#
# 安装器在部署扩展和 L1 后调用。只使用 Windows PowerShell 5 自带能力，
# 不依赖 Node。逻辑与 hub/core/preview_paths.js 保持一致：
#   thumbs/... -> previews/effects/... 或 previews/presets/...
# 原始 L1 拼图、帧序列、WebP、插件效果和预设预览都会迁移。
# ============================================================
param(
  [Parameter(Mandatory = $true)]
  [string]$DataDir,
  [string]$PreviewRoot = "",
  [string]$SettingsPath = "",
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Say {
  param([string]$Text)
  if (-not $Quiet) { Write-Host $Text -ForegroundColor Gray }
}

function Get-DocsPath {
  return [Environment]::GetFolderPath("MyDocuments")
}

function Read-JsonFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
  if (-not $raw) { return $null }
  return ($raw | ConvertFrom-Json)
}

function Write-JsonFile {
  param([string]$Path, $Value)
  $parent = Split-Path -Parent $Path
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  [System.IO.File]::WriteAllText(
    $Path,
    ($Value | ConvertTo-Json -Depth 20),
    $utf8NoBom
  )
}

function Read-Document {
  param(
    [string]$Path,
    [string]$Kind,
    [string[]]$Fields,
    [string[]]$SheetFields
  )
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
  if (-not $text) { return $null }
  return [pscustomobject]@{
    Path = $Path
    Text = $text
    Doc = ($text | ConvertFrom-Json)
    Kind = $Kind
    Fields = $Fields
    SheetFields = $SheetFields
  }
}

function Expand-Pattern {
  param([string]$Value, [int]$Frames)
  if ($Value -notmatch '%04d') { return @($Value) }
  $count = [Math]::Max(1, $Frames)
  $out = @()
  for ($i = 0; $i -lt $count; $i++) {
    $out += $Value.Replace('%04d', $i.ToString('D4'))
  }
  return $out
}

$script:Mappings = @{}
$script:Copied = New-Object System.Collections.Generic.List[string]
$script:Sources = New-Object System.Collections.Generic.List[string]

function Copy-PreviewFile {
  param([string]$Source, [string]$Target)
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { return }
  $sourceFull = [IO.Path]::GetFullPath($Source)
  $targetFull = [IO.Path]::GetFullPath($Target)
  if ($sourceFull -ieq $targetFull) { return }
  if (Test-Path -LiteralPath $targetFull -PathType Leaf) {
    $sourceLength = (Get-Item -LiteralPath $sourceFull).Length
    $targetLength = (Get-Item -LiteralPath $targetFull).Length
    if ($sourceLength -ne $targetLength) {
      throw "目标已存在同名但大小不同的文件：$targetFull"
    }
    return
  }
  $parent = Split-Path -Parent $targetFull
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  Copy-Item -LiteralPath $sourceFull -Destination $targetFull -Force
  $script:Copied.Add($targetFull)
  $script:Sources.Add($sourceFull)
}

function Remove-EmptyDirectoryTree {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return 0 }
  $removed = 0
  foreach ($child in @(Get-ChildItem -LiteralPath $Path -Force -Directory -ErrorAction SilentlyContinue)) {
    $removed += Remove-EmptyDirectoryTree $child.FullName
  }
  $remaining = @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue)
  if ($remaining.Count -eq 0) {
    try {
      [IO.Directory]::Delete($Path)
      return $removed + 1
    } catch {}
  }
  return $removed
}

function Convert-PreviewValue {
  param([string]$Value, [string]$Kind, [int]$Frames)
  if (-not $Value) { return $Value }
  $normalized = $Value.Replace('\', '/')
  if ($normalized.StartsWith('previews/')) { return $Value }

  $relative = $normalized.TrimStart('/')
  if ($relative.StartsWith('thumbs/')) { $relative = $relative.Substring(7) }
  elseif ($relative.StartsWith('data/')) { $relative = $relative.Substring(5) }
  if (-not $relative) { return $Value }

  $targetValue = 'previews/' + $Kind + '/' + $relative
  $script:Mappings[$Value] = $targetValue
  $oldFiles = @(Expand-Pattern $Value $Frames)
  $newFiles = @(Expand-Pattern $targetValue $Frames)
  for ($i = 0; $i -lt $oldFiles.Count; $i++) {
    $oldRelative = $oldFiles[$i].Replace('\', '/').TrimStart('/')
    if ($oldRelative.StartsWith('thumbs/')) { $oldRelative = $oldRelative.Substring(7) }
    elseif ($oldRelative.StartsWith('data/')) { $oldRelative = $oldRelative.Substring(5) }
    $newRelative = $newFiles[$i].Substring('previews/'.Length)
    Copy-PreviewFile `
      (Join-Path $DataDir ($oldRelative.Replace('/', '\'))) `
      (Join-Path $PreviewRoot ($newRelative.Replace('/', '\')))
  }
  return $targetValue
}

function Update-Document {
  param($Entry)
  if (-not $Entry) { return }
  foreach ($item in @($Entry.Doc.items)) {
    if (-not $item) { continue }
    $frames = 1
    if ($item.PSObject.Properties.Name -contains 'frames') {
      $frames = [Math]::Max(1, [int]$item.frames)
    }
    foreach ($field in $Entry.Fields) {
      if ($item.PSObject.Properties.Name -contains $field) {
        $value = [string]$item.$field
        if ($value) { $item.$field = Convert-PreviewValue $value $Entry.Kind $frames }
      }
    }
  }
  foreach ($sheet in @($Entry.Doc.sheets)) {
    if (-not $sheet) { continue }
    foreach ($field in $Entry.SheetFields) {
      if ($sheet.PSObject.Properties.Name -contains $field) {
        $value = [string]$sheet.$field
        if ($value) { $sheet.$field = Convert-PreviewValue $value $Entry.Kind 1 }
      }
    }
  }
}

function Update-Tsv {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $lines = (Get-Content -LiteralPath $Path -Raw -Encoding UTF8).Split([string[]]@("`r`n", "`n"), [StringSplitOptions]::None)
  $out = @()
  foreach ($line in $lines) {
    if (-not $line -or $line.StartsWith('matchName')) { $out += $line; continue }
    $cells = $line.Split("`t")
    if ($cells.Count -gt 4 -and $script:Mappings.ContainsKey($cells[4])) {
      $cells[4] = $script:Mappings[$cells[4]]
    }
    $out += ($cells -join "`t")
  }
  [System.IO.File]::WriteAllText($Path, ($out -join "`r`n"), $utf8NoBom)
}

$DataDir = [IO.Path]::GetFullPath($DataDir)
if (-not (Test-Path -LiteralPath $DataDir)) { throw "data 目录不存在：$DataDir" }

if (-not $PreviewRoot) {
  $candidates = @()
  if ($SettingsPath) { $candidates += $SettingsPath }
  # 扩展 data 里的设置是 Hub 最近一次写入的权威值；用户目录里的镜像只作兜底。
  $candidates += (Join-Path $DataDir 'preview_settings.json')
  $candidates += (Join-Path (Get-DocsPath) 'DreamEngine\preview_settings.json')
  foreach ($candidate in $candidates) {
    $settings = Read-JsonFile $candidate
    if ($settings -and $settings.root) { $PreviewRoot = [string]$settings.root; break }
  }
}
if (-not $PreviewRoot) { $PreviewRoot = Join-Path $DataDir 'previews' }
$PreviewRoot = [IO.Path]::GetFullPath($PreviewRoot)
New-Item -ItemType Directory -Force -Path (Join-Path $PreviewRoot 'effects') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $PreviewRoot 'presets') | Out-Null

$entries = @(
  (Read-Document (Join-Path $DataDir 'manifest.json') 'effects' @('src','frameSrc','webpSrc','stillSrc') @('src')),
  (Read-Document (Join-Path $DataDir 'plugin_manifest.json') 'effects' @('src','frameSrc','webpSrc','stillSrc') @('src')),
  (Read-Document (Join-Path $DataDir 'preset_manifest.json') 'presets' @('src','frameSrc','webpSrc','stillSrc') @('src')),
  (Read-Document (Join-Path $DataDir 'preset_plugin_manifest.json') 'presets' @('src','frameSrc','webpSrc','stillSrc') @('src'))
) | Where-Object { $_ -ne $null }

$backup = @{}
foreach ($entry in $entries) { $backup[$entry.Path] = $entry.Text }
$tsvPaths = @('previews.tsv', 'plugin_previews.tsv', 'preset_previews.tsv') | ForEach-Object { Join-Path $DataDir $_ }
foreach ($tsv in $tsvPaths) {
  if (Test-Path -LiteralPath $tsv) { $backup[$tsv] = Get-Content -LiteralPath $tsv -Raw -Encoding UTF8 }
}

try {
  foreach ($entry in $entries) { Update-Document $entry }

  # 未被索引引用的旧 thumbs 也迁移，按文件名/子目录区分效果与预设。
  $thumbs = Join-Path $DataDir 'thumbs'
  if (Test-Path -LiteralPath $thumbs) {
    $thumbsRoot = (Resolve-Path $thumbs).Path
    foreach ($file in @(Get-ChildItem -LiteralPath $thumbsRoot -Recurse -File)) {
      $relative = $file.FullName.Substring($thumbsRoot.Length).TrimStart([char]92, [char]47)
      $kind = if ($relative -match '(^|[\\/])preset_' -or $relative -match '^presets[\\/]') { 'presets' } else { 'effects' }
      Copy-PreviewFile $file.FullName (Join-Path (Join-Path $PreviewRoot $kind) $relative)
    }
  }

  # 旧默认根 data/previews 也收口到当前根目录。
  $legacyRoot = Join-Path $DataDir 'previews'
  if ((Test-Path -LiteralPath $legacyRoot) -and ([IO.Path]::GetFullPath($legacyRoot) -ine [IO.Path]::GetFullPath($PreviewRoot))) {
    $legacyFull = (Resolve-Path $legacyRoot).Path
    foreach ($file in @(Get-ChildItem -LiteralPath $legacyFull -Recurse -File)) {
      $relative = $file.FullName.Substring($legacyFull.Length).TrimStart([char]92, [char]47)
      Copy-PreviewFile $file.FullName (Join-Path $PreviewRoot $relative)
    }
  }

  foreach ($entry in $entries) { Write-JsonFile $entry.Path $entry.Doc }
  foreach ($tsv in $tsvPaths) { Update-Tsv $tsv }
  $settingsRoot = if ([IO.Path]::GetFullPath($PreviewRoot) -ieq [IO.Path]::GetFullPath((Join-Path $DataDir "previews"))) { "" } else { $PreviewRoot }
  Write-JsonFile (Join-Path $DataDir "preview_settings.json") ([pscustomobject]@{ version = 1; root = $settingsRoot })

  foreach ($source in $script:Sources) {
    try { if (Test-Path -LiteralPath $source) { Remove-Item -LiteralPath $source -Force } } catch {}
  }
  # 源文件搬走后清掉空目录；有未迁移文件时删除会失败并保留目录。
  Remove-EmptyDirectoryTree $thumbs | Out-Null
  if ([IO.Path]::GetFullPath($legacyRoot) -ine [IO.Path]::GetFullPath($PreviewRoot)) {
    Remove-EmptyDirectoryTree $legacyRoot | Out-Null
  }
  Say "预览迁移完成：$PreviewRoot"
} catch {
  foreach ($key in $backup.Keys) {
    try { [System.IO.File]::WriteAllText($key, $backup[$key], $utf8NoBom) } catch {}
  }
  foreach ($file in $script:Copied) {
    try { if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force } } catch {}
  }
  throw
}
