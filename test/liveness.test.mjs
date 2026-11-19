import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { sessionInTab } from '../lib/foreground.mjs';
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

const tabSessions = [
  { id: 'a', chain: chain(1, 900), titles: ['部署脚本'] },
  { id: 'b', chain: chain(2, 900), titles: ['部署'] },
  { id: 'c', chain: chain(3, 901), titles: ['订单接口'] },
  { id: 'd', chain: null, titles: [] },
];

test('按标签标题找到会话，互相包含时取最长的', () => {
  assert.equal(sessionInTab(tabSessions, { pid: 900, title: '✳ 部署脚本' }), 'a');
  assert.equal(sessionInTab(tabSessions, { pid: 900, title: '✳ 部署' }), 'b');
});

test('终端进程对不上、没有标题或分不出时不确认', () => {
  assert.equal(sessionInTab(tabSessions, { pid: 900, title: '✳ 订单接口' }), null);
  assert.equal(sessionInTab(tabSessions, { pid: 900, title: '✳ Claude Code' }), null);
  assert.equal(sessionInTab([{ id: 'x', chain: null, titles: ['同名'] }, { id: 'y', chain: null, titles: ['同名'] }], { pid: 1, title: '同名' }), null);
  assert.equal(sessionInTab(tabSessions, null), null);
});

test('前台检测脚本只含 ASCII，并且只读窗口标题', () => {
  const code = readFileSync(new URL('../app/watch-foreground.ps1', import.meta.url), 'utf8');
  assert.equal([...code].filter((c) => c.charCodeAt(0) > 127).join(''), '');
  assert.doesNotMatch(code, /keybd_event|SendInput|SendKeys|SetForegroundWindow|SetConsoleTitle/i);
});
