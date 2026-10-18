// lib/session-nav.mjs — T-61 P6a 提取（机械搬移自 orchestrate.mjs；块体逐字节未动，仅加 export 前缀）
// 符号集（计划 C-6a：CDP 会话导航/附着/探测/截图/响应等待 + ensure-tabs 检测）：
//   块1（原 L374-610）：attachToTarget/logEnsure/tryFetchVersion/ensureTabs/probeTab/
//     screenshotTab/waitForResponse（内嵌 pollOnce）六函数连续体；
//   块2（原 L934-964）：前置注释 L934-937 + navigateToFreshChat（会话隔离导航）。
//   export 面 6 符号：attachToTarget/ensureTabs/probeTab/screenshotTab/waitForResponse/
//     navigateToFreshChat；logEnsure/tryFetchVersion/pollOnce 零块外引用，模块内部化。
// 依赖（块内自由标识符扫描实证 tmp/t61/p6a-depscan.mjs；误报已逐一剔除）：
//   node:fs appendFileSync/mkdirSync/writeFileSync、node:path dirname、
//   cdp-client CDP、constants CDP_HOST/ENSURE_LOG/START_BAT/CDP_VERSION_PROBE_TIMEOUT_MS/
//   CDP_ATTACH_RETRIES/CDP_ATTACH_RETRY_DELAY_MS/RESPONSE_STABLE_DEFAULT_MS/RESPONSE_POLL_MAX/
//   TIMEOUT_INLINE_BASE_MS、prompts buildSnapshotScript、reviewers getReviewers、
//   markers isPromptContaminated。
//   剔除误报：captureScreenshot='Page.captureScreenshot' 协议字符串非标识符引用；
//   splitEndMarkers/markerStart/markerEnd/setDispatchMarkers/main/prompt 仅存在于块内注释；
//   join 为 Array.prototype.join 方法调用非 node:path。
// 入口面：回迁 import 六符号（块外引用实证 attachToTarget L987/L1894、ensureTabs L1423、
//   probeTab L1497/L1641、screenshotTab L915/L1271/L1522/L1666、waitForResponse L1127/L1258、
//   navigateToFreshChat L822/L998/L1898）；P6b 计划依赖 attachToTarget/navigateToFreshChat/
//   waitForResponse/screenshotTab 届时自此转引。
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CDP } from '../cdp-client.mjs';
import { CDP_HOST, ENSURE_LOG, START_BAT, CDP_VERSION_PROBE_TIMEOUT_MS, CDP_ATTACH_RETRIES, CDP_ATTACH_RETRY_DELAY_MS, RESPONSE_STABLE_DEFAULT_MS, RESPONSE_POLL_MAX, TIMEOUT_INLINE_BASE_MS } from './constants.mjs';
import { buildSnapshotScript } from './prompts.mjs';
import { getReviewers } from './reviewers.mjs';
import { isPromptContaminated } from './markers.mjs';

export async function attachToTarget(cdp, page) {
    const attach = await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true });
    return attach.sessionId;
}

// ---------- ensure-tabs（仅检测，不启动 Chrome） ----------
function logEnsure(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  console.log(line);
  try {
    mkdirSync(dirname(ENSURE_LOG), { recursive: true });
    appendFileSync(ENSURE_LOG, line + '\n', 'utf8');
  } catch (e) { console.warn('[WARN] ensure-tabs 日志写入失败: ' + e.message); }
}

async function tryFetchVersion() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CDP_VERSION_PROBE_TIMEOUT_MS);
    const r = await fetch('http://' + CDP_HOST + '/json/version', { signal: controller.signal });
    clearTimeout(timeout);
    if (r.ok) return await r.json();
  } catch (e) { console.warn('[WARN] /json/version 探测失败: ' + e.message); }
  return null;
}

export async function ensureTabs() {
  logEnsure('=== ensure-tabs start ===');
  const version = await tryFetchVersion();
  if (!version) {
    logEnsure('9222 unreachable.');
    logEnsure('请双击 ' + START_BAT + ' 启动 CDP Chrome，');
    logEnsure('确认 enabled reviewer 网站已打开并登录后，重新运行本命令。');
    return false;
  }
  logEnsure('9222 OK: ' + version.Browser);
  logEnsure('ws: ' + version.webSocketDebuggerUrl);

  const cdp = new CDP(version.webSocketDebuggerUrl);
  try {
    await cdp.connect();
  } catch (e) {
    logEnsure('WS connect FAILED: ' + e.message);
    return false;
  }

  try {
    const list = await fetch('http://' + CDP_HOST + '/json/list').then(r => r.json());
    for (const rv of getReviewers()) {
      const page = list.find(x => x.type === 'page' && rv.url_match && rv.url_match.test(x.url));
      if (!page) {
        logEnsure(rv.name + ': MISSING tab (' + rv.url_match + ')');
        continue;
      }
      try {
        // P2-01: attachToTarget 重试 3 次
        let sessionId = null;
        for (let i = 0; i < CDP_ATTACH_RETRIES; i++) {
          try {
            const attach = await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true });
            sessionId = attach.sessionId;
            break;
          } catch (e) {
            if (i === CDP_ATTACH_RETRIES - 1) throw e;
            await new Promise(r => setTimeout(r, CDP_ATTACH_RETRY_DELAY_MS));
          }
        }
        await cdp.send('Runtime.enable', {}, sessionId);
        const snap = await cdp.send('Runtime.evaluate', {
          expression: '(() => { const t = document.body ? document.body.innerText : ""; const btns = document.querySelectorAll("input[type=email], input[type=password], button").length; return { url: location.href, head: t.slice(0, 2000), title: document.title, loginForms: btns }; })()',
          returnByValue: true,
        }, sessionId);
        const v = snap.result.value;
        // P2-02: 登录检测精确化 - 用登录表单元素数判断，避免"登录记录"等误报
        const needsLogin = v.loginForms > 0 || /(?:sign\s*in|log\s*in|登录)\s*(?![^<]*记录|history)/i.test(v.head);
        logEnsure(rv.name + ': title="' + v.title + '" url=' + v.url + ' loginHint=' + (needsLogin ? 'NEEDS-LOGIN' : 'ok'));
      } catch (e) {
        logEnsure(rv.name + ' check failed: ' + e.message);
      }
    }
    const missingAfter = getReviewers().filter(rv => !list.find(x => x.type === 'page' && rv.url_match && rv.url_match.test(x.url)));
    if (missingAfter.length > 0) {
      logEnsure('still missing: ' + missingAfter.map(r => r.name).join(','));
      return false;
    }
    logEnsure('[ENSURE-TABS] ready: ' + getReviewers().map(r => r.name).join('/'));
    return true;
  } finally {
    cdp.close();
  }
}




// ---------- prompt 污染检测（T-56 W4 迁 lib/markers.mjs，此处只保留引用） ----------
// markerStart/markerEnd/setDispatchMarkers/splitEndMarkers/isPromptContaminated 均自 lib 导入；
// M-17 原子修复：后缀 marker 机制照常生效（main 生成 dispatchId 后立即 setDispatchMarkers）。

// ---------- tab 操作 ----------
export async function probeTab(cdp, page, reviewer) {
    const sessionId = await attachToTarget(cdp, page);
  await cdp.send('Runtime.enable', {}, sessionId);
  const snap = await cdp.send('Runtime.evaluate', {
    expression: buildSnapshotScript(reviewer && reviewer.response_selector),
    returnByValue: true,
  }, sessionId);
  return { sessionId, snapshot: snap.result.value };
}

export async function screenshotTab(cdp, sessionId, outPath) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId, 30000);
  const buf = Buffer.from(r.data, 'base64');
  writeFileSync(outPath, buf);
  return { bytes: buf.length };
}

export async function waitForResponse(cdp, sessionId, { maxMs = TIMEOUT_INLINE_BASE_MS, stableMs = RESPONSE_STABLE_DEFAULT_MS, pollMax = RESPONSE_POLL_MAX, extraSelectors, graceMs = 60000 } = {}) {
  const start = Date.now();
  let lastLen = -1;
  let lastBodyLen = -1;
  let lastChangeAt = Date.now();
  let lastBodyChangeAt = Date.now();
  let lastAfterLen = -1;
  let lastAfterChangeAt = Date.now();
  // T-89：afterMarker 基线——marker 出现后的第一次采样长度。此后 afterMarker 必须
  // 较基线增长（本轮新回复落地）或含 ISSUE-ID，才允许完成判定（见 markerGateOk）。
  let baseAfterLen = -1;
  let attempts = 0;
  let lastUrl = '';

  let pollFailCount = 0;
  const pollOnce = async () => {
    try {
      const snap = await cdp.send('Runtime.evaluate', {
        expression: buildSnapshotScript(extraSelectors),
        returnByValue: true,
      }, sessionId);
      const v = snap && snap.result && snap.result.value;
      if (!v) {
        // 页面导航/执行上下文切换时，evaluate 常返回 {result:{type:"undefined"}}
        // 或 exceptionDetails（无 value 键）。不能把 undefined 交给上层解引用。
        pollFailCount++;
        const why = (snap && snap.result && snap.result.exceptionDetails)
          ? 'exception: ' + String(snap.result.exceptionDetails.exception?.description || snap.result.exceptionDetails.text).slice(0, 200)
          : 'no-value: ' + JSON.stringify(snap && snap.result).slice(0, 200);
        if (pollFailCount >= 5) throw new Error('pollOnce consecutive failures: ' + why);
        return {
          url: '', title: '', readyState: '', bodyLen: lastBodyLen,
          lastText: '', lastTextLen: lastLen,
          bodyTail: '', realTail: '', realTailLen: 0,
          afterMarker: '', afterMarkerLen: 0,
          generating: true, ts: Date.now(), _pollError: why,
        };
      }
      pollFailCount = 0;
      return v;
    } catch (e) {
      pollFailCount++;
      if (pollFailCount >= 5) throw new Error('pollOnce consecutive failures: ' + e.message);
      return {
        url: '', title: '', readyState: '', bodyLen: lastBodyLen,
        lastText: '', lastTextLen: lastLen,
        bodyTail: '', realTail: '', realTailLen: 0,
        afterMarker: '', afterMarkerLen: 0,
        generating: true, ts: Date.now(), _pollError: e.message,
      };
    }
  };

// Exponential backoff parameters
let baseInterval = 100; // Start with 100ms instead of 1500ms
let maxInterval = 2000; // Cap at 2 seconds
let currentInterval = baseInterval;

  const tryComplete = (s) => {
    const tailText = (s.afterMarkerLen > 50) ? s.afterMarker
      : (s.realTailLen > 50) ? s.realTail : (s.bodyTail || '');
    const tailTag = (s.afterMarkerLen > 50) ? 'AFTER_MARKER'
      : (s.realTailLen > 50) ? 'REAL_TAIL' : 'BODY_TAIL';
    const isPromptEcho = /=== 本次审阅开始（以下待审 artifact）===|#dispatch=|=== 待审 artifact 全文结束（以下为你的回答）===|#dispatch=/.test(s.lastText || '');
    const issueIdAfterMarker = /^[ \t]*ISSUE-ID\s*[:：]/m.test(s.afterMarker || '');
    const isRealReview = issueIdAfterMarker || (s.lastTextLen >= 200 && !isPromptEcho);
    // T-89：marker 首见采样即基线（tryComplete 全调用点共用：主循环/grace/收尾）
    if (baseAfterLen < 0 && s.markerFound) baseAfterLen = s.afterMarkerLen;
    // T-89 afterMarker 基线闸：marker 在场时 lastText 可能是 marker 之前的陈旧旧回复
    // （复用脏会话实证 29c93600——旧 V8 回复 950 字先满足稳定窗）。必须 afterMarker
    // 含本轮 ISSUE-ID 或较基线增长，才放行完成判定。
    const markerGateOk = !s.markerFound || issueIdAfterMarker || (baseAfterLen >= 0 && s.afterMarkerLen > baseAfterLen);
    if (!s.generating && s.lastTextLen > 0 && isRealReview && markerGateOk && Date.now() - lastChangeAt > stableMs) {
      if (s.lastTextLen < 50) {
        if (isPromptContaminated(tailText)) return { ...s, lastText: '', lastTextLen: 0, fallback: 'PROMPT_CONTAMINATED_NO_RESPONSE' };
        return { ...s, lastText: tailText, lastTextLen: tailText.length, fallback: 'SHORT_SELECT_' + tailTag };
      }
      return s;
    }
    if (s.afterMarkerLen > 50 && markerGateOk && !s.generating && Date.now() - lastAfterChangeAt > stableMs) {
      if (isPromptContaminated(s.afterMarker)) return { ...s, lastText: '', lastTextLen: 0, fallback: 'PROMPT_CONTAMINATED_NO_RESPONSE' };
      return { ...s, lastText: s.afterMarker, lastTextLen: s.afterMarkerLen, fallback: 'AFTER_MARKER' };
    }
    return null;
  };

  while (Date.now() - start < maxMs && attempts < pollMax) {
    const s = await pollOnce();
    attempts++;
    if (s.lastTextLen !== lastLen) { lastLen = s.lastTextLen; lastChangeAt = Date.now(); }
    if (s.bodyLen !== lastBodyLen) { lastBodyLen = s.bodyLen; lastBodyChangeAt = Date.now(); }
    if (s.afterMarkerLen !== lastAfterLen) { lastAfterLen = s.afterMarkerLen; lastAfterChangeAt = Date.now(); }
    if (s.url && s.url !== lastUrl) { lastUrl = s.url; lastChangeAt = Date.now(); lastBodyChangeAt = Date.now(); lastAfterChangeAt = Date.now(); }
    const tailText = (s.afterMarkerLen > 50) ? s.afterMarker
      : (s.realTailLen > 50) ? s.realTail : (s.bodyTail || '');
    const tailTag = (s.afterMarkerLen > 50) ? 'AFTER_MARKER'
      : (s.realTailLen > 50) ? 'REAL_TAIL' : 'BODY_TAIL';
    const completed = tryComplete(s);
    if (completed) return completed;
    // 已确认消息发出（sent 阶段保证输入框清空/URL 跳变）后，
    // 唯一可信的"响应完成"信号是 model-response 类选择器出现非空内容且稳定。
    // 不再用 bodyLen>1000 门槛——SPA 会话页初始 DOM 可能极小（DeepSeek bodyLen=58）。
    // P1-03: ISSUE-ID 必须出现在 marker 之后（afterMarker）才算真实回复；
    // prompt 自带 "ISSUE-ID: G-01" 示例，旧逻辑会把含示例的用户气泡回显当回复。
    // 同时排除含 marker 的 prompt 回显。
    const isPromptEcho = /=== 本次审阅开始（以下待审 artifact）===|#dispatch=|=== 待审 artifact 全文结束（以下为你的回答）===|#dispatch=/.test(s.lastText || '');
    const issueIdAfterMarker = /^[ \t]*ISSUE-ID\s*[:：]/m.test(s.afterMarker || '');
    const isRealReview = issueIdAfterMarker || (s.lastTextLen >= 200 && !isPromptEcho);
    // T-89：与 tryComplete 同闸（此块为同条件复写，保持两处一致防回归）
    if (baseAfterLen < 0 && s.markerFound) baseAfterLen = s.afterMarkerLen;
    const markerGateOk = !s.markerFound || issueIdAfterMarker || (baseAfterLen >= 0 && s.afterMarkerLen > baseAfterLen);
    if (!s.generating && s.lastTextLen > 0 && isRealReview && markerGateOk && Date.now() - lastChangeAt > stableMs) {
      if (s.lastTextLen < 50) {
        if (isPromptContaminated(tailText)) {
          return { ...s, lastText: '', lastTextLen: 0, fallback: 'PROMPT_CONTAMINATED_NO_RESPONSE' };
        }
        return { ...s, lastText: tailText, lastTextLen: tailText.length, fallback: 'SHORT_SELECT_' + tailTag };
      }
      return s;
    }
    // afterMarker 通道：marker 之后已有实质内容且稳定（适用无 model-response 选择器的站点）。
    // P1-01: afterMarker 已不含 marker 本身，可直接作为真实回复返回。
    if (s.afterMarkerLen > 50 && markerGateOk && !s.generating && Date.now() - lastAfterChangeAt > stableMs) {
      if (isPromptContaminated(s.afterMarker)) {
        return { ...s, lastText: '', lastTextLen: 0, fallback: 'PROMPT_CONTAMINATED_NO_RESPONSE' };
      }
      return { ...s, lastText: s.afterMarker, lastTextLen: s.afterMarkerLen, fallback: 'AFTER_MARKER' };
    }
    
    // Exponential backoff with reset on change detection
    const hasChange = (s.lastTextLen !== lastLen) || (s.bodyLen !== lastBodyLen) || (s.afterMarkerLen !== lastAfterLen);
    if (hasChange) {
      // Reset interval when we detect changes to be more responsive
      currentInterval = baseInterval;
    } else {
// Increase interval exponentially, but cap at maxInterval
currentInterval = Math.min(currentInterval * 2.0, maxInterval);
    }
    
    await new Promise(r => setTimeout(r, currentInterval));
  }
  const graceUntil = Date.now() + graceMs;
  while (Date.now() < graceUntil) {
    try {
      const s = await pollOnce();
      if (s.lastTextLen !== lastLen) { lastLen = s.lastTextLen; lastChangeAt = Date.now(); }
      if (s.bodyLen !== lastBodyLen) { lastBodyLen = s.bodyLen; lastBodyChangeAt = Date.now(); }
      if (s.afterMarkerLen !== lastAfterLen) { lastAfterLen = s.afterMarkerLen; lastAfterChangeAt = Date.now(); }
      if (s.url && s.url !== lastUrl) { lastUrl = s.url; lastChangeAt = Date.now(); lastBodyChangeAt = Date.now(); lastAfterChangeAt = Date.now(); }
      const completed = tryComplete(s);
      if (completed) return completed;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 1000));
  }

  const s = await pollOnce();
  {
    const tailText = (s.afterMarkerLen > 50) ? s.afterMarker
      : (s.realTailLen > 50) ? s.realTail : (s.bodyTail || '');
    const tailTag = (s.afterMarkerLen > 50) ? 'AFTER_MARKER'
      : (s.realTailLen > 50) ? 'REAL_TAIL' : 'BODY_TAIL';
    if (s.afterMarkerLen > 50 || s.lastTextLen > 0 || s.realTailLen > 50) {
      if (isPromptContaminated(tailText)) {
        return { ...s, lastText: '', lastTextLen: 0, fallback: 'PROMPT_CONTAMINATED_NO_RESPONSE' };
      }
      const isPromptEcho = /=== 本次审阅开始（以下为待审 artifact）===|=== 待审 artifact 全文结束（以下为你的回答）===/.test(s.lastText || '');
      const t = (s.lastTextLen > 50 && !isPromptEcho) ? s.lastText : tailText;
      return { ...s, lastText: t, lastTextLen: t.length, fallback: 'TIMEOUT_' + tailTag };
    }
  }
  throw new Error('waitForResponse timeout');
}

// ---------- 会话隔离：分发前导航到新会话页 ----------
// waitForResponse 以"文本长度稳定 stableMs 即完成"判定响应，若 tab 沿用上一轮会话，
// 上一轮 assistant 回答在 DOM 里早已稳定，会被立即当作本轮响应返回（陈旧捕获）。
// 导航到 url_open（新会话 URL）后等页面载入，从根本上消除旧上下文。
export async function navigateToFreshChat(cdp, sessionId, reviewer) {
  const url = reviewer.url_open;
  if (!url) return { ok: false, error: 'no url_open configured' };
  try {
    await cdp.send('Page.navigate', { url }, sessionId);
    // 轮询等待载入：readyState complete 且编辑器出现，最长 30s
    const t0 = Date.now();
    const editorSel = reviewer.editor_selector || '';
    const expr = '(() => { const ready = document.readyState === "complete"; ' +
      (editorSel ? ('const ed = document.querySelector(' + JSON.stringify(editorSel) + '); const edOk = !!(ed && (ed.offsetParent !== null || ed.getBoundingClientRect().height > 0));') : 'const edOk = true;') +
      ' return { ready, edOk, bodyLen: document.body ? document.body.innerText.length : 0 }; })()';
    let lastBody = -1;
    let stableSince = Date.now();
     while (Date.now() - t0 < 30000) {
       const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
       const v = r.result.value || {};
       if (v.bodyLen !== lastBody) { lastBody = v.bodyLen; stableSince = Date.now(); }
       if (v.ready && v.edOk && v.bodyLen > 0 && Date.now() - stableSince > 1500) {
         return { ok: true, url, bodyLen: v.bodyLen };
       }
       await new Promise(x => setTimeout(x, 200));
     }
    return { ok: false, error: 'fresh page load poll timeout', url };
  } catch (e) {
    return { ok: false, error: e.message, url };
  }
}
