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
