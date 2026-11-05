// 按最差情况检查对比度：半透明卡片叠在纯黑或纯白背景上时，文字和状态色是否还看得清。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const css = (name) => readFileSync(new URL(`../app/public/${name}`, import.meta.url), 'utf8');

function tokens(source) {
  const [dark, light] = [source.match(/:root \{([\s\S]*?)\n\}/)[1], source.match(/prefers-color-scheme: light\) \{\s*:root \{([\s\S]*?)\n  \}/)[1]];
  const parse = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const base = parse(dark);
  return { dark: base, light: { ...base, ...parse(light) } };
}

const hex = (value) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
const over = (fg, alpha, bg) => fg.map((c, i) => c * alpha + bg[i] * (1 - alpha));
const luminance = (rgb) => {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];
const FOREGROUNDS = ['text', 'muted', 'waiting', 'error', 'working', 'thinking', 'stale', 'done', 'idle'];
const themes = tokens(css('style.css'));

for (const [name, t] of Object.entries(themes)) {
  const rgb = t['card-rgb'].split(' ').map(Number);
  const backdrops = (alpha) => [over(rgb, alpha, BLACK), over(rgb, alpha, WHITE)];

  test(`${name}：标准透明度下文字和状态色对比度 ≥ 4.5`, () => {
    for (const bg of backdrops(Number(t['card-alpha']))) {
      for (const key of FOREGROUNDS) {
        const ratio = contrast(hex(t[key]), bg);
        assert.ok(ratio >= 4.5, `${key} = ${ratio.toFixed(2)}`);
      }
    }
  });

  test(`${name}：较透明时正文 ≥ 4.5，其余 ≥ 3`, () => {
    for (const bg of backdrops(Number(t['translucent-alpha']))) {
      assert.ok(contrast(hex(t.text), bg) >= 4.5, `text = ${contrast(hex(t.text), bg).toFixed(2)}`);
      for (const key of FOREGROUNDS) {
        const ratio = contrast(hex(t[key]), bg);
        assert.ok(ratio >= 3, `${key} = ${ratio.toFixed(2)}`);
      }
    }
  });
}

const history = tokens(css('history.css'));
for (const [name, t] of Object.entries(history)) {
  test(`历史窗口 ${name}：文字对比度 ≥ 4.5`, () => {
    for (const key of ['text', 'muted', 'working', 'error', 'accent']) {
      const ratio = contrast(hex(t[key]), hex(t.panel));
      assert.ok(ratio >= 4.5, `${key} = ${ratio.toFixed(2)}`);
    }
  });
}
