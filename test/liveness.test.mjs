import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEvent, checkLiveness, pruneSessions } from '../lib/server.mjs';

const ID = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const chain = (agent, terminal = 900) => [{ pid: 1, name: 'bash.exe' }, { pid: agent, name: 'claude.exe' }, { pid: terminal, name: 'WindowsTerminal.exe' }];
const withChain = (n, agent) => {
  const m = new Map();
  applyEvent(m, { event: 'Stop', session_id: ID(n), ts: 1 });
  applyEvent(m, { event: 'Origin', session_id: ID(n), chain: chain(agent) });
  return m;
};

test('进程还在：卡片保留，也不会被 24 小时清理', () => {
  const m = withChain(1, 100);
  assert.equal(m.get(ID(1)).alive, true);
  checkLiveness(m, new Map([[100, 'claude.exe']]));
  assert.equal(pruneSessions(m, 30 * 24 * 3600e3), false);
  assert.ok(m.has(ID(1)));
});

test('进程没了（关掉了终端）：卡片移除', () => {
  const m = withChain(1, 100);
  assert.equal(checkLiveness(m, new Map([[200, 'claude.exe']])), true);
  assert.equal(m.has(ID(1)), false);
});

test('pid 被别的程序复用：当作已退出', () => {
  const m = withChain(1, 100);
  checkLiveness(m, new Map([[100, 'chrome.exe']]));
  assert.equal(m.has(ID(1)), false);
});

test('没有进程链或查不到进程列表：不改动，按时间规则处理', () => {
  const m = new Map();
  applyEvent(m, { event: 'Stop', session_id: ID(1), ts: 1 });
  assert.equal(checkLiveness(m, new Map()), false);
  assert.equal(m.get(ID(1)).alive, undefined);
  const known = withChain(2, 100);
  assert.equal(checkLiveness(known, null), false);
  assert.ok(known.has(ID(2)));
});

test('恢复会话后旧进程链作废，存活状态重新判断', () => {
  const m = withChain(1, 100);
  applyEvent(m, { event: 'SessionStart', session_id: ID(1), ts: 2 });
  assert.equal(m.get(ID(1)).alive, null);
  checkLiveness(m, new Map());
  assert.ok(m.has(ID(1)));
});

test('快速检查：只看 pid 在不在，无权访问也算在', async () => {
  const { pidsAlive } = await import('../lib/server.mjs');
  const m = new Map([...withChain(1, 100), ...withChain(2, 200), ...withChain(3, 300)]);
  const probe = (pid) => {
    if (pid === 200) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    if (pid === 300) throw Object.assign(new Error('denied'), { code: 'EPERM' });
  };
  assert.deepEqual([...pidsAlive(m, probe)], [[100, 'claude.exe'], [300, 'claude.exe']]);
  checkLiveness(m, pidsAlive(m, probe));
  assert.deepEqual([...m.keys()], [ID(1), ID(3)]);
});
