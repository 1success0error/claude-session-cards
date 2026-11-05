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
