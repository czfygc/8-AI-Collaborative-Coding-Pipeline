// lib/analyze-core.mjs — T-61 P4 提取（机械搬移自 orchestrate.mjs；块体逐字节未动，仅加 export 前缀）
// 符号集（计划 C-4，审计 H2 修正：unquoteYamlValue/extractVerdictLines 已不在原文件）：
//   块1：mapSeverity/extractSeverityFromLine/splitFindings/extractOverallVerdict/normalizeNameKey/
//        factPropKey/extractScopeFromFinding/normScope/sevIncludes/buildCanonicalIssues/
//        buildAggregatedFeedback/writeLayerBSkeletons（12 函数）
//   块2：extractThresholds/extractFilters/runAnalyze（STEP B 分析层）
// sha256 三件套留入口（main 专用；submitVerdict 为内联 createHash 不依赖）。
// 依赖（块内自由标识符扫描实证）：node:fs 四函数、join/normalizePath/pathSep、js-yaml、
// constants（TITAN_ROOT/REVIEWERS_YAML）、markers（splitEndMarkers）、verdict-parse（readRawResponse/
// extractVerdictLines——块1经splitFindings、块2经runAnalyze）、reviewers（getReviewers——P2 适配器前瞻收益）。
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, normalize as normalizePath, sep as pathSep } from 'node:path';
import * as yaml from 'js-yaml';
import { TITAN_ROOT, REVIEWERS_YAML } from './constants.mjs';
import { splitEndMarkers } from './markers.mjs';
import { readRawResponse, extractVerdictLines } from './verdict-parse.mjs';
import { getReviewers } from './reviewers.mjs';

// ---------- finding 提取（STEP B） ----------
export function mapSeverity(raw) {
  const t = String(raw || '').trim().toUpperCase();
  if (t === '高' || t === 'HIGH') return 'HIGH';
  if (t === '中' || t === 'MEDIUM' || t === 'MED') return 'MEDIUM';
  if (t === '低' || t === 'LOW') return 'LOW';
  return null;
}

export function extractSeverityFromLine(line) {
  const sm = line.match(/严重程度[^高中低]*([高中低])/);
  if (sm) return mapSeverity(sm[1]);
  // DELTA-014（T-59 批2）：惰性 [^|]+? + \s* 回撤结构改为贪心 [^|]+——调用侧本就 .trim()，
  // 语义等价且消除多项式回撤形态。ReDoS 审计：本函数与 factPropKey 其余正则均为线性
  // 否定字符类/字面交替（无指数嵌套量词），对抗输入护栏断言见 orchestrator/test/regex-redos.test.mjs。
  const tbl = line.match(/^\s*\|\s*[^|]+\|\s*[^|]+\|\s*([^|]+)\|/);
  if (tbl) return mapSeverity(tbl[1].trim());
  const head = line.slice(0, 300);
  const sm3 = head.match(/(?:^|[\s|:\-\(【\[])(高|中|低|HIGH|MEDIUM|LOW|high|medium|low)(?:$|[\s|:\-\)】\]，,。.])/);
  if (sm3) return mapSeverity(sm3[1]);
  return null;
}

export function splitFindings(responseText) {
  const text = String(responseText || '');
  const lines = text.split('\n');
  const findings = [];
  let current = null;
  // P2-15: 边界 marker 取当前 dispatch 的带后缀版本；兼容旧 dispatch 的无后缀版本。
  const endMarkers = splitEndMarkers();
  let afterAnswer = true;  // 默认从开头扫描
  // 但若文本中存在 marker，则从最后一个 marker 之后开始
  if (endMarkers.some(m => text.includes(m))) {
    for (let i = 0; i < lines.length; i++) {
      if (endMarkers.some(m => lines[i].includes(m))) {
        afterAnswer = true;
        break;
      }
      afterAnswer = false;
    }
  }
  const idRe = /(?:ISSUE[\s_-]?ID[^A-Za-z0-9]*([A-Za-z]-?\d+(?:-\d+)*)|^[^\S\n]*(?:#{1,6}\s*|\*\*|\d+[.)\s]*)?([A-Z])-(\d+)\b)/i;
  for (const line of lines) {
    if (!afterAnswer) {
      if (endMarkers.some(m => line.includes(m))) { current = null; afterAnswer = true; }
      continue;
    }
    const m = line.match(idRe);
    if (m) {
      if (current) findings.push(current);
      const issueId = m[1] || (m[2] + '-' + m[3]);
      current = { issueId, text: line.trim(), severity: extractSeverityFromLine(line) };
      continue;
    }
    if (current) {
      current.text += '\n' + line.trim();
      if (!current.severity) current.severity = extractSeverityFromLine(line);
    }
  }
  // P2-05: 若无 ISSUE-ID 但至少有两行非空文本，则 fallback 以空行分割段落
  if (findings.length === 0 && lines.length >= 2) {
    const nonEmpty = lines.filter(l => l.trim().length > 0);
    if (nonEmpty.length >= 2) {
      const blocks = [];
      let block = [];
      for (const line of lines) {
        if (line.trim() === '') {
          if (block.length > 0) { blocks.push(block); block = []; }
        } else {
          block.push(line.trim());
        }
      }
      if (block.length > 0) blocks.push(block);
      for (const [idx, blk] of blocks.entries()) {
        if (blk.length > 0) {
          findings.push({ issueId: `BLOCK-${String(idx+1).padStart(3,'0')}`, text: blk.join('\n'), severity: null });
        }
      }
    }
  }
  if (current) findings.push(current);
  return findings;
}

// T-56 W8：extractVerdictLines 迁 lib/verdict-parse.mjs（见顶部 import），此处删原定义。
// 唯一事实源避免双源漂移（灭 M-05/M-06）；解析契约见 orchestrator/test/verdict-parse.test.mjs。

// S3: reviewer 级整体判定 —— 无结构化 verdict 表时，扫全文语气词归一为 PASS/FAIL/CONDITIONAL/UNKNOWN
// 顺序敏感：先把否定包（"未发现…问题"/"没有…问题"）从文本中剔除，再做正负判定，
// 否则"未发现阻塞问题"里的"阻塞"会被误判为 FAIL
export function extractOverallVerdict(text) {
  const raw = String(text || '');
  const hasC = /(?:CONDITIONAL|部分通过|有条件)/i.test(raw);
  if (hasC) return 'CONDITIONAL';
  // P2-06: 否定包按行处理，不跨行惰性删除 —— 旧实现 [\s\S]{0,12}? 可吞掉换行，
  // 把下一行的正文当成否定包的一部分删掉，制造假 FAIL/假 PASS。
  const cleanPerLine = raw.split('\n').map(l =>
    l.replace(/(?:未|没有|不存在)[^\n]{0,12}?(?:问题|阻塞|issue)/gi, '')
     .replace(/无\s*(?:任何\s*)?问题/gi, '')
  ).join('\n');
  if (/(?:FAIL|不通过|阻塞|BLOCKED)/i.test(cleanPerLine)) return 'FAIL';
  if (/(?:存在|发现)[^\n]{0,10}?问题/i.test(cleanPerLine)) return 'FAIL';
  if (/(?:PASS|通过|无\s*ISSUE)/i.test(cleanPerLine)) return 'PASS';
  return 'UNKNOWN';
}

export function normalizeNameKey(name) {
  return String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// S2: 事实命题键 —— 剥离判定词/标点/格式，使"判定：PASS"与"= FAIL"归并到同一命题键。
// 判定差异本身由 extractVerdict 表达，命题键只负责"这是不是同一件事"。
export function factPropKey(p) {
  let s = String(p || '');
  // 结构化 verdict 行：第一个 | 之前是条目名，依据部分不参与命题键
  const barIdx = s.indexOf('|');
  if (barIdx !== -1) s = s.slice(0, barIdx);
  return s
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/(判定|结论|结果|verdict|status|状态|section\s*判定)\s*[:：]?\s*/gi, ' ')
    .replace(/\b(pass|fail|blocked|conditional|accept|reject|defer|通过|不通过|阻塞|部分|有条件|高|中|低|high|medium|low)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// S2: evidence scope 归一 —— finding 文本的"位置："字段抽 artifact 区段；拿不到则回退 raw 路径。
// 用于 CONSENSUS 与 COMPLEMENTARY 的区分（同命题 + 同 scope 才算共识）。
export function extractScopeFromFinding(text) {
  const t = String(text || '');
  // P2-05: 支持 Issue-ID 一位数字 + 边界；也支持自然语言 severity
  const idRe = /(?:ISSUE[\s_-]?ID[^A-Za-z0-9]*([A-Za-z]-?\d+(?:-\d+)*)|^[^\S\n]*(?:#{1,6}\s*|\*\*|\d+[.)\s]*)?([A-Z])-(\d{1,2})\b)/i;
  // 位置字段：也接受英文 "position:" 以及多种分隔符
  const m = t.match(/(?:位置|position)\s*[:：]\s*(.+)/i);
  if (m) {
    // 只取第一个 scope 片段（遇到 " / " 即停止）
    const firstSegment = m[1].trim().split(/\s*\/\s*/)[0];
    return firstSegment.slice(0, 120);
  }
  return '';
}
export function normScope(scope, fallback) {
  const s = String(scope || '').trim();
  if (!s) return 'artifact'; // fallback to artifact-level, not reviewer-specific path
  return s.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 120);
}
export function sevIncludes(threshold, sev) {
  if (!sev) return false;
  if (Array.isArray(threshold)) return threshold.map(x => String(x).toUpperCase()).includes(sev);
  return String(threshold).toUpperCase() === sev;
}

// ---------- canonical 归一化（STEP A：每条 finding 一条 occurrence） ----------
export function buildCanonicalIssues(rawByReviewer) {
  const issues = [];
  let counter = 1;
  for (const rv of getReviewers()) {
    const raw = rawByReviewer[rv.name];
    if (!raw || !raw.ok) continue;
    const findings = splitFindings(raw.responseText);
    if (findings.length === 0) {
      issues.push({
        canonicalIssueId: 'F-' + String(counter++).padStart(3, '0'),
        factualProposition: (raw.responseText || '').slice(0, 300),
        evidenceScope: '',
        occurrences: [{ reviewer: rv.name, issueId: 'NONE', severity: null }],
      });
      continue;
    }
    for (const f of findings) {
      issues.push({
        canonicalIssueId: 'F-' + String(counter++).padStart(3, '0'),
        factualProposition: f.text.slice(0, 500),
        // evidenceScope 必须是 artifact 内的区段（如 orchestrate.mjs:500），
        // 不是 raw 文件路径 —— 否则跨 reviewer 的 scope 永远不同，COMPLEMENTARY 判定失效
        evidenceScope: extractScopeFromFinding(f.text),
        occurrences: [{ reviewer: rv.name, issueId: f.issueId || 'NONE', severity: f.severity || null }],
      });
    }
  }
  return issues;
}

// ---------- Layer A: aggregated-feedback.md ----------
export function buildAggregatedFeedback(summary, rawByReviewer, meta) {
  const parts = [];
  parts.push('# 多方审计聚合反馈 (Layer A)');
  parts.push('');
  parts.push('dispatchId: ' + meta.dispatchId);
  parts.push('timestamp: ' + meta.timestamp);
  parts.push('reviewRound: ' + meta.reviewRound);
  parts.push('parentDispatchId: ' + (meta.parentDispatchId || 'null'));
  parts.push('trigger: ' + meta.trigger);
  parts.push('delivery: ' + (meta.delivery || 'inline'));
  parts.push('artifactPath: ' + meta.artifactPath);
  parts.push('artifactSha256: ' + meta.artifactSha256);
  if (meta.artifactFileName) parts.push('artifactFileName: ' + meta.artifactFileName);
  if (meta.artifactSizeBytes != null) parts.push('artifactSizeBytes: ' + meta.artifactSizeBytes);
  if (meta.artifactSizeChars != null) parts.push('artifactSizeChars: ' + meta.artifactSizeChars);
  parts.push('');
  parts.push('## 审计视角');
  parts.push('');
  parts.push('| Reviewer | 视角 | 状态 | 反馈长度 | Raw SHA256 |');
  parts.push('|---|---|---|---|---|');
  for (const rv of getReviewers()) {
    const s = summary[rv.name] || {};
    parts.push('| ' + rv.name + ' | ' + rv.perspective + ' | ' + (s.status || 'missing') + ' | ' + (s.textLen || 0) + ' | ' + (s.sha || '') + ' |');
  }
  parts.push('');
  parts.push('## 原始反馈');
  parts.push('');
  for (const rv of getReviewers()) {
    const raw = rawByReviewer[rv.name];
    parts.push('### ' + rv.name + ' — ' + rv.perspective);
    parts.push('');
    parts.push('Perspective (verbatim):');
    parts.push('');
    parts.push(rv.perspective_prompt);
    parts.push('');
    if (raw && raw.ok) {
      parts.push('Raw path: layer-a/raw/' + rv.name + '.md');
      parts.push('Raw SHA256: ' + raw.sha);
      parts.push('');
      parts.push(raw.responseText);
    } else {
      parts.push('(status: ' + (raw ? raw.error : 'missing') + ')');
    }
    parts.push('');
    parts.push('---');
    parts.push('');
  }
  return parts.join('\n');
}

// ---------- Layer B 骨架 ----------
export function writeLayerBSkeletons(layerBDir) {
  // P2-17: skeleton 带 status 标记，analyze 成功后会覆盖为 COMPLETED。
  // 中途失败时留下的是 STEP_A_PLACEHOLDER，可被区分，不再误判为"已执行但无冲突"。
  writeFileSync(join(layerBDir, 'status.json'), JSON.stringify({ status: 'STEP_A_PLACEHOLDER', ts: new Date().toISOString() }, null, 2), 'utf8');
  writeFileSync(join(layerBDir, 'conflicts.json'), JSON.stringify([], null, 2), 'utf8');
  writeFileSync(join(layerBDir, 'blind-spots.json'), JSON.stringify([], null, 2), 'utf8');
  writeFileSync(join(layerBDir, 'delta.md'),
    '# Layer B — delta\n\n' +
    '<!-- STEP A 阶段仅占位。冲突检测、盲点分级、过滤器审计由 STEP B 填充。 -->\n' +
    '\n' +
    '## DELTA 项\n\n_（STEP B 填充）_\n\n' +
    '## Filtered Findings\n\n| Reviewer | Issue-ID | Rule | Reason |\n|---|---|---|---|\n| _(STEP B 填充)_ | | | |\n',
    'utf8');
}

// ---------- STEP B：--analyze 分析层 ----------
// DELTA-011（T-59 批2）：thresholds/filters 改用顶部已导入的 js-yaml 全量解析，
// 替换旧的手工逐行正则（对缩进/引号/含#值/多行值等合法 YAML 变体脆弱）。
// 与 loadReviewersYaml 同源同防御姿态：解析失败回落空对象/空数组，不抛。
// 输出形状保持与旧实现一致：标量 String 化、数组保留（等价性探针 tmp/t59-b2/probe-011.mjs）。
export function extractThresholds(yamlText) {
  let doc = null;
  try { doc = yaml.load(String(yamlText)); } catch { doc = null; }
  const src = (doc && typeof doc === 'object' && doc.thresholds && typeof doc.thresholds === 'object' && !Array.isArray(doc.thresholds))
    ? doc.thresholds : {};
  const t = {};
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (v === null || v === undefined || (typeof v === 'object' && !Array.isArray(v))) continue;
    t[k] = Array.isArray(v) ? v.map(x => (x === null || typeof x === 'object') ? '' : String(x)) : String(v);
  }
  return t;
}

export function extractFilters(yamlText) {
  let doc = null;
  try { doc = yaml.load(String(yamlText)); } catch { doc = null; }
  const src = (doc && Array.isArray(doc.filters)) ? doc.filters : [];
  const filters = [];
  for (const item of src) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (item.ruleId === undefined || item.ruleId === null) continue;
    const cur = { ruleId: String(item.ruleId) };
    if (item.pattern !== undefined && item.pattern !== null) cur.pattern = String(item.pattern);
    if (item.reason !== undefined && item.reason !== null) cur.reason = String(item.reason);
    filters.push(cur);
  }
  return filters;
}

export async function runAnalyze(dispatchId) {
  // P1-08: 消费侧校验 dispatchId 格式（8 位 hex 或 fixture _*）；path.normalize 后限定根目录
  if (!/^(_?[0-9a-f]{8}|_[a-zA-Z0-9_]+)$/.test(dispatchId)) {
    console.error('[ANALYZE] dispatchId 格式错误：非 8 位 hex 或 fixture: ' + dispatchId);
    process.exit(1);
  }
  const outDir = join(TITAN_ROOT, 'reviews', dispatchId);
  const norm = normalizePath(outDir);
  if (!norm.startsWith(TITAN_ROOT + pathSep)) {
    console.error('[ANALYZE] dispatchId 路径穿越：' + outDir);
    process.exit(1);
  }
  const layerADir = join(outDir, 'layer-a');
  const layerBDir = join(outDir, 'layer-b');
  // S1: 数据源切换为 Layer A 已归一化的 canonical issues（X-04）。
  // 不再用 extractIssueBlocks 重解 raw —— Layer A/Layer B 两套解析器发散会导致同一次分发产出不一致的 finding 集。
  const metaPath = join(layerADir, 'dispatch-meta.json');
  const issuesPath = join(layerADir, 'issues-normalized.json');
  if (!existsSync(metaPath) || !existsSync(issuesPath)) {
    console.error('[ANALYZE] 缺少 layer-a 数据，需要 dispatch-meta.json 与 issues-normalized.json: ' + layerADir);
    process.exit(1);
  }
  mkdirSync(layerBDir, { recursive: true });
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  const issues = JSON.parse(readFileSync(issuesPath, 'utf8'));

  const yamlText = readFileSync(REVIEWERS_YAML, 'utf8');
  const thresholds = extractThresholds(yamlText);
  const filters = extractFilters(yamlText);
  console.log('[ANALYZE] dispatchId=' + dispatchId + ' issues=' + issues.length);
  console.log('[ANALYZE] thresholds=' + JSON.stringify(thresholds));
  console.log('[ANALYZE] filters=' + filters.map(f => f.ruleId).join(','));

  // raw 仍读取：用于 verdict 提取与严重度回退扫描（canonical issue 只保留前 500 字）
  // P1-05: 遍历 dispatch-meta.reviewers 而非当前的 getReviewers()，避免 dispatch 后关闭某 reviewer 导致其 raw 被静默忽略
  const rawByReviewer = {};
  for (const rv of meta.reviewers) {
    const rawPath = join(layerADir, 'raw', rv.name + '.md');
    // T-56 W8（M-14 根治）：readRawResponse 是 async，必须 await——旧代码漏 await 把
    // Promise 当字符串，extractVerdictLines 全体 0 行 → analyze 全 NONE 占位（冻结基线
    // verdictLines gemini=6/deepseek=9 被吞）。此处补 await 后 analyze 回归冻结值。
    rawByReviewer[rv.name] = existsSync(rawPath) ? (await readRawResponse(rawPath)) : '';
  }

  // 从 canonical issues 重建 perReviewer 视图（行为等价于旧的 extractIssueBlocks，但与 Layer A 同源）
  // noFindings 占位条目（issueId='NONE'）留在 issues-normalized.json 里备查，不参与分类。
  // P1-05: 遍历 dispatch-meta.reviewers 确保所有参与分发的 reviewer 都被分类（包括 FAILED/NONE）
  const perReviewer = {};
  for (const rv of meta.reviewers) {
    const rawText = rawByReviewer[rv.name] || '';
    const verdicts = extractVerdictLines(rawText);
    const hasText = rawText.length > 0;
    const hasVerdict = verdicts.length > 0;
    if (!hasText && !hasVerdict) {
      // 无任何 raw 文本 + 无 verdict → NONE 占位（静默/失败）
      perReviewer[rv.name] = { verdicts: [], issues: [], isNone: true };
    } else {
      perReviewer[rv.name] = { verdicts, issues: [], hasText, hasVerdict };
    }
  }
  for (const issue of issues) {
    for (const occ of (issue.occurrences || [])) {
      if (occ.issueId === 'NONE') continue;
      const slot = perReviewer[occ.reviewer];
      if (!slot) continue;
      slot.issues.push({
        issueId: occ.issueId,
        text: issue.factualProposition || '',
        severity: occ.severity,
      });
    }
  }
  // P1-05: 以 dispatch-meta.reviewers 为准输出每个 reviewer 的分析状态（含 NONE 占位）
  for (const rv of meta.reviewers) {
    const d = perReviewer[rv.name] || {};
    console.log('[ANALYZE] ' + rv.name + ': verdictLines=' + (d.verdicts?.length || 0) + ' issueBlocks=' + (d.issues?.length || 0) + ' isNone=' + (d.isNone ? 'true' : 'false'));
  }

  // Verdict 分组 → FACT_CONFLICT（只包含有 verdict 的 reviewer）
  const verdictByName = {};
  for (const [reviewer, data] of Object.entries(perReviewer)) {
    if (!data.verdicts || data.verdicts.length === 0) continue;
    for (const v of data.verdicts) {
      const key = normalizeNameKey(v.name);
      if (!key) continue;
      if (!verdictByName[key]) verdictByName[key] = { displayName: v.name, byReviewer: {} };
      verdictByName[key].byReviewer[reviewer] = { verdict: v.verdict, reason: v.reason };
    }
  }
   // Precompute a map from factPropKey to occurrences (excluding NONE) for efficient lookup
   const factPropKeyToOccurrences = new Map();
   for (const issue of issues) {
     const propKey = factPropKey(issue.factualProposition);
     for (const occ of (issue.occurrences || [])) {
       if (occ.issueId === 'NONE') continue;
       if (!factPropKeyToOccurrences.has(propKey)) {
         factPropKeyToOccurrences.set(propKey, []);
       }
       factPropKeyToOccurrences.get(propKey).push(occ);
     }
   }
   const conflicts = [];
   for (const key of Object.keys(verdictByName)) {
    const group = verdictByName[key];
    const entries = Object.entries(group.byReviewer);
    if (entries.length < 2) continue;
    const verdictSet = new Set(entries.map(e => e[1].verdict));
    if (verdictSet.size < 2) continue;
    conflicts.push({
      conflictId: 'C-' + String(conflicts.length + 1).padStart(3, '0'),
      type: 'FACT_CONFLICT',
      name: group.displayName,
      verdicts: Object.fromEntries(entries.map(e => [e[0], e[1].verdict])),
      reasons: Object.fromEntries(entries.map(e => [e[0], e[1].reason])),
       occurrences: factPropKeyToOccurrences.get(factPropKey(group.displayName)) || [],
    });
  }

  // S3: 跨 reviewer 命题归并 —— factPropKey 剥离判定词后归并同命题。
  // 合并为 CONSENSUS 还需"同 evidence scope"；同命题不同 scope → COMPLEMENTARY（不合并、不丢）。
  // 从 canonical issues 重建 (reviewer, issueId, severity, scope, text) 五元组
  const occurrences = [];
  for (const issue of issues) {
    for (const occ of (issue.occurrences || [])) {
      if (occ.issueId === 'NONE') continue;
      occurrences.push({
        reviewer: occ.reviewer,
        issueId: occ.issueId,
        severity: mapSeverity(occ.severity) || occ.severity,
        // P7: scope fallback 不再用 reviewer 的 raw 路径（那会让跨 reviewer
        // 的空 scope 永不相同，COMPLEMENTARY 误配对）；统一回落到 artifact 级
        scope: normScope(issue.evidenceScope),
        text: issue.factualProposition || '',
      });
    }
  }

  // 先跑 FILTERED（过滤命中的一律不进其余桶）
  const filtered = [];
  const survivors = [];
  let warnedBadFilters = null; // DELTA-022：坏 pattern 的 ruleId 只警告一次（防每 occurrence 刷屏）
  for (const o of occurrences) {
    let matched = null;
    for (const f of filters) {
      if (!f.pattern) continue;
      try { if (new RegExp(f.pattern, 'i').test(o.text)) { matched = f; break; } } catch (e) {
        if (!warnedBadFilters) warnedBadFilters = new Set();
        if (!warnedBadFilters.has(f.ruleId)) { warnedBadFilters.add(f.ruleId); console.warn('[WARN] 过滤器 pattern 非法，跳过: ' + f.ruleId + ' (' + e.message + ')'); }
      }
    }
    if (matched) {
      filtered.push({
        reviewer: o.reviewer,
        issueId: o.issueId,
        ruleId: matched.ruleId,
        reason: matched.reason,
        proposition: o.text.slice(0, 300),
      });
    } else {
      survivors.push(o);
    }
  }

  const blindSpots = [];
  const consensus = [];
  const complementary = [];
  const backlogs = [];
  const highSeverityUnconfirmed = []; // P2-07: HSU 独立桶，不再混入 backlogs
  const sevOrder = { HIGH: 3, MEDIUM: 2, LOW: 1 };

  // S3: 主题键 —— scope 的第一段（orchestrate.mjs:500 → orchestrate.mjs；screenshot-timestamp → screenshot）。
  // 同主题、不同命题、不同 reviewer → COMPLEMENTARY（视角互补，不是共识也不是冲突）。
  function topicKey(scope) {
    // P2-16: Windows 绝对路径 D:\TITAN\foo\bar.mjs:500 —— 只 replace \ → / 再 split
    // 仍会把盘符当第一段（"d"），scope 归并失效。正确做法：先取路径基名（剥盘符与目录），
    // 再按 : - / 切第一段。
    //   D:\TITAN\orchestrator\orchestrate.mjs:500 → orchestrate.mjs
    //   orchestrate.mjs:500                        → orchestrate.mjs
    //   screenshot-timestamp                       → screenshot
    const normalized = String(scope || '').replace(/\\/g, '/');
    const base = normalized.slice(normalized.lastIndexOf('/') + 1);
    return base.split(/[:\-\/]/)[0].toLowerCase().trim();
  }

  // P1-12b/P5: 中文无空格分词修正 —— 命题是"标题/位置/严重程度/建议"多行结构，
  // 整句中文（"提供商配置键名拼写错误"）会成为单个 token，跨模型措辞差异直接 0 重叠。
  // 修法：剥离结构标签与 ISSUE-ID 行、截掉 verdict 表尾巴、中英术语词典归一、再分词。
  const ZH_EN_GLOSSARY = [
    [/(?:上下文窗口)/g, ' contextwindow '],
    [/(?:最大输出长度|输出上限)/g, ' maxtokens '],
    [/(?:提供商|配置块|provider)/g, ' provider '],
    [/(?:拼写错误|typo)/g, ' typo '],
    [/(?:超时)/g, ' timeout '],
    [/(?:重试)/g, ' retry '],
    [/(?:键名)/g, ' keyname '],
    [/(?:环境变量|envvar)/g, ' envvar '],
    [/(?:模型|model)/g, ' model '],
    [/(?:nvida|nvidia)/g, ' nvidia '],
    [/(?:googl|google)/g, ' google '],
    [/(?:cometapi|apmix)/g, ' provider '],
    [/(?:contextwindow|context window)/g, ' contextwindow '],
    [/(?:maxtokens|max tokens|输出长度)/g, ' maxtokens '],
    [/(?:apiKey|api key)/g, ' apikey '],
    [/(?:env|environment)/g, ' env '],
  ];
  function tokenizeProp(text) {
    const cleaned = String(text || '')
      // 截掉附在命题后的 verdict 表（"条目\t判定\t..." 起的所有行）
      .split('\n')
      .reduce((acc, l) => {
        if (acc.cut) return acc;
        if (/^\s*(?:条目|名称)\s*(?:\t|\|)\s*(?:判定|verdict)/i.test(l)) { acc.cut = true; return acc; }
        acc.lines.push(l); return acc;
      }, { lines: [], cut: false }).lines
      .filter(l => !/^ISSUE[\s_-]?ID/i.test(l))                 // 去掉 ISSUE-ID 行（纯编号噪声）
      .map(l => l.replace(/(?:标题|位置|严重程度|建议)\s*[:：]\s*/gi, ' ')) // 去掉结构标签
      .join(' ');
    let s = factPropKey(cleaned);
    for (const [re, rep] of ZH_EN_GLOSSARY) s = s.replace(re, rep);
    // 排除结构/停用词，避免人为抬高重叠率
    const stopwords = /^(标题 | 位置 | 严重程度 | 建议 | 或 | 和 | 的 | 为|是|有|与|及|或)$/i;
    return new Set(s.split(/\s+/).filter(w => w.length >= 2 && !stopwords.test(w)));
  }
  function tokenOverlap(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    return inter / Math.min(a.size, b.size);
  }

  // P5: 聚类改为按 topic（scope 首段）而非 scope 全等 —— 真实数据里同一事实的 scope
  // 在两模型间长度不同（"nvida:" vs "nvida: displayName: nvidia / apiKeyEnv: ..."），
  // scope 全等会让 4 个目标共识对全部落空。
  const SOFT_MATCH_RATIO = 0.25;
   const SOFT_MATCH_MIN_SHARED = 2;
   const groupList = [];
   // Index: topic -> tokenPair -> Set of group indices
   const topicTokenPairIndex = new Map();
   for (const o of survivors) {
     const pk = factPropKey(o.text);
     if (!pk) continue;
     const tokens = tokenizeProp(o.text);
     const topic = topicKey(o.scope);
     let target = null;
     
     // Only check groups in the same topic using token pair indexing
     if (topicTokenPairIndex.has(topic)) {
       const pairIndex = topicTokenPairIndex.get(topic);
       // Generate token pairs for this occurrence
       const tokenArray = [...tokens];
       const pairs = new Set();
       for (let i = 0; i < tokenArray.length; i++) {
         for (let j = i + 1; j < tokenArray.length; j++) {
           pairs.add(`${tokenArray[i]}|${tokenArray[j]}`);
         }
       }
       
       // Count how many pairs each group shares
       const groupScores = new Map();
       for (const pair of pairs) {
         if (pairIndex.has(pair)) {
           for (const groupIndex of pairIndex.get(pair)) {
             const score = (groupScores.get(groupIndex) || 0) + 1;
             groupScores.set(groupIndex, score);
           }
         }
       }
       
       // Find groups that meet the thresholds
       let bestScore = 0;
       let bestGroupIndex = -1;
       for (const [groupIndex, sharedCount] of groupScores.entries()) {
         if (sharedCount >= SOFT_MATCH_MIN_SHARED) {
           const group = groupList[groupIndex];
           const overlap = tokenOverlap(group.tokens, tokens);
           if (overlap >= SOFT_MATCH_RATIO && sharedCount > bestScore) {
             bestScore = sharedCount;
             bestGroupIndex = groupIndex;
           }
         }
       }
       
       if (bestGroupIndex >= 0) {
         target = groupList[bestGroupIndex];
       }
     }
     
     if (!target) {
       target = { propKey: pk, tokens, scope: o.scope, topic, occurrences: [], proposition: o.text.slice(0, 500) };
       const groupIndex = groupList.length;
       groupList.push(target);
       
       // Add this group to the index
       if (!topicTokenPairIndex.has(topic)) {
         topicTokenPairIndex.set(topic, new Map());
       }
       const pairIndex = topicTokenPairIndex.get(topic);
       const tokenArray = [...tokens];
       for (let i = 0; i < tokenArray.length; i++) {
         for (let j = i + 1; j < tokenArray.length; j++) {
           const pair = `${tokenArray[i]}|${tokenArray[j]}`;
           if (!pairIndex.has(pair)) {
             pairIndex.set(pair, new Set());
           }
           pairIndex.get(pair).add(groupIndex);
         }
       }
     } else if (o.scope.length < target.scope.length) {
       target.scope = o.scope; // 保留更短（更精确）的 scope 作为组证据范围
       // Note: We don't update the index here for simplicity, as scope changes are rare
       // and the index is based on tokens only. This is acceptable as scope is only
       // used for tie-breaking when choosing between equally matching groups.
     }
     target.occurrences.push(o);
   }
  const isMulti = new Set(groupList.filter(g => new Set(g.occurrences.map(o => o.reviewer)).size >= 2).map(g => g.propKey + ' ||| ' + g.topic));

  for (const g of groupList) {
    const gk = g.propKey + ' ||| ' + g.topic;
    const reviewerSet = new Set(g.occurrences.map(o => o.reviewer));
    let maxSev = null;
    for (const o of g.occurrences) {
      if (o.severity && (!maxSev || sevOrder[o.severity] > sevOrder[maxSev])) maxSev = o.severity;
    }

    if (isMulti.has(gk)) {
      // S3 关键修复：同命题且同 scope 才是 CONSENSUS
      consensus.push({ proposition: g.proposition, evidenceScope: g.scope, occurrences: g.occurrences, severity: maxSev });
      continue;
    }

    // 单方组：先查同主题、不同命题、不同 reviewer 的其他单方组 → COMPLEMENTARY
    let comp = false;
    for (const h of groupList) {
      if (h === g) continue;
      const hgk = h.propKey + ' ||| ' + h.topic;
      if (isMulti.has(hgk)) continue;
      if (h.topic !== g.topic || h.propKey === g.propKey) continue;
      const hReviewers = new Set(h.occurrences.map(o => o.reviewer));
      if ([...reviewerSet].some(r => hReviewers.has(r))) continue; // 同 reviewer 的不同发现不算互补
      comp = true;
      break;
    }

    if (comp) {
      // P1-11: 配对方信息带入 —— complementary 节点必须记录配对方，满足"互补 ≥2 reviewer"的定义
      const compWith = [];
      for (const h of groupList) {
        if (h === g) continue;
        const hgk = h.propKey + ' ||| ' + h.topic;
        if (isMulti.has(hgk)) continue;
        if (h.topic !== g.topic || h.propKey === g.propKey) continue;
        const hReviewers = new Set(h.occurrences.map(o => o.reviewer));
        if ([...reviewerSet].some(r => hReviewers.has(r))) continue;
        compWith.push({ proposition: h.proposition, evidenceScope: h.scope, reviewers: [...hReviewers] });
      }
      complementary.push({ proposition: g.proposition, evidenceScope: g.scope, occurrences: g.occurrences, complementaryWith: compWith });
      // 不 continue，让单方 HIGH 继续进入 BLIND_SPOT/BACKLOG 分流
    }

    // 剩余单方：按阈值分 BLIND_SPOT / HIGH_SEVERITY_UNCONFIRMED / BACKLOG
    // P16: 三桶互斥级联 —— 旧代码把 HSU 放在 upDelta 分支内判断 maxSev!=='HIGH'，
    // 而 upDelta 本身要求 maxSev==='HIGH'（srtDelta=HIGH），HSU 分支恒不可达。
    // 正确语义：upDelta → BLIND_SPOT(入 DELTA)；否则 HIGH → HSU（高严重但未达升级阈值）；
    // 再否则按 single_reviewer_to_backlog → BACKLOG。
    const srtDelta = thresholds.single_reviewer_to_delta;
    const srtBacklog = thresholds.single_reviewer_to_backlog;
    const upDelta = srtDelta !== undefined ? sevIncludes(srtDelta, maxSev) : (maxSev === 'HIGH' && sevIncludes(thresholds.blind_spot_to_delta, 'HIGH'));
    if (upDelta) {
      blindSpots.push({ proposition: g.proposition, evidenceScope: g.scope, severity: maxSev, occurrences: g.occurrences });
    } else if (maxSev === 'HIGH') {
      highSeverityUnconfirmed.push({ proposition: g.proposition, evidenceScope: g.scope, severity: maxSev, occurrences: g.occurrences });
    } else if (srtBacklog !== undefined ? sevIncludes(srtBacklog, maxSev) : true) {
      backlogs.push({ bucket: 'BACKLOG', proposition: g.proposition, evidenceScope: g.scope, severity: maxSev, occurrences: g.occurrences });
    }
  }

  // S3: FACT_CONFLICT 已由 verdict 表（verdictByName）检测。补 ASSUMPTION_CONFLICT：
  // 仅在结构化 verdict 表缺失（verdictLines=0）时，用整体判定启发式兜底
  // P1-05: 以 dispatch-meta.reviewers 为准
  const overallVerdicts = {};
  let hasVerdictLines = false;
  for (const rv of meta.reviewers) {
    const verdicts = extractVerdictLines(rawByReviewer[rv.name]);
    if (verdicts.length > 0) hasVerdictLines = true;
    overallVerdicts[rv.name] = verdicts.length > 0 ? extractOverallVerdict(rawByReviewer[rv.name]) : null;
  }
  // 若至少一个 reviewer 有结构化 verdict 表，则不触发 ASSUMPTION_CONFLICT 兜底
  if (!hasVerdictLines) {
    const nonUnknown = meta.reviewers.filter(r => overallVerdicts[r.name] && overallVerdicts[r.name] !== 'UNKNOWN');
    if (nonUnknown.length >= 2) {
      const vset = new Set(nonUnknown.map(r => overallVerdicts[r.name]));
      if (vset.size > 1) {
        conflicts.push({
          conflictId: 'C-' + String(conflicts.length + 1).padStart(3, '0'),
          type: 'ASSUMPTION_CONFLICT',
          name: '整体判定不一致',
          verdicts: Object.fromEntries(nonUnknown.map(r => [r.name, overallVerdicts[r.name]])),
          reasons: Object.fromEntries(nonUnknown.map(r => [r.name, ''])),
        });
      }
    }
  }

  writeFileSync(join(layerBDir, 'conflicts.json'), JSON.stringify(conflicts, null, 2), 'utf8');
  // P2-17: analyze 成功完成，覆盖 STEP_A_PLACEHOLDER
  writeFileSync(join(layerBDir, 'status.json'), JSON.stringify({ status: 'COMPLETED', ts: new Date().toISOString(), counts: { conflicts: conflicts.length, blindSpots: blindSpots.length, highSeverityUnconfirmed: highSeverityUnconfirmed.length, consensus: consensus.length, complementary: complementary.length, backlogs: backlogs.length } }, null, 2), 'utf8');
  writeFileSync(join(layerBDir, 'blind-spots.json'), JSON.stringify(blindSpots, null, 2), 'utf8');
  writeFileSync(join(layerBDir, 'high-severity-unconfirmed.json'), JSON.stringify(highSeverityUnconfirmed, null, 2), 'utf8');
  writeFileSync(join(layerBDir, 'filtered.json'), JSON.stringify(filtered, null, 2), 'utf8');
  writeFileSync(join(layerBDir, 'backlog.json'), JSON.stringify({ consensus, complementary, backlog: backlogs }, null, 2), 'utf8');

  // S4: delta.md —— DELTA 项 = FACT_CONFLICT + ASSUMPTION_CONFLICT + BLIND_SPOT + HIGH_SEVERITY_UNCONFIRMED
  // 按类型优先级排序后统一编号，避免盲点排在事实冲突前面
  const deltas = [];
  for (const c of conflicts) {
    deltas.push({
      type: c.type,
      name: c.name,
      verdicts: c.verdicts,
      reasons: c.reasons,
      occurrences: [],
      finding: c.name,
      evidenceScope: '',
      requires: c.type === 'ASSUMPTION_CONFLICT'
        ? '多方整体判定不一致，可能基于不相容前提，需架构师裁定前提'
        : '该条目事实判定冲突，需裁决事实真相',
      action: 'revise artifact | accept risk | escalate',
    });
  }
  for (const b of blindSpots) {
    deltas.push({
      type: 'BLIND_SPOT',
      occurrences: b.occurrences.map(o => ({ reviewer: o.reviewer, issueId: o.issueId, severity: o.severity })),
      finding: b.proposition.slice(0, 300),
      evidenceScope: b.evidenceScope || '',
      requires: '单方高严重度发现（其他 reviewer 未指出），是否采纳',
      action: 'revise artifact | accept risk | re-dispatch',
      raisedBy: b.occurrences.map(o => o.reviewer),
    });
  }
  for (const bl of highSeverityUnconfirmed) {
    deltas.push({
      type: 'HIGH_SEVERITY_UNCONFIRMED',
      occurrences: bl.occurrences.map(o => ({ reviewer: o.reviewer, issueId: o.issueId, severity: o.severity })),
      finding: bl.proposition.slice(0, 300),
      evidenceScope: bl.evidenceScope || '',
      requires: '单方 HIGH 严重度但低于盲点阈值，是否需架构师决策',
      action: 'accept risk | re-dispatch',
      raisedBy: bl.occurrences.map(o => o.reviewer),
    });
  }
  const priority = { FACT_CONFLICT: 0, ASSUMPTION_CONFLICT: 1, HIGH_SEVERITY_UNCONFIRMED: 2, BLIND_SPOT: 3 };
  deltas.sort((a, b) => (priority[a.type] - priority[b.type]));
  deltas.forEach((dt, i) => { dt.deltaId = 'DELTA-' + String(i + 1).padStart(3, '0'); });

  const d = [];
  d.push('# Layer B — delta');
  d.push('');
  d.push('dispatchId: ' + dispatchId);
  d.push('generated: ' + new Date().toISOString());
  d.push('artifactSha256: ' + (meta.artifactSha256 || ''));
  d.push('round: ' + (meta.reviewRound || 1) + '  trigger: ' + (meta.trigger || ''));
  d.push('counts: conflicts=' + conflicts.length + ' blind_spots=' + blindSpots.length + ' filtered=' + filtered.length + ' consensus=' + consensus.length + ' complementary=' + complementary.length + ' backlog=' + backlogs.length);
  d.push('');
  d.push('## DELTA 项');
  d.push('');
  if (deltas.length === 0) {
    d.push('_（无 DELTA 项）_');
    d.push('');
  }
  for (const dt of deltas) {
    d.push('### ' + dt.deltaId);
    d.push('Type: ' + dt.type);
    if (dt.name) d.push('Name: ' + dt.name);
    d.push('Reviewers:');
    // P1-05: delta.md 的 Reviewers 段以 dispatch-meta.reviewers 为准，保证
    // dispatch 时在席但 analyze 前（可能）被禁用的 reviewer 仍出现在 DELTA 里
    for (const rv of meta.reviewers) {
      // 冲突类用 verdict 表；盲点/单方类标 raised（该 reviewer 提出了此发现）vs not raised
      const raised = dt.raisedBy && dt.raisedBy.includes(rv.name);
      const v = raised
        ? 'raised' + (dt.occurrences.find(o => o.reviewer === rv.name) ? ' (' + dt.occurrences.find(o => o.reviewer === rv.name).issueId + ', ' + String(dt.occurrences.find(o => o.reviewer === rv.name).severity || 'null') + ')' : '')
        : ((dt.verdicts && dt.verdicts[rv.name]) || 'not raised');
      d.push('  - ' + rv.name + ': ' + v);
    }
    d.push('Occurrences:');
    if (dt.occurrences && dt.occurrences.length) {
      for (const o of dt.occurrences) d.push('  - { reviewer: ' + o.reviewer + ', issueId: ' + o.issueId + ', severity: ' + String(o.severity || 'null') + ' }');
    } else {
      d.push('  - (整体判定级，无单体 occurrence)');
    }
    d.push('Finding: ' + dt.finding);
    // I005: Evidence / Same-fact verification —— 对齐 SKILL.md DELTA 模板，
    // 每条 DELTA 自带证据锚点与同事实校验三要素（artifact SHA256 / 命题 / scope）
    d.push('Evidence:');
    if (dt.occurrences && dt.occurrences.length) {
      for (const o of dt.occurrences) d.push('  - ' + o.reviewer + ' ' + o.issueId + ' (' + String(o.severity || 'null') + ')');
    } else {
      d.push('  - (verdict 表级冲突，见 Reviewers 段判定值)');
    }
    d.push('Same-fact verification:');
    d.push('  - artifact: ' + (meta.artifactSha256 || ''));
    d.push('  - factual proposition: ' + (dt.finding || '').slice(0, 200));
    d.push('  - evidence scope: ' + (dt.evidenceScope || '(unscoped)'));
    d.push('Requires Architect decision: ' + dt.requires);
    d.push('Suggested action: ' + dt.action);
    d.push('');
  }
  d.push('## Filtered Findings (recorded, not acted upon)');
  d.push('');
  if (filtered.length === 0) {
    d.push('_(none)_');
  } else {
    d.push('| Reviewer | Issue-ID | Rule | Reason |');
    d.push('|---|---|---|---|');
    for (const f of filtered) d.push('| ' + f.reviewer + ' | ' + f.issueId + ' | ' + f.ruleId + ' | ' + (f.reason || '').slice(0, 80) + ' |');
  }
  d.push('');
  writeFileSync(join(layerBDir, 'delta.md'), d.join('\n'), 'utf8');

  console.log('[ANALYZE] conflicts=' + conflicts.length + ' blind_spots=' + blindSpots.length + ' filtered=' + filtered.length + ' consensus=' + consensus.length + ' complementary=' + complementary.length + ' backlog=' + backlogs.length);
  console.log('[ANALYZE] deltas=' + deltas.length + ' layer-b: ' + layerBDir);
}
