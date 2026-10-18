// orchestrator/lib/markers.mjs — T-56 W4（M-17 原子修复）：prompt 边界 marker 套件唯一事实源
// 背景（M-17）：setDispatchMarkers 从未被调用 → marker 后缀机制从未生效；prompt 构造用
// 裸常量（PROMPT_MARKER_START/END），检测却用带后缀函数 —— 产出与检测两套语义错位；
// markerEnd(dispatchMarkerSuffix) 调用点传了参数但函数不收 → 静默错配。
// 三处同改（禁止单点修）：
//   1. main 在两个 dispatchId 生成点之后调 setDispatchMarkers(dispatchId)
//   2. buildReviewPrompt/buildUploadPrompt 改调 markerStart()/markerEnd()
//   3. markerStart/markerEnd 支持可选 suffix 参数 —— markerEnd('') 显式返回无后缀版，
//      保留旧 dispatch（无后缀 marker）与未知来源文本的兼容解析。
// 契约见 orchestrator/test/markers.test.mjs（三态：后缀→contaminated / 旧无后缀→true / 干净→false）。

export const PROMPT_MARKER_START = '=== 本次审阅开始（以下为待审 artifact）===';
export const PROMPT_MARKER_END = '=== 待审 artifact 全文结束（以下为你的回答）===';

// P2-15: 每次 dispatch 给 marker 追加 dispatchId 后缀，使"自审"场景（artifact 自身含
// marker 片段，reviewer 在"位置"里引用它）不再误判边界、丢弃 findings。
// 旧 dispatch（如 66c0f00e）用的是无后缀 marker；解析侧同时认两种（见 orchestrate splitFindings）。
import { AsyncLocalStorage } from 'node:async_hooks';

const suffixContext = new AsyncLocalStorage();
let fallbackSuffix = '';

export function setDispatchMarkers(dispatchId) { fallbackSuffix = dispatchId || ''; }

export function currentDispatchSuffix() { return suffixContext.getStore() ?? fallbackSuffix; }

export function withDispatchSuffix(suffix, run) { return suffixContext.run(suffix || '', run); }

export function markerStart(suffix) {
  const s = suffix === undefined ? currentDispatchSuffix() : (suffix || '');
  return s ? PROMPT_MARKER_START + ' #dispatch=' + s : PROMPT_MARKER_START;
}

export function markerEnd(suffix) {
  const s = suffix === undefined ? currentDispatchSuffix() : (suffix || '');
  return s ? PROMPT_MARKER_END + ' #dispatch=' + s : PROMPT_MARKER_END;
}

export function splitEndMarkers() {
  const s = currentDispatchSuffix();
  return s ? [markerEnd(), markerEnd('')] : [markerEnd()];
}

export function isPromptContaminated(text) {
  if (!text) return false;
  const s = currentDispatchSuffix();
  const ends = s ? [markerEnd(), markerEnd('')] : [markerEnd()];
  for (const m of ends) {
    if (text.includes(m)) return true;
  }
  const starts = s ? [markerStart(), markerStart('')] : [markerStart()];
  for (const m of starts) {
    if (text.includes(m)) return true;
  }
  return false;
}