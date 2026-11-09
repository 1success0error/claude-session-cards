import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('切换窗口时不注入按键：模拟按键会让中文输入法的选词框消失', () => {
  const code = readFileSync(new URL('../app/focus-window.ps1', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  assert.doesNotMatch(code, /keybd_event|SendInput|SendKeys|SendWait/i);
});

test('焦点要留在终端控件上：选中已选中的标签会把焦点移到标签标题，输入法随之失效', () => {
  const code = readFileSync(new URL('../app/focus-window.ps1', import.meta.url), 'utf8');
  assert.match(code, /if \(-not \$selection\.Current\.IsSelected\) \{ \$selection\.Select\(\) \}/);
  assert.match(code, /'method=foreground'; Restore-TerminalFocus; exit 0/);
  assert.match(code, /'method=switch'; Restore-TerminalFocus; exit 0/);
  assert.match(code, /'method=attach'; Restore-TerminalFocus; exit 0/);
});

test('输入法选词时的回车不能提交标题', () => {
  const code = readFileSync(new URL('../app/public/app.js', import.meta.url), 'utf8');
  assert.match(code, /if \(e\.isComposing \|\| e\.keyCode === 229\) return;/);
});

test('Windows Terminal 的所有窗口都要找，不能只看主窗口', () => {
  const code = readFileSync(new URL('../app/focus-window.ps1', import.meta.url), 'utf8');
  assert.match(code, /CASCADIA_HOSTING_WINDOW_CLASS/);
  assert.doesNotMatch(code, /FromHandle\(\$terminal\.MainWindowHandle\)/);
});

test('脚本只能含 ASCII：Windows PowerShell 5 按 GBK 读无 BOM 的脚本，中文会吞掉换行，把下一行变成注释', () => {
  const code = readFileSync(new URL('../app/focus-window.ps1', import.meta.url), 'utf8');
  assert.equal([...code].filter((c) => c.charCodeAt(0) > 127).join(''), '');
});

test('没有标题的会话用控制台标题临时标记标签，并且一定恢复原标题', () => {
  const code = readFileSync(new URL('../app/focus-window.ps1', import.meta.url), 'utf8');
  assert.match(code, /AttachConsole\(\$consoleProcess\)/);
  assert.match(code, /\} finally \{\s+\[void\]\[CardsNative\.Console\]::SetConsoleTitle\(\$old\.ToString\(\)\)/);
  // 多个标签标题相同时按标题匹配不可靠，要交给控制台标记
  assert.match(code, /if \(\$hits\.Count -eq 1\) \{ return \$hits\[0\] \}/);
});
