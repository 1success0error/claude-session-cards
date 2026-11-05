import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CARD_EVENTS, CARD_SCRIPT, install, isInstalled, PET_SCRIPT, uninstall } from '../lib/settings.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'cards-settings-'));
const read = (d) => JSON.parse(readFileSync(join(d, 'settings.json'), 'utf8'));
const mine = (d, event) => read(d).hooks[event].flatMap((g) => g.hooks).filter((h) => h.command?.includes(CARD_SCRIPT));

test('没有配置文件时创建', () => {
  const d = dir();
  install(d);
  assert.equal(isInstalled(d), true);
  for (const event of CARD_EVENTS) assert.equal(mine(d, event).length, 1);
  assert.ok(existsSync(join(d, 'hooks', CARD_SCRIPT)));
});

test('保留已有设置和别人的 hook，并留备份', () => {
  const d = dir();
  const original = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo other' }] }] } };
  writeFileSync(join(d, 'settings.json'), JSON.stringify(original));
  install(d);
  const after = read(d);
  assert.equal(after.model, 'opus');
  assert.equal(after.hooks.Stop[0].hooks[0].command, 'echo other');
  assert.equal(mine(d, 'Stop').length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(d, 'settings.json.bak-claude-session-cards'), 'utf8')), original);
});

test('重复安装不重复添加', () => {
  const d = dir();
  install(d);
  install(d);
  assert.equal(mine(d, 'PreToolUse').length, 1);
});

test('卸载只移除自己的条目', () => {
  const d = dir();
  writeFileSync(join(d, 'settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo other' }] }] } }));
  install(d, { dshPet: true });
  assert.ok(existsSync(join(d, 'hooks', PET_SCRIPT)));
  uninstall(d);
  assert.deepEqual(read(d), { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo other' }] }] } });
  assert.equal(existsSync(join(d, 'hooks', CARD_SCRIPT)), false);
  assert.equal(existsSync(join(d, 'hooks', PET_SCRIPT)), false);
});

test('同一组里混有别人的 hook 时只删自己的', () => {
  const d = dir();
  install(d);
  const s = read(d);
  s.hooks.Stop[0].hooks.push({ type: 'command', command: 'echo other' });
  writeFileSync(join(d, 'settings.json'), JSON.stringify(s));
  uninstall(d);
  assert.deepEqual(read(d).hooks.Stop[0].hooks.map((h) => h.command), ['echo other']);
});

test('配置文件损坏时拒绝修改', () => {
  const d = dir();
  writeFileSync(join(d, 'settings.json'), '{ broken');
  assert.throws(() => install(d), /不是有效的 JSON/);
  assert.equal(readFileSync(join(d, 'settings.json'), 'utf8'), '{ broken');
});

test('hooks 类型异常时拒绝修改', () => {
  const d = dir();
  writeFileSync(join(d, 'settings.json'), JSON.stringify({ hooks: [] }));
  assert.throws(() => install(d), /不是对象/);
});
