# Shared After Effects native-dialog watchdog.
# AE export failures block RenderQueue.render() with a Win32 modal dialog, so
# ExtendScript cannot catch them. Callers use Get-AEDialogInfo from their render
# loop and terminate only the dedicated AE instance.

$script:CanWatchAEDialogs = $true
if (-not ("DreamEngineNativeWindows" -as [type])) {
  try {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class DreamEngineNativeWindows {
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr lParam);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);

  public static string FindDialog(int processId) {
    string found = null;
    EnumWindows(delegate(IntPtr hWnd, IntPtr ignored) {
      if (!IsWindowVisible(hWnd)) return true;
      uint owner;
      GetWindowThreadProcessId(hWnd, out owner);
      if (owner != (uint)processId) return true;

      StringBuilder className = new StringBuilder(256);
      GetClassName(hWnd, className, className.Capacity);
      if (!String.Equals(className.ToString(), "#32770", StringComparison.Ordinal)) return true;

      StringBuilder title = new StringBuilder(1024);
      GetWindowText(hWnd, title, title.Capacity);
      StringBuilder body = new StringBuilder();
      EnumChildWindows(hWnd, delegate(IntPtr child, IntPtr childIgnored) {
        StringBuilder text = new StringBuilder(4096);
        GetWindowText(child, text, text.Capacity);
        if (text.Length > 0) {
          if (body.Length > 0) body.Append(" ");
          body.Append(text.ToString());
        }
        return true;
      }, IntPtr.Zero);
      found = title.ToString() + "\t" + body.ToString();
      return false;
    }, IntPtr.Zero);
    return found;
  }

  public static bool CloseDialog(int processId) {
    bool closed = false;
    EnumWindows(delegate(IntPtr hWnd, IntPtr ignored) {
      if (!IsWindowVisible(hWnd)) return true;
      uint owner;
      GetWindowThreadProcessId(hWnd, out owner);
      if (owner != (uint)processId) return true;
      StringBuilder className = new StringBuilder(256);
      GetClassName(hWnd, className, className.Capacity);
      if (!String.Equals(className.ToString(), "#32770", StringComparison.Ordinal)) return true;
      bool clicked = false;
      EnumChildWindows(hWnd, delegate(IntPtr child, IntPtr childIgnored) {
        StringBuilder childClass = new StringBuilder(256);
        GetClassName(child, childClass, childClass.Capacity);
        if (!String.Equals(childClass.ToString(), "Button", StringComparison.OrdinalIgnoreCase)) return true;
        StringBuilder text = new StringBuilder(256);
        GetWindowText(child, text, text.Capacity);
        string label = text.ToString();
        if (String.Equals(label, "OK", StringComparison.OrdinalIgnoreCase) ||
            label == "确定" || label == "是") {
          // BM_CLICK：直接点击标准按钮，避免不同语言的按钮 ID 差异。
          PostMessage(child, 0x00F5, IntPtr.Zero, IntPtr.Zero);
          clicked = true;
          return false;
        }
        return true;
      }, IntPtr.Zero);
      if (!clicked) PostMessage(hWnd, 0x0111, new IntPtr(1), IntPtr.Zero);
      closed = true;
      return false;
    }, IntPtr.Zero);
    return closed;
  }
}
'@
  } catch {
    $script:CanWatchAEDialogs = $false
    Write-Host "[提示] 当前 PowerShell 禁止编译 Win32 检测器，将退化为超时跳过。" -ForegroundColor Yellow
  }
}

function Get-AEDialogInfo {
  if (-not $script:CanWatchAEDialogs) { return $null }
  foreach ($process in @(Get-Process -Name AfterFX -ErrorAction SilentlyContinue)) {
    try {
      $raw = [DreamEngineNativeWindows]::FindDialog($process.Id)
    } catch {
      continue
    }
    if (-not $raw) { continue }
    $parts = $raw -split "`t", 2
    $title = [string]$parts[0]
    $text = if ($parts.Count -ge 2) { [string]$parts[1] } else { "" }
    $combined = $title + " " + $text
    $isWarning = $combined -match '(?i)警告|warning'
    $isError = $combined -match '(?i)错误|error|无法|failed|failure|意外|unexpected|cannot|can''t|不能|AEGP|PNGIO|输入文件|5027'
    if ($isWarning -or $isError) {
      return [pscustomobject]@{
        ProcessId = $process.Id
        Title = $title
        Text = $text
        Severity = if ($isError) { "error" } else { "warning" }
      }
    }
  }
  return $null
}

function Close-AEDialogInfo {
  param([int]$ProcessId)
  if (-not $script:CanWatchAEDialogs -or $ProcessId -le 0) { return $false }
  try {
    return [DreamEngineNativeWindows]::CloseDialog($ProcessId)
  } catch {
    return $false
  }
}

function Get-UnfinishedBeginPaths {
  param([string[]]$Lines)

  $pending = @{}
  $order = New-Object System.Collections.ArrayList
  foreach ($line in @($Lines)) {
    $parts = [string]$line -split '\|', 3
    $kind = [string]$parts[0]
    $name = if ($parts.Count -ge 2) { [string]$parts[1] } else { "" }
    if (-not $name) { continue }
    if ($kind -eq "BEGIN") {
      if (-not $pending.ContainsKey($name)) { [void]$order.Add($name) }
      $pending[$name] = $true
    } elseif ($kind -eq "OK" -or $kind -eq "FAIL" -or $kind -eq "SKIP") {
      if ($pending.ContainsKey($name)) { $pending.Remove($name) }
    }
  }
  return @($order | Where-Object { $pending.ContainsKey([string]$_) } | ForEach-Object { [string]$_ })
}
