// T-147: 图表文档回归 —— 自包含离线 HTML + 可访问性契约 + 索引齐全
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIAGRAMS = [
  'design-specs/diagrams/v2-architecture.html',
  'design-specs/diagrams/mcp-call-chain.html',
  'design-specs/diagrams/orchestrator-dependency.html',
];

test('T-147 三张图在位且为自包含离线 HTML', () => {
  for (const rel of DIAGRAMS) {
    const file = join(ROOT, rel);
    assert.ok(existsSync(file), '缺图: ' + rel);
    const html = readFileSync(file, 'utf8');
    assert.match(html, /^<!DOCTYPE html>/i);
    assert.match(html, /role="img"/);
    assert.match(html, /min-width: 960px/);
    assert.ok(!/<script\b/i.test(html), rel + ': 不应含脚本');
    assert.ok(!/<img\b/i.test(html), rel + ': 不应含图片');
    assert.ok(!/@import/i.test(html), rel + ': 不应含 CSS import');
    assert.ok(!/fonts\.googleapis\.com/i.test(html), rel + ': 不应加载在线字体');
    assert.ok(!/\b(?:src|href)="https?:/i.test(html), rel + ': 不应引用远程资源');
  }
});

test('T-147 每张图的 aria-labelledby 能解析到 title 与 desc', () => {
  for (const rel of DIAGRAMS) {
    const html = readFileSync(join(ROOT, rel), 'utf8');
    const labelled = html.match(/aria-labelledby="([^"]+)"/);
    assert.ok(labelled, rel + ': 缺 aria-labelledby');
    for (const id of labelled[1].split(/\s+/)) {
      assert.ok(html.includes('id="' + id + '"'), rel + ': 缺 id ' + id);
    }
    const svgStart = html.indexOf('<svg');
    const titleAt = html.indexOf('<title', svgStart);
    const defsAt = html.indexOf('<defs', svgStart);
    assert.ok(titleAt > svgStart && (defsAt === -1 || titleAt < defsAt), rel + ': <title> 必须是 svg 首个子元素');
  }
});

test('T-147 图集索引覆盖全部三张图', () => {
  const idx = readFileSync(join(ROOT, 'design-specs/diagrams/index.md'), 'utf8');
  for (const rel of DIAGRAMS) {
    assert.ok(idx.includes(rel.split('/').pop()), '索引缺: ' + rel);
  }
});
