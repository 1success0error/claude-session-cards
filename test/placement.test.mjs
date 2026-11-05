import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placeBeside } from '../lib/placement.mjs';

const AREA = { x: 0, y: 0, width: 2048, height: 1112 };
const SIZE = { width: 760, height: 680 };
const card = (x, y, height = 200) => ({ x, y, width: 320, height });

test('右侧放得下就放右侧，顶部对齐', () => {
  assert.deepEqual(placeBeside(card(100, 80), SIZE, AREA), { x: 428, y: 80, width: 760, height: 680 });
});

test('右侧放不下放左侧', () => {
  assert.equal(placeBeside(card(1700, 80), SIZE, AREA).x, 1700 - 8 - 760);
});

test('卡片靠下时向上收，不超出屏幕底部', () => {
  assert.equal(placeBeside(card(100, 1000), SIZE, AREA).y, 1112 - 8 - 680);
});

test('两侧都放不下时选空间大的一侧并限制在屏幕内', () => {
  const small = { x: 0, y: 0, width: 1000, height: 800 };
  const placed = placeBeside(card(100, 80), SIZE, small);
  assert.equal(placed.x, 1000 - 8 - 760);
  assert.equal(placeBeside(card(600, 80), SIZE, small).x, 8);
});

test('屏幕比窗口小时缩小窗口', () => {
  const tiny = { x: 0, y: 0, width: 600, height: 500 };
  const placed = placeBeside(card(100, 80), SIZE, tiny);
  assert.equal(placed.width, 584);
  assert.equal(placed.height, 484);
  assert.equal(placed.x, 8);
});

test('左边的副显示器（负坐标）', () => {
  const left = { x: -2048, y: 0, width: 2048, height: 1112 };
  assert.equal(placeBeside(card(-1900, 80), SIZE, left).x, -1900 + 320 + 8);
  assert.equal(placeBeside(card(-340, 80), SIZE, left).x, -340 - 8 - 760);
});

test('屏幕工作区不从 0 开始（如任务栏在上方）', () => {
  const top = { x: 0, y: 48, width: 2048, height: 1104 };
  assert.equal(placeBeside(card(100, 0), SIZE, top).y, 56);
});
