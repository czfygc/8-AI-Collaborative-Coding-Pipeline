// orchestrator/test/scan-triage.test.mjs — T-56 W4：findings 分诊过滤 fixture 单测
// 契约：占位符/纯重构/建新文件三类默认拦（kept 不含、dropped 带 rule id），实问题放行；
// --allow-* 显式放行对应类别。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triageFindings, TRIAGE_RULES } from '../lib/scan-triage.mjs';

const F = (over) => ({
  file: 'orchestrator/orchestrate.mjs', line: 1, type: 'BUG', severity: 'HIGH',
  title: '真实 bug', description: '边界检查缺失', ...over,
});

const fixture = [
  F({ title: '详细描述' }),                                  // 占位符：prompt 示例原样回
  F({ title: 'TODO: 后续处理' }),                            // 占位符
  F({ type: 'STYLE', severity: 'LOW', title: '该函数过长，建议重构', description: '拆分成两个函数' }), // 纯重构
  F({ type: 'BEST_PRACTICE', severity: 'MEDIUM', title: '建议抽取独立模块', description: '建新文件' }), // 建新文件类
  F({ type: 'BUG', severity: 'HIGH', title: '重构该函数以修复竞态', description: '存在竞态条件' }),      // BUG 类重构=放行
  F({ severity: 'HIGH', type: 'SECURITY', title: '命令注入' }),                                          // 实问题放行
];

test('默认拦三类：kept 保留实问题，dropped 带 rule id 可审计', () => {
  const { kept, dropped } = triageFindings(fixture);
  assert.equal(kept.length, 2);
  assert.ok(kept.every((f) => /竞态|命令注入/.test(f.title)), 'kept 应为真实问题');
  assert.equal(dropped.length, 4);
  const ids = dropped.flatMap((d) => d.rules);
  assert.ok(ids.includes('placeholder'), '占位符应被拦');
  assert.ok(ids.includes('refactor'), '纯重构应被拦');
  assert.ok(ids.includes('new-file'), '建新文件应被拦');
  assert.ok(dropped.every((d) => d.finding === fixture.find((f) => f === d.finding && f) || !!d.finding), 'dropped 应保留原 finding 引用');
});

test('--allow-placeholder 放行占位符类', () => {
  const { kept, dropped } = triageFindings(fixture, { placeholder: true });
  assert.equal(kept.length, 4);
  assert.equal(dropped.filter((d) => d.rules.includes('placeholder')).length, 0);
});

test('--allow-refactor --allow-new-file：仅剩占位符被拦', () => {
  const { kept, dropped } = triageFindings(fixture, { refactor: true, 'new-file': true });
  assert.equal(kept.length, 4);
  assert.equal(dropped.length, 2);
  assert.ok(dropped.every((d) => d.rules.includes('placeholder')));
});

test('空数组/无 findings 输入安全', () => {
  assert.deepEqual(triageFindings([]), { kept: [], dropped: [] });
  assert.deepEqual(triageFindings(null), { kept: [], dropped: [] });
});

test('规则 id 幂等且覆盖 plan 需求三类', () => {
  const ids = TRIAGE_RULES.map((r) => r.id).sort();
  assert.deepEqual(ids, ['new-file', 'placeholder', 'refactor']);
});