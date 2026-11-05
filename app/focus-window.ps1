# Bring the terminal that hosts a Claude Code session to the foreground, and select its
# Windows Terminal tab when the tab title matches the session title.
# Input comes from the environment so no value is ever parsed as a command line:
#   CARDS_CHAIN  pid:name pairs from the claude process upward, comma separated
#   CARDS_TITLE  session title, optional
#   CARDS_HWND   window handle to focus directly, instead of searching CARDS_CHAIN
# Exit codes: 0 focused, 2 no window found, 3 window found but Windows refused the focus change.
$ErrorActionPreference = 'Stop'

Add-Type -Namespace CardsNative -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
'@

$target = $null
$hwnd = [IntPtr]::Zero
if ($env:CARDS_HWND) { $hwnd = [IntPtr]::new([long]$env:CARDS_HWND) }
foreach ($pair in ($env:CARDS_CHAIN -split ',')) {
    $parts = $pair -split ':', 2
    $processId = 0
    if ($parts.Count -ne 2 -or -not [int]::TryParse($parts[0], [ref]$processId)) { continue }
    # A pid can be reused after the process exits, so the name has to match as well.
    $proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($proc -and ("$($proc.ProcessName).exe" -ieq $parts[1]) -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
        $target = $proc
        break
    }
}
if ($target) { $hwnd = $target.MainWindowHandle }
if ($hwnd -eq [IntPtr]::Zero) { exit 2 }

if ($env:CARDS_HWND -and [CardsNative.Win32]::GetForegroundWindow() -eq $hwnd) { exit 0 }

if ([CardsNative.Win32]::IsIconic($hwnd)) { [void][CardsNative.Win32]::ShowWindow($hwnd, 9) }

if ($env:CARDS_TITLE -and $target -and $target.ProcessName -eq 'WindowsTerminal') {
    try {
        Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
        $root = [Windows.Automation.AutomationElement]::FromHandle($hwnd)
        $isTab = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::TabItem)
        foreach ($tab in $root.FindAll([Windows.Automation.TreeScope]::Descendants, $isTab)) {
            # Claude Code prefixes the title with a spinner character, so match on containment.
            if ($tab.Current.Name.Contains($env:CARDS_TITLE)) {
                $tab.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select()
                break
            }
        }
    } catch {
        # Tab selection is best effort: still bring the window forward.
    }
}

# Windows only lets the foreground process hand over focus. A synthetic Alt press lifts that lock.
[CardsNative.Win32]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[CardsNative.Win32]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[void][CardsNative.Win32]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 80
if ([CardsNative.Win32]::GetForegroundWindow() -ne $hwnd) { exit 3 }
exit 0
