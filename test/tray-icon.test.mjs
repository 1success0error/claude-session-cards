import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drawIcon } from '../app/tray-icon.mjs';

const pixel = (buffer, size, x, y) => [...buffer.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];

for (const size of [16, 20, 24, 32, 48]) {
  test(`${size}px：尺寸正确，四角透明，中心不透明`, () => {
    const icon = drawIcon(size);
    assert.equal(icon.length, size * size * 4);
    assert.equal(pixel(icon, size, 0, 0)[3], 0);
    assert.equal(pixel(icon, size, size - 1, size - 1)[3], 0);
    assert.equal(pixel(icon, size, size >> 1, size >> 1)[3], 255);
  });
}

test('颜色是预乘的：任何通道都不超过透明度', () => {
  const icon = drawIcon(32);
  for (let i = 0; i < icon.length; i += 4) {
    assert.ok(Math.max(icon[i], icon[i + 1], icon[i + 2]) <= icon[i + 3]);
  }
});

test('16px 下两行内容仍然分得开', () => {
  const size = 16;
  const icon = drawIcon(size);
  const brightness = (y) => pixel(icon, size, 10, y)[1];
  assert.ok(brightness(5) > 180, `第一行 ${brightness(5)}`);
  assert.ok(brightness(10) > 180, `第二行 ${brightness(10)}`);
  assert.ok(brightness(8) < 110, `行间 ${brightness(8)}`);
});
