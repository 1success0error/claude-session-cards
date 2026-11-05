import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { activeLimits, mergeLimits, scanUsage, startOfWeek } from '../lib/usage.mjs';

const THURSDAY_NOON = new Date(2026, 10, 5, 12, 0, 0).getTime();
const at = (day, hour = 10) => new Date(2026, 10, day, hour).toISOString();
const reply = (id, timestamp, usage, extra = {}) => ({ type: 'assistant', timestamp, requestId: `r-${id}`, message: { id, usage }, ...extra });
const tokens = (input, output, cacheWrite = 0, cacheRead = 0) => ({ input_tokens: input, output_tokens: output, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead });

function config(files) {
  const root = mkdtempSync(join(tmpdir(), 'cards-usage-'));
  for (const [name, records] of Object.entries(files)) {
    const path = join(root, 'projects', name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n'));
    const when = new Date(THURSDAY_NOON);
    utimesSync(path, when, when);
  }
  return root;
}

test('周从周一开始，周日算上一周的最后一天', () => {
  assert.equal(new Date(startOfWeek(new Date(2026, 10, 5))).getDate(), 2);
  assert.equal(new Date(startOfWeek(new Date(2026, 10, 2))).getDate(), 2);
  assert.equal(new Date(startOfWeek(new Date(2026, 10, 8))).getDate(), 2);
});

test('按今日和本周统计，主数字不含读取缓存', async () => {
  const root = config({
    'p/a.jsonl': [
      reply('today', at(5), tokens(10, 20, 30, 1000)),
      reply('monday', at(2), tokens(1, 2, 3, 500)),
      reply('lastweek', at(1), tokens(100, 100, 100, 100)),
    ],
  });
  const usage = await scanUsage(root, THURSDAY_NOON);
  assert.deepEqual(usage.today, { input: 10, output: 20, cacheRead: 1000, cacheWrite: 30, total: 60 });
  assert.deepEqual(usage.week, { input: 11, output: 22, cacheRead: 1500, cacheWrite: 33, total: 66 });
});

test('同一条回复只算一次，输出数取最大值', async () => {
  const root = config({
    'p/a.jsonl': [
      reply('m', at(5), tokens(10, 5, 30)),
      reply('m', at(5), tokens(10, 50, 30)),
      reply('m', at(5), tokens(10, 20, 30)),
    ],
  });
  const { today } = await scanUsage(root, THURSDAY_NOON);
  assert.equal(today.output, 50);
  assert.equal(today.total, 90);
});

test('跨文件去重；子代理目录也统计', async () => {
  const root = config({
    'p/a.jsonl': [reply('same', at(5), tokens(1, 1))],
    'p/b.jsonl': [reply('same', at(5), tokens(1, 1))],
    'p/a/subagents/c.jsonl': [reply('sub', at(5), tokens(2, 2))],
  });
  assert.equal((await scanUsage(root, THURSDAY_NOON)).today.total, 6);
});

test('损坏的行和非回复记录不影响统计', async () => {
  const root = config({
    'p/a.jsonl': ['{ "usage" broken', { type: 'user', message: { usage: tokens(9, 9) } }, reply('ok', at(5), tokens(1, 1))],
  });
  assert.equal((await scanUsage(root, THURSDAY_NOON)).today.total, 2);
});

test('没有记录目录时返回 0', async () => {
  const usage = await scanUsage(mkdtempSync(join(tmpdir(), 'cards-usage-')), THURSDAY_NOON);
  assert.equal(usage.today.total, 0);
  assert.equal(usage.week.total, 0);
});

test('限额：缺失的窗口保留原值，异常数值被忽略或限制', () => {
  let limits = mergeLimits({}, { five_hour: { used_percentage: 42.5, resets_at: 2000 }, seven_day: { used_percentage: 18, resets_at: 3000 } }, 100);
  assert.deepEqual(limits.fiveHour, { percent: 42.5, resetsAt: 2000000 });
  limits = mergeLimits(limits, { seven_day: { used_percentage: 130, resets_at: 3000 } }, 200);
  assert.equal(limits.fiveHour.percent, 42.5);
  assert.equal(limits.sevenDay.percent, 100);
  assert.equal(limits.updatedAt, 200);
  assert.equal(mergeLimits(limits, { five_hour: { used_percentage: 'x' } }, 300).updatedAt, 200);
});

test('限额：过了重置时间就不再显示', () => {
  const limits = { fiveHour: { percent: 42, resetsAt: 1000 }, sevenDay: { percent: 18, resetsAt: 5000 }, updatedAt: 1 };
  assert.deepEqual(activeLimits(limits, 2000), { updatedAt: 1, sevenDay: limits.sevenDay });
});
