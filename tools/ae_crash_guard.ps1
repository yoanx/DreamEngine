# AE 崩溃修复对话框看守（Hub 渲染 / 取参期间常驻运行）
#
# 背景：After Effects 上次异常退出后，下次启动有一定概率弹出「崩溃修复选项」对话框，
# 挡住脚本化启动流程（AE 停在对话框上，渲染脚本只能等到超时）。
#
# 本脚本只做一件事：识别出这个对话框后，往窗口里送一个 Enter 键——对话框的默认按钮
# 就是「继续」，等价于用户手动点「继续」。不点其它按钮、不结束 / 重启 AE 进程、
# 不碰 AfterFX 之外的窗口。
#
# 检测规则（宁可不按，也不按错）：
#   1) 只看 -ProcessNames（默认 AfterFX）进程的**可见**顶层窗口；
#   2) 窗口类名必须是对话框类 #32770；
#   3) 窗口里必须存在 Adobe 组件对话框的内容容器（子窗口类名含 DroverLord），
#      该对话框是自绘的，按钮不是真实子窗口，只能靠这条特征确认它是 AE 模态框；
#   4) 标题为空，或标题命中 -TitlePattern（默认覆盖 崩溃修复 / Crash Repair / 错误 / 警告 等）；
#   5) 同一窗口在 -CooldownMs（默认 8 秒）内只按一次；按完等 700ms 复核窗口是否消失。
#
# 按 Enter 而不是点坐标的理由：默认按钮位置随 DPI / 语言变化，Enter 由对话框自己决定
# 默认按钮，既稳又不需要坐标；实测（2026-11-09，AE 2025 25.6.4）可正常触发「继续」。
#
# 典型用法（Hub 主进程会这样启动它，也可单独跑）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\ae_crash_guard.ps1 `
#       -LogPath "$env:USERPROFILE\Documents\DreamEngineProbe\ae_guard.log" -TimeoutSec 3600 -Quiet
# 手动排查：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\ae_crash_guard.ps1 -DryRun -Once -Quiet

[CmdletBinding()]
param(
  [string[]]$ProcessNames = @("AfterFX"),
  [string]$TitlePattern = "崩溃修复|Crash Repair|崩溃|错误|Error|警告|Warning",
  [int]$TimeoutSec = 7200,
  [int]$IntervalMs = 1200,
  [int]$CooldownMs = 8000,
  [string]$LogPath = "",
  [switch]$DryRun,
  [switch]$Quiet,
  [switch]$Once,
  [switch]$Singleton
)

$ErrorActionPreference = "Continue"
$utf8 = New-Object System.Text.UTF8Encoding($false)
$script:startedAt = Get-Date
$script:pressed = @{}

function Write-GuardLog {
  param([string]$Message)
  $line = "[" + (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss") + "] " + $Message
  if (-not $Quiet) { Write-Host $line }
  if ($LogPath) {
    try {
      $dir = Split-Path -Parent $LogPath
      if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
      }
      [System.IO.File]::AppendAllText($LogPath, $line + "`r`n", $utf8)
    } catch {
      if (-not $Quiet) { Write-Host ("[guard] log write failed: " + $_.Exception.Message) }
    }
  }
}

# ---------------------------------------------------------------- Win32 声明
if (-not ("DreamEngineGuard2.Win32" -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace DreamEngineGuard2 {
  public static class Win32 {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    public const uint WM_KEYDOWN = 0x0100;
    public const uint WM_KEYUP = 0x0101;
    public const int VK_RETURN = 0x0D;

    public static string TextOf(IntPtr hWnd) {
      StringBuilder sb = new StringBuilder(512);
      GetWindowText(hWnd, sb, sb.Capacity);
      return sb.ToString();
    }

    public static string ClassOf(IntPtr hWnd) {
      StringBuilder sb = new StringBuilder(256);
      GetClassName(hWnd, sb, sb.Capacity);
      return sb.ToString();
    }

    public static string SizeOf(IntPtr hWnd) {
      RECT r;
      if (!GetWindowRect(hWnd, out r)) return "?";
      return (r.Right - r.Left) + "x" + (r.Bottom - r.Top);
    }

    public static List<IntPtr> VisibleTopWindows() {
      List<IntPtr> list = new List<IntPtr>();
      EnumWindows(delegate(IntPtr h, IntPtr l) {
        if (IsWindowVisible(h)) list.Add(h);
        return true;
      }, IntPtr.Zero);
      return list;
    }

    public static uint PidOf(IntPtr hWnd) {
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      return pid;
    }

    // 自绘对话框的内容容器：类名含 DroverLord 的直接子窗口
    public static bool HasDroverLordChild(IntPtr hWnd) {
      bool found = false;
      EnumChildWindows(hWnd, delegate(IntPtr h, IntPtr l) {
        if (found) return false;
        string cls = ClassOf(h);
        if (cls.IndexOf("DroverLord", StringComparison.OrdinalIgnoreCase) >= 0) { found = true; return false; }
        return true;
      }, IntPtr.Zero);
      return found;
    }

    public static bool SendEnter(IntPtr hWnd) {
      bool down = PostMessage(hWnd, WM_KEYDOWN, new IntPtr(VK_RETURN), new IntPtr(0x001C0001));
      System.Threading.Thread.Sleep(40);
      bool up = PostMessage(hWnd, WM_KEYUP, new IntPtr(VK_RETURN), unchecked((IntPtr)(int)0xC01C0001));
      return down && up;
    }
  }
}
'@ -Language CSharp
}

# ---------------------------------------------------------------- 单实例
$mutex = $null
if ($Singleton) {
  $mutex = New-Object System.Threading.Mutex($false, "DreamEngineAeCrashGuard")
  if (-not $mutex.WaitOne(0)) {
    Write-GuardLog "another guard instance is running, exit"
    exit 0
  }
}

Write-GuardLog ("guard start: processes=" + ($ProcessNames -join ",") + " interval=" + $IntervalMs + "ms timeout=" + $TimeoutSec + "s dryRun=" + [bool]$DryRun)
try { [void][DreamEngineGuard2.Win32]::SetProcessDPIAware() } catch { }

$titleRegex = $null
try { $titleRegex = New-Object System.Text.RegularExpressions.Regex($TitlePattern, "IgnoreCase") } catch { }

$handled = 0
while ($true) {
  $elapsed = ((Get-Date) - $script:startedAt).TotalSeconds
  if ($elapsed -ge $TimeoutSec) {
    Write-GuardLog ("guard stop: timeout after " + [int]$elapsed + "s, enter sent " + $handled + " time(s)")
    break
  }

  $targetPids = @()
  foreach ($name in $ProcessNames) {
    foreach ($proc in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
      $targetPids += [uint32]$proc.Id
    }
  }
  $targetPids = @($targetPids | Sort-Object -Unique)

  foreach ($hWnd in [DreamEngineGuard2.Win32]::VisibleTopWindows()) {
    $winPid = [DreamEngineGuard2.Win32]::PidOf($hWnd)
    if ($targetPids -notcontains $winPid) { continue }
    if ([DreamEngineGuard2.Win32]::ClassOf($hWnd) -ne "#32770") { continue }

    # 标题命中关键词是强特征；真实「崩溃修复选项」标题为空，
    # 这时必须再确认窗口里有 Adobe 组件容器（DroverLord），不能只看类名。
    $title = [DreamEngineGuard2.Win32]::TextOf($hWnd)
    $matched = $false
    $reason = ""
    if ($titleRegex -and $title -and $titleRegex.IsMatch($title)) {
      $matched = $true
      $reason = "title"
    } elseif (-not $title -and [DreamEngineGuard2.Win32]::HasDroverLordChild($hWnd)) {
      $matched = $true
      $reason = "empty-title+droverlord"
    }
    if (-not $matched) { continue }

    $key = $hWnd.ToInt64().ToString()
    $now = (Get-Date).ToUniversalTime()
    if ($script:pressed.ContainsKey($key)) {
      $last = $script:pressed[$key]
      if (($now - $last).TotalMilliseconds -lt $CooldownMs) { continue }
    }
    $script:pressed[$key] = $now

    Write-GuardLog ("dialog detected: hwnd=" + $key + " pid=" + $pidOfWin + " title='" + $title + "' size=" + [DreamEngineGuard2.Win32]::SizeOf($hWnd) + " match=" + $reason)
    if ($DryRun) {
      Write-GuardLog ("dry-run: would send Enter to hwnd=" + $key)
      continue
    }
    $sent = [DreamEngineGuard2.Win32]::SendEnter($hWnd)
    if (-not $sent) {
      Write-GuardLog ("send Enter failed: hwnd=" + $key)
      continue
    }
    $handled++
    Start-Sleep -Milliseconds 700
    $stillOpen = [DreamEngineGuard2.Win32]::IsWindow($hWnd)
    if ($stillOpen) {
      Write-GuardLog ("Enter sent but dialog still open: hwnd=" + $key)
    } else {
      Write-GuardLog ("Enter sent, dialog dismissed: hwnd=" + $key)
    }
  }

  if ($Once) {
    Write-GuardLog ("guard stop: single pass done, enter sent " + $handled + " time(s)")
    break
  }
  Start-Sleep -Milliseconds $IntervalMs
}

if ($mutex) {
  try { $mutex.ReleaseMutex() } catch { }
  $mutex.Dispose()
}
exit 0
