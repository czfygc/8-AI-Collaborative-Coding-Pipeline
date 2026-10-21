// verify-baseline.mjs
// 只读验证 layer-b 是否达标（S4 冻结基线 §2 + 汇总.md §七 对照）
// 用法: node verify-baseline.mjs [dispatchId] (缺省 66c0f00e)
// 退出码: 0=PASS, 1=FAIL, 2=内部错误(文件不存在等)
// 只读，不修改任何文件

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { extractVerdictLines } from './lib/verdict-parse.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.D_TITAN_ROOT || join(__dirname, '..');

/**
 * ============ TARGET 常量（集中定义，便于后续调整）============
 * 主基准来源：reviews/_final_evidence/_session_memory.md §2
 *   「回归基线断言（每次改动后必须验证，跌破立即回滚）」
 *   该基线经 T-01/T-04/T-07 多批次多轮复跑验证，具回滚权威。
 *
 * 差异说明：orchestrator/汇总.md §七「验证基线（修完 S4 后应达到）」
 *   给出的目标不同（blind-spots ≥2、complementary backlog ≤5），
 *   但冻结基线 §2 实测 blind-spots=0 / complementary=0 且被反复验证。
 *   本脚本以 §2 为准；§七 数值在各条备注中标注供对照。
 */
const TARGET = {
  verdictLines: { gemini: 6, deepseek: 9 },  // §2 冻结
  consensus: 4,                               // §2 冻结（汇总 §七 ≥4）
  assumptionConflict: 0,                      // §2 与 §七 一致
  blindSpots: 0,                              // §2 冻结（汇总 §七 ≥2 —— 见备注差异）
  complementaryBacklog: 0,                    // §2 冻结（汇总 §七 ≤5）
};

// T-83 收敛：extractVerdictLines 唯一事实源 = lib/verdict-parse.mjs（顶部已 import）。
// 原本地副本（表头分隔跳过正则含 /i）已废除，统一为 lib 版（无 /i，对 ASCII 分隔行行为一致）。

/**
 * 读取 raw.md 响应正文 —— 与 lib/verdict-parse.mjs:readRawResponse 逻辑同源，判边界保留同步实现（T-83）。
 * lib 版为 async（orchestrate 调用点必须 await）；本脚本保持 sync IO 风格，逻辑等价已由 T-73 评估+M4 判定。
 * 逻辑变更时须同步核对此处与 lib 版。
 */
function readRawResponse(mdPath) {
  const content = readFileSync(mdPath, 'utf8');
  const m = content.match(/## Response\s*\n([\s\S]*)$/);
  return m ? m[1].trim() : content;
}

function evaluate(c) {
  if (c.op === '==') return c.actual === c.expected;
  if (c.op === '>=') return c.actual >= c.expected;
  if (c.op === '<=') return c.actual <= c.expected;
  return false;
}

function verifyBaseline(dispatchId) {
  const TITAN_ROOT = process.env.D_TITAN_ROOT || resolve(fileURLToPath(new URL('..', import.meta.url)));
  const outDir = join(TITAN_ROOT, 'reviews', dispatchId);
  const layerB = join(outDir, 'layer-b');
  const rawDir = join(outDir, 'layer-a', 'raw');

  const required = [
    ['status.json', join(layerB, 'status.json')],
    ['blind-spots.json', join(layerB, 'blind-spots.json')],
    ['conflicts.json', join(layerB, 'conflicts.json')],
    ['backlog.json', join(layerB, 'backlog.json')],
    ['delta.md', join(layerB, 'delta.md')],
    ['raw/gemini.md', join(rawDir, 'gemini.md')],
    ['raw/deepseek.md', join(rawDir, 'deepseek.md')],
  ];
  for (const [label, f] of required) {
    if (!existsSync(f)) {
      console.error('[MISSING] ' + f + ' 不存在');
      console.error('请先跑: node orchestrate.mjs --analyze ' + dispatchId);
      process.exit(2);
    }
  }

  const status = JSON.parse(readFileSync(join(layerB, 'status.json'), 'utf8'));
  const blindSpotsArr = JSON.parse(readFileSync(join(layerB, 'blind-spots.json'), 'utf8'));
  const conflicts = JSON.parse(readFileSync(join(layerB, 'conflicts.json'), 'utf8'));
  const backlog = JSON.parse(readFileSync(join(layerB, 'backlog.json'), 'utf8'));
  const deltaMd = readFileSync(join(layerB, 'delta.md'), 'utf8');
  const rawGemini = readRawResponse(join(rawDir, 'gemini.md'));
  const rawDeepseek = readRawResponse(join(rawDir, 'deepseek.md'));

  const vlGemini = extractVerdictLines(rawGemini).length;
  const vlDeepseek = extractVerdictLines(rawDeepseek).length;
  const consensus = (status.counts && status.counts.consensus) || 0;
  const assumptionConflicts = conflicts.filter(c => c.type === 'ASSUMPTION_CONFLICT').length;
  const blindSpots = blindSpotsArr.length;
  const complementary = (backlog.complementary && backlog.complementary.length) || 0;
  const deltas = (deltaMd.match(/DELTA-\d{3}/g) || []).length;

  const checks = [
    { id: 1, label: 'verdictLines(gemini)', actual: vlGemini, expected: 6, op: '==', note: '' },
    { id: 2, label: 'verdictLines(deepseek)', actual: vlDeepseek, expected: 9, op: '==', note: '' },
    { id: 3, label: 'CONSENSUS', actual: consensus, expected: 4, op: '>=', note: '可能原因：scope fallback 破坏命题归并（P1-12）；查 runAnalyze topicKey/factPropKey 逻辑' },
    { id: 4, label: 'ASSUMPTION_CONFLICT 假冲突', actual: assumptionConflicts, expected: 0, op: '==', note: '可能原因：extractVerdictLines 未接受 \\t 分隔；或 extractOverallVerdict 否定包跨行误删（P2-06）' },
    { id: 5, label: 'blind-spots', actual: blindSpots, expected: 0, op: '==', note: '§2 冻结值 0 为准（gate-v1.1 起收紧为 ==0：blind-spots 任何漂移都必须显式重定基线，不许被 >= 吞掉）；汇总 §七 目标 ≥2 与 §2 冻结值冲突，以 §2 为准——若违规先核对是否有人按 §七 改了分层逻辑' },
    { id: 6, label: 'complementary backlog', actual: complementary, expected: 0, op: '<=', note: '§2 冻结值 0 为准；汇总 §七 目标 ≤5' },
    // ---- gate-v2 新增 4 条（⑥ 调参裁定；来源：硬度矩阵盲区 + 第6轮实测）----
    { id: 7, label: 'blind-spot occurrences 完整', actual: blindSpotsArr.filter(b => !Array.isArray(b.occurrences)).length, expected: 0, op: '==', note: '缺 occurrences 会让 analyze 在 delta 生成段崩溃（L3102 实测）' },
    { id: 8, label: 'backlog.complementary 键', actual: (backlog && Array.isArray(backlog.complementary)) ? 0 : 1, expected: 0, op: '==', note: '硬度矩阵 M10：键被删被读作 0，数据丢失不可见' },
    { id: 9, label: 'counts 与产物一致', actual: ((((status.counts && status.counts.conflicts) === conflicts.length) ? 0 : 1) + (((status.counts && status.counts.blindSpots) === blindSpotsArr.length) ? 0 : 1) + ((Array.isArray(backlog.complementary) && (status.counts && status.counts.complementary) === backlog.complementary.length) ? 0 : 1) + ((Array.isArray(backlog.backlog) && (status.counts && status.counts.backlogs) === backlog.backlog.length) ? 0 : 1)), expected: 0, op: '==', note: 'status.json counts 必须与 conflicts/blind-spots/backlog 产物长度一致（防写半套产物，P2-17 类）' },
    { id: 10, label: 'CONSENSUS ==4（gate-v2 收紧）', actual: consensus, expected: 4, op: '==', note: '硬度矩阵 M4：>= 上行漂移不可见；漂移一律走预登记→REBASELINE（协议已演练）' },
    // ---- gate-v3 新增（Director 2026-10-02 紧急指令：d8aac99 事故证明 10/10 ≠ 语法绿）----
    { id: 11, label: 'orchestrate.mjs 语法', actual: (() => { try { execFileSync('node', ['--check', join(REPO_ROOT, 'orchestrator', 'orchestrate.mjs')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return 0; } catch { return 1; } })(), expected: 0, op: '==', note: 'd8aac99 事故：主树语法坏但门禁 10/10 照过 —— 语法必须是门禁项（node --check）' },
  ];

  console.log('=== verify-baseline: ' + dispatchId + ' ===');
  console.log('');
  let firstFail = null;
  let failCount = 0;
  for (const c of checks) {
    const ok = evaluate(c);
    if (!ok) { failCount++; if (firstFail === null) firstFail = c; }
    const mark = ok ? '✅' : '❌';
    const label = (c.label + ' '.repeat(32)).slice(0, 32);
    console.log('[' + c.id + '/' + checks.length + '] ' + label + ': ' + String(c.actual).padStart(4) + '  (期望 ' + c.op + ' ' + c.expected + ')  ' + mark);
    if (!ok && c.note) console.log('      → ' + c.note);
  }
  console.log('');
  if (failCount === 0) {
    console.log('✅ PASS — ' + checks.length + '/' + checks.length + ' 通过');
    process.exit(0);
  } else {
    console.log('❌ FAIL — ' + (checks.length - failCount) + '/' + checks.length + ' 通过，第 ' + firstFail.id + ' 条不符');
    process.exit(1);
  }
}

const dispatchId = process.argv[2] || '66c0f00e';
verifyBaseline(dispatchId);
