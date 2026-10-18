// delta-to-registry.mjs  —— 合同 #4 步 C 之一
// 把 orchestrator/汇总.md 的 48 条存量问题（P1 15 + P2 18 + P3 15）导入为工单（work-orders.json）。
// 汇总.md 是审计基线（M7 只读），本脚本**只读**它；行锚点现场解析（G13），未命中 -> NEEDS_ENRICHMENT。
//
// 用法:
//   node delta-to-registry.mjs --dry-run            # 只打印统计，不写文件
//   node delta-to-registry.mjs --out <path>         # 真实写出
//   node delta-to-registry.mjs --limit 3            # 只处理前 N 条（冒烟）
//   node delta-to-registry.mjs --base <sha>         # 指定 base_commit（缺省当前 HEAD）
// 退出码: 0=成功, 1=写出失败, 2=源文件缺失/解析为 0 条

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withLockedJsonWrite } from './lib/lock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TITAN = process.env.D_TITAN_ROOT || join(__dirname, '..');
const SUMMARY = join(TITAN, 'orchestrator', '汇总.md');

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const dryRun = has('--dry-run');
// S-07：canonical 工单队列 = orchestrator/work-orders.json。旧默认写仓库根，而消费者
// （autopilot/fixer-pool/verify-delta）全读 orchestrator/，按默认用法导入即丢失——默认改
// 到 orchestrator/ 与消费者对齐；--out 仍可显式覆盖。
const outPath = resolve(val('--out') || join(__dirname, 'work-orders.json'));
const limit = val('--limit') ? Number(val('--limit')) : null;

console.log('[OUT] ' + outPath + (dryRun ? '（dry-run，不写文件）' : ''));

if (!existsSync(SUMMARY)) { console.error('[MISSING] ' + SUMMARY); process.exit(2); }

function headSha() {
  if (val('--base')) return val('--base');
  try { return execFileSync('git', ['-C', TITAN, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
  catch { return null; }
}

// ---------- 解析 汇总.md ----------
function splitRow(line) {
  // 拆 markdown 表格行：| a | b | c |
  const t = line.trim();
  if (!t.startsWith('|')) return null;
  return t.replace(/^\|/, '').replace(/\|$/, '').split('|').map(s => s.trim());
}

function parseSummary(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const items = [];
  let priority = null, stage = null, cur = null;
  let cols = null; // 表格式段落的列映射
  const flush = () => { if (cur && cur.id) items.push(cur); cur = null; };
  for (const line of lines) {
    let m;
    if ((m = line.match(/^##\s+.*?(P[123])\s*[—-]/))) { flush(); priority = m[1]; stage = null; cols = null; continue; }
    if ((m = line.match(/^###\s+(S\d+)/))) { flush(); stage = m[1]; continue; }
    // 表格式段落（P2/P3）：表头 -> 列映射；数据行 -> 一条工单
    if (priority && (m = line.match(/^\|\s*ID\s*\|/))) {
      const head = splitRow(line);
      cols = {};
      head.forEach((h, i) => { const k = h.replace(/[*\s]/g, ''); cols[k] = i; });
      continue;
    }
    if (cols && /^\|\s*\*\*P\d-\d+\*\*\s*\|/.test(line.trim())) {
      const cells = splitRow(line);
      const id = (cells[cols['ID']] || '').replace(/[*\s]/g, '');
      if (!id) continue;
      flush();
      cur = {
        id,
        title: (cells[cols['问题']] || '').replace(/\*/g, ''),
        priority, stage,
        location: cells[cols['位置']] || '',
        fix: (cells[cols['修复要点']] || cells[cols['修复']] || '').replace(/\*/g, ''),
        impact: '',
      };
      flush(); // 表格行自包含，直接入列
      cur = null;
      continue;
    }
    if ((m = line.match(/^####\s+(P\d-\d+)\s+(.+)$/))) { flush(); cur = { id: m[1], title: m[2].trim(), priority, stage, location: '', fix: '', impact: '' }; continue; }
    if (cur) {
      if ((m = line.match(/^[-*]\s+\*\*位置\*\*：(.*)$/))) cur.location = m[1].trim();
      else if ((m = line.match(/^[-*]\s+\*\*修复\*\*：(.*)$/))) cur.fix = m[1].trim();
      else if ((m = line.match(/^[-*]\s+\*\*影响\*\*：(.*)$/))) cur.impact = m[1].trim();
    }
  }
  flush();
  return items;
}

// ---------- 锚点解析（G13 现场解析）----------
const DEFAULT_TARGET = 'orchestrator/orchestrate.mjs';

function pickTarget(loc) {
  if (/reviewers\.yaml/.test(loc)) return 'orchestrator/reviewers.yaml';
  if (/verify-baseline/.test(loc)) return 'orchestrator/verify-baseline.mjs';
  if (/adapters\.json/.test(loc)) return 'orchestrator/adapters.json';
  return DEFAULT_TARGET;
}

const STOP = new Set(['issue','issues','layer','marker','reviewers','dispatch','response','analysis','config','severity','priority','content','output','result','error','value','false','true','length','string','number','window','files','lines','close','sender','status','system','check','path','line','node','bash','test','refs','exec','both','each','have','from','with','this','that']);
function looksLikeSymbol(tok) {
  if (!tok || tok.length < 5) return false;
  if (STOP.has(tok.toLowerCase())) return false;
  // 混合大小写 / 下划线 / 点号 / 括号内出现 → 更像代码符号
  return /[A-Z_.$]/.test(tok.slice(1)) || /[_.]/.test(tok) || /^[a-z]+[A-Z]/.test(tok);
}

// 返回候选 pattern 数组（按可信度排序），不再只返回一个
function patternCandidates(loc, title) {
  const out = [];
  const push = (p, kind) => { if (p && !out.some(x => x.pattern === p)) out.push({ pattern: p, kind }); };
  const btLoc = loc.match(/\`([^\`]+)\`/); if (btLoc && !btLoc[1].includes(' ')) push(btLoc[1], 'backtick');
  const sym = loc.match(/([A-Za-z_$][\w$.]{4,})\s*L\d+/); if (sym) push(sym[1], 'symbol+line');
  const paren = loc.match(/L\d+[^()]*\(([A-Za-z_$][\w$.]{2,})\)/); if (paren) push(paren[1], 'line+paren');
  const btT = title.match(/\`([^\`]+)\`/); if (btT) push(btT[1], 'title-backtick');
  // 标题里的类标识符 token
  for (const m of (title.match(/[A-Za-z_$][A-Za-z0-9_$.*?\\-]{4,}/g) || [])) {
    if (looksLikeSymbol(m)) push(m, 'title-token');
  }
  return out;
}

function resolveAnchor(targetRels, candidates) {
  if (!candidates.length) return { resolvedLine: null, pattern: null, resolvedFile: null, hit: false, reason: 'no-pattern' };
  for (const rel of targetRels) {
    const p = join(TITAN, rel);
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, 'utf8').replace(/\r/g, '').split('\n');
    for (const c of candidates) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(c.pattern)) return { resolvedLine: i + 1, pattern: c.pattern, resolvedFile: rel, hit: true, reason: 'hit:' + c.kind };
      }
    }
  }
  return { resolvedLine: null, pattern: candidates[0].pattern, resolvedFile: null, hit: false, reason: 'pattern-not-found' };
}

// S-11：verify_cmd 按扩展名分派——mjs/js/cjs→node --check；json→JSON.parse；
// yaml/yml→js-yaml 解析（克隆树缺 node_modules 时 check-file 以 exit 2 报 ENV，
// 与 verify-delta 的 ENV:ENV_DEPS 语义对接）。统一走 orchestrator/lib/check-file.mjs。
function verifyCmdFor(target) {
  const ext = extname(String(target)).toLowerCase();
  if (['.mjs', '.js', '.cjs', '.json', '.yaml', '.yml'].includes(ext)) {
    return 'node orchestrator/lib/check-file.mjs ' + target;
  }
  return 'node --check ' + target;
}
function depsFor(target) {
  const ext = extname(String(target)).toLowerCase();
  return (ext === '.yaml' || ext === '.yml') ? ['js-yaml'] : [];
}

// ---------- 主流程 ----------
const items = parseSummary(readFileSync(SUMMARY, 'utf8'));
if (items.length === 0) { console.error('[ERROR] 解析出 0 条'); process.exit(2); }
const use = limit ? items.slice(0, limit) : items;
const base = headSha();
const now = new Date().toISOString();

const orders = use.map((it, idx) => {
  const target = pickTarget(it.location);
  const candidates = patternCandidates(it.location, it.title);
  const targetList = target === DEFAULT_TARGET ? [target] : [target, DEFAULT_TARGET];
  const anchor = resolveAnchor(targetList, candidates);
  const effectiveTarget = anchor.resolvedFile || target;
  const pattern = anchor.pattern;
  const status = anchor.hit ? 'ready' : 'NEEDS_ENRICHMENT';
  return {
    id: 'WO-' + now.slice(0, 10).replace(/-/g, '') + '-' + String(idx + 1).padStart(3, '0'),
    source_delta: it.id + ' (汇总.md ' + (it.stage || '-') + '/' + (it.priority || '-') + ')',
    source_title: it.title,
    status,
    owner: null,
    verifier: null,
    base_commit: base,
    target_files: [effectiveTarget],
    anchor: { file: effectiveTarget, triedFiles: targetList, pattern, patternCandidates: candidates.map(c => c.pattern + '(' + c.kind + ')'), resolvedLine: anchor.resolvedLine, expectHit: true, resolveReason: anchor.reason },
    instruction: it.fix || it.impact || it.title,
    verify_cmd: verifyCmdFor(effectiveTarget),
    verify_cmd_deps: depsFor(effectiveTarget),
    expected_gate_drift: {},
    attempt_count: 0,
    created_at: now,
    approved_at: null,
    closed_at: null,
    note: status === 'NEEDS_ENRICHMENT' ? ('锚点未命中: ' + anchor.reason + (pattern ? ' (pattern=' + pattern + ')' : ' (位置仅有行号，需人工补 pattern)')) : null,
  };
});

const ready = orders.filter(o => o.status === 'ready').length;
const enrich = orders.length - ready;
const dist = {};
for (const o of orders) dist[o.anchor.resolveReason] = (dist[o.anchor.resolveReason] || 0) + 1;

const doc = {
  schema_version: '1.0',
  contract: 'orchestrator/autopilot-contract-v1.md#1',
  source: 'orchestrator/汇总.md（只读导入，M7 不改）',
  base_commit: base,
  generated_at: now,
  stats: { total: orders.length, ready, needs_enrichment: enrich, byResolveReason: dist },
  orders,
};

console.log('=== delta-to-registry' + (dryRun ? '（dry-run）' : '') + ' ===');
console.log('源条目: ' + items.length + '，本次处理: ' + orders.length + (limit ? '（--limit ' + limit + '）' : ''));
console.log('ready=' + ready + '  NEEDS_ENRICHMENT=' + enrich);
console.log('锚点解析原因分布: ' + JSON.stringify(dist));
console.log('base_commit=' + base);
if (dryRun) {
  console.log('dry-run：不写文件。前 3 条预览:');
  for (const o of orders.slice(0, 3)) console.log('  ' + o.id + ' [' + o.status + '] ' + o.source_delta + ' -> ' + o.anchor.file + ':' + o.anchor.resolvedLine);
  process.exit(0);
}
// S-09：写回走 lib/lock.mjs（wx 抢锁 + 死锁清理 + tmp/rename 原子落盘），
// 生成件是全量重生成，无快照比对（每次运行都重算，直接整写）。
const wres = withLockedJsonWrite(outPath, { produceDoc: () => doc });
if (!wres.ok) {
  console.error('[WRITE] ' + wres.status + (wres.detail ? '：' + wres.detail : ''));
  process.exit(1);
}
console.log('[WRITE] written (locked): ' + outPath);
console.log('已写出: ' + outPath);
process.exit(0);
