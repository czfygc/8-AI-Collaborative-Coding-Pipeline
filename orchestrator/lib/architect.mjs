// lib/architect.mjs — T-61 P7 提取（机械搬移自 orchestrate.mjs；块体逐字节未动，仅加 export 前缀）
// 符号集（计划 C-7：架构师裁决链——ChatGPT 注入裁决 + 本地占位模式 + architect 段解析）：
//   块1（原 L44-68）：前置注释 L44-46 + architectCache 状态 + parseArchitectYaml
//     （reviewers.yaml architect 段解析，I006；缺失/异常回落空对象）；
//   块2（原 L828-961）：前置注释 L828-829 + runArchitect（--architect：delta.md 无 DELTA 短路、
//     token 预算截断、注入/fresh-chat/提交/助手捕获轮询/formatOk 逐条校验/落盘）；
//   块3（原 L963-1011）：前置注释 L963-965 + runArchitectLocal（--architect-local：无 CDP 占位裁决）。
//   export 面 3 符号：runArchitect/runArchitectLocal/parseArchitectYaml（T-82 孪生收敛：
//   parseArchitectYaml 导出供 review-flow.mjs 转口，其原独立实现已废除；architectCache 仍模块私有）。
//   块外引用实证 runArchitect L431/L813、runArchitectLocal L435/L821（行址=baseCommit 9236d51）。
// 依赖（块内自由标识符扫描实证 tmp/t61/p7-depscan.mjs；误报已逐一剔除）：
//   node:fs existsSync/mkdirSync/readFileSync/writeFileSync、node:path join/normalize as normalizePath/
//   sep as pathSep、js-yaml yaml、cdp-client CDP、constants TITAN_ROOT/CDP_HOST/REVIEWERS_YAML/
//   ARCHITECT_DELTA_MAX_CHARS/ARCHITECT_CAPTURE_WINDOW_MS/ARCHITECT_SUBMIT_SETTLE_MS、
//   prompts buildInjectScript、markers markerEnd、session-nav attachToTarget/navigateToFreshChat。
//   剔除误报：mode/prompt 仅注释与字符串；ARCHITECT_CAPTURE_EMPTY/ARCHITECT_FORMAT_WARN/
//   DELTA_EMPTY_SHORT_CIRCUIT 为 console 消息字符串；Target.attachToTarget 系 cdp.send 协议串
//   非标识符引用；ncaptured 系换行符+captured 拼接产生的假 token。
// 入口 import 收窄：fs 行剔 statSync/renameSync/openSync/closeSync/unlinkSync；constants 行剔三个
//   ARCHITECT_*；prompts 行剔 buildInjectScript；session-nav 行剔 attachToTarget/navigateToFreshChat；
//   markers 行剔 markerEnd；入口新增回迁 import 行 runArchitect/runArchitectLocal。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, normalize as normalizePath, sep as pathSep } from 'node:path';
import * as yaml from 'js-yaml';
import { CDP } from '../cdp-client.mjs';
import { TITAN_ROOT, CDP_HOST, REVIEWERS_YAML, ARCHITECT_DELTA_MAX_CHARS, ARCHITECT_CAPTURE_WINDOW_MS, ARCHITECT_SUBMIT_SETTLE_MS } from './constants.mjs';
import { buildInjectScript } from './prompts.mjs';
import { markerEnd } from './markers.mjs';
import { attachToTarget, navigateToFreshChat } from './session-nav.mjs';

// I006: 解析 reviewers.yaml 的 architect 段（ChatGPT 架构师配置）。
// S0 P1-04: 与 reviewers 同源，统一走 js-yaml（architect 段为对象，非数组）。
// 缺失时返回空对象，调用侧回落到内联默认。
let architectCache = null;
export function parseArchitectYaml(path) {
  if (architectCache !== null) {
    return architectCache;
  }
  if (!existsSync(path)) {
    return {};
  }
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
  let doc;
  try {
    doc = yaml.load(text);
  } catch (e) {
    return {};
  }
  if (!doc || !doc.architect || typeof doc.architect !== 'object') {
    architectCache = {};
    return {};
  }
  architectCache = doc.architect;
  return architectCache;
}

// ---------- 架构师裁决：--architect <dispatchId> 注入 delta.md 到 ChatGPT ----------
// 会话隔离：prompt 头部声明全新会话 + 只要求逐条 accept/reject/defer，不评论方案本身。
export async function runArchitect(dispatchId) {
  // P1-08：消费侧校验 dispatchId 格式（8 位 hex）；path.normalize 后限定根目录
  // T-71/T-72（2026-10-21）：放行 scan-<base36> 形式 —— scan 模式产出 layer-b/delta.md
  // 后需直接送 ChatGPT 逐条裁决，但原正则只认 8 位 hex，导致「去重汇总 → ChatGPT 审核」
  // 链路在 scan 路径上完全走不通（--analyze 亦只吃 layer-a canonical，scan 无 layer-a）。
  // 路径穿越防护不变：下方 normalizePath + startsWith(TITAN_ROOT + pathSep) 仍把关。
  if (!/^[0-9a-f]{8}$/.test(dispatchId) && !/^scan-[0-9a-z]+$/.test(dispatchId)) {
    console.error('[ARCHITECT] dispatchId 格式错误：非 8 位 hex 或 scan-<id>: ' + dispatchId);
    process.exit(1);
  }
  const outDir = join(TITAN_ROOT, 'reviews', dispatchId);
  const norm = normalizePath(outDir);
  if (!norm.startsWith(TITAN_ROOT + pathSep)) {
    console.error('[ARCHITECT] dispatchId 路径穿越：' + outDir);
    process.exit(1);
  }
  const layerBDir = join(outDir, 'layer-b');
  const deltaPath = join(layerBDir, 'delta.md');
  if (!existsSync(deltaPath)) { console.error('[ARCHITECT] 缺少 delta.md: ' + deltaPath); process.exit(1); }
  const delta = readFileSync(deltaPath, 'utf8');
  // P1-02 余项（2026-09-30）: delta 无 DELTA-### 条目时短路 —— 没有任何可裁决内容，
  // 不应发起 CDP/fresh-chat/注入全链路（空转还必然得到"捕获为空"误判）。
  if (!/DELTA-\d{3}/.test(delta)) {
    writeFileSync(join(layerBDir, 'architect-decision.md'),
      '# architect-decision.md\n\nsource: delta.md ' + dispatchId +
      '\ncaptured: ' + new Date().toISOString() +
      '\n\n_（delta 无 DELTA 项：无需架构师裁决，本地短路，未走 CDP）_\n', 'utf8');
    console.log('[ARCHITECT] DELTA_EMPTY_SHORT_CIRCUIT: delta.md 无 DELTA-### 条目，已本地写入裁决并跳过 CDP');
    return;
  }
  // P2-13: delta token 预算 —— 超长 delta 会让架构师上下文溢出，按字符预算截断并留痕
  const MAX_DELTA_CHARS = ARCHITECT_DELTA_MAX_CHARS;
  const deltaBody = delta.length > MAX_DELTA_CHARS
    ? delta.slice(0, MAX_DELTA_CHARS) + '\n\n[DELTA TRUNCATED ' + (delta.length - MAX_DELTA_CHARS) + ' chars — 后续条目未送架构师]\n'
    : delta;
  const architectPrompt = '这是一个全新会话。忽略任何历史上下文。\n只针对以下 DELTA 逐条回复：accept / reject / defer + 一句理由。\n不要评论方案本身。不要给改进建议。\n====\n' + deltaBody
    // T-71/T-72（2026-10-21 实测 scan-mvha0zta）：ChatGPT 新 UI 会把用户气泡以
    // "You said:" 引用块形式渲染在 assistant 消息内部 → innerText = prompt 回显 + 回答。
    // prompt 末尾插 marker，捕获侧（snapExpr 已用 markerEnd 剥离）即可切掉回显，
    // 令 architect-decision.md 只落真实裁决，formatOk 判定也落在回答区而非回显区。
    + '\n' + markerEnd(dispatchId);
  mkdirSync(layerBDir, { recursive: true });
  // 架构师配置读 reviewers.yaml 的 architect 段（I006），缺失时回落内联默认
  const archCfg = { ...parseArchitectYaml(REVIEWERS_YAML) };
  if (!archCfg.url_open) archCfg.url_open = 'https://chatgpt.com/';
  if (!archCfg.editor_selector) archCfg.editor_selector = '#prompt-textarea';
  if (!archCfg.url_match) archCfg.url_match = 'chatgpt' + String.fromCharCode(92) + '.' + 'com';
  const list = await fetch('http://' + CDP_HOST + '/json/list').then(r => r.json());
  const cg = list.find(x => x.type === 'page' && new RegExp(archCfg.url_match).test(x.url));
  if (!cg) { console.error('[ARCHITECT] 未找到 ChatGPT tab'); process.exit(1); }
  // 复用 CDP 类：send 自带 60s 超时，避免 ChatGPT 无响应时永久挂起（I003）
  const cdp = new CDP(cg.webSocketDebuggerUrl);
  await cdp.connect();
  try {
    const sid = await attachToTarget(cdp, cg);
    await cdp.send('Page.enable', {}, sid);
    await cdp.send('Runtime.enable', {}, sid);
    // 会话隔离：导航到新会话页，避免把上一轮残留回复当成本轮裁决（陈旧捕获，I002）
    const fresh = await navigateToFreshChat(cdp, sid, archCfg);
    if (fresh.ok) console.log('[ARCHITECT] fresh-chat ok, bodyLen=' + fresh.bodyLen);
    else console.warn('[ARCHITECT] 新会话导航失败，继续（可能捕获陈旧响应）: ' + fresh.error);
    // T-62（2026-10-14）：注入统一走 buildInjectScript——原 injectExpr 是其孪生复制（坑源），旧版 ProseMirror 分支即 innerText 直写失效点。
    const inj = await cdp.send('Runtime.evaluate', { expression: buildInjectScript(architectPrompt), returnByValue: true }, sid);
    const injVal = inj && inj.result && inj.result.value;
    console.log('[ARCHITECT] inject=' + JSON.stringify(injVal));
    if (!injVal || !injVal.ok) {
      console.error('[ARCHITECT] 注入失败，不提交，避免把旧页面文本当裁决');
      return;
    }
    // P2-13: editorState 复检 —— 读回编辑器内容，确认 prompt 真的落地（而非只确认元素存在）
    const checkExpr = '(() => { const els=[...document.querySelectorAll(\'textarea,[contenteditable="true"]\')].filter(e=>e.offsetParent!==null).sort((a,b)=>b.getBoundingClientRect().width-a.getBoundingClientRect().width); const el=els[0]; if(!el) return {ok:false,reason:\'no-editor\'}; const txt=(el.tagName===\'TEXTAREA\'||el.tagName===\'INPUT\')?el.value:(el.innerText||\'\'); return {ok:txt.length>100,len:txt.length,head:txt.slice(0,60)}; })()';
    const chk = await cdp.send('Runtime.evaluate', { expression: checkExpr, returnByValue: true }, sid);
    const chkVal = chk && chk.result && chk.result.value;
    console.log('[ARCHITECT] editorState=' + JSON.stringify(chkVal));
    if (!chkVal || !chkVal.ok) {
      console.error('[ARCHITECT] 编辑器复检失败（未落地），不提交');
      return;
    }
    await new Promise(r => setTimeout(r, ARCHITECT_SUBMIT_SETTLE_MS));
    const subExpr = '(() => { const btns=[...document.querySelectorAll(\'button\')].filter(b=>{const t=((b.innerText||\'\')+\' \'+(b.getAttribute(\'aria-label\')||\'\')).toLowerCase();return /send|发送|submit/.test(t)&&!b.disabled;}); if(btns.length){btns[0].click();return{ok:true,m:\'button\'};} const el=[...document.querySelectorAll(\'textarea,[contenteditable="true"]\')].filter(e=>e.offsetParent!==null).sort((a,b)=>b.getBoundingClientRect().width-a.getBoundingClientRect().width)[0]; if(el){el.focus();el.dispatchEvent(new KeyboardEvent(\'keydown\',{key:\'Enter\',code:\'Enter\',bubbles:true}));return{ok:true,m:\'enter\'};} return {ok:false}; })()';
    const sb = await cdp.send('Runtime.evaluate', { expression: subExpr, returnByValue: true }, sid);
    const sbVal = sb && sb.result && sb.result.value;
    console.log('[ARCHITECT] submit=' + JSON.stringify(sbVal));
    if (!sbVal || !sbVal.ok) {
      console.error('[ARCHITECT] 提交失败，跳过响应采集');
      return;
    }
    // P1-02: 捕获限定 assistant 消息 —— 去掉 .markdown/article/[class*="response"] 等会命中
    // 用户气泡与侧边栏的选择器；只取助手消息，且排除注入的 prompt 回显（含 PROMPT_MARKER）
    const snapExpr = '(() => { const MARKER=' + JSON.stringify(markerEnd(dispatchId)) + '; const sel=' + JSON.stringify([archCfg.response_selector, '[data-message-author-role="assistant"]', 'model-response', '[class*="agent"]'].filter(Boolean)) + '; let last=\'\'; for(const s of sel){const ns=[...document.querySelectorAll(s)];if(ns.length){const t=(ns[ns.length-1].innerText||\'\').trim();if(t.length>last.length)last=t;}} if(last.includes(MARKER)){const mi=last.lastIndexOf(MARKER);last=last.slice(mi+MARKER.length).trim();} const stop=[...document.querySelectorAll(\'button\')].filter(b=>((b.innerText||\'\')+\' \'+(b.getAttribute(\'aria-label\')||\'\')).toLowerCase().match(/stop|停止|cancel/)); return {len:last.length,last,generating:stop.length>0}; })()';
    let last = ''; let lastLen = -1; let stable = 0; const t0 = Date.now();
    while (Date.now() - t0 < ARCHITECT_CAPTURE_WINDOW_MS) {
      const r = await cdp.send('Runtime.evaluate', { expression: snapExpr, returnByValue: true }, sid);
      const v = r.result.value;
      if (v.len === lastLen) stable++; else { stable = 0; lastLen = v.len; }
      if (!v.generating && v.len > 0 && stable > 2) { last = v.last; break; }
      if (!v.generating && v.len > 0 && Date.now() - t0 > 60000) { last = v.last; break; }
      await new Promise(x => setTimeout(x, 4000));
    }
    const bodyt = await cdp.send('Runtime.evaluate', { expression: "document.body?document.body.innerText:''", returnByValue: true }, sid);
    const body = bodyt.result.value || '';
    // P1-02: 去掉 body.slice(-3000) 兜底 —— 它会把侧边栏/prompt 回显当裁决。
    // 仅当 assistant 捕获完全失败时才告警，不再用 body 尾部填充。
    // P1-02 余项（2026-09-30）: 下限 50→10。50 会误杀合法短裁决（实测 32 字符的
    // "无 DELTA 项：defer…" 被判空并覆盖成占位）；10 仍可挡住 spinner/占位碎片。
    // T-71/T-72（2026-10-21 实测 scan-mvha0zta / scan-mvhavowt）：ChatGPT 新 UI 把用户
    // 气泡以 "You said:" 引用块渲染在 assistant 消息内部 → innerText = prompt 回显 + 回答。
    // 剥离：① marker 命中（prompt 尾部插的 markerEnd）→ 取其后；② marker 未命中
    // （ChatGPT 对超长 prompt 会折叠 "Show more"，DOM 里可能没有完整 marker）→
    // 兜底取「最后一个 DELTA id 所在行行首之后」——回显在前、回答在后且必含 DELTA id。
    const MARKER_TEXT = markerEnd(dispatchId);
    let bodyText = last;
    if (bodyText.includes(MARKER_TEXT)) {
      const mi = bodyText.lastIndexOf(MARKER_TEXT);
      bodyText = bodyText.slice(mi + MARKER_TEXT.length).trim();
    } else {
      const idsForStrip = (delta.match(/DELTA-\d{3}/g) || []);
      let lastIdAt = -1;
      for (const id of idsForStrip) {
        const p = bodyText.lastIndexOf(id);
        if (p > lastIdAt) lastIdAt = p;
      }
      if (lastIdAt > 0) {
        const lineStart = bodyText.lastIndexOf('\n', lastIdAt) + 1;
        const cand = bodyText.slice(lineStart).trim();
        if (cand.length >= 20) bodyText = cand;
      }
    }
    last = bodyText;
    if (!last || last.length < 10) {
      console.warn('[ARCHITECT] ARCHITECT_CAPTURE_EMPTY: assistant 消息捕获为空或过短（len=' + (last ? last.length : 0) + ', bodyLen=' + body.length + '），不写侧边栏文本');
      last = '_（捕获失败：未找到 assistant 消息，本文件为占位）_';
    }
    const outPath = join(layerBDir, 'architect-decision.md');
    writeFileSync(outPath, '# architect-decision.md\n\nsource: delta.md ' + dispatchId + '\ncaptured: ' + new Date().toISOString() + '\n\n' + last, 'utf8');
    // 格式自检（I008）：逐 DELTA-### 校验 —— 在该 id 之后找最近的 accept/reject/defer，
    // 避免旧实现整文匹配一次即全过（deltaIds.every 的回调忽略了 did）。
    // P1-02: formatOk 必须排除 delta.md 模板自带的 accept risk 等文本误判 ——
    // 判定词必须出现在 DELTA id 之后且紧邻（同行或 300 字符内），且不能是 prompt 回显残留。
    // S8b: id 正则统一为 DELTA-\d{3}（与 delta.md 生成端 padStart(3,'0') 一致）
    const deltaIds = (delta.match(/DELTA-\d{3}/g) || []);
    const missing = [];
    for (const did of deltaIds) {
      // T-71/T-72（2026-10-21 实测 scan-mvhavowt）：prompt 回显里也含 DELTA id，
      // 用 indexOf 会把判定窗口落在回显区（无判定词 → 全条误报 missing）。
      // 回答区在末尾（回显在前），故用 lastIndexOf 定位回答区中的 id。
      const at = last.lastIndexOf(did);
      if (at < 0) { missing.push(did + ' (id 未出现在裁决中)'); continue; }
      // P2-13: 窗口按下一个 DELTA id 边界裁切，而不是固定 600 字符
      let windowEnd = last.length;
      for (const other of deltaIds) {
        const oi = last.indexOf(other, at + did.length);
        if (oi > at && oi < windowEnd) windowEnd = oi;
      }
      const after = last.slice(at, Math.min(at + 600, windowEnd));
      // 判定词必须与 id 同段（行首或紧随），排除 "accept risk" 类模板文本
      // T-71/T-72（2026-10-21 实测 scan-mvha0zta）：ChatGPT 实际逐条给了裁决，
      // 但格式是同行 `DELTA-001: accept — 理由`，判定词不在行首 → 原正则
      // (?:^|\n) 锚定判全条 missing（16/16 误报）。放宽为「行首 / 冒号后 / 列表项前」，
      // 同时仍排除 "accept risk" 类模板文本（判定词前不得有字母）。
      const decisionMatch = after.match(/(?:^|\n|:\s|\*|-)\s*(?<!risk\s)(accept|reject|defer)\b/i);
      if (!decisionMatch) missing.push(did + ' (其后窗口内无独立 accept/reject/defer)');
    }
    const formatOk = deltaIds.length > 0 && missing.length === 0;
    console.log('[ARCHITECT] formatOk=' + formatOk + ' (deltaIds=' + deltaIds.length + (missing.length ? ', missing=' + JSON.stringify(missing) : '') + ')');
    if (!formatOk) console.warn('[ARCHITECT] ARCHITECT_FORMAT_WARN: 未逐条 accept/reject/defer: ' + JSON.stringify(missing) + '（已落盘但不阻塞）');
    console.log('[ARCHITECT] architect-decision.md 已写: ' + outPath + ' (chars=' + last.length + ')');
  } finally {
    cdp.close();
  }
  return;
}

// ---------- --architect-local 本地测试模式（不依赖 CDP） ----------
// 从 delta.md 读出全部 DELTA-### id，对每条生成 "defer（本地测试占位，未走 CDP）" 裁决，
// 直接写 architect-decision.md。用于无 Chrome/CDP 环境下验证四方会诊闭环。
export async function runArchitectLocal(dispatchId) {
  // P1-08: 消费侧校验 dispatchId 格式（8 位 hex）；path.normalize 后限定根目录
  if (!/^[0-9a-f]{8}$/.test(dispatchId)) {
    console.error('[ARCHITECT-LOCAL] dispatchId 格式错误：非 8 位 hex: ' + dispatchId);
    process.exit(1);
  }
  const outDir = join(TITAN_ROOT, 'reviews', dispatchId);
  const norm = normalizePath(outDir);
  if (!norm.startsWith(TITAN_ROOT + pathSep)) {
    console.error('[ARCHITECT-LOCAL] dispatchId 路径穿越：' + outDir);
    process.exit(1);
  }
  const layerBDir = join(outDir, 'layer-b');
  const deltaPath = join(layerBDir, 'delta.md');
  if (!existsSync(deltaPath)) { console.error('[ARCHITECT-LOCAL] 缺少 delta.md: ' + deltaPath); process.exit(1); }
  const delta = readFileSync(deltaPath, 'utf8');
  // delta.md 中 DELTA-### 可能出现多次（每条 Type/Reviewers/... 段），去重保序
  const seen = new Set();
  const deltaIds = [];
  for (const m of delta.matchAll(/DELTA-\d{3}/g)) {
    if (!seen.has(m[0])) { seen.add(m[0]); deltaIds.push(m[0]); }
  }
  const parts = [];
  parts.push('# architect-decision.md (LOCAL TEST MODE)');
  parts.push('');
  parts.push('source: delta.md ' + dispatchId);
  parts.push('generated: ' + new Date().toISOString());
  parts.push('mode: local-test — 未调用 CDP/ChatGPT，全部裁决为 defer 占位，仅供闭环测试');
  parts.push('deltaIds: ' + deltaIds.length);
  parts.push('');
  if (deltaIds.length === 0) {
    parts.push('_（delta.md 无 DELTA-### 条目，生成为空裁决）_');
  } else {
    for (const did of deltaIds) {
      parts.push('### ' + did);
      parts.push('Decision: defer');
      parts.push('Reason: 本地测试模式占位裁决，未经过 ChatGPT 架构师判定。');
      parts.push('');
    }
  }
  const outPath = join(layerBDir, 'architect-decision.md');
  writeFileSync(outPath, parts.join('\n'), 'utf8');
  console.log('[ARCHITECT-LOCAL] deltaIds=' + deltaIds.length + ' 全部 defer（占位）');
  console.log('[ARCHITECT-LOCAL] architect-decision.md 已写: ' + outPath);
  return;
}
