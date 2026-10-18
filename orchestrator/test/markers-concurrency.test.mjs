// T-70 markers.mjs 等价性探针：suffix 语义
// 1. 单线程等价：setDispatchMarkers 后 markerEnd() 带 #dispatch=<id>，markerEnd('') 裸版（与 markers.test.mjs A/B 一致）
// 2. 并发隔离：withDispatchSuffix 下两个并发 dispatch 的 marker 后缀互不干扰（旧模块级单例无此能力）
// 3. 嵌套作用域：取最近 ALS 作用域，退出后回落模块级 fallback
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROMPT_MARKER_END, markerEnd, setDispatchMarkers, currentDispatchSuffix, withDispatchSuffix,
} from '../lib/markers.mjs';

test('探针：setDispatchMarkers 单线程语义等价（markerEnd 带后缀 / 裸版）', () => {
  setDispatchMarkers('abc12345');
  assert.equal(currentDispatchSuffix(), 'abc12345');
  assert.equal(markerEnd(), PROMPT_MARKER_END + ' #dispatch=abc12345');
  assert.equal(markerEnd(''), PROMPT_MARKER_END);
});

test('探针：两个并发 dispatch 的 marker 后缀隔离（withDispatchSuffix）', async () => {
  const [endA, endB] = await Promise.all([
    withDispatchSuffix('dispatch-A', () => markerEnd()),
    withDispatchSuffix('dispatch-B', () => markerEnd()),
  ]);
  assert.equal(endA, PROMPT_MARKER_END + ' #dispatch=dispatch-A');
  assert.equal(endB, PROMPT_MARKER_END + ' #dispatch=dispatch-B');
});

test('探针：嵌套作用域取最近 ALS 层，退出后回落 fallback', async () => {
  setDispatchMarkers('fallback-id');
  const inner = await withDispatchSuffix('outer', async () => {
    return withDispatchSuffix('inner', () => markerEnd());
  });
  assert.equal(inner, PROMPT_MARKER_END + ' #dispatch=inner');
  assert.equal(markerEnd(), PROMPT_MARKER_END + ' #dispatch=fallback-id');
});
