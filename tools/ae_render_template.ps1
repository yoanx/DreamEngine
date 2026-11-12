# Shared After Effects render-template compatibility helpers.
# Packaged per-version AEPs avoid first-run template generation. AE only
# guarantees forward project compatibility: use the closest packaged template
# that is not newer than the selected AE.

$script:AeRenderTemplateHelperDir = $PSScriptRoot

function Get-AeRenderMajorYear {
  param([string]$Ae)

  if (-not $Ae) { throw "AfterFX.exe path is empty" }
  $installDir = Split-Path -Parent (Split-Path -Parent $Ae)
  $nameMatch = [regex]::Match((Split-Path -Leaf $installDir), '(?<!\d)(19|20)\d{2}(?!\d)')
  if ($nameMatch.Success) { return [int]$nameMatch.Value }

  $rawVersion = ""
  try {
    $versionInfo = (Get-Item -LiteralPath $Ae -ErrorAction Stop).VersionInfo
    $rawVersion = [string]$versionInfo.FileVersion
    if (-not $rawVersion) { $rawVersion = [string]$versionInfo.ProductVersion }
  } catch {}
  $versionMatch = [regex]::Match($rawVersion, '^\d+')
  if (-not $versionMatch.Success) {
    throw "Cannot determine After Effects version from: $Ae"
  }
  $major = [int]$versionMatch.Value
  if ($major -ge 23) { return $major + 2000 }
  if ($major -ge 14) { return $major + 2003 }
  throw "Unsupported After Effects major version: $major"
}

function Get-AeRenderTemplatePath {
  param(
    [string]$Ae,
    [string]$Probe
  )

  if (-not $Probe) { throw "DreamEngine probe path is empty" }
  $year = Get-AeRenderMajorYear -Ae $Ae
  return Join-Path $Probe ("render_templates\DreamEnginePNG-ae{0}-v1.aep" -f $year)
}

function Get-AePackagedRenderTemplatePath {
  param([string]$Ae)

  $year = Get-AeRenderMajorYear -Ae $Ae
  $templateDir = Join-Path $script:AeRenderTemplateHelperDir "templates"
  if (-not (Test-Path -LiteralPath $templateDir)) { return "" }

  $best = $null
  $bestYear = -1
  $bestVersion = -1
  foreach ($file in @(Get-ChildItem -LiteralPath $templateDir -File -Filter "DreamEnginePNG-ae*.aep" -ErrorAction SilentlyContinue)) {
    $match = [regex]::Match(
      $file.Name,
      '^DreamEnginePNG-ae(?<year>\d{4})-v(?<version>\d+)\.aep$',
      [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
    if (-not $match.Success) { continue }
    $candidateYear = [int]$match.Groups["year"].Value
    $candidateVersion = [int]$match.Groups["version"].Value
    if ($candidateYear -gt $year) { continue }
    if ($candidateYear -gt $bestYear -or
        ($candidateYear -eq $bestYear -and $candidateVersion -gt $bestVersion)) {
      $best = $file.FullName
      $bestYear = $candidateYear
      $bestVersion = $candidateVersion
    }
  }
  return $(if ($best) { $best } else { "" })
}

function Write-AeTemplateUtf8 {
  param([string]$Path, [string]$Text)
  [System.IO.File]::WriteAllText(
    $Path,
    [string]$Text,
    (New-Object System.Text.UTF8Encoding($false))
  )
}

function Resolve-AeRenderTemplate {
  param(
    [string]$Ae,
    [string]$Probe,
    [string]$BuilderScript,
    [string]$LoaderScript,
    [int]$TimeoutSec = 90
  )

  $template = Get-AeRenderTemplatePath -Ae $Ae -Probe $Probe
  $templateDir = Split-Path -Parent $template
  New-Item -ItemType Directory -Force -Path $templateDir | Out-Null
  if ((Test-Path -LiteralPath $template) -and
      (Get-Item -LiteralPath $template).Length -gt 0) {
    return $template
  }
  $packaged = Get-AePackagedRenderTemplatePath -Ae $Ae
  if ($packaged) { return $packaged }
  if (-not (Test-Path -LiteralPath $BuilderScript)) {
    throw "Missing AE template builder: $BuilderScript"
  }
  if (-not (Test-Path -LiteralPath $LoaderScript)) {
    throw "Missing AE template loader: $LoaderScript"
  }

  $scriptMarker = Join-Path $Probe "template_builder_script_path.txt"
  $loaderError = Join-Path $Probe "template_builder_loader_error.txt"
  Write-AeTemplateUtf8 -Path $scriptMarker -Text $BuilderScript
  Remove-Item -LiteralPath $loaderError -Force -ErrorAction SilentlyContinue

  $previousTemplate = $env:DREAMENGINE_TEMPLATE_PATH
  $previousAudit = $env:DREAMENGINE_TEMPLATE_AUDIT
  $env:DREAMENGINE_TEMPLATE_PATH = $template
  $env:DREAMENGINE_TEMPLATE_AUDIT = [System.IO.Path]::ChangeExtension($template, ".audit.json")
  $process = $null
  try {
    $process = Start-Process -FilePath $Ae `
      -ArgumentList @("-r", $LoaderScript) `
      -WindowStyle Hidden -PassThru
    $deadline = (Get-Date).AddSeconds([Math]::Max(10, $TimeoutSec))
    while (-not $process.HasExited -and (Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 300
      $process.Refresh()
    }
    if (-not $process.HasExited) {
      & taskkill /T /F /PID $process.Id 2>$null | Out-Null
      throw "Timed out while building an After Effects render template"
    }
    Start-Sleep -Milliseconds 200
    if (-not (Test-Path -LiteralPath $template) -or
        (Get-Item -LiteralPath $template).Length -le 0) {
      $detail = ""
      if (Test-Path -LiteralPath $loaderError) {
        $detail = ": " + ([System.IO.File]::ReadAllText($loaderError)).Trim()
      }
      throw "After Effects did not create the render template$detail"
    }
    return $template
  } finally {
    if ($null -eq $previousTemplate) {
      Remove-Item Env:DREAMENGINE_TEMPLATE_PATH -ErrorAction SilentlyContinue
    } else {
      $env:DREAMENGINE_TEMPLATE_PATH = $previousTemplate
    }
    if ($null -eq $previousAudit) {
      Remove-Item Env:DREAMENGINE_TEMPLATE_AUDIT -ErrorAction SilentlyContinue
    } else {
      $env:DREAMENGINE_TEMPLATE_AUDIT = $previousAudit
    }
  }
}
