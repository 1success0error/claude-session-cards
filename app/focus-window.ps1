# Bring the terminal that hosts a Claude Code session to the foreground, and select its
# Windows Terminal tab when the tab title matches the session title.
# Input comes from the environment so no value is ever parsed as a command line:
#   CARDS_CHAIN  pid:name pairs from the claude process upward, comma separated
#   CARDS_TITLE  session title, optional
#   CARDS_HWND   window handle to focus directly, instead of searching CARDS_CHAIN
#   CARDS_QUERY  only report the current foreground window
#   CARDS_SESSION  session ID, used to find a resumed session by its command line
# Exit codes: 0 focused, 2 session is not running, 3 Windows refused the focus change,
#             4 session is running but has no window we can find.
$ErrorActionPreference = 'Stop'

Add-Type -Namespace CardsNative -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool on);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
'@

$foreground = [CardsNative.Win32]::GetForegroundWindow()
"previous=$foreground"
if ($env:CARDS_QUERY) { exit 0 }

$target = $null
$hwnd = [IntPtr]::Zero
if ($env:CARDS_HWND) { $hwnd = [IntPtr]::new([long]$env:CARDS_HWND) }
$running = $false

function Find-Window([int]$processId) {
    $proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) { return $proc }
    return $null
}

# 1. The recorded process chain. If the agent process itself is gone, the terminal may still be
#    open but the session is not in it, so the rest of the chain proves nothing.
$chain = @()
foreach ($pair in ($env:CARDS_CHAIN -split ',')) {
    $parts = $pair -split ':', 2
    $processId = 0
    if ($parts.Count -eq 2 -and [int]::TryParse($parts[0], [ref]$processId)) {
        $proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
        # A pid can be reused after the process exits, so the name has to match as well.
        $alive = $proc -and ("$($proc.ProcessName).exe" -ieq $parts[1])
        $chain += [pscustomobject]@{ Id = $processId; Name = $parts[1]; Alive = $alive }
    }
}
$agent = $chain | Where-Object { $_.Name -match '^(claude|node)' } | Select-Object -First 1
if (-not $agent -or $agent.Alive) {
    if ($agent) { $running = $true }
    foreach ($item in $chain) {
        if ($item.Alive) {
            $target = Find-Window $item.Id
            if ($target) { break }
        }
    }
}

# 2. A process started with --resume <this session>, for chains recorded before the session was resumed.
if (-not $target -and $env:CARDS_SESSION) {
    $table = @{}
    Get-CimInstance Win32_Process | ForEach-Object { $table[[int]$_.ProcessId] = $_ }
    foreach ($item in $table.Values) {
        if ($item.ProcessId -ne $PID -and $item.CommandLine -like "*--resume $env:CARDS_SESSION*") {
            $running = $true
            $current = [int]$item.ProcessId
            for ($depth = 0; $depth -lt 16 -and -not $target -and $table.ContainsKey($current); $depth++) {
                $target = Find-Window $current
                $current = [int]$table[$current].ParentProcessId
            }
            if ($target) { break }
        }
    }
}

# 3. A Windows Terminal tab showing this session's title.
if (-not $target -and $env:CARDS_TITLE) {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $isTab = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::TabItem)
    foreach ($terminal in (Get-Process WindowsTerminal -ErrorAction SilentlyContinue)) {
        if ($terminal.MainWindowHandle -eq [IntPtr]::Zero) { continue }
        $root = [Windows.Automation.AutomationElement]::FromHandle($terminal.MainWindowHandle)
        foreach ($tab in $root.FindAll([Windows.Automation.TreeScope]::Descendants, $isTab)) {
            if ($tab.Current.Name.Contains($env:CARDS_TITLE)) { $target = $terminal; $running = $true; break }
        }
        if ($target) { break }
    }
}

if ($target) { $hwnd = $target.MainWindowHandle }
if ($hwnd -eq [IntPtr]::Zero) { if ($running) { exit 4 } else { exit 2 } }

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

# Never inject keystrokes here: a synthetic Alt press left the Chinese IME without a candidate
# window in the terminal until focus moved away and back.
function Test-Focused {
    Start-Sleep -Milliseconds 120
    return [CardsNative.Win32]::GetForegroundWindow() -eq $hwnd
}

[void][CardsNative.Win32]::SetForegroundWindow($hwnd)
if (Test-Focused) { 'method=foreground'; exit 0 }

[CardsNative.Win32]::SwitchToThisWindow($hwnd, $true)
if (Test-Focused) { 'method=switch'; exit 0 }

$foregroundThread = [CardsNative.Win32]::GetWindowThreadProcessId([CardsNative.Win32]::GetForegroundWindow(), [IntPtr]::Zero)
$thisThread = [CardsNative.Win32]::GetCurrentThreadId()
if ([CardsNative.Win32]::AttachThreadInput($thisThread, $foregroundThread, $true)) {
    try {
        [void][CardsNative.Win32]::BringWindowToTop($hwnd)
        [void][CardsNative.Win32]::SetForegroundWindow($hwnd)
    } finally {
        [void][CardsNative.Win32]::AttachThreadInput($thisThread, $foregroundThread, $false)
    }
}
if (Test-Focused) { 'method=attach'; exit 0 }
exit 3
