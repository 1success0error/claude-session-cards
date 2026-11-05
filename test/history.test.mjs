import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readSessionMeta, scanHistory } from '../lib/history.mjs';

const ID = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const user = (content, extra = {}) => ({ type: 'user', cwd: '/work/shop', message: { role: 'user', content }, ...extra });
const write = (root, project, name, records) => {
  const dir = join(root, 'projects', project);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n'));
  return path;
};
const config = () => mkdtempSync(join(tmpdir(), 'cards-history-'));

test('读取标题、目录和首条提示词', async () => {
  const root = config();
  write(root, 'p', `${ID(1)}.jsonl`, [{ type: 'mode' }, user('第一句话'), user('第二句话'), { type: 'ai-title', aiTitle: '旧标题' }, { type: 'ai-title', aiTitle: '新标题' }]);
  const [s] = await scanHistory(root);
  assert.equal(s.id, ID(1));
  assert.equal(s.title, '新标题');
  assert.equal(s.prompt, '第一句话');
  assert.equal(s.cwd, '/work/shop');
  assert.equal(s.project, 'shop');
});

test('手动命名优先于自动标题', async () => {
  const root = config();
  write(root, 'p', `${ID(1)}.jsonl`, [user('x'), { type: 'custom-title', customTitle: '我的名字' }, { type: 'ai-title', aiTitle: '自动' }]);
  assert.equal((await scanHistory(root))[0].title, '我的名字');
});

test('跳过系统注入的消息和工具结果', async () => {
  const root = config();
  write(root, 'p', `${ID(1)}.jsonl`, [
    user('<command-name>/clear</command-name>'),
    user('系统提示', { isMeta: true }),
    user([{ type: 'tool_result', content: 'x' }]),
    user([{ type: 'text', text: '  真正的\n问题  ' }]),
  ]);
  assert.equal((await scanHistory(root))[0].prompt, '真正的 问题');
});

test('去掉粘贴内容的内部标签，只有粘贴内容的消息也能显示', async () => {
  const root = config();
  write(root, 'p', `${ID(1)}.jsonl`, [user('<pasted_content id="6b91">报错日志</pasted_content> 帮我看看')]);
  assert.equal((await scanHistory(root))[0].prompt, '报错日志 帮我看看');
});

test('没有对话内容的空壳记录被过滤', async () => {
  const root = config();
  write(root, 'p', `${ID(1)}.jsonl`, [{ type: 'ai-title', aiTitle: '空壳' }, { type: 'mode' }]);
  assert.deepEqual(await scanHistory(root), []);
});

test('只收录会话文件，跳过子代理目录和其他文件名', async () => {
  const root = config();
  write(root, 'p', `${ID(1)}.jsonl`, [user('a')]);
  write(root, 'p', 'notes.jsonl', [user('b')]);
  write(root, 'p', `${ID(2)}.txt`, [user('c')]);
  write(root, join('p', ID(1), 'subagents'), `${ID(3)}.jsonl`, [user('d')]);
  assert.deepEqual((await scanHistory(root)).map((s) => s.id), [ID(1)]);
});

test('损坏的行不影响其他内容', async () => {
  const root = config();
  write(root, 'p', `${ID(1)}.jsonl`, ['{ broken', user('还能读')]);
  assert.equal((await scanHistory(root))[0].prompt, '还能读');
});

test('大文件：开头没有目录时从结尾补，标题也从结尾读', async () => {
  const root = config();
  const filler = { type: 'file-history-snapshot', snapshot: 'x'.repeat(1024 * 1024) };
  write(root, 'p', `${ID(1)}.jsonl`, [filler, user('尾部消息'), { type: 'ai-title', aiTitle: '尾部标题' }]);
  const [s] = await scanHistory(root);
  assert.equal(s.cwd, '/work/shop');
  assert.equal(s.title, '尾部标题');
});

test('按修改时间倒序；文件变化后缓存失效', async () => {
  const root = config();
  const old = write(root, 'p', `${ID(1)}.jsonl`, [user('旧')]);
  write(root, 'p', `${ID(2)}.jsonl`, [user('新')]);
  utimesSync(old, new Date(1000), new Date(1000));
  assert.deepEqual((await scanHistory(root)).map((s) => s.id), [ID(2), ID(1)]);
  write(root, 'p', `${ID(1)}.jsonl`, [user('旧'), { type: 'ai-title', aiTitle: '更新了' }]);
  const rows = await scanHistory(root);
  assert.equal(rows[0].id, ID(1));
  assert.equal(rows[0].title, '更新了');
});

test('读取最后实际使用的模型，跳过 synthetic', async () => {
  const root = config();
  const assistant = (model) => ({ type: 'assistant', message: { model } });
  const path = write(root, 'p', `${ID(1)}.jsonl`, [assistant('claude-opus-5-5'), assistant('claude-sonnet-5-5'), assistant('<synthetic>'), { type: 'ai-title', aiTitle: '标题' }]);
  assert.deepEqual(await readSessionMeta(path), { title: '标题', model: 'claude-sonnet-5-5' });
});

test('读不到记录时返回空值', async () => {
  assert.deepEqual(await readSessionMeta(join(config(), 'missing.jsonl')), { title: null, model: null });
});

test('没有 projects 目录时返回空', async () => {
  assert.deepEqual(await scanHistory(config()), []);
});
