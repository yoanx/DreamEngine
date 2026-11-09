# ============================================================
# DreamEngine 完全卸载脚本（Windows）
#
# 由 NSIS 卸载器调用。清理 DreamEngine 自己创建的全部内容：
#   - CEP 面板与面板用户数据
#   - Documents\DreamEngine 预设库、背景和 Hub 路径标记
#   - Documents\DreamEngineProbe 日志、状态与渲染中间文件
#   - Electron 用户数据、更新缓存和构建缓存
#   - 临时渲染目录
#   - 安装时写入的 CEP PlayerDebugMode
#
# 路径参数只用于自动化测试。正常卸载不要传这些参数。
# ============================================================
param(
  [string]$Extension = "",
  [string]$Documents = "",
  [string]$AppData = "",
  [string]$LocalAppData = "",
  [string]$Temp = "",
  [string]$RegistryRoot = "HKCU:\Software",
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$script:FailureCount = 0

function Say {
  param([string]$Text, [string]$Color = "Gray")
  if (-not $Quiet) { Write-Host $Text -ForegroundColor $Color }
}

function Warn {
  param([string]$Text)
  $script:FailureCount++
  Write-Host "[警告] $Text" -ForegroundColor Yellow
}

function Test-ReparsePoint {
  param([string]$Path)
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if (-not $item) { return $false }
  return (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Remove-OwnedPath {
  param(
    [string]$Path,
    [string]$Label
  )

  if (-not $Path) { return }
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if (-not $item) { return }

  try {
    if (Test-ReparsePoint $Path) {
      # 开发机的 CEP 扩展常是指向仓库的 Junction。只断链，绝不递归进入目标。
      if ($item.PSIsContainer) {
        & cmd.exe /c rmdir "$Path" 2>$null
      } else {
        Remove-Item -LiteralPath $Path -Force
      }
    } else {
      Remove-Item -LiteralPath $Path -Recurse -Force
    }

    if (Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue) {
      throw "路径仍然存在"
    }
    Say "已删除 $Label：$Path" "Green"
  } catch {
    Warn "无法删除$Label：$Path（$($_.Exception.Message)）"
  }
}

function Get-RegistryValueState {
  param(
    [string]$KeyPath,
    [string]$Name
  )

  $key = Get-Item -LiteralPath $KeyPath -Force -ErrorAction SilentlyContinue
  if (-not $key) {
    return @{
      keyExisted = $false
      valueExisted = $false
      value = ""
    }
  }

  $hasValue = @($key.GetValueNames()) -contains $Name
  $value = ""
  if ($hasValue) { $value = [string]$key.GetValue($Name) }
  return @{
    keyExisted = $true
    valueExisted = $hasValue
    value = $value
  }
}

function Remove-RegistryValue {
  param(
    [string]$KeyPath,
    [string]$Name
  )

  $key = Get-Item -LiteralPath $KeyPath -Force -ErrorAction SilentlyContinue
  if (-not $key) { return }
  if (@($key.GetValueNames()) -contains $Name) {
    Remove-ItemProperty -LiteralPath $KeyPath -Name $Name -Force
  }
}

function Remove-RegistryKeyIfEmpty {
  param([string]$KeyPath)

  $key = Get-Item -LiteralPath $KeyPath -Force -ErrorAction SilentlyContinue
  if (-not $key) { return }
  if (@($key.GetValueNames()).Count -eq 0 -and @(Get-ChildItem -LiteralPath $KeyPath -Force).Count -eq 0) {
    Remove-Item -LiteralPath $KeyPath -Force
  }
}

# ---------- 1. 路径解析 ----------
if (-not $Documents) {
  $Documents = [Environment]::GetFolderPath("MyDocuments")
}
if (-not $AppData) {
  $AppData = $env:APPDATA
}
if (-not $LocalAppData) {
  $LocalAppData = $env:LOCALAPPDATA
}
if (-not $Temp) {
  $Temp = [System.IO.Path]::GetTempPath().TrimEnd("\")
}
if (-not $Extension) {
  $Extension = Join-Path $AppData "Adobe\CEP\extensions\com.dreamengine.panel"
}

Say "== DreamEngine 完全卸载 ==" "Cyan"

# ---------- 2. 恢复 CEP 调试设置 ----------
# 安装脚本首次安装时把原始注册表状态写进 install-state.json。
# 有状态文件就精确恢复；旧版没有状态文件时，只移除值为 1 的 PlayerDebugMode。
$statePath = Join-Path $LocalAppData "DreamEngine\install-state.json"
$state = $null
if (Test-Path -LiteralPath $statePath) {
  try {
    $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    Warn "无法读取安装状态，将按旧版规则清理 CEP 调试设置：$($_.Exception.Message)"
  }
}

foreach ($version in @(9, 10, 11, 12, 13, 14)) {
  $keyPath = Join-Path $RegistryRoot "CSXS.$version"
  try {
    $saved = $null
    if ($state -and $state.playerDebugMode) {
      $saved = @($state.playerDebugMode | Where-Object { [int]$_.version -eq $version }) | Select-Object -First 1
    }

    if ($saved) {
      if ([bool]$saved.valueExisted) {
        if (-not (Test-Path -LiteralPath $keyPath)) {
          New-Item -Path $keyPath -Force | Out-Null
        }
        New-ItemProperty -LiteralPath $keyPath -Name "PlayerDebugMode" `
          -Value ([string]$saved.value) -PropertyType String -Force | Out-Null
      } elseif ([bool]$saved.keyExisted) {
        if (-not (Test-Path -LiteralPath $keyPath)) {
          New-Item -Path $keyPath -Force | Out-Null
        }
        Remove-RegistryValue -KeyPath $keyPath -Name "PlayerDebugMode"
      } else {
        Remove-RegistryValue -KeyPath $keyPath -Name "PlayerDebugMode"
        Remove-RegistryKeyIfEmpty -KeyPath $keyPath
      }
    } else {
      $current = Get-RegistryValueState -KeyPath $keyPath -Name "PlayerDebugMode"
      if ($current.valueExisted -and $current.value -eq "1") {
        Remove-RegistryValue -KeyPath $keyPath -Name "PlayerDebugMode"
        Remove-RegistryKeyIfEmpty -KeyPath $keyPath
      }
    }
  } catch {
    Warn "无法恢复 CSXS.$version 的 PlayerDebugMode：$($_.Exception.Message)"
  }
}

# ---------- 3. 删除 DreamEngine 自有目录 ----------
$ownedPaths = @(
  @{ Path = $Extension; Label = "CEP 面板" },
  @{ Path = (Join-Path $AppData "dreamengine-hub"); Label = "Hub 用户数据" },
  @{ Path = (Join-Path $AppData "DreamEngine Hub"); Label = "Hub 用户数据" },
  @{ Path = (Join-Path $AppData "dreamengine-hub-updater"); Label = "Hub 更新缓存" },
  @{ Path = (Join-Path $LocalAppData "DreamEngine"); Label = "DreamEngine 本地数据与构建缓存" },
  @{ Path = (Join-Path $LocalAppData "dreamengine-hub"); Label = "Hub 本地缓存" },
  @{ Path = (Join-Path $LocalAppData "DreamEngine Hub"); Label = "Hub 本地缓存" },
  @{ Path = (Join-Path $LocalAppData "dreamengine-hub-updater"); Label = "Hub 更新缓存" },
  @{ Path = (Join-Path $Temp "DreamEnginePluginRunner"); Label = "临时渲染目录" },
  @{ Path = (Join-Path $Documents "DreamEngine"); Label = "预设库与背景目录" },
  @{ Path = (Join-Path $Documents "DreamEngineProbe"); Label = "日志与探针目录" }
)

foreach ($entry in $ownedPaths) {
  Remove-OwnedPath -Path $entry.Path -Label $entry.Label
}

if (Test-Path -LiteralPath $Temp) {
  Get-ChildItem -LiteralPath $Temp -Directory -Force -Filter "dreamengine_keep_*" -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-OwnedPath -Path $_.FullName -Label "安装备份临时目录" }
}

# CEP 把每个扩展的 localStorage 放在共享 cep_cache 下。只删除名称精确匹配
# DreamEngine 扩展的宿主缓存，保留其他 Adobe 面板的收藏与设置。
$cepCache = Join-Path $Temp "cep_cache"
if (Test-Path -LiteralPath $cepCache) {
  Get-ChildItem -LiteralPath $cepCache -Directory -Force -Filter "*_com.dreamengine.panel.main" `
    -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-OwnedPath -Path $_.FullName -Label "CEP 面板本地存储" }
}

if ($script:FailureCount -gt 0) {
  Say "卸载完成，但有 $script:FailureCount 项未能清理。请关闭 After Effects 和 DreamEngine Hub 后重新卸载。" "Yellow"
  exit 1
}

Say "DreamEngine 已完全卸载。" "Green"
exit 0
