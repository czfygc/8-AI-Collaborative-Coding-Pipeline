// orchestrator/test/send-check-expr.test.mjs — T-56 W2.4：buildSendCheckExpr 产物契约 + vm 行为
// 背景（S-01）：旧实现把 reviewer.url_open 裸引用拼进浏览器执行表达式模板
// （orchestrate.mjs:2037 `( reviewer.url_open ? ... )`）——浏览器内 ReferenceError:
// reviewer is not defined → 发送确认/send-rescue 连坐失效，而 Node 侧永不报错（语法闸盲区）。
// 修复：抽纯函数 buildSendCheckExpr(initialUrlNorm, hasUrlOpen) 进 lib/，Node 侧预计算
// 布尔 + JSON.stringify 插值。契约：
//   ① 产物无裸 reviewer 标识符  ② new Function 可解析（语法完整）
//   ③ 含 JSON 编码值（含转义序列注入） ④ vm 假 DOM 行为断言 sent 布尔语义等价旧版

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildSendCheckExpr } from '../lib/send-check-expr.mjs';

function evalExpr(expr, { href, assistantPresent = false, residual = '' } = {}) {
  const document = {
    querySelectorAll: () => (residual === '__NOEL__'
      ? []
      : [{ tagName: 'TEXTAREA', value: residual, offsetParent: {}, getBoundingClientRect: () => ({ width: 100 }) }]),
    querySelector: () => (assistantPresent ? { id: 'asst' } : null),
  };
  const location = { href };
  return vm.runInNewContext(expr, { document, location });
}

test('① 产物无裸 reviewer 标识符（hasUrlOpen 两态）', () => {
  const e1 = buildSendCheckExpr('https://site', true);
  const e2 = buildSendCheckExpr('', false);
  assert.ok(!e1.includes('reviewer'), 'e1 不应含 reviewer: ' + e1);
  assert.ok(!e2.includes('reviewer'), 'e2 不应含 reviewer: ' + e2);
});

test('② new Function 可解析（语法破坏检测，含特殊字符 URL）', () => {
  assert.doesNotThrow(() => new Function(buildSendCheckExpr('https://site', true)));
  assert.doesNotThrow(() => new Function(buildSendCheckExpr('a"b<c/&', false)));
});

test('③ 含 JSON 编码值（引号转义原样注入）', () => {
  const out = buildSendCheckExpr('x?y"z', true);
  assert.ok(out.includes('"x?y\\"z"'), '应含 JSON.stringify 产物: ' + out);
});

test('④ 行为：输入框空 + URL 变化 + 有 url_open -> sent=true', () => {
  const r = evalExpr(buildSendCheckExpr('https://site', true), { href: 'https://site/app/9', residual: '__NOEL__' });
  assert.equal(r.residualLen, 0);
  assert.equal(r.sent, true);
});

test('④ 行为：URL 未变化且无助手回复 -> sent=false', () => {
  const r = evalExpr(buildSendCheckExpr('https://site/app/9', true), { href: 'https://site/app/9', residual: '__NOEL__' });
  assert.equal(r.sent, false);
});

test('④ 行为：无 url_open 但有助手回复 -> sent=true（旧 else 分支等价）', () => {
  const r = evalExpr(buildSendCheckExpr('', false), { href: 'https://any', assistantPresent: true, residual: '__NOEL__' });
  assert.equal(r.sent, true);
});

test('④ 行为：initialUrlNorm 为空 + url_open 有值 -> 不因空值误判 sent', () => {
  const r = evalExpr(buildSendCheckExpr('', true), { href: 'https://site/1', residual: '__NOEL__' });
  assert.equal(r.sent, false);
});

test('④ 行为：输入框残余非空 -> sent=false 且 residualLen 正确（URL 变化也无用）', () => {
  const r = evalExpr(buildSendCheckExpr('https://site', true), { href: 'https://site/x', residual: '  未完  ' });
  assert.equal(r.sent, false);
  assert.equal(r.residualLen, 2);
});