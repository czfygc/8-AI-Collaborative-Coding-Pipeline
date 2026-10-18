// orchestrator/test/markers.test.mjs — T-56 W4（M-17）：marker 套件三态 + 后缀机制契约
// 背景（M-17）：setDispatchMarkers 从未被调用；prompt 用裸常量、检测用函数；markerEnd
// 调用点传参但函数不收。修复后契约：
//   A. setDispatchMarkers 生效后 markerStart()/markerEnd() 带 #dispatch=<id> 后缀
//   B. markerEnd('') 显式返回无后缀版（旧 dispatch 兼容解析）
//   C. isPromptContaminated 三态：带后缀→true / 旧无后缀→true / 干净→false
//   D. splitEndMarkers：后缀态返回 [带后缀, 无后缀]；无后缀态返回 [无后缀]

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROMPT_MARKER_START, PROMPT_MARKER_END,
  markerStart, markerEnd, setDispatchMarkers, currentDispatchSuffix,
  splitEndMarkers, isPromptContaminated,
} from '../lib/markers.mjs';

beforeEach(() => setDispatchMarkers(''));

test('A setDispatchMarkers 生效：markerStart/markerEnd 带 #dispatch= 后缀', () => {
  setDispatchMarkers('abc12345');
  assert.equal(currentDispatchSuffix(), 'abc12345');
  assert.equal(markerStart(), PROMPT_MARKER_START + ' #dispatch=abc12345');
  assert.equal(markerEnd(), PROMPT_MARKER_END + ' #dispatch=abc12345');
});

test('B 无后缀兼容：markerEnd("") 显式返回裸 marker', () => {
  setDispatchMarkers('abc12345');
  assert.equal(markerEnd(''), PROMPT_MARKER_END);
  assert.equal(markerStart(''), PROMPT_MARKER_START);
});

test('C 三态之一：带后缀 marker → contaminated=true', () => {
  setDispatchMarkers('abc12345');
  const text = 'prompt 回显\n' + markerEnd() + '\n这是我的回答';
  assert.equal(isPromptContaminated(text), true);
});

test('C 三态之二：旧无后缀 marker → contaminated=true（兼容旧 dispatch）', () => {
  setDispatchMarkers('abc12345');
  const text = 'prompt 回显\n' + PROMPT_MARKER_END + '\n这是我的回答';
  assert.equal(isPromptContaminated(text), true);
});

test('C 三态之三：干净回复 → contaminated=false', () => {
  setDispatchMarkers('abc12345');
  const text = 'ISSUE-ID: G-01\n标题：真问题\n这是干净的回复，无任何 marker';
  assert.equal(isPromptContaminated(text), false);
});

test('C 边界：空文本/null → false', () => {
  assert.equal(isPromptContaminated(''), false);
  assert.equal(isPromptContaminated(null), false);
});

test('D splitEndMarkers：后缀态返回 [带后缀, 无后缀]；无后缀态返回 [无后缀]', () => {
  setDispatchMarkers('');
  assert.deepEqual(splitEndMarkers(), [PROMPT_MARKER_END]);
  setDispatchMarkers('feedbeef');
  assert.deepEqual(splitEndMarkers(), [PROMPT_MARKER_END + ' #dispatch=feedbeef', PROMPT_MARKER_END]);
});