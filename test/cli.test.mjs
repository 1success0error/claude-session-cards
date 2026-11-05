// 端到端：临时配置目录 + 独立端口，走网页模式，不碰真实配置，也不开窗口。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'cards-cli-'));
const PORT = '47899';
const env = { ...process.env, CLAUDE_CONFIG_DIR: join(root, 'claude'), CLAUDE_SESSION_CARDS_HOME: join(root, 'data'), CLAUDE_SESSION_CARDS_PORT: PORT };
const BASE = `http://127.0.0.1:${PORT}`;

const cli = (...args) => {
  const res = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
};
const sessions = async () => (await (await fetch(`${BASE}/api/sessions`)).json()).sessions;
const runHook = (payload) => {
  const script = join(env.CLAUDE_CONFIG_DIR, 'hooks', 'claude-session-cards.mjs');
  const res = spawnSync(process.execPath, [script], { env, input: JSON.stringify(payload), encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
};

after(() => spawnSync(process.execPath, [CLI, 'stop'], { env }));

test('服务没开时 hook 静默退出', () => {
  cli('install');
  runHook({ hook_event_name: 'Stop', session_id: 'early', cwd: root });
});

test('安装 → 启动 → hook 上报 → 状态 → 退出', async () => {
  assert.match(cli('start', '--web'), /网页模式/);
  assert.match(cli('start', '--web'), /已在运行/);

  runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'e2e', cwd: root, prompt: '帮我看看接口为什么返回 500' });
  let [s] = await sessions();
  assert.equal(s.state, 'thinking');
  assert.equal(s.task, '帮我看看接口为什么返回 500');

  runHook({ hook_event_name: 'PreToolUse', session_id: 'e2e', cwd: root, tool_name: 'Bash', tool_input: { command: 'SECRET=abc deploy', description: '运行测试' } });
  [s] = await sessions();
  assert.equal(s.tool, 'Bash: 运行测试');
  assert.doesNotMatch(JSON.stringify(s), /SECRET/);

  runHook({ hook_event_name: 'PreToolUse', session_id: 'e2e', cwd: root, tool_name: 'WebFetch', tool_input: { url: 'https://x.dev/a?token=abc' } });
  [s] = await sessions();
  assert.equal(s.tool, 'WebFetch: https://x.dev/a');

  assert.match(cli('status'), /e2e/);
  await new Promise((r) => setTimeout(r, 1300));
  assert.ok(existsSync(join(env.CLAUDE_SESSION_CARDS_HOME, 'state.json')));
  assert.match(readFileSync(join(env.CLAUDE_SESSION_CARDS_HOME, 'state.json'), 'utf8'), /e2e/);
});

test('访问控制', async () => {
  const post = (headers) => fetch(`${BASE}/api/event`, { method: 'POST', headers, body: '{}' });
  assert.equal((await post({ 'Content-Type': 'application/json', Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ 'Content-Type': 'text/plain' })).status, 403);
  assert.equal((await fetch(`${BASE}/../package.json`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/shutdown`, { method: 'POST', headers: { 'Content-Type': 'text/plain' } })).status, 403);
});

test('历史接口读取配置目录里的会话', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const dir = join(env.CLAUDE_CONFIG_DIR, 'projects', 'demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify({ type: 'user', cwd: '/work/demo', message: { content: '历史提示词' } })}\n`);
  const { sessions: rows } = await (await fetch(`${BASE}/api/history`)).json();
  assert.equal(rows[0].id, id);
  assert.equal(rows[0].prompt, '历史提示词');
  assert.equal(rows[0].active, false);
  assert.equal((await fetch(`${BASE}/history.html`)).status, 200);
});

test('确认提示和修改标题', async () => {
  runHook({ hook_event_name: 'Stop', session_id: 'e2e', cwd: root });
  const get = async () => (await sessions()).find((s) => s.id === 'e2e');
  const json = { 'Content-Type': 'application/json' };
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await get()).attention, true);
  assert.equal((await fetch(`${BASE}/api/sessions/e2e/ack`, { method: 'POST', headers: json, body: '{}' })).status, 204);
  assert.equal((await get()).attention, false);

  const setTitle = (title) => fetch(`${BASE}/api/sessions/e2e/title`, { method: 'PUT', headers: json, body: JSON.stringify({ title }) });
  assert.equal((await setTitle('  我的标题 ')).status, 204);
  assert.equal((await get()).title, '我的标题');
  assert.deepEqual(JSON.parse(readFileSync(join(env.CLAUDE_SESSION_CARDS_HOME, 'titles.json'), 'utf8')), { e2e: '我的标题' });
  assert.equal((await setTitle('')).status, 204);
  assert.equal((await get()).title, null);

  const evil = await fetch(`${BASE}/api/sessions/e2e/title`, { method: 'PUT', headers: { ...json, Origin: 'https://evil.example' }, body: '{"title":"x"}' });
  assert.equal(evil.status, 403);
  assert.equal((await setTitle(42)).status, 400);
  assert.doesNotMatch(JSON.stringify(await sessions()), /"(chain|transcript|autoTitle)"/);
});

test('退出并卸载', async () => {
  assert.match(cli('stop'), /已退出/);
  await new Promise((r) => setTimeout(r, 300));
  assert.match(cli('status'), /未运行/);
  cli('uninstall', '--purge');
  assert.equal(existsSync(env.CLAUDE_SESSION_CARDS_HOME), false);
  assert.equal(existsSync(join(env.CLAUDE_CONFIG_DIR, 'hooks', 'claude-session-cards.mjs')), false);
});
