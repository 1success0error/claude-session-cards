# Report the foreground Windows Terminal window, so a finished session stops flashing once the
# user switches to its tab. The window title of Windows Terminal is the title of the selected tab.
# One line per change: <window handle> TAB <terminal process id> TAB <title as UTF-8 base64>.
# A window that is not Windows Terminal is reported as "0 TAB 0 TAB".
# Only window titles are read, no tab contents. Exits when CARDS_PARENT is gone.
$ErrorActionPreference = 'Stop'

Add-Type -Namespace CardsNative -Name Foreground -UsingNamespace System.Text -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int processId);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder name, int size);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int size);
'@

$parent = [int]$env:CARDS_PARENT
$last = $null
$tick = 0
while ($true) {
    $hwnd = [CardsNative.Foreground]::GetForegroundWindow()
    $line = "0`t0`t"
    if ($hwnd -ne [IntPtr]::Zero) {
        $class = New-Object System.Text.StringBuilder 64
        [void][CardsNative.Foreground]::GetClassName($hwnd, $class, $class.Capacity)
        if ($class.ToString() -eq 'CASCADIA_HOSTING_WINDOW_CLASS') {
            $owner = 0
            [void][CardsNative.Foreground]::GetWindowThreadProcessId($hwnd, [ref]$owner)
            $text = New-Object System.Text.StringBuilder 512
            [void][CardsNative.Foreground]::GetWindowText($hwnd, $text, $text.Capacity)
            $title = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text.ToString()))
            $line = "$hwnd`t$owner`t$title"
        }
    }
    if ($line -ne $last) {
        [Console]::Out.WriteLine($line)
        [Console]::Out.Flush()
        $last = $line
    }
    $tick++
    if ($parent -and $tick % 20 -eq 0 -and -not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { exit 0 }
    Start-Sleep -Milliseconds 500
}
