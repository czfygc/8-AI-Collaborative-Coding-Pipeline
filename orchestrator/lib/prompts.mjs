// lib/prompts.mjs — T-61 P1 提取（机械搬移自 orchestrate.mjs；块体逐字节未动，仅加 export 前缀）
// 符号集（计划 C-1）：buildInjectScript/buildEditorStateScript/buildSubmitScript/buildRegenClickScript/
// buildSnapshotScript/buildSourceHeader/buildReviewPrompt/buildUploadPrompt（8 符号）。
// labelOf 为 buildRegenClickScript 模板串内嵌符号、随宿主整体搬移（审计 H2）；buildSourceHeader 归位
// 本模块而非 P6b——buildReviewPrompt/buildUploadPrompt 调用它，放 P6b 会成 prompts→session-send 环。
// 依赖：lib/markers.mjs（markerStart/markerEnd——prompt 边界标记）、lib/constants.mjs（截断/尾窗常量）。
import { markerStart, markerEnd } from './markers.mjs';
import { MAX_REPORT_CHARS, SNAPSHOT_TAIL_CHARS } from './constants.mjs';

// ---------- 注入/提交/快照脚本 ----------
export function buildInjectScript(promptText) {
  return `
(() => {
  const PROMPT = ${JSON.stringify(promptText)};
  const candidates = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
    .filter(e => {
      const r = e.getBoundingClientRect();
      return r.width > 100 && r.height > 20 && e.offsetParent !== null;
    })
    .sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * rb.height;
    });
  const el = candidates[0];
  if (!el) return { ok: false, error: 'no-input-found' };
  el.focus();
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set;
    setter.call(el, PROMPT);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (el.classList && el.classList.contains('ql-editor')) {
    // Quill 编辑器（Gemini）：先尝试 innerText（O(1)），未注册再用 execCommand 逐行兜底。
    // 关键：Gemini 的"发送"按钮只在 Quill 数据模型注册了内容后才亮起（disabled 消失），
    // 仅写 innerText 而未触发 Quill 的 delta 更新会导致 submit 点击无效——
    // 消息停留在输入框，waitForResponse 抓到的是页面脚本而非回复。
    el.focus();
    const setAndCheck = () => {
      el.innerText = PROMPT;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: PROMPT }));
      return (el.innerText || '').replace(/\\s/g, '').length;
    };
    let registered = setAndCheck();
      // 若 innerText 未被 Quill 注册，用 execCommand 逐段插入兜底（最多 500 行，防超时）
      if (registered === 0) {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
        const lines = PROMPT.split('\\n');
        // 限制行数以防止超时，超过限制则返回错误以强制使用上传通道
        if (lines.length > 500) {
          return { ok: false, error: 'INLINE_CONTENT_TOO_LARGE', lines: lines.length };
        }
        let execSuccess = false;
        try {
          for (let i = 0; i < lines.length; i++) {
            if (i > 0) document.execCommand('insertParagraph', false);
            if (lines[i]) document.execCommand('insertText', false, lines[i]);
          }
          execSuccess = true;
        } catch (e) {
          return { ok: false, error: 'quill-exec-command-threw', exception: e.toString() };
        }
        if (!execSuccess) {
          return { ok: false, error: 'quill-exec-command-failed' };
        }
        registered = (el.innerText || '').replace(/\\s/g, '').length;
        if (registered === 0) {
          return { ok: false, error: 'quill-registered-zero-after-exec' };
        }
      }
    // 兜底 2：Quill 实例直接 setContents（若可访问）
    if (registered === 0) {
      const quill = el.__quill || (el.closest('.ql-toolbar, .ql-container') && el.closest('.ql-toolbar, .ql-container').__quill);
      if (quill && quill.setContents) {
        // P2-03: 检查是否有已有草稿内容
        try {
          const contents = quill.getContents();
          if (contents && contents.ops && contents.ops.length > 1) {
            console.warn('[WARN] Quill editor has existing content (ops=' + contents.ops.length + ')');
          }
        } catch (e) { console.warn('[WARN] quill.getContents failed: ' + (e && e.message)); }
        quill.setContents([{ insert: PROMPT + '\\n' }]);
        registered = (el.innerText || '').replace(/\\s/g, '').length;
        // P2-03: 用 Quill ops 长度校验注册成功
        if (quill.getText && quill.getText().length < 100) {
          console.warn('[WARN] Quill getText() shows low registered length');
        }
      }
    }
    return { ok: true, tag: el.tagName, quill: true, textLen: (el.innerText || '').length, registered };
  } else {
    // T-62（2026-10-14）：ProseMirror 等 contenteditable——innerText 直写不进数据模型
    //（T-58 实测 textLen=1）；改 execCommand('insertText') 真实输入管线，读回验收后回落旧直写。
    el.focus();
    let viaExec = false;
    try {
      document.execCommand('selectAll', false, null);
      viaExec = document.execCommand('insertText', false, PROMPT) === true;
    } catch (e2) { viaExec = false; }
    const gotLen = (el.innerText || '').replace(/\\s/g, '').length;
    if (!viaExec || gotLen === 0) {
      el.innerText = PROMPT;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: PROMPT }));
    }
  }
  return { ok: true, tag: el.tagName, id: el.id, textLen: (el.innerText || '').length };
})()
`;
}

// R-04: 提交成功校验。注入用最宽输入框启发式（与 buildInjectScript 一致），
// 返回输入框残余文本长度与是否仍含本轮 prompt marker——marker 还在说明提交未成功。
export function buildEditorStateScript() {
  return `
(() => {
  const el = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
    .filter(e => { const r = e.getBoundingClientRect(); return r.width > 100 && r.height > 20 && e.offsetParent !== null; })
    .sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return rb.width * rb.height - ra.width * ra.height; })[0];
  if (!el) return { ok: false, error: 'no-input-found' };
  const txt = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? (el.value || '') : (el.innerText || '');
  return { ok: true, textLen: txt.length, containsMarker: txt.includes(${JSON.stringify(markerStart())}) || txt.includes(${JSON.stringify(markerEnd())}) };
})()
`;
}

export function buildSubmitScript(reviewer, mode = 'auto') {
  const submitSel = reviewer && reviewer.submit_selector ? JSON.stringify(reviewer.submit_selector) : null;
  // mode='enter' 强制 Enter；mode='button' 强制按钮（升级重试用，跳过 enter 分支）；
  // mode='auto' 按 reviewer.submit_method 走默认策略。
  const enterOnly = mode === 'enter' || (mode === 'auto' && !!(reviewer && reviewer.submit_method === 'enter'));
  return `
(() => {
  if (${enterOnly}) {
    // T-40: submit_method=enter（chatgpt 扫描席专用）——Enter 已触发提交后，同拍的
    // btns2 兜底点击会把同一 prompt 再发一遍（实测同页双气泡）。只走 Enter，不点按钮。
    const elE = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
      .filter(e => e.offsetParent !== null)
      .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
    if (!elE) return { ok: false, error: 'no-input-found' };
    elE.focus();
    const tryKeyE = (type) => elE.dispatchEvent(new KeyboardEvent(type, {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
    }));
    tryKeyE('keydown');
    tryKeyE('keypress');
    tryKeyE('keyup');
    return { ok: true, method: 'enter-only' };
  }
  const SUBMIT_SEL = ${submitSel};
  if (SUBMIT_SEL) {
    // 站点专用提交按钮（DeepSeek 圆形主按钮：类名匹配，无 send/发送 文本）
    const b = document.querySelector(SUBMIT_SEL);
    if (b) {
      b.click();
      return { ok: true, method: 'submit-selector' };
    }
  }
  // ChatGPT 发送按钮（附件态实测：按钮已亮但合成 Enter 不发送，必须真点按钮）
  const tidBtn = document.querySelector('button[data-testid="send-button"]');
  if (tidBtn && !tidBtn.disabled && tidBtn.getAttribute('aria-disabled') !== 'true') {
    tidBtn.click();
    return { ok: true, method: 'send-button-testid' };
  }
  const btns = [...document.querySelectorAll('button, [role="button"], [role="submit"]')].filter(b => {
    const t = (b.innerText || '').toLowerCase() + ' ' + (b.getAttribute('aria-label') || '').toLowerCase()
      + ' ' + (b.className || '').toString().toLowerCase();
    return /send|发送|submit/.test(t) && !b.disabled && !b.getAttribute('aria-disabled');
  });
  if (btns.length) {
    btns[0].click();
    return { ok: true, method: 'button' };
  }
  // 类名兜底：DeepSeek 的圆形主按钮（ds-button--circle.ds-button--primary）不含任何
  // send/发送 文案，正则永远匹配不到；在无 submit_selector 配置时按类名命中。
  const circleBtn = [...document.querySelectorAll('[role="button"],button')].filter(b => {
    const c = (b.className && b.className.baseVal !== undefined ? b.className.baseVal : b.className || '').toString();
    return /ds-button--circle/.test(c) && /ds-button--primary/.test(c) && !b.disabled && !b.getAttribute('aria-disabled');
  });
  if (circleBtn.length) {
    circleBtn[0].click();
    return { ok: true, method: 'circle-primary' };
  }
  const el = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
    .filter(e => e.offsetParent !== null)
    .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
  if (!el) return { ok: false, error: 'no-submit-target' };
  el.focus();
  // 深度兼容：部分前端（React 表单）只在 keydown + Enter 且 cancelable 时触发提交；
  // DeepSeek 还需同时派发 keyup 才能被其输入监听捕获。
  const tryKey = (type) => el.dispatchEvent(new KeyboardEvent(type, {
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
    bubbles: true, cancelable: true,
  }));
  tryKey('keydown');
  tryKey('keypress');
  tryKey('keyup');
  // 兜底：提交按钮可能在 Enter 之后才亮起，等一帧再点（IIFE 不可用 await，用同步降级：
  // 直接再扫一遍按钮，命中即点；没命中就靠 Enter 派发已足够）
  const btns2 = [...document.querySelectorAll('button')].filter(b => {
    const t = (b.innerText || '').toLowerCase() + ' ' + (b.getAttribute('aria-label') || '').toLowerCase();
    return /send|发送|submit/.test(t) && !b.disabled;
  });
  if (btns2.length) { btns2[0].click(); return { ok: true, method: 'enter+button' }; }
  return { ok: true, method: 'enter' };
})()`;
}

// 点"刷新/重新生成"按钮（T-40 用户反馈：chatgpt 等 4 页都有"刷新"选项，回复无意义
// 或空 [] 时需点它）。通用文本/aria 匹配（含菜单项与祖先标签），取最后命中（最新一条
// 消息的工具栏）；调用方在本脚本前会先悬停最后一条回复（部分站点工具栏 hover 才渲染）。
export function buildRegenClickScript(regenSelector = null) {
  const selectorExpr = regenSelector ? `(${JSON.stringify(regenSelector)})` : 'null';
  return `
(() => {
  const re = /\bregenerate\b|\bretry\b|重试|重新生成|重新回答|重新扫描/i;
      const labelOf = (b) => {
        let t = ((b.getAttribute && b.getAttribute('aria-label')) || '') + ' ';
        t += ((b.getAttribute && b.getAttribute('title')) || '') + ' ';
        t += (b.innerText || '');
        const p = b.parentElement;
        if (p) {
          t += ' ' + ((p.getAttribute && p.getAttribute('aria-label')) || '') + ' ';
          t += ((p.getAttribute && p.getAttribute('title')) || '');
        }
        return t.trim();
      };
      // 否则，限定在最后一条助手消息的操作栏
      const assistantMsgs = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
      let operationBarCandidates = [];
      
      if (assistantMsgs.length > 0) {
        const lastAssistantMsg = assistantMsgs[assistantMsgs.length - 1];
        // 向上查找最近的容器（最多3级），该容器可能包含操作栏
        let container = lastAssistantMsg;
        for (let i = 0; i < 3 && container.parentElement; i++) {
          container = container.parentElement;
          // 在此容器中查找操作栏元素
          const ops = [...container.querySelectorAll('button, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="option"]')]
            .filter(b => b.offsetParent !== null);
          if (ops.length > 0) {
            operationBarCandidates = ops;
            break;
          }
        }
        
        // 如果仍未找到，尝试在后续兄弟元素中查找
        if (operationBarCandidates.length === 0) {
          let sibling = lastAssistantMsg.nextElementSibling;
          let depth = 0;
          while (sibling && depth < 5) {
            const ops = [...sibling.querySelectorAll('button, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="option"]')]
              .filter(b => b.offsetParent !== null);
            if (ops.length > 0) {
              operationBarCandidates = ops;
              break;
            }
            sibling = sibling.nextElementSibling;
            depth++;
          }
        }
      }
      
      // 如果通过助手消息未找到操作栏，则回退到文档末尾附近的元素（更可能是最近的）
      if (operationBarCandidates.length === 0) {
        const allButtons = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="option"]')]
          .filter(b => b.offsetParent !== null);
        // 取最后20个按钮（它们是跟着回复消息出现的操作栏成员）
        operationBarCandidates = allButtons.slice(Math.max(0, allButtons.length - 20));
      }

const cands = operationBarCandidates
      .map(b => ({ b, label: labelOf(b) }))
      .filter(x => re.test(x.label));
      
      // 审阅者专用选择器优先
      const reviewerSelector = ${selectorExpr};
      if (reviewerSelector) {
        const reviewerCands = [...document.querySelectorAll(reviewerSelector)]
          .filter(b => b.offsetParent !== null)
          .map(b => ({ b, label: labelOf(b) }))
          .filter(x => re.test(x.label));
        if (reviewerCands.length > 0) {
          cands = reviewerCands;
        }
      }
  if (!cands.length) {
    const all = [...document.querySelectorAll('button, [role="button"]')]
      .filter(b => b.offsetParent !== null)
      .map(b => (b.getAttribute('aria-label') || b.innerText || '').trim())
      .filter(Boolean).slice(-15);
    return { ok: false, reason: 'no-regen-button', candidates: all };
  }
  const hit = cands[cands.length - 1];
  const label = hit.label.slice(0, 80);
  hit.b.click();
  return { ok: true, label };
})()`;
}

export function buildSnapshotScript(extraSelectors) {
  // T-62（2026-10-14）：per-seat response_selector 前插（字符串/数组皆可，见台账 T-62）。
  const extra = Array.isArray(extraSelectors)
    ? extraSelectors.filter((s) => typeof s === 'string' && s)
    : (typeof extraSelectors === 'string' && extraSelectors ? [extraSelectors] : []);
  return `
(() => {
  const rawBody = document.body ? document.body.innerText : '';
  const clean = (txt) => txt.split('\\n')
    .filter(l => !/^\\s*(text|copy|download|复制|下载)\\s*$/.test(l))
    .join('\\n')
    .trim();
  const bodyText = clean(rawBody);
  const selectors = [...${JSON.stringify(extra)},
    'model-response',
    'model-response-content',
    'response-container',
    'message-content',
    '[data-message-author-role="assistant"]',
    '.markdown',
    'article',
    '[class*="assistant"]',
    '[class*="response"]',
    '[data-test-id="model-response"]',
    '.model-response-text',
    '.response-container-content',
    '[data-testid="message-content"]',
    '.message-bubble'
  ];
  let lastText = '';
  const realNodes = [
    ...document.querySelectorAll('model-response, model-response-content, response-container, message-content, [data-message-author-role="assistant"], .markdown')
  ];
  const realTail = realNodes.length ? clean(realNodes[realNodes.length - 1].innerText || '') : '';
  for (const sel of selectors) {
    const nodes = [...document.querySelectorAll(sel)];
    if (nodes.length) {
      const t = clean(nodes[nodes.length - 1].innerText || '');
      if (t.length > lastText.length) lastText = t;
    }
  }
  const stopBtns = [...document.querySelectorAll('button')].filter(b => {
    const t = ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase();
    return /stop|停止|cancel|取消生成/.test(t);
  });
  // R-03: afterMarker 优先捕获（PROMPT_MARKER_END 之后的真实回答）
  // 注意：必须跳过 <script>/<style>/<noscript> 内容（它们会被 walker 遍历但非回答）。
  // 复用页面时，conversation 历史里可能有多个 marker，从最后一个开始找（当前轮次）。
  // DELTA-013（T-59 批2）：旧实现两次全量遍历 document.body（找 marker 一遍、收集其后
  // 文本又一遍），大 DOM 页每次 poll 双倍阻塞主线程；合并为单次遍历——先存全部文本节点，
  // 再从最后一个含 MARKER 的节点之后取非空文本。纯 querySelectorAll 不可行：marker 是
  // 文本内容，CSS 标准无文本选择器（:contains 为 jQuery 扩展，querySelectorAll 不支持）。
  // 输出语义与旧实现逐字段一致（A/B 证据 tmp/t59-b2/probe-013-ab.mjs）。
  const MARKER = ${JSON.stringify(markerEnd())};
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // 过滤掉 script/style/noscript 等标签的文本节点
      if (node.parentElement) {
        const tag = node.parentElement.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
          return NodeFilter.FILTER_REJECT;
        }
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const _texts = [];
  const _markerIdx = [];
  let _n;
  while ((_n = walker.nextNode())) {
    const _t = _n.textContent || '';
    if (_t.includes(MARKER)) _markerIdx.push(_texts.length);
    _texts.push(_t);
  }
  const _after = [];
  if (_markerIdx.length) {
    for (let _i = _markerIdx[_markerIdx.length - 1] + 1; _i < _texts.length; _i++) {
      const _t = _texts[_i].trim();
      if (_t) _after.push(_t);
    }
  }
  const afterMarkerRaw = _after.join('\\n').trim();
  // returnByValue 序列化上限：截断超长回答，避免 CDP 静默丢弃整个 value
  const afterMarker = afterMarkerRaw.length > ${MAX_REPORT_CHARS}
    ? afterMarkerRaw.slice(0, ${MAX_REPORT_CHARS}) + '\\n[TRUNCATED ' + (afterMarkerRaw.length - ${MAX_REPORT_CHARS}) + ' chars]'
    : afterMarkerRaw;
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    bodyLen: bodyText.length,
    lastText,
    lastTextLen: lastText.length,
    bodyTail: bodyText.slice(-${SNAPSHOT_TAIL_CHARS}),
    afterMarker,
    afterMarkerLen: afterMarker.length,
    realTail,
    realTailLen: realTail.length,
    generating: stopBtns.length > 0,
    // T-89：页面上是否能找到 dispatch marker 文本（最后出现处=本轮 prompt 气泡）。
    // waitForResponse 的 afterMarker 基线闸用它区分"陈旧会话旧回复"与"本轮新回复"。
    markerFound: _markerIdx.length > 0,
    ts: Date.now()
  };
})()
`;
}

// ---------- 来源标识头 + prompt 构建 ----------
export function buildSourceHeader(angle, dispatchId, timestamp, mode) {
  const modeLabel = mode === 'upload' ? 'Harness 自动分发（附件模式）' : 'Harness 自动分发';
  return [
    '---',
    '【来源】' + modeLabel,
    '【分发时间】' + timestamp,
    '【审阅视角】' + angle,
    '【分发 ID】' + dispatchId,
    '---',
    '',
    '',
  ].join('\n');
}

export function buildReviewPrompt(report, reviewer, dispatchId, timestamp) {
  const header = buildSourceHeader(reviewer.perspective, dispatchId, timestamp, 'inline');
  const body =
    '要求：\n' +
    '1. 输出结构化 ISSUE 列表，每条必须独占一块。\n' +
    '2. 每条 ISSUE 的第一行必须严格以 "ISSUE-ID: ' + reviewer.prefix + '-<NN>" 开头（<NN> 为两位数字，如 ' + reviewer.prefix + '-01）。\n' +
    '3. 每个字段单独占一行，行首固定写死字段名：\n' +
    '   ISSUE-ID: ' + reviewer.prefix + '-01\n' +
    '   标题：<一句话问题标题>\n' +
    '   位置：<引用报告原文片段>\n' +
    '   严重程度：<高|中|低>\n' +
    '   建议：<一句话>\n' +
    '4. 只列具体问题，不要笼统评价。\n' +
    '5. 如果某项无问题，明确说"该项无 ISSUE"。\n' +
    '6. 最多 20 条，按严重程度降序。\n' +
    '7. 在 ISSUE 列表末尾，添加一个结构化判定表：\n' +
    '   | 条目 | 判定 | 简要理由 |\n' +
    '   |---|---|---|\n' +
    '   | 安全性 | FAIL | 缺少边界检查 |\n' +
    '   | 性能 | PASS | 时间复杂度合理 |\n' +
    '   ...\n' +
    '\n' +
    markerStart() + '\n' +
    '=== 待审 artifact 全文 ===\n' +
    report + '\n' +
    markerEnd() + '\n';
  return header + reviewer.perspective_prompt + '\n\n' + body;
}

export function buildUploadPrompt(reviewer, dispatchId, timestamp, artifactFileName) {
  const header = buildSourceHeader(reviewer.perspective, dispatchId, timestamp, 'upload');
  const body =
    '附件是待审 artifact：' + artifactFileName + '\n' +
    '请先完整阅读附件，再输出审阅结果。\n' +
    '\n' +
    '要求：\n' +
    '1. 输出结构化 ISSUE 列表，每条必须独占一块。\n' +
    '2. 每条 ISSUE 的第一行必须严格以 "ISSUE-ID: ' + reviewer.prefix + '-<NN>" 开头（<NN> 为两位数字，如 ' + reviewer.prefix + '-01）。\n' +
    '3. 每个字段单独占一行，行首固定写死字段名：\n' +
    '   ISSUE-ID: ' + reviewer.prefix + '-01\n' +
    '   标题：<一句话问题标题>\n' +
    '   位置：<引用附件中的片段>\n' +
    '   严重程度：<高|中|低>\n' +
    '   建议：<一句话>\n' +
    '4. 只列具体问题，不要笼统评价。\n' +
    '5. 如果某项无问题，明确说"该项无 ISSUE"。\n' +
    '6. 最多 20 条，按严重程度降序。\n' +
    '7. 在 ISSUE 列表末尾，添加一个结构化判定表：\n' +
    '   | 条目 | 判定 | 简要理由 |\n' +
    '   |---|---|---|\n' +
    '   | 安全性 | FAIL | 缺少边界检查 |\n' +
    '   | 性能 | PASS | 时间复杂度合理 |\n' +
    '   ...\n' +
    '\n' +
    markerStart() + '\n' +
    '（artifact 见附件，不在此处重复）\n' +
    markerEnd() + '\n';
  return header + reviewer.perspective_prompt + '\n\n' + body;
}
