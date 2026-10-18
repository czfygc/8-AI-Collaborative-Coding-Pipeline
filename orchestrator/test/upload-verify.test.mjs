import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildAttachmentConfirmExpr } from '../lib/upload-verify.mjs';

test('expr 可解析且含 JSON 编码的文件名主名前缀（8 字符）', () => {
  const expr = buildAttachmentConfirmExpr('D:/x/a8-scan-target.cjs');
  assert.ok(typeof expr === 'string');
  new Function('return ' + expr); // 仅编译
  assert.ok(expr.includes('"a8-scan-"')); // 主名 a8-scan-target 的前 8 字符
});

test('Windows 反斜杠路径也能取到 basename（M9 类风险）', () => {
  const expr = buildAttachmentConfirmExpr('C:\\tmp\\attach-test.md');
  assert.ok(expr.includes('"attach-t"')); // 主名 attach-test 的前 8 字符
  new Function('return ' + expr); // 仅编译
});

test('行为等价：vm 假 DOM 下 命中/未命中', () => {
  const expr = buildAttachmentConfirmExpr('D:/x/attach-test.md');
  const ctxHit = { document: { body: { innerText: '… attach-test.md 20.0 B …' }, querySelector: () => null } };
  const ctxMiss = { document: { body: { innerText: 'nothing here' }, querySelector: () => null } };
  assert.equal(vm.runInNewContext(expr, vm.createContext(ctxHit)), true);
  assert.equal(vm.runInNewContext(expr, vm.createContext(ctxMiss)), false);
});

test('qwen 芯片渲染格式（扩展名前插空格）仍命中（T-58 实证修正）', () => {
  const expr = buildAttachmentConfirmExpr('D:/x/orchestrate.mjs');
  const ctxQwen = { document: { body: { innerText: '… orchestrate .mjs 205.0 KB …' }, querySelector: () => null } };
  assert.equal(vm.runInNewContext(expr, vm.createContext(ctxQwen)), true);
});

test('芯片省略号截断场景：前缀匹配仍成立（MiMo 处方③）', () => {
  const expr = buildAttachmentConfirmExpr('D:/t/abcdefghij-0123456789-very-long-name.md');
  const ctxLong = { document: { body: { innerText: '… abcdefgh …' }, querySelector: () => null } };
  assert.equal(vm.runInNewContext(expr, vm.createContext(ctxLong)), true);
  // 截断早于 8 字符的不命中（确认失败→降级拖拽，属预期行为）
  const ctxTooShort = { document: { body: { innerText: '… abcd …' }, querySelector: () => null } };
  assert.equal(vm.runInNewContext(expr, vm.createContext(ctxTooShort)), false);
});

test('extra selector（gemini wrapper）命中即 true', () => {
  const expr = buildAttachmentConfirmExpr('D:/x/foo.md', '.attachment-preview-wrapper');
  const ctxSel = { document: { body: { innerText: '' }, querySelector: (q) => (q === '.attachment-preview-wrapper' ? {} : null) } };
  assert.equal(vm.runInNewContext(expr, vm.createContext(ctxSel)), true);
});