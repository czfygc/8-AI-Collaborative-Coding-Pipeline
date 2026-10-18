// T-68：scan-entry 两处动态 import 运行时探针——真实执行 import()，断言目标可解析并导出预期符号。
// 验收：把 scan-entry.mjs 任一 import() 路径改坏，此处应红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScanEntry } from '../lib/scan-entry.mjs';
import * as scanFlow from '../scan-flow.mjs';
import * as scanArgs from '../lib/scan-args.mjs';

test('scan-entry：runScanEntry 导出为可调用函数', () => {
  assert.equal(typeof runScanEntry, 'function');
});

test('scan-entry 动态依赖：scan-flow.mjs 导出 runScanMode 与 parseFindingsJson', () => {
  assert.equal(typeof scanFlow.runScanMode, 'function');
  assert.equal(typeof scanFlow.parseFindingsJson, 'function');
});

test('scan-entry 动态依赖：scan-args.mjs 导出 forceLocalOnly', () => {
  assert.equal(typeof scanArgs.forceLocalOnly, 'function');
});
