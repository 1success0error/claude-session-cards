import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { searchHistory, termsOf } from '../lib/search.mjs';

const ID = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const line = (r) => `${JSON.stringify(r)}\n`;
const user = (content, extra = {}) => line({ type: 'user', message: { role: 'user', content }, ...extra });
const reply = (text) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }, { type: 'tool_use', name: 'Bash', input: { command: 'echo 工具参数' } }] } });
const config = () => mkdtempSync(join(tmpdir(), 'cards-search-'));
const write = (root, n, text) => {
  const dir = join(root, 'projects', 'p');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${ID(n)}.jsonl`);
  writeFileSync(path, text);
  return path;
};

test('搜索用户的提问和 Claude 的回答，不搜工具和系统内容', async () => {
  const root = config();
  write(root, 1, [
    user('订单接口为什么返回 500'),
    reply('因为 Redis 连接池耗尽了'),
    user([{ type: 'tool_result', content: '工具输出里的秘密' }]),
    user('<system-reminder>系统提醒</system-reminder>'),
    user('元数据', { isMeta: true }),
    line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: '子代理回答' }] } }),
  ].join(''));

  const [hit] = await searchHistory(root, 'redis');
  assert.equal(hit.id, ID(1));
  assert.deepEqual(hit.snippets, [{ role: 'assistant', text: '因为 Redis 连接池耗尽了' }]);
  assert.equal((await searchHistory(root, '订单'))[0].snippets[0].role, 'user');
  for (const hidden of ['工具输出', '工具参数', '系统提醒', '元数据', '子代理']) assert.deepEqual(await searchHistory(root, hidden), [], hidden);
});

test('多个词都要出现在同一会话里，可以分散在不同消息', async () => {
  const root = config();
  write(root, 1, user('部署脚本') + reply('改好了 nginx 配置'));
  write(root, 2, user('部署文档'));
  assert.deepEqual((await searchHistory(root, '部署 NGINX')).map((m) => m.id), [ID(1)]);
  assert.equal((await searchHistory(root, '部署')).length, 2);
  assert.deepEqual(await searchHistory(root, '   '), []);
});

test('长消息只返回关键词附近的片段', async () => {
  const root = config();
  write(root, 1, user(`${'前'.repeat(200)}关键词${'后'.repeat(200)}`));
  const [{ snippets: [s] }] = await searchHistory(root, '关键词');
  assert.ok(s.text.startsWith('…') && s.text.endsWith('…'));
  assert.ok(s.text.includes('关键词'));
  assert.ok(Array.from(s.text).length < 140);
});

test('文件追加、改写和删除后结果跟着变', async () => {
  const root = config();
  const path = write(root, 1, user('第一条'));
  assert.equal((await searchHistory(root, '第二条')).length, 0);

  appendFileSync(path, user('第二条'));
  assert.equal((await searchHistory(root, '第二条')).length, 1);
  assert.equal((await searchHistory(root, '第一条')).length, 1);

  // 没写完的最后一行先不收录，写完后能搜到
  appendFileSync(path, user('第三条').slice(0, 20));
  assert.equal((await searchHistory(root, '第三条')).length, 0);
  appendFileSync(path, user('第三条').slice(20));
  assert.equal((await searchHistory(root, '第三条')).length, 1);

  writeFileSync(path, user('重写'));
  assert.equal((await searchHistory(root, '第一条')).length, 0);
  assert.equal((await searchHistory(root, '重写')).length, 1);

  rmSync(path);
  assert.deepEqual(await searchHistory(root, '重写'), []);
});

test('搜索词去重、忽略大小写并限制长度', () => {
  assert.deepEqual(termsOf(' Foo  foo BAR '), ['foo', 'bar']);
  assert.equal(termsOf('x'.repeat(1000))[0].length, 200);
  assert.deepEqual(termsOf(null), []);
});
