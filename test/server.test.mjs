import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEvent, normalizeTitle, pruneSessions } from '../lib/server.mjs';

const CWD = ['D:', 'project', 'shop'].join(String.fromCharCode(92));
const fresh = () => new Map();
const e = (event, ts, extra = {}) => ({ event, session_id: 'a1', ts, cwd: CWD, ...extra });

test('正常一轮', () => {
  const m = fresh();
  applyEvent(m, e('UserPromptSubmit', 100, { prompt: '修接口' }));
  assert.equal(m.get('a1').state, 'thinking');
  assert.equal(m.get('a1').project, 'shop');
  applyEvent(m, e('PreToolUse', 200, { tool_name: 'Bash', tool: 'Bash: 测试' }));
  assert.equal(m.get('a1').state, 'working');
  applyEvent(m, e('PostToolUse', 300));
  assert.equal(m.get('a1').state, 'thinking');
  assert.equal(m.get('a1').tool, null);
  applyEvent(m, e('Stop', 400));
  assert.equal(m.get('a1').state, 'done');
});

test('一轮结束时提示，新一轮或继续工作时清除', () => {
  const m = fresh();
  applyEvent(m, e('UserPromptSubmit', 100, { prompt: 'a' }));
  assert.equal(m.get('a1').attention, false);
  applyEvent(m, e('Stop', 200));
  assert.equal(m.get('a1').attention, true);
  applyEvent(m, e('Notification', 300, { notification_type: 'idle_prompt' }));
  assert.equal(m.get('a1').attention, true);
  applyEvent(m, e('UserPromptSubmit', 400, { prompt: 'b' }));
  assert.equal(m.get('a1').attention, false);
  applyEvent(m, e('StopFailure', 500));
  assert.equal(m.get('a1').attention, true);
  applyEvent(m, e('PreToolUse', 9000, { tool_name: 'Bash' }));
  assert.equal(m.get('a1').attention, false);
});

test('Stop 后迟到的工具事件不会清除提示', () => {
  const m = fresh();
  applyEvent(m, e('Stop', 1000));
  applyEvent(m, e('PreToolUse', 1500, { tool_name: 'Bash' }));
  assert.equal(m.get('a1').attention, true);
});

test('只记录 jsonl 的 transcript 路径', () => {
  const m = fresh();
  applyEvent(m, e('SessionStart', 1, { transcript_path: 'C:/x/a.jsonl' }));
  assert.equal(m.get('a1').transcript, 'C:/x/a.jsonl');
  applyEvent(m, e('Stop', 2, { transcript_path: 'C:/secret.txt' }));
  assert.equal(m.get('a1').transcript, 'C:/x/a.jsonl');
});

test('标题规范化', () => {
  assert.equal(normalizeTitle('  新 \n 标题 '), '新 标题');
  assert.equal(normalizeTitle('   '), null);
  assert.equal(normalizeTitle(null), null);
  assert.equal(Array.from(normalizeTitle('字'.repeat(200))).length, 80);
  assert.throws(() => normalizeTitle(42));
});

test('记录上一步，新一轮清空', () => {
  const m = fresh();
  applyEvent(m, e('PreToolUse', 100, { tool_name: 'Read', tool: 'Read: a.js' }));
  applyEvent(m, e('PostToolUse', 200, { tool_name: 'Read', tool: 'Read: a.js' }));
  assert.equal(m.get('a1').prevTool, 'Read: a.js');
  applyEvent(m, e('PreToolUse', 300, { tool_name: 'Bash', tool: 'Bash: 测试' }));
  assert.equal(m.get('a1').tool, 'Bash: 测试');
  assert.equal(m.get('a1').prevTool, 'Read: a.js');
  applyEvent(m, e('UserPromptSubmit', 400, { prompt: '下一个' }));
  assert.equal(m.get('a1').prevTool, null);
});

test('PostToolUse 迟到被丢弃时，上一步仍然正确', () => {
  const m = fresh();
  applyEvent(m, e('PreToolUse', 100, { tool_name: 'Read', tool: 'Read: a.js' }));
  applyEvent(m, e('PreToolUse', 300, { tool_name: 'Bash', tool: 'Bash: 测试' }));
  applyEvent(m, e('PostToolUse', 200, { tool_name: 'Read', tool: 'Read: a.js' }));
  assert.equal(m.get('a1').tool, 'Bash: 测试');
  assert.equal(m.get('a1').prevTool, 'Read: a.js');
});

test('Origin 只记录进程链，不改变状态也不刷新活动时间', () => {
  const m = fresh();
  applyEvent(m, e('Stop', 100));
  applyEvent(m, { event: 'Origin', session_id: 'a1', ts: 900, chain: [{ pid: 12, name: 'claude.exe' }, { pid: -1, name: 'bad' }, { name: 'nopid' }], transcript_path: 'x.jsonl' });
  const s = m.get('a1');
  assert.deepEqual(s.chain, [{ pid: 12, name: 'claude.exe' }]);
  assert.equal(s.transcript, 'x.jsonl');
  assert.equal(s.state, 'done');
  assert.equal(s.updatedAt, 100);
});

test('POSIX 路径也能取到项目名', () => {
  const m = fresh();
  applyEvent(m, e('SessionStart', 1, { cwd: '/home/me/work/api/' }));
  assert.equal(m.get('a1').project, 'api');
});

test('乱序：旧事件不回拨', () => {
  const m = fresh();
  applyEvent(m, e('PreToolUse', 500, { tool_name: 'Bash' }));
  applyEvent(m, e('PostToolUse', 400));
  assert.equal(m.get('a1').state, 'working');
});

test('Stop 后迟到的工具事件被忽略，很久之后的生效', () => {
  const m = fresh();
  applyEvent(m, e('Stop', 1000));
  applyEvent(m, e('PreToolUse', 1500, { tool_name: 'Bash' }));
  assert.equal(m.get('a1').state, 'done');
  applyEvent(m, e('PreToolUse', 9000, { tool_name: 'Bash' }));
  assert.equal(m.get('a1').state, 'working');
});

test('完成后子代理事件不翻转', () => {
  const m = fresh();
  applyEvent(m, e('Stop', 1000));
  applyEvent(m, e('PreToolUse', 9000, { tool_name: 'Bash', subagent: true }));
  assert.equal(m.get('a1').state, 'done');
});

test('权限通知进入等待；idle_prompt 不翻转已完成', () => {
  const m = fresh();
  applyEvent(m, e('Notification', 100, { notification_type: 'permission_prompt', message: '要确认' }));
  assert.equal(m.get('a1').state, 'waiting');
  applyEvent(m, e('Stop', 200));
  applyEvent(m, e('Notification', 300, { notification_type: 'idle_prompt' }));
  assert.equal(m.get('a1').state, 'done');
});

test('AskUserQuestion 进入等待', () => {
  const m = fresh();
  applyEvent(m, e('PreToolUse', 100, { tool_name: 'AskUserQuestion' }));
  assert.equal(m.get('a1').state, 'waiting');
});

test('StopFailure 进入出错，SessionEnd 删除', () => {
  const m = fresh();
  applyEvent(m, e('StopFailure', 100));
  assert.equal(m.get('a1').state, 'error');
  applyEvent(m, e('SessionEnd', 200));
  assert.equal(m.size, 0);
});

test('任务进度', () => {
  const m = fresh();
  applyEvent(m, e('TaskCreated', 100, { task_id: '1' }));
  applyEvent(m, e('TaskCreated', 101, { task_id: '2' }));
  applyEvent(m, e('TaskCompleted', 102, { task_id: '1' }));
  assert.deepEqual(m.get('a1').todos, { done: 1, total: 2 });
  applyEvent(m, e('PreToolUse', 200, { tool_name: 'TodoWrite', todos: { done: 3, total: 5 } }));
  assert.deepEqual(m.get('a1').todos, { done: 3, total: 5 });
});

test('非法 session_id 被拒绝', () => {
  const m = fresh();
  assert.equal(applyEvent(m, e('Stop', 1, { session_id: '../x' })), false);
  assert.equal(m.size, 0);
});

test('清理 24 小时前的会话', () => {
  const m = fresh();
  applyEvent(m, e('Stop', 100));
  assert.equal(pruneSessions(m, 100 + 25 * 3600e3), true);
  assert.equal(m.size, 0);
});
