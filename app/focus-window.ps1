# Bring the terminal that hosts a Claude Code session to the foreground, and select its
# Windows Terminal tab when the tab title matches the session title.
# Input comes from the environment so no value is ever parsed as a command line:
#   CARDS_CHAIN  pid:name pairs from the claude process upward, comma separated
#   CARDS_TITLE  session titles, one per line, optional
#   CARDS_HWND   window handle to focus directly, instead of searching CARDS_CHAIN
#   CARDS_QUERY  only report the current foreground window
#   CARDS_SESSION  session ID, used to find a resumed session by its command line
#   CARDS_DRY_RUN  report the window and tab that would be used, without switching
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
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int processId);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool on);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
'@

# Windows Terminal runs every window in one process, and MainWindowHandle is only whichever
# window was active last. Tabs have to be searched in all of them.
Add-Type -Namespace CardsNative -Name Windows -UsingNamespace System.Collections.Generic, System.Text -MemberDefinition @'
public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int processId);
[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder name, int size);
public static List<IntPtr> TerminalWindows(int processId) {
    var found = new List<IntPtr>();
    EnumWindows((hWnd, _) => {
        int owner;
        GetWindowThreadProcessId(hWnd, out owner);
        var name = new StringBuilder(64);
        GetClassName(hWnd, name, name.Capacity);
        if (owner == processId && IsWindowVisible(hWnd) && name.ToString() == "CASCADIA_HOSTING_WINDOW_CLASS") found.Add(hWnd);
        return true;
    }, IntPtr.Zero);
    return found;
}
'@

$foreground = [CardsNative.Win32]::GetForegroundWindow()
"previous=$foreground"
if ($env:CARDS_QUERY) { exit 0 }

$target = $null
$hwnd = [IntPtr]::Zero
if ($env:CARDS_HWND) { $hwnd = [IntPtr]::new([long]$env:CARDS_HWND) }
$running = $false

$titles = @(($env:CARDS_TITLE -split "`n") | Where-Object { $_ })
function Test-TabTitle([string]$name) {
    foreach ($title in $titles) { if ($name.Contains($title)) { return $true } }
    return $false
}

$tabHit = $null
# Claude Code prefixes the title with a spinner character, so match on containment.
function Find-TerminalTab([System.Diagnostics.Process]$terminal) {
    if (-not $titles -or $terminal.ProcessName -ne 'WindowsTerminal') { return $null }
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $isTab = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::TabItem)
    foreach ($window in [CardsNative.Windows]::TerminalWindows($terminal.Id)) {
        $root = [Windows.Automation.AutomationElement]::FromHandle($window)
        foreach ($tab in $root.FindAll([Windows.Automation.TreeScope]::Descendants, $isTab)) {
            if (Test-TabTitle $tab.Current.Name) { return [pscustomobject]@{ Window = $window; Tab = $tab } }
        }
    }
    return $null
}

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
        $tabHit = Find-TerminalTab $terminal
        if ($tabHit) { $target = $terminal; $running = $true; break }
    }
}

if ($target) {
    if (-not $tabHit) { $tabHit = Find-TerminalTab $target }
    # Use the window that holds the tab; otherwise fall back to the main window, which at least brings the terminal forward.
    $hwnd = if ($tabHit) { $tabHit.Window } else { $target.MainWindowHandle }
}
if ($hwnd -eq [IntPtr]::Zero) { if ($running) { exit 4 } else { exit 2 } }

if ($env:CARDS_DRY_RUN) {
    "window=$hwnd tab=$(if ($tabHit) { $tabHit.Tab.Current.Name } else { '(none)' })"
    exit 0
}

if ([CardsNative.Win32]::IsIconic($hwnd)) { [void][CardsNative.Win32]::ShowWindow($hwnd, 9) }

if ($tabHit) {
    try {
        # Selecting a tab that is already selected moves keyboard focus onto the tab header.
        $selection = $tabHit.Tab.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)
        if (-not $selection.Current.IsSelected) { $selection.Select() }
    } catch {
        # Tab selection is best effort: still bring the window forward.
    }
}

# Never inject keystrokes here: a synthetic Alt press left the Chinese IME without a candidate
# window in the terminal until focus moved away and back.
# The IME only works while the terminal control has keyboard focus. If focus lands anywhere else,
# such as the tab header, the candidate window stays hidden until focus moves away and back.
function Restore-TerminalFocus {
    $processId = 0
    [void][CardsNative.Win32]::GetWindowThreadProcessId($hwnd, [ref]$processId)
    $proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if (-not $proc -or $proc.ProcessName -ne 'WindowsTerminal') { return }
    try {
        Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
        Start-Sleep -Milliseconds 100
        $focused = [Windows.Automation.AutomationElement]::FocusedElement
        if ($focused -and $focused.Current.ClassName -eq 'TermControl') { return }
        $root = [Windows.Automation.AutomationElement]::FromHandle($hwnd)
        $isTerminal = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ClassNameProperty, 'TermControl')
        foreach ($control in $root.FindAll([Windows.Automation.TreeScope]::Descendants, $isTerminal)) {
            if (-not $control.Current.IsOffscreen) {
                $control.SetFocus()
                'terminal-focus=restored'
                return
            }
        }
    } catch {
        # Focus repair is best effort: the window has already been brought forward.
    }
}

function Test-Focused {
    Start-Sleep -Milliseconds 120
    return [CardsNative.Win32]::GetForegroundWindow() -eq $hwnd
}

[void][CardsNative.Win32]::SetForegroundWindow($hwnd)
if (Test-Focused) { 'method=foreground'; Restore-TerminalFocus; exit 0 }

[CardsNative.Win32]::SwitchToThisWindow($hwnd, $true)
if (Test-Focused) { 'method=switch'; Restore-TerminalFocus; exit 0 }

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
if (Test-Focused) { 'method=attach'; Restore-TerminalFocus; exit 0 }
exit 3
