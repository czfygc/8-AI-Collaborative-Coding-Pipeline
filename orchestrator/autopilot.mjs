// autopilot.mjs —— 步5 D 实施骨架（合同 orchestrator/autopilot-contract-v1.md 的运行时）
//
// 职责：认领工单 → 调修理工（可插拔）→ verify-delta 红→绿 → FAIL 二分类 → gate3 守门人 → 落证据/改状态
// 唯一写者：orchestrator/work-orders.json（合同 #8）
//
// 用法:
//   node autopilot.mjs --dry-run [--limit N] [--wo <id>]     # 演练：不写状态、不跑 CLI
//   node autopilot.mjs --run [--limit N] [--wo <id>]         # 真跑：verify + 分类 + 状态更新
//   node autopilot.mjs --run --skip-gate                     # 跳过 gate3（仅调试）
// 退出码: 0=本轮无失败  1=存在非预期回归(RED)  2=环境错误

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256OfText, withLockedJsonWrite } from './lib/lock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TITAN = process.env.D_TITAN_ROOT || join(__dirname, '..');
let WO_PATH;
const EVIDENCE_DIR = join(__dirname, 'audit-evidence', 'autopilot');
const SIZE_CAP = 50 * 1024 * 1024;   // 合同 #9：50MB 输出硬上限
const DISK_MIN = 1024 * 1024 * 1024; // 磁盘 <1GB 暂停调度

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const DRY = has('--dry-run');
const SKIP_GATE = has('--skip-gate');
// S-06：fixer 摆渡开关（默认 off）。on 时每张工单先查 child_ref：有→直跑 verify；
// 无→fail-closed 标 NEEDS_FIX + 打印手跑命令，绝不带着"未修复"状态去 verify。
const RUN_FIXERS = has('--run-fixers');
const LIMIT = val('--limit') ? Number(val('--limit')) : 1;
const ONLY = val('--wo');
WO_PATH = val('--workorders') || join(__dirname, 'work-orders.json');

// ---------- 基础设施 ----------
function gitRetry(args, cwd = TITAN) {
  for (let i = 1; i <= 3; i++) {
    try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) {
      const msg = String(e.stderr || e.message || '');
      if (/index\.lock|another git process/i.test(msg) && i < 3) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000); continue; }
      const err = new Error(msg); err.env = /index\.lock/i.test(msg); throw err;
    }
  }
}

function diskFreeMB() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', '(Get-PSDrive C).Free'], { encoding: 'utf8' });
    return Math.floor(Number(out.trim()) / (1024 * 1024));
  } catch { return null; }
}

// M-08：load/save 全部 try/catch + 证据——加载失败不再裸崩（写证据后 exit 2），
// 保存走锁通道（lib/lock.mjs，与 fixer-pool/delta-to-registry 同一套单写者协议）。
function saveOrders(doc, baseSnapshot) {
  const wres = withLockedJsonWrite(WO_PATH, { produceDoc: () => doc, baseSnapshot });
  if (!wres.ok) {
    const err = new Error('[WO-SAVE] ' + wres.status + (wres.detail ? '：' + wres.detail : ''));
    writeEvidence('save-error-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json', { status: wres.status, detail: wres.detail });
    throw err;
  }
  console.log('[WO-SAVE] written (locked)');
}

let woSnapshot = null;
function loadOrders() {
  try {
    const raw = readFileSync(WO_PATH, 'utf8');
    woSnapshot = sha256OfText(raw);
    const doc = JSON.parse(raw);
    if (!doc || !Array.isArray(doc.orders)) throw new Error('work-orders.json 结构异常（缺 orders 数组）');
    return doc;
  } catch (e) {
    writeEvidence('load-error-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json', { path: WO_PATH, error: String(e.message || e) });
    console.error('[WO-LOAD] 加载失败（证据已落 audit-evidence/autopilot/）: ' + (e.message || e));
    process.exit(2);
  }
}

function writeEvidence(name, obj) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  let text = JSON.stringify(obj, null, 2);
  if (text.length > SIZE_CAP) text = text.slice(0, SIZE_CAP) + '\n/* TRUNCATED: size cap 50MB (contract #9) */';
  const p = join(EVIDENCE_DIR, name);
  writeFileSync(p, text, 'utf8');
  return p;
}

// ---------- 主流程 ----------
// ---- ⑦ 每日上限（复核指令4：硬编码入 limits.json、分通道记账、不可临时豁免）----
if (has('--register-dispatch')) {
  const channel = val('--register-dispatch');
  if (!['api', 'cdp'].includes(channel)) { console.error('[BAD_CHANNEL] 只允许 api|cdp'); process.exit(2); }
  const limits = JSON.parse(readFileSync(join(__dirname, 'limits.json'), 'utf8'));
  const day = new Date().toISOString().slice(0, 10);
  const counterDir = join(TITAN, 'reviews', '_autopilot', 'counters');
  const counterFile = join(counterDir, day + '.json');
  let counter = { date: day, cdp: 0, api: 0, writer: 'autopilot' };
  if (existsSync(counterFile)) { try { counter = JSON.parse(readFileSync(counterFile, 'utf8')); } catch { /* 损坏则重置 */ } }
  const cap = limits.daily['dispatch_' + channel];
  const used = counter[channel] || 0;
  if (used >= cap) {
    console.error('[DAILY_CAP] ' + day + ' ' + channel + ' 今日已用 ' + used + '/' + cap + '（limits.json 硬编码，不可临时调）→ 停批回合同');
    process.exit(2);
  }
  counter[channel] = used + 1;
  mkdirSync(counterDir, { recursive: true });
  writeFileSync(counterFile, JSON.stringify(counter, null, 2), 'utf8');
  console.log('[COUNT] ' + day + ' ' + channel + ' = ' + counter[channel] + '/' + cap + '（上限来自 limits.json）');
  process.exit(0);
}

const doc = loadOrders();
const orders = doc.orders.filter(o => (ONLY ? o.id === ONLY : o.status === 'ready'));
console.log('=== autopilot' + (DRY ? '（dry-run）' : '') + ' ===');
console.log('可处理工单: ' + orders.length + (ONLY ? '（--wo ' + ONLY + '）' : '') + '，limit=' + LIMIT);

const free = diskFreeMB();
if (free !== null && free * 1024 * 1024 < DISK_MIN) {
  console.error('[BLOCKED] 磁盘水位不足（' + free + 'MB < 1GB），暂停调度（合同 #9）');
  process.exit(2);
}

let anyRed = false, envError = false, anyBroken = false;
const round = [];

for (const wo of orders.slice(0, LIMIT)) {
  const rec = { id: wo.id, steps: [] };
  // 1) 认领（合同 #2：in_progress 前 owner 必填）
  if (!wo.owner) {
    rec.steps.push('SKIP: owner 未分配（待 Director/派工）');
    round.push(rec); continue;
  }
  if (!DRY) { wo.status = 'in_progress'; wo.claimed_at = new Date().toISOString(); }
  rec.steps.push('claim owner=' + wo.owner + ' verifier=' + (wo.verifier || '(null)'));

  // 2) 验证者必须 ≠ owner（合同 #2）
  if (wo.verifier && wo.verifier === wo.owner) {
    rec.steps.push('BAD_ORDER: verifier==owner（M4）'); rec.result = 'BAD_ORDER';
    round.push(rec); continue;
  }

  // 3) fixer 摆渡（S-06）：--run-fixers 开启时启用；默认 off 保持原直跑 verify-delta。
  if (RUN_FIXERS) {
    if (wo.child_ref) {
      rec.steps.push('fixer ferry: child_ref=' + wo.child_ref + ' 已在册，直跑 verify-delta');
    } else {
      const manualCmd = 'node orchestrator/fixer-pool.mjs --run --wo ' + wo.id;
      rec.steps.push('fixer ferry: child_ref 缺失 → fail-closed 标 NEEDS_FIX（手跑命令: ' + manualCmd + '）');
      rec.result = 'NEEDS_FIX';
      if (!DRY) {
        wo.status = 'NEEDS_FIX';
        wo.needs_fix_reason = 'no child_ref from fixer-pool (fail-closed, run: ' + manualCmd + ')';
      }
      round.push(rec);
      continue;
    }
  }

  // 4) 红→绿
  if (DRY) {
    rec.steps.push('verify-delta: skipped (dry-run)');
    rec.result = 'DRY';
    round.push(rec); continue;
  }
  const evPath = join(tmpdir(), 'autopilot-' + wo.id + '.json');
  const vdArgs = [join(__dirname, 'verify-delta.mjs'), '--wo', wo.id, '--workorders', WO_PATH, '--evidence', evPath];
  if (wo.child_ref) vdArgs.push('--child', wo.child_ref); // 演练/修复分支可指定子提交
  const r = spawnSync(process.execPath, vdArgs,
    { encoding: 'utf8', cwd: TITAN, maxBuffer: 8 * 1024 * 1024 });
  let ev = null;
  try { ev = existsSync(evPath) ? JSON.parse(readFileSync(evPath, 'utf8')) : null; unlinkSync(evPath); } catch { /* 保留 null */ }
  const code = r.status === null ? 2 : r.status;
  rec.steps.push('verify-delta exit=' + code + ' verdict=' + (ev && ev.checks ? ev.checks.verdict : 'n/a'));

  if (code === 2) {
    envError = true;
    wo.status = 'blocked'; wo.block_reason = 'ENV:' + ((ev && ev.errors && ev.errors[0] && ev.errors[0].code) || 'UNKNOWN');
    rec.result = 'ENV'; round.push(rec); continue;
  }
  if (code === 3) {
    anyBroken = true;
    wo.status = 'ROLLBACK_PENDING'; // 父树即红 -> 交 #3 分类（预登记漂移集判定）
    rec.result = 'BASELINE_BROKEN'; round.push(rec); continue;
  }
  if (code === 1) {
    anyRed = true;
    wo.attempt_count = (wo.attempt_count || 0) + 1;
    // FAIL 二分类（合同 #3）：命中预登记漂移集 -> REBASELINE，否则保留
    const driftKeys = Object.keys(wo.expected_gate_drift || {});
    if (driftKeys.length && ev && ev.checks && ev.checks.failId && wo.expected_gate_drift['#' + ev.checks.failId]) {
      wo.status = 'REBASELINE'; rec.result = 'EXPECTED_DRIFT';
      rec.steps.push('命中预登记漂移 #' + ev.checks.failId + ' -> REBASELINE');
    } else {
      // FAIL×2 -> debug 三分支（合同 #10），此处为可插拔钩子
      if (wo.attempt_count >= 2) {
        rec.steps.push('FAIL×2 -> debug hook（三分支：REJECTED_DEFINITION / 回 fixer 改锚点 / blocked 交人）');
        wo.status = 'blocked'; wo.block_reason = 'FAIL_X2_PENDING_DEBUG';
      } else {
        wo.status = 'in_progress';
      }
      rec.result = 'RED';
    }
    rec.evidence = writeEvidence('verify-' + wo.id + '.json', ev || { error: 'no evidence', raw: (r.stdout || '').slice(-4000) });
    round.push(rec); continue;
  }

  // GREEN -> gate3 守门人（合同 #10，只读）
  rec.result = 'GREEN';
  if (SKIP_GATE) { rec.steps.push('gate3 skipped'); }
  else { rec.steps.push('gate3: deferred to --gate (separate read-only run, contract #10)'); }
  wo.status = 'verifying';
  rec.evidence = writeEvidence('verify-' + wo.id + '.json', ev || {});
  round.push(rec);
}

if (!DRY) {
  try { saveOrders(doc, woSnapshot); }
  catch (e) {
    console.error('[FATAL] ' + (e.message || e));
    process.exit(1);
  }
}
const evPath = writeEvidence('round-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json', { dry: DRY, diskFreeMB: free, round });
console.log(JSON.stringify(round, null, 2));
console.log('轮次证据: ' + evPath);
process.exit(envError ? 2 : (anyRed ? 1 : (anyBroken ? 3 : 0)));
