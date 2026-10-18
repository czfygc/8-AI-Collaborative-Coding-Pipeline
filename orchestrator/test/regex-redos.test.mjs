// regex-redos.test.mjs — DELTA-014（T-59 批2）护栏：extractSeverityFromLine / factPropKey
// ① 行为金样：severity 提取与命题键归并的关键输出钉死（含表格行尾随空格——贪心化等价性证明）
// ② ReDoS 护栏：对抗输入（长管道行/多段管道/无判定词长文/判定词轰炸/空白轰炸/标点轰炸）
//    必须在毫秒级完成；若未来引入嵌套歧义量词（指数回撤），计时断言会超时变红。
// 被测函数从活文件行级提取（与提交物零漂移），不复制实现。
// T-61 P4（2026-10-15）：mapSeverity/extractSeverityFromLine/factPropKey 已机械搬移至 lib/analyze-core.mjs，
// 提取源随迁（行级提取语义不变——仍从活文件取，与提交物零漂移）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'lib', 'analyze-core.mjs'), 'utf8');
const lines = src.split('\n');

function extractFn(name) {
  // T-61 P4：lib/analyze-core.mjs 中函数带 export 前缀——匹配与提取均剥前缀，行为金样不变
  const s0 = lines.findIndex(l => l.replace(/^export /, '').startsWith('function ' + name + '('));
  assert.ok(s0 >= 0, 'function ' + name + ' not found in lib/analyze-core.mjs');
  let e0 = -1;
  for (let i = s0 + 1; i < lines.length; i++) {
    if (lines[i].replace(/\r$/, '') === '}') { e0 = i; break; }
  }
  assert.ok(e0 > s0, 'function ' + name + ' closing brace not found');
  return lines.slice(s0, e0 + 1).map(l => l.replace(/^export /, '')).join('\n');
}

const factory = new Function(
  extractFn('mapSeverity') + '\n' + extractFn('extractSeverityFromLine') +
  '\nreturn { extractSeverityFromLine };'
);
const { extractSeverityFromLine } = factory();

const factPropKey = new Function(extractFn('factPropKey') + '\nreturn factPropKey;')();

const timed = (fn, input) => {
  const t0 = process.hrtime.bigint();
  const out = fn(input);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { out, ms };
};

// ---------- ① 行为金样 ----------
test('severity: 严重程度 前缀（中英冒号/英文词）', () => {
  assert.equal(extractSeverityFromLine('严重程度：高'), 'HIGH');
  assert.equal(extractSeverityFromLine('严重程度: MEDIUM'), 'MEDIUM');
  assert.equal(extractSeverityFromLine('严重程度——低'), 'LOW');
  assert.equal(extractSeverityFromLine('no severity here'), null);
});

test('severity: 表格行（第 3 列；贪心化后行尾空格仍由 trim 收口）', () => {
  assert.equal(extractSeverityFromLine('| 位置 | 说明 | 高 |'), 'HIGH');
  assert.equal(extractSeverityFromLine('| a | b | HIGH   |x'), 'HIGH');
  assert.equal(extractSeverityFromLine('| a | b |   low  |'), 'LOW');
  assert.equal(extractSeverityFromLine('| a | b |'), null);
});

test('severity: 行首 300 字符内的边界词（sm3 通道）', () => {
  assert.equal(extractSeverityFromLine('- HIGH (边界)'), 'HIGH');
  assert.equal(extractSeverityFromLine('【中】评级'), 'MEDIUM');
});

test('factPropKey: 判定词归并（S2 设计——PASS/FAIL 两措辞同命题键）', () => {
  const a = factPropKey('判定：PASS 位置 src/app.js:2');
  const b = factPropKey('= FAIL 位置 src/app.js:2');
  assert.equal(a, b);
  assert.ok(!/\b(pass|fail)\b/i.test(a), '判定词应被剥离');
  assert.ok(a.includes('位置'), '实体词保留');
});

test('factPropKey: verdict 表行取第一个 | 之前为键依据', () => {
  const k = factPropKey('坐标检查 | 判定：FAIL | 证据 src/a.js:1');
  assert.equal(k, factPropKey('坐标检查 | 判定：PASS | 忽略后半'));
  assert.ok(k.includes('坐标检查'));
});

// ---------- ② ReDoS 护栏（阈值 500ms：线性实现毫秒级，指数回撤必远超） ----------
const GUARD_MS = 500;

test('guard: 长管道行无闭合（tbl 通道多项式回撤形态）', () => {
  const { out, ms } = timed(extractSeverityFromLine, '|' + 'a'.repeat(200000));
  assert.equal(out, null);
  assert.ok(ms < GUARD_MS, 'took ' + ms.toFixed(1) + 'ms');
});

test('guard: 多段管道行 + 判定词单元格', () => {
  const { out, ms } = timed(extractSeverityFromLine, '|a|b|HIGH|'.repeat(20000));
  assert.equal(out, 'HIGH');
  assert.ok(ms < GUARD_MS, 'took ' + ms.toFixed(1) + 'ms');
});

test('guard: 严重程度后无判定词长文（否定字符类全扫描）', () => {
  const { out, ms } = timed(extractSeverityFromLine, '严重程度' + 'x'.repeat(200000));
  assert.equal(out, null);
  assert.ok(ms < GUARD_MS, 'took ' + ms.toFixed(1) + 'ms');
});

test('guard: factPropKey — section 空白轰炸（\\s*[:：]?\\s* 结构）', () => {
  const { ms } = timed(factPropKey, 'section' + ' '.repeat(300000) + 'x');
  assert.ok(ms < GUARD_MS, 'took ' + ms.toFixed(1) + 'ms');
});

test('guard: factPropKey — 判定词交替轰炸', () => {
  const { ms } = timed(factPropKey, 'pass fail blocked conditional '.repeat(20000));
  assert.ok(ms < GUARD_MS, 'took ' + ms.toFixed(1) + 'ms');
});

test('guard: factPropKey — 竖线切割 + Unicode 标点轰炸', () => {
  const { ms: m1 } = timed(factPropKey, 'a|'.repeat(100000));
  const { ms: m2 } = timed(factPropKey, '！'.repeat(200000));
  assert.ok(m1 < GUARD_MS && m2 < GUARD_MS, 'took ' + m1.toFixed(1) + '/' + m2.toFixed(1) + 'ms');
});
