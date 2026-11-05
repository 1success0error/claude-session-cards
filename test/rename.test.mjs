import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { renameSession, sessionMayBeOpen } from '../lib/rename.mjs';

const chain = [{ pid: 1, name: 'bash.exe' }, { pid: 2, name: 'claude.exe' }, { pid: 3, name: 'WindowsTerminal.exe' }];

test('不在卡片里的会话算已关闭', () => {
  assert.equal(sessionMayBeOpen(undefined), false);
});

test('按 Claude 进程判断，不看终端还开不开', () => {
  assert.equal(sessionMayBeOpen({ chain, updatedAt: 0 }, 1e12, (pid) => pid === 2), true);
  assert.equal(sessionMayBeOpen({ chain, updatedAt: 1e12 }, 1e12, (pid) => pid === 3), false);
});

test('不知道进程时，最近有活动就算开着', () => {
  const now = 1e12;
  assert.equal(sessionMayBeOpen({ chain: null, updatedAt: now - 60_000 }, now), true);
  assert.equal(sessionMayBeOpen({ chain: null, updatedAt: now - 3_600_000 }, now), false);
});

test('非法的会话 ID 或没有目录时不运行', async () => {
  assert.equal(await renameSession({ id: 'not-a-uuid; rm -rf', title: 'x', cwd: 'D:/', dataDir: 'D:/none' }), false);
  assert.equal(await renameSession({ id: '00000000-0000-4000-8000-000000000000', title: 'x', cwd: null, dataDir: 'D:/none' }), false);
});

test('标题不会被当成命令解析，临时进程不触发 hook', () => {
  const code = readFileSync(new URL('../lib/rename.mjs', import.meta.url), 'utf8');
  assert.match(code, /\$env:CARDS_RENAME/);
  assert.match(code, /disableAllHooks/);
});
