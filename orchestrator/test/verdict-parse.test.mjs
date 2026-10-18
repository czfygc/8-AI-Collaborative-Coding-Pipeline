// orchestrator/test/verdict-parse.test.mjs — T-56 W8：verdict 解析 + raw 读取 fixture
// 契约：
//   extractVerdictLines：| 与 \t 分隔、首列分隔符可选、表头行/分隔行跳过、判定词必须紧邻
//   结构化分隔（散文 "if test PASS then" 不误命中）、大小写归一、含转义场景（\t 分隔 + 前缀 |）
//   readRawResponse：截取 "## Response" 之后段落 trim；无该节则整文返回
// 回归锚点：冻结 dispatch 66c0f00e 的 raw → verdictLines gemini=6 / deepseek=9（analyze 回归用）

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractVerdictLines, readRawResponse } from '../lib/verdict-parse.mjs';

let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'verdict-parse-')) + '\\'; });
after(() => { try { rmSync(join(dir), { recursive: true, force: true }); } catch {} });

test('| 分隔：提取 name/verdict/reason，跳表头与分隔行', () => {
  const text = [
    '| 条目 | 判定 | 理由 |',
    '|---|---|---|',
    '| 安全性 | PASS | 边界检查齐全 |',
    '| 性能 | FAIL | 嵌套循环 O(n^2) |',
    '| 风格 | CONDITIONAL | 视团队规范 |',
  ].join('\n');
  const v = extractVerdictLines(text);
  assert.equal(v.length, 3);
  assert.deepEqual(v[0], { name: '安全性', verdict: 'PASS', reason: '边界检查齐全' });
  assert.deepEqual(v[1], { name: '性能', verdict: 'FAIL', reason: '嵌套循环 O(n^2)' });
  assert.equal(v[2].verdict, 'CONDITIONAL');
});

test('\\t 分隔 + 首列无分隔符前置（P4 转义场景）', () => {
  const text = '模块边界是否清晰\tPASS\t分层明确\n错误输入处理\tFAIL\t缺校验\n';
  const v = extractVerdictLines(text);
  assert.equal(v.length, 2);
  assert.deepEqual(v[0], { name: '模块边界是否清晰', verdict: 'PASS', reason: '分层明确' });
  assert.deepEqual(v[1], { name: '错误输入处理', verdict: 'FAIL', reason: '缺校验' });
});

test('散文 "if test PASS then" 不误命中（结构化分隔强约束）', () => {
  const v = extractVerdictLines('普通句子 if test PASS then 继续跑；没有 | 或 tab 分列。\n');
  assert.equal(v.length, 0);
});

test('判定词大小写归一 + 名称/条目表头跳过（name/item）', () => {
  const v = extractVerdictLines('| name | verdict | reason |\n| x | pass | ok reason |\n');
  assert.equal(v.length, 1);
  assert.equal(v[0].verdict, 'PASS');
});

test('readRawResponse：截取 ## Response 之后段落并 trim（行内空白不 trim，与旧实现一致）', async () => {
  const p = join(dir, 'raw1.md');
  writeFileSync(p, '# 标题\n前置元信息\n\n## Response\n\n  正文段落  \n  第二行  \n', 'utf8');
  assert.equal(await readRawResponse(p), '正文段落  \n  第二行');
});

test('readRawResponse：无 ## Response 节则整文原样返回（含尾换行；空文本安全）', async () => {
  const p = join(dir, 'raw2.md');
  writeFileSync(p, '只有一段正文\n', 'utf8');
  assert.equal(await readRawResponse(p), '只有一段正文\n');
  const e = join(dir, 'raw3.md');
  writeFileSync(e, '', 'utf8');
  assert.equal(await readRawResponse(e), '');
});