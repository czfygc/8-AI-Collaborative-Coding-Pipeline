// orchestrator/test/scan-args.test.mjs — T-56 W2.3：forceLocalOnly 纯函数三组合
// 背景（C-03）：orchestrate.mjs scan 块内 `const localOnly` 被 `localOnly = true` 重赋值
// —— 多文件且未带 --local-only 时 TypeError 炸断整个 scan 模式；且旧警告文案自相矛盾
// （"To use web seats with multi-file scans, please use --local-only"——带 --local-only 恰是
// 不要 web seats）。修复：抽 pure function forceLocalOnly(scanIsMulti, localOnly) 进
// orchestrator/lib/scan-args.mjs，scan 块改动态 import，警告文案改为自洽表述。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forceLocalOnly } from '../lib/scan-args.mjs';

test('三组合之一：单文件+未带 flag → 不强制（网页席保留）', () => {
  assert.equal(forceLocalOnly(false, false), false);
});

test('三组合之二：多文件+未带 flag → 强制 local-only（网页席收不到 N-1 文件）', () => {
  assert.equal(forceLocalOnly(true, false), true);
});

test('三组合之三：多文件+已带 flag → 保持 true', () => {
  assert.equal(forceLocalOnly(true, true), true);
});

test('边界：单文件+已带 flag → 保持 true', () => {
  assert.equal(forceLocalOnly(false, true), true);
});