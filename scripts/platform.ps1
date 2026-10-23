param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Payload = "e30="
)

# Ibwedu platform helper for the DSH plugin.
#
# The script is invoked as:  powershell -NoProfile -ExecutionPolicy Bypass -File platform.ps1 -Action <name> -Payload <base64 JSON>
# and always prints exactly one JSON object to stdout. Keep this file ASCII-safe
# at the syntax level, but the Chinese UI strings below are real literals, so the
# file must keep its UTF-8 BOM for Windows PowerShell 5.1 to decode it correctly.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

Add-Type -AssemblyName System.Windows.Forms, System.Drawing, UIAutomationClient, UIAutomationTypes

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class IbwWin32 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@ | Out-Null

[IbwWin32]::SetProcessDPIAware() | Out-Null

$Options = @{}
if ($Payload) {
  try {
    $raw = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Payload))
    if ($raw.Trim().Length -gt 0) {
      $parsed = $raw | ConvertFrom-Json
      if ($parsed -ne $null) { $Options = $parsed }
    }
  } catch {
    # An unreadable payload simply means "no options".
  }
}

function Get-Opt([string]$Name, $Default = $null) {
  if ($Options -eq $null) { return $Default }
  $property = $Options.PSObject.Properties[$Name]
  if ($property -eq $null) { return $Default }
  if ($property.Value -eq $null) { return $Default }
  return $property.Value
}

$processFilter = [string](Get-Opt "process" "msedge")

function Get-WindowLists {
  $list = New-Object System.Collections.ArrayList
  foreach ($process in (Get-Process -ErrorAction SilentlyContinue)) {
    if (-not $process.MainWindowTitle) { continue }
    if ($process.MainWindowHandle -eq [IntPtr]::Zero) { continue }
    $rect = New-Object IbwWin32+RECT
    $bounds = $null
    try {
      if ([IbwWin32]::GetWindowRect($process.MainWindowHandle, [ref]$rect)) {
        $bounds = [pscustomobject]@{
          x = $rect.Left; y = $rect.Top
          width = [int](($rect.Right - $rect.Left))
          height = [int](($rect.Bottom - $rect.Top))
        }
      }
    } catch { }
    [void]$list.Add([pscustomobject]@{
      pid = $process.Id
      process = $process.ProcessName
      title = $process.MainWindowTitle
      handle = [string]$process.MainWindowHandle
      bounds = $bounds
    })
  }
  return @($list.ToArray())
}

function Find-ProcessByWindowTitle([string]$Pattern, [string]$ProcessName) {
  foreach ($process in (Get-Process -ErrorAction SilentlyContinue)) {
    if (-not $process.MainWindowTitle) { continue }
    if ($ProcessName -and $process.ProcessName -ine $ProcessName) { continue }
    if ($Pattern -and $process.MainWindowTitle -notlike "*$Pattern*") { continue }
    return $process
  }
  return $null
}

function Get-WindowElement($Process) {
  if ($Process -eq $null) { return $null }
  return [System.Windows.Automation.AutomationElement]::FromHandle($Process.MainWindowHandle)
}

function Find-DescendantByName($Root, [string]$Name) {
  $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $Name)
  return $Root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

function Get-ControlType([string]$Name) {
  $field = [System.Windows.Automation.ControlType].GetField($Name)
  if ($field -eq $null) { throw "unknown control type $Name" }
  return $field.GetValue($null)
}

function Find-DescendantByContains($Root, [string]$Text, [string]$ControlTypeName) {
  if ($ControlTypeName) {
    $type = Get-ControlType $ControlTypeName
    $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $type)
    $elements = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    foreach ($element in $elements) {
      if ($element.Current.Name -like "*$Text*") { return $element }
    }
    return $null
  }
  $all = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($element in $all) {
    if ($element.Current.Name -like "*$Text*") { return $element }
  }
  return $null
}

function Get-ElementInfo($Element) {
  if ($Element -eq $null) { return $null }
  $rect = New-Object System.Windows.Rect
  try { $rect = $Element.Current.BoundingRectangle } catch { }
  $x = 0; $y = 0; $width = 0; $height = 0
  try {
    if (-not [double]::IsInfinity($rect.X)) { $x = [int]$rect.X; $y = [int]$rect.Y; $width = [int]$rect.Width; $height = [int]$rect.Height }
  } catch { }
  return [pscustomobject]@{
    name = $Element.Current.Name
    type = $Element.Current.ControlType.ProgrammaticName
    automationId = $Element.Current.AutomationId
    enabled = $Element.Current.IsEnabled
    offscreen = $Element.Current.IsOffscreen
    rect = [pscustomobject]@{ x = $x; y = $y; width = $width; height = $height }
  }
}

function Click-Point([int]$X, [int]$Y, [bool]$Double = $false) {
  [IbwWin32]::SetCursorPos($X, $Y) | Out-Null
  Start-Sleep -Milliseconds 120
  [IbwWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [IbwWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  if ($Double) {
    Start-Sleep -Milliseconds 70
    [IbwWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [IbwWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  }
}

function Invoke-Element($Element) {
  if ($Element -eq $null) { throw "element not found" }
  try {
    $pattern = $Element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
    return "invoke"
  } catch { }
  try {
    $pattern = $Element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    $pattern.Select()
    return "select"
  } catch { }
  try {
    $pattern = $Element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
    $pattern.Toggle()
    return "toggle"
  } catch { }
  $info = Get-ElementInfo $Element
  if ($info.rect.width -gt 0 -and $info.rect.height -gt 0) {
    Click-Point ($info.rect.x + [int]($info.rect.width / 2)) ($info.rect.y + [int]($info.rect.height / 2)) $false
    return "mouse"
  }
  throw "element is not invokable and has no on-screen rectangle"
}

function Invoke-ByName($Root, [string]$Name, [string]$ControlTypeName) {
  $element = Find-DescendantByName $Root $Name
  if ($element -eq $null -and $ControlTypeName) { $element = Find-DescendantByContains $Root $Name $ControlTypeName }
  if ($element -eq $null) { return $null }
  $info = Get-ElementInfo $element
  $how = Invoke-Element $element
  return [pscustomobject]@{ invoked = $how; element = $info }
}

function Get-TextElements($Root, [int]$Limit) {
  $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
  $elements = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  $seen = New-Object 'System.Collections.Generic.HashSet[string]'
  $texts = New-Object System.Collections.ArrayList
  foreach ($element in $elements) {
    $name = $element.Current.Name
    if (-not $name) { continue }
    $name = $name.Trim()
    if ($name.Length -eq 0) { continue }
    if ($seen.Add($name)) { [void]$texts.Add($name) }
    if ($texts.Count -ge $Limit) { break }
  }
  return @($texts.ToArray())
}

function Save-ScreenShot([string]$Path, $Crop = $null) {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bitmap.Size)
    if ($Crop -ne $null) {
      $left = [int]$Crop.x
      $top = [int]$Crop.y
      $width = [int]$Crop.width
      $height = [int]$Crop.height
      if ($left -lt 0) { $left = 0 }
      if ($top -lt 0) { $top = 0 }
      if ($left + $width -gt $bounds.Width) { $width = $bounds.Width - $left }
      if ($top + $height -gt $bounds.Height) { $height = $bounds.Height - $top }
      if ($width -lt 1 -or $height -lt 1) { throw "crop is outside the virtual screen" }
      $region = New-Object System.Drawing.Rectangle $left, $top, $width, $height
      $cropped = $bitmap.Clone($region, $bitmap.PixelFormat)
      try { $cropped.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $cropped.Dispose() }
      return [pscustomobject]@{ path = $Path; width = $width; height = $height; x = $bounds.X + $left; y = $bounds.Y + $top; cropped = $true }
    }
    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
  return [pscustomobject]@{ path = $Path; width = $bounds.Width; height = $bounds.Height; x = $bounds.X; y = $bounds.Y; cropped = $false }
}

function Wait-UntilText($Root, [string]$Needle, [int]$TimeoutMs) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  while ([DateTime]::UtcNow -lt $deadline) {
    $texts = Get-TextElements $Root 400
    foreach ($text in $texts) {
      if ($text -like "*$Needle*") { return [pscustomobject]@{ found = $true; text = $text } }
    }
    Start-Sleep -Milliseconds 700
  }
  return [pscustomobject]@{ found = $false; text = $null }
}

$result = $null
try {
  switch ($Action) {
    "windows" {
      $result = [pscustomobject]@{ ok = $true; windows = (Get-WindowLists) }
    }
    "focus" {
      $title = [string](Get-Opt "title" "")
      $process = Find-ProcessByWindowTitle $title $processFilter
      if ($process -eq $null) { throw "no window title matches ""$title""" }
      if ([IbwWin32]::IsIconic($process.MainWindowHandle)) { [IbwWin32]::ShowWindow($process.MainWindowHandle, 9) | Out-Null }
      [IbwWin32]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
      Start-Sleep -Milliseconds 400
      $rect = New-Object IbwWin32+RECT
      [IbwWin32]::GetWindowRect($process.MainWindowHandle, [ref]$rect) | Out-Null
      $result = [pscustomobject]@{
        ok = $true; title = $process.MainWindowTitle; pid = $process.Id
        bounds = [pscustomobject]@{ x = $rect.Left; y = $rect.Top; width = [int]($rect.Right - $rect.Left); height = [int]($rect.Bottom - $rect.Top) }
      }
    }
    "shot" {
      $path = [string](Get-Opt "path" "")
      if ($path.Length -eq 0) { throw "shot requires a path" }
      $result = Save-ScreenShot $path (Get-Opt "crop" $null)
      $result = [pscustomobject]@{ ok = $true; screenshot = $result }
    }
    "click" {
      Click-Point ([int](Get-Opt "x" 0)) ([int](Get-Opt "y" 0)) $false
      $result = [pscustomobject]@{ ok = $true; clicked = @([int](Get-Opt "x" 0), [int](Get-Opt "y" 0)) }
    }
    "dblclick" {
      Click-Point ([int](Get-Opt "x" 0)) ([int](Get-Opt "y" 0)) $true
      $result = [pscustomobject]@{ ok = $true; doubleClicked = @([int](Get-Opt "x" 0), [int](Get-Opt "y" 0)) }
    }
    "move" {
      [IbwWin32]::SetCursorPos([int](Get-Opt "x" 0), [int](Get-Opt "y" 0)) | Out-Null
      $result = [pscustomobject]@{ ok = $true; moved = @([int](Get-Opt "x" 0), [int](Get-Opt "y" 0)) }
    }
    "wheel" {
      $x = [int](Get-Opt "x" 0)
      $y = [int](Get-Opt "y" 0)
      $delta = [int](Get-Opt "delta" 3)
      [IbwWin32]::SetCursorPos($x, $y) | Out-Null
      Start-Sleep -Milliseconds 120
      $step = 120
      if ($delta -lt 0) { $step = -120 }
      $notches = [Math]::Abs($delta)
      for ($i = 0; $i -lt $notches; $i++) {
        [IbwWin32]::mouse_event(0x0800, 0, 0, $step, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 40
      }
      $result = [pscustomobject]@{ ok = $true; wheel = @($x, $y, $delta) }
    }
    "type" {
      [System.Windows.Forms.SendKeys]::SendWait([string](Get-Opt "text" ""))
      $result = [pscustomobject]@{ ok = $true; typed = [string](Get-Opt "text" "") }
    }
    "paste" {
      Set-Clipboard -Value ([string](Get-Opt "text" ""))
      Start-Sleep -Milliseconds 200
      $chord = [string](Get-Opt "chord" "^v")
      [System.Windows.Forms.SendKeys]::SendWait($chord)
      $result = [pscustomobject]@{ ok = $true; pasted = $true; chord = $chord }
    }
    "open-url" {
      $url = [string](Get-Opt "url" "")
      if ($url.Length -eq 0) { throw "open-url requires url" }
      $process = Find-ProcessByWindowTitle $title $processFilter
      if ($process -eq $null) { throw "no window title matches ""$title"" for process ""$processFilter""" }
      [IbwWin32]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
      Start-Sleep -Milliseconds 400
      [System.Windows.Forms.SendKeys]::SendWait("^t")
      Start-Sleep -Milliseconds 700
      Set-Clipboard -Value $url
      Start-Sleep -Milliseconds 150
      [System.Windows.Forms.SendKeys]::SendWait("^v")
      Start-Sleep -Milliseconds 350
      [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
      Start-Sleep -Milliseconds 800
      $result = [pscustomobject]@{ ok = $true; url = $url; window = $process.MainWindowTitle }
    }
    "key" {
      [System.Windows.Forms.SendKeys]::SendWait([string](Get-Opt "keys" ""))
      $result = [pscustomobject]@{ ok = $true; keys = [string](Get-Opt "keys" "") }
    }
    "uia-find" {
      $title = [string](Get-Opt "title" "")
      $name = [string](Get-Opt "name" "")
      if ($name.Length -eq 0) { throw "uia-find requires name" }
      $limit = [int](Get-Opt "limit" 20)
      $process = Find-ProcessByWindowTitle $title $processFilter
      if ($process -eq $null) { throw "no window title matches ""$title""" }
      $root = Get-WindowElement $process
      $conditions = @()
      foreach ($typeName in @("Button", "Hyperlink", "Text", "ListItem", "TabItem", "MenuItem", "CheckBox", "RadioButton", "Edit")) {
        $conditions += New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, (Get-ControlType $typeName))
      }
      $condition = New-Object System.Windows.Automation.OrCondition -ArgumentList (, $conditions)
      $elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
      $found = New-Object System.Collections.ArrayList
      foreach ($element in $elements) {
        $elementName = $element.Current.Name
        if (-not $elementName) { continue }
        if ($elementName -notlike "*$name*") { continue }
        [void]$found.Add((Get-ElementInfo $element))
        if ($found.Count -ge $limit) { break }
      }
      $result = [pscustomobject]@{ ok = $true; window = $process.MainWindowTitle; count = $found.Count; matches = @($found.ToArray()) }
    }
    "uia-click" {
      $title = [string](Get-Opt "title" "")
      $name = [string](Get-Opt "name" "")
      if ($name.Length -eq 0) { throw "uia-click requires name" }
      $controlType = Get-Opt "controlType" $null
      $process = Find-ProcessByWindowTitle $title $processFilter
      if ($process -eq $null) { throw "no window title matches ""$title""" }
      $root = Get-WindowElement $process
      $outcome = Invoke-ByName $root $name $controlType
      if ($outcome -eq $null) { throw "no UI Automation element named like ""$name"" in ""$($process.MainWindowTitle)""" }
      $result = [pscustomobject]@{ ok = $true; window = $process.MainWindowTitle; invoked = $outcome.invoked; element = $outcome.element }
    }
    "uia-texts" {
      $title = [string](Get-Opt "title" "")
      $limit = [int](Get-Opt "limit" 200)
      $process = Find-ProcessByWindowTitle $title $processFilter
      if ($process -eq $null) { throw "no window title matches ""$title""" }
      $root = Get-WindowElement $process
      $texts = Get-TextElements $root $limit
      $result = [pscustomobject]@{ ok = $true; window = $process.MainWindowTitle; count = $texts.Count; texts = $texts }
    }
    "select-tab" {
      $title = [string](Get-Opt "title" "")
      $name = [string](Get-Opt "name" "")
      if ($name.Length -eq 0) { throw "select-tab requires name" }
      $process = Find-ProcessByWindowTitle $title $processFilter
      if ($process -eq $null) { throw "no window title matches ""$title""" }
      $root = Get-WindowElement $process
      $outcome = Invoke-ByName $root $name "TabItem"
      if ($outcome -eq $null) { throw "no tab named like ""$name"" in ""$($process.MainWindowTitle)""" }
      Start-Sleep -Milliseconds 2500
      $result = [pscustomobject]@{ ok = $true; window = $process.MainWindowTitle; invoked = $outcome.invoked; element = $outcome.element }
    }
    "wait-text" {
      $title = [string](Get-Opt "title" "")
      $needle = [string](Get-Opt "text" "")
      if ($needle.Length -eq 0) { throw "wait-text requires text" }
      $timeout = [int](Get-Opt "timeoutMs" 20000)
      $process = Find-ProcessByWindowTitle $title $processFilter
      if ($process -eq $null) { throw "no window title matches ""$title""" }
      $root = Get-WindowElement $process
      $found = Wait-UntilText $root $needle $timeout
      $result = [pscustomobject]@{ ok = $true; found = $found.found; text = $found.text; window = $process.MainWindowTitle }
    }
    "complete-experiment" {
      $title = [string](Get-Opt "title" "")
      $steps = New-Object System.Collections.ArrayList
      $process = Find-ProcessByWindowTitle $title $processFilter
      if ($process -eq $null) { throw "no window title matches ""$title""" }
      $root = Get-WindowElement $process
      [void]$steps.Add("window: " + $process.MainWindowTitle)
      $button = Find-DescendantByName $root "图标: check-circle-o 完成实验"
      if ($button -eq $null) { $button = Find-DescendantByContains $root "完成实验" "Button" }
      if ($button -eq $null) { throw "the 完成实验 button was not found; load the experiment page first" }
      [void]$steps.Add("complete button: " + (Get-ElementInfo $button).name)
      $how = Invoke-Element $button
      [void]$steps.Add("invoked via $how")
      Start-Sleep -Milliseconds 1200
      # The platform shows an in-page modal whose 确定 button lives in the page tree,
      # not a separate top-level window; poll the page first, then fall back to a window.
      $confirm = $null
      $deadline = [DateTime]::UtcNow.AddMilliseconds(25000)
      while ([DateTime]::UtcNow -lt $deadline -and $confirm -eq $null) {
        $confirm = Find-DescendantByName $root "确定"
        if ($confirm -eq $null) { $confirm = Find-DescendantByContains $root "确定" "Button" }
        if ($confirm -eq $null) {
          $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "完成实验")
          $dialog = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
          if ($dialog -ne $null) {
            $confirm = Find-DescendantByName $dialog "确定"
            if ($confirm -eq $null) { $confirm = Find-DescendantByContains $dialog "确定" "Button" }
          }
        }
        if ($confirm -eq $null) { Start-Sleep -Milliseconds 300 }
      }
      if ($confirm -ne $null) {
        $dialogHow = Invoke-Element $confirm
        [void]$steps.Add("confirmed via $dialogHow")
      } else {
        [void]$steps.Add("no confirmation button appeared")
      }
      $found = Wait-UntilText $root "你已成功完成此实验" 20000
      if ($found.found) { [void]$steps.Add("success text: " + $found.text) }
      else { [void]$steps.Add("success text not observed within 20s") }
      $result = [pscustomobject]@{
        ok = $true
        completed = $found.found
        steps = @($steps.ToArray())
        window = $process.MainWindowTitle
      }
    }
    "texts-after" {
      $title = [string](Get-Opt "title" "")
      $process = Find-ProcessByWindowTitle $title $processFilter
      if ($process -eq $null) { throw "no window title matches ""$title""" }
      $texts = Get-TextElements (Get-WindowElement $process) 300
      $result = [pscustomobject]@{ ok = $true; window = $process.MainWindowTitle; texts = $texts }
    }
    default {
      throw "unknown action $Action"
    }
  }
} catch {
  $message = $_.Exception.Message
  $result = [pscustomobject]@{ ok = $false; error = $message; action = $Action }
  [Console]::Out.Write(($result | ConvertTo-Json -Compress -Depth 8))
  exit 2
}

[Console]::Out.Write(($result | ConvertTo-Json -Compress -Depth 8))
exit 0
