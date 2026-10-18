// orchestrator/test/file-sanity.test.mjs — T-56 W7：titan-sanity suite
// 契约（护栏逐条）：
//   协议标记入文件 / 体积减半 / JS 语法炸 / JSON 炸 / import 冒烟炸 → problems 非空
//   干净文件 / 未改动体积 / YAML 好文件 → problems 空
//   T-59 新增：mojibake（U+FFFD）→ 拦；full-file-rewrite（占比>80% 且行数稳定）→ 拦，小修放行

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFileSanity } from '../lib/file-sanity.mjs';

let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'file-sanity-')) + '\\'; });
after(() => { try { rmSync(join(dir), { recursive: true, force: true }); } catch {} });

function w(name, content) {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

test('干净 mjs：problems 空', () => {
  const p = w('clean.mjs', 'export const a = 1;\nexport const b = 2;\n');
  const r = checkFileSanity(p, { lines: 3 });
  assert.deepEqual(r.problems, []);
});

test('协议标记入文件 → marker-as-file-content', () => {
  const p = w('marker.mjs', 'ALREADY_RESOLVED\n');
  const r = checkFileSanity(p, { lines: 100 });
  assert.ok(r.problems.some((x) => x.includes('marker-as-file-content')));
});

test('体积减半 → shrink 问题', () => {
  const p = w('shrink.mjs', 'export const a = 1;\n');
  const r = checkFileSanity(p, { lines: 120 });
  assert.ok(r.problems.some((x) => x.includes('shrink')));
});

test('JS 语法炸 → node--check FAIL', () => {
  const p = w('bad.mjs', 'export const = ;\n');
  const r = checkFileSanity(p, { lines: 100 });
  assert.ok(r.problems.some((x) => x.includes('node--check FAIL')));
});

test('JSON 炸 → JSON.parse FAIL；好 JSON 无问题', () => {
  const bad = w('bad.json', '{"a":}');
  assert.ok(checkFileSanity(bad, null).problems.some((x) => x.includes('JSON.parse FAIL')));
  const good = w('good.json', '{"a":1}');
  assert.deepEqual(checkFileSanity(good, null).problems, []);
});

test('纯库模块 import 冒烟：加载期炸弹 → import-smoke FAIL；好库模块通过', () => {
  const bad = w('cdp-client.mjs', 'const __dirname_bad = __dirnameTDZ;\nexport {};\n');
  const r = checkFileSanity(bad, null);
  assert.ok(r.problems.some((x) => x.includes('import-smoke FAIL')), JSON.stringify(r.problems));
  const good = w('review-flow.mjs', 'export const marker = "ok";\n');
  assert.deepEqual(checkFileSanity(good, null).problems, []);
});

test('YAML：好文件通过（工作区含 js-yaml）', () => {
  const p = w('ok.yaml', 'a: 1\nb: [x, y]\n');
  assert.deepEqual(checkFileSanity(p, null).problems, []);
});

test('mojibake（U+FFFD）→ 拦截', () => {
  const p = w('broken-enc.mjs', 'export const a = 1; // ' + String.fromCharCode(0xFFFD) + '\n');
  const r = checkFileSanity(p, { lines: 100 });
  assert.ok(r.problems.some((x) => x.includes('mojibake')), JSON.stringify(r.problems));
});

test('full-file-rewrite（改动占比 >80% 且行数稳定）→ 拦截；小修放行', () => {
  const body = Array.from({ length: 100 }, (_, i) => 'const v' + i + ' = ' + i + ';').join('\n') + '\n';
  const p = w('rewrite-guard.mjs', body);
  const bigLines = [];
  for (let i = 0; i < 100; i++) bigLines.push('-const v' + i + ' = ' + i + ';');
  for (let i = 0; i < 100; i++) bigLines.push('+const w' + i + ' = ' + i + ';');
  const bigDiff = ['diff --git a/rewrite-guard.mjs b/rewrite-guard.mjs', '--- a/rewrite-guard.mjs', '+++ b/rewrite-guard.mjs'].concat(bigLines).join('\n');
  const rBig = checkFileSanity(p, { lines: 101 }, { diffText: bigDiff });
  assert.ok(rBig.problems.some((x) => x.includes('full-file-rewrite')), JSON.stringify(rBig.problems));
  const smallDiff = ['diff --git a/rewrite-guard.mjs b/rewrite-guard.mjs', '--- a/rewrite-guard.mjs', '+++ b/rewrite-guard.mjs', '-const v1 = 1;', '+const v1 = 11;'].join('\n');
  const rSmall = checkFileSanity(p, { lines: 101 }, { diffText: smallDiff });
  assert.ok(!rSmall.problems.some((x) => x.includes('full-file-rewrite')), JSON.stringify(rSmall.problems));
});