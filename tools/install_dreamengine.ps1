# ============================================================
# DreamEngine 安装 / 升级脚本（Windows / After Effects 2021+）
#
# 设计原则：**升级绝不能删用户数据**。
#   用户数据 = 自己生成的预览图（data/thumbs）、三份运行时索引、
#   以及 Documents\DreamEngine 下的预设库与背景（本脚本从不碰它）。
#   旧版脚本用 Remove-Item -Recurse 全删再覆盖，一次升级会把几小时的
#   插件预览渲染结果清零 —— 本脚本改为「增量覆盖 + 用户数据保护」。
#
# 用法：
#   全新安装   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   升级       powershell -ExecutionPolicy Bypass -File .\install.ps1
#   清空重装   ... -Fresh          （会删掉用户生成的预览，需二次确认）
#   换新版 L1  ... -UpdateL1       （备份现有索引后部署包内内置包）
#   只看结果   ... -WhatIf
# ============================================================
param(
  [string]$Source = "",
  [string]$Target = "",
  [switch]$Fresh,
  [switch]$UpdateL1,
  [switch]$NoDebugMode,
  [switch]$WhatIf,
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"

function Say {
  param([string]$Text, [string]$Color = "Gray")
  if (-not $Quiet) { Write-Host $Text -ForegroundColor $Color }
}
function Fail {
  param([string]$Text)
  Write-Host "[错误] $Text" -ForegroundColor Red
  exit 1
}

function Copy-TreeFast {
  param([string]$Source, [string]$Target)
  if (-not (Test-Path -LiteralPath $Source)) { return }
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  $robocopy = Get-Command robocopy.exe -ErrorAction SilentlyContinue
  if ($robocopy) {
    & $robocopy.Source $Source $Target /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -gt 7) { throw "robocopy 失败：$LASTEXITCODE" }
    return
  }
  Copy-Item -Path (Join-Path $Source "*") -Destination $Target -Recurse -Force
}

# ---------- 1. 路径解析 ----------
if (-not $Source) { $Source = $PSScriptRoot }
if (-not $Source) { $Source = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not (Test-Path $Source)) { Fail "找不到安装源目录：$Source" }
$Source = (Resolve-Path $Source).Path

$extSrc   = Join-Path $Source "extension"
$l1Src    = Join-Path $Source "l1"
$toolsSrc = Join-Path $Source "tools"
$docs     = [Environment]::GetFolderPath("MyDocuments")
$userPresets = Join-Path $docs "DreamEngine\presets"

if (-not (Test-Path (Join-Path $extSrc "index.html"))) {
  Fail "安装源不完整：缺少 extension\index.html（源目录：$Source）"
}

# CEP 扩展目录是用户级的，不需要管理员权限
$cepRoot = Join-Path $env:APPDATA "Adobe\CEP\extensions"
if (-not $Target) { $Target = Join-Path $cepRoot "com.dreamengine.panel" }

Say "== DreamEngine 安装 ==" "Cyan"
Say "源目录  : $Source"
Say "扩展目录: $Target"

# ---------- 2. Junction / 符号链接检测 ----------
# 开发机上扩展目录常是指向仓库的 Junction。对它跑 Remove-Item -Recurse
# 有可能顺着链接删掉仓库内容；这里只删链接本身。
function Test-ReparsePoint {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return $false }
  $item = Get-Item $Path -Force
  return (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

if (Test-Path $Target) {
  if (Test-ReparsePoint $Target) {
    Say "检测到扩展目录是链接（Junction / 符号链接），只移除链接本身，不动目标内容。" "Yellow"
    if (-not $WhatIf) {
      & cmd /c rmdir "$Target" 2>$null
      if (Test-Path $Target) { Fail "无法移除链接：$Target（可能正被 After Effects 占用）" }
    }
  } elseif ($Fresh) {
    Say "== -Fresh：将删除扩展目录（含你已生成的全部预览）==" "Yellow"
    if (-not $WhatIf) {
      $answer = Read-Host "确认删除 $Target ？输入 YES 继续"
      if ($answer -ne "YES") { Fail "已取消。" }
      Remove-Item -Recurse -Force $Target
    }
  }
}

# ---------- 3. 备份用户数据 ----------
# 索引文件由用户机器现场生成，升级时不能丢。预览目录不搬来搬去：
# 扩展本体是增量复制，原地保留数万个小文件，避免覆盖安装反复复制。
$KEEP = @(
  "manifest.json",
  "previews.tsv",
  "animated.json",
  "plugin_manifest.json",
  "plugin_previews.tsv",
  "plugin_blacklist.json",
  "preset_manifest.json",
  "preset_previews.tsv",
  "preset_plugin_manifest.json",
  "preset_plugin_blacklist.json",
  "preset_plugin_previews.tsv",
  "preview_settings.json"
)

$dataDst = Join-Path $Target "data"
$backup = Join-Path $env:TEMP ("dreamengine_keep_" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$keptCount = 0

# 必须在复制扩展本体**之前**判断：这一步会在目标目录里创建 data/manifest.json
# （包里若带了索引），之后再判断就会把全新安装误判成老用户，跳过 L1 部署，
# 结果是装完一张图都没有。
$hadLocalManifest = Test-Path (Join-Path $dataDst "manifest.json")

if (Test-Path $dataDst) {
  New-Item -ItemType Directory -Force -Path $backup | Out-Null
  foreach ($name in $KEEP) {
    $src = Join-Path $dataDst $name
    if (Test-Path $src) {
      Copy-Item -Path $src -Destination $backup -Recurse -Force
      $keptCount++
    }
  }
  if ($keptCount -gt 0) { Say "已保护 $keptCount 项用户数据（预览图 / 索引）" "Gray" }
}

# ---------- 4. 部署扩展本体 ----------
if (-not $WhatIf) {
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  New-Item -ItemType Directory -Force -Path $dataDst | Out-Null
  New-Item -ItemType Directory -Force -Path $userPresets | Out-Null
  Copy-Item -Path (Join-Path $extSrc "*") -Destination $Target -Recurse -Force
}
Say "扩展本体已部署" "Green"

# ---------- 5. 还原用户数据（覆盖包内同名文件）----------
if ($keptCount -gt 0 -and -not $WhatIf) {
  foreach ($item in (Get-ChildItem $backup -Force)) {
    $dst = Join-Path $dataDst $item.Name
    if ($item.PSIsContainer) {
      if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
      Copy-Item -Path $item.FullName -Destination $dst -Recurse -Force
    } else {
      Copy-Item -Path $item.FullName -Destination $dst -Force
    }
  }
  Remove-Item -Recurse -Force $backup -ErrorAction SilentlyContinue
  Say "用户数据已还原（未被随包内容覆盖）" "Green"
}

# ---------- 6. L1 内置预览包 ----------
# 全新安装：直接铺满，装完即有图。
# 升级：默认不动，避免覆盖用户自己生成的条目；-UpdateL1 才替换（先备份）。
$l1ManifestSrc = Join-Path $l1Src "manifest.json"
$l1ManifestDst = Join-Path $dataDst "manifest.json"
$l1HasFrameSequences = Test-Path (Join-Path $l1Src "previews\effects\webp\builtin\frames")

if (-not (Test-Path $l1ManifestSrc)) {
  Say "包里没有 l1 目录，跳过内置预览部署" "Yellow"
} elseif (-not $WhatIf) {
  New-Item -ItemType Directory -Force -Path (Join-Path $dataDst "thumbs") | Out-Null

  # names.json 是纯程序数据，始终更新
  if (Test-Path (Join-Path $l1Src "names.json")) {
    Copy-Item -Force (Join-Path $l1Src "names.json") (Join-Path $dataDst "names.json")
  }

  $deployL1 = $true
  if ($hadLocalManifest -and -not $UpdateL1) {
    $deployL1 = $false
    $localCount = 0
    $localHasFrameSequences = $false
    try {
      $localManifest = Get-Content $l1ManifestDst -Raw -Encoding UTF8 | ConvertFrom-Json
      $localCount = @($localManifest.items).Count
      foreach ($localItem in @($localManifest.items)) {
        if ($localItem.format -eq "webp-sequence" -and ([string]$localItem.frameSrc).EndsWith(".webp")) {
          $localHasFrameSequences = $true
          break
        }
      }
    } catch {}
    if ($l1HasFrameSequences -and -not $localHasFrameSequences) {
      $deployL1 = $true
      Say "检测到旧版内置预览索引，自动升级为安装包内的 WebP 帧序列。" "Yellow"
    } else {
      Say "已存在本地索引（$localCount 条），保留不覆盖。如需换用包内内置包请加 -UpdateL1。" "Yellow"
    }
  }

  if ($deployL1) {
    if ($hadLocalManifest) {
      $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
      $bakDir = Join-Path $dataDst "_backup-$stamp"
      New-Item -ItemType Directory -Force -Path $bakDir | Out-Null
      Copy-Item -Force $l1ManifestDst (Join-Path $bakDir "manifest.json")
      if (Test-Path (Join-Path $dataDst "previews.tsv")) {
        Copy-Item -Force (Join-Path $dataDst "previews.tsv") (Join-Path $bakDir "previews.tsv")
      }
      Say "旧索引已备份到：$bakDir" "Yellow"
    }
    Copy-Item -Force $l1ManifestSrc $l1ManifestDst
    if (Test-Path (Join-Path $l1Src "previews.tsv")) {
      Copy-Item -Force (Join-Path $l1Src "previews.tsv") (Join-Path $dataDst "previews.tsv")
    }
    if (Test-Path (Join-Path $l1Src "animated.json")) {
      Copy-Item -Force (Join-Path $l1Src "animated.json") (Join-Path $dataDst "animated.json")
    }
    $l1Previews = Join-Path $l1Src "previews"
    if (Test-Path $l1Previews) {
      $previewsDst = Join-Path $dataDst "previews"
      Copy-TreeFast $l1Previews $previewsDst
    }
    $l1Thumbs = Join-Path $l1Src "thumbs"
    if (Test-Path $l1Thumbs) {
      # -UpdateL1 是显式替换内置预览包；同名 WebP 必须覆盖，
      # 否则旧单页文件会阻止安装包里的新动画生效。
      # 递归复制，保留 webp/插件名/ 与 stills/ 子目录。
      Copy-TreeFast $l1Thumbs (Join-Path $dataDst "thumbs")
    }
    $deployed = @(Get-ChildItem (Join-Path $dataDst "thumbs") -Recurse -File -ErrorAction SilentlyContinue).Count
    Say "内置预览已部署：$deployed 张图" "Green"
  }
}

# ---------- 6.4 内置预设预览包（静态 WebP 帧序列） ----------
# 安装包里的 615 个 AE 自带预设预览放在独立的 bundled 目录，
# 用户现场渲染的预览仍保留在 previews/presets 下，二者通过索引合并。
$presetBundleSrc = Join-Path $Source "presets"
if (-not (Test-Path -LiteralPath $presetBundleSrc)) {
  Say "包里没有预设预览包，跳过内置预设预览部署" "Yellow"
} elseif (-not $WhatIf) {
  $bundledManifestSrc = Join-Path $presetBundleSrc "manifest.json"
  $bundledPreviewsSrc = Join-Path $presetBundleSrc "previews"
  if (Test-Path -LiteralPath $bundledManifestSrc) {
    New-Item -ItemType Directory -Force -Path $dataDst | Out-Null
    $bundledManifestDst = Join-Path $dataDst "bundled_preset_manifest.json"
    $bundlePreviewsDst = Join-Path $dataDst "previews"
    $bundleCurrent = $false
    if ((Test-Path -LiteralPath $bundledManifestDst) -and
        (Test-Path -LiteralPath (Join-Path $bundlePreviewsDst "bundled\presets"))) {
      try {
        $bundleCurrent = (Get-FileHash -LiteralPath $bundledManifestSrc -Algorithm SHA256).Hash -eq
          (Get-FileHash -LiteralPath $bundledManifestDst -Algorithm SHA256).Hash
      } catch {}
    }
    if (-not $bundleCurrent) {
      Copy-Item -Force $bundledManifestSrc $bundledManifestDst
      if (Test-Path -LiteralPath $bundledPreviewsSrc) {
        Copy-TreeFast $bundledPreviewsSrc $bundlePreviewsDst
      }
      $bundledCount = 0
      try { $bundledCount = @((Get-Content -LiteralPath $bundledManifestSrc -Raw -Encoding UTF8 | ConvertFrom-Json).items).Count } catch {}
      Say "内置预设预览已部署：$bundledCount 条（WebP 帧序列）" "Green"
    } else {
      Say "内置预设预览已是当前版本，跳过重复复制" "Green"
    }
  }
}
# ---------- 6.5 迁移旧预览到统一根目录 ----------
$migrationScript = Join-Path $PSScriptRoot "migrate_previews.ps1"
$devMigration = Join-Path (Split-Path -Parent $PSScriptRoot) "hub\installer\migrate_previews.ps1"
if (Test-Path -LiteralPath $devMigration) {
  $migrationScript = $devMigration
} elseif (-not (Test-Path -LiteralPath $migrationScript)) {
  $migrationScript = Join-Path $toolsSrc "migrate_previews.ps1"
}
if (-not $WhatIf) {
  if (Test-Path -LiteralPath $migrationScript) {
    try {
      & $migrationScript -DataDir $dataDst -Quiet
      Say "旧预览已迁移到统一预览根目录" "Green"
    } catch {
      Say "预览迁移失败，已保留原预览和索引：$($_.Exception.Message)" "Yellow"
    }
  } else {
    Say "未找到 migrate_previews.ps1，跳过预览迁移" "Yellow"
  }
}

# ---------- 7. 离线工具 ----------
if ((Test-Path $toolsSrc) -and -not $WhatIf) {
  $toolsDst = Join-Path $Target "tools"
  New-Item -ItemType Directory -Force -Path $toolsDst | Out-Null
  Copy-Item -Path (Join-Path $toolsSrc "*") -Destination $toolsDst -Recurse -Force
  Say "离线工具已部署：$toolsDst" "Green"
}

# ---------- 8. 记录注册表原始状态 ----------
# 更新会复用现有 install-state.json。只有第一次安装时才记录原值，
# 否则第二次安装会把 DreamEngine 写入的 1 误当成用户原值。
if (-not $WhatIf) {
  $stateRoot = Join-Path $env:LOCALAPPDATA "DreamEngine"
  $statePath = Join-Path $stateRoot "install-state.json"
  if (-not (Test-Path $statePath)) {
    try {
      New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
      $debugStates = @()
      foreach ($v in @(9, 10, 11, 12, 13, 14)) {
        $key = "HKCU:\Software\Adobe\CSXS.$v"
        $keyItem = Get-Item -LiteralPath $key -Force -ErrorAction SilentlyContinue
        $valueExisted = $false
        $value = ""
        if ($keyItem) {
          $valueExisted = @($keyItem.GetValueNames()) -contains "PlayerDebugMode"
          if ($valueExisted) { $value = [string]$keyItem.GetValue("PlayerDebugMode") }
        }
        $debugStates += [ordered]@{
          version = $v
          keyExisted = [bool]$keyItem
          valueExisted = $valueExisted
          value = $value
        }
      }
      $state = [ordered]@{
        schemaVersion = 1
        createdAt = (Get-Date).ToString("o")
        playerDebugMode = $debugStates
      }
      [System.IO.File]::WriteAllText(
        $statePath,
        ($state | ConvertTo-Json -Depth 5),
        (New-Object System.Text.UTF8Encoding($false))
      )
      Say "已记录 CEP 调试设置原始状态：$statePath" "Gray"
    } catch {
      Say "无法记录 CEP 调试设置原始状态，将跳过注册表修改：$($_.Exception.Message)" "Yellow"
      $NoDebugMode = $true
    }
  }
}

# ---------- 9. 允许加载未签名扩展 ----------
# AE 读的是「自身 CEP 版本对应」的那个键，只写 CSXS.11 在别的 AE 版本上等于没写。
# AE 2021=CEP 11、CC2022=12、2023=12、2024=13、2025=14，覆盖 9~14 最稳。
if (-not $NoDebugMode -and -not $WhatIf) {
  $written = @()
  foreach ($v in @(9, 10, 11, 12, 13, 14)) {
    $key = "HKCU:\Software\Adobe\CSXS.$v"
    try {
      if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
      New-ItemProperty -Path $key -Name "PlayerDebugMode" -Value "1" -PropertyType String -Force | Out-Null
      $written += "CSXS.$v"
    } catch {
      Say "写入 CSXS.$v 失败：$($_.Exception.Message)" "Yellow"
    }
  }
  Say ("已开启 CEP 调试模式：" + ($written -join ", ")) "Green"
}

# ---------- 10. 汇总 ----------
Say ""
Say "安装完成。" "Green"
Say "启动 After Effects 后，在菜单里打开：窗口 > 扩展 > DreamEngine" "Cyan"
if ($WhatIf) { Say "（本次是 -WhatIf 演练，没有改动任何文件）" "Yellow" }
