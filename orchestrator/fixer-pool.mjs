// fixer-pool.mjs —— ⑦ 修理工调度框架（Director 2026-10-02 指令）
// 机制：双克隆隔离 + 每槽独立 pin/fallback + 每日记账 + MAX_CONCURRENT_FIXERS 串行（先跑通机制，补 key 后改 2 并行）
//
// 用法:
//   node fixer-pool.mjs --dry-run [--limit N]        # 只列出待修队列与槽位分配
//   node fixer-pool.mjs --run [--limit N] [--wo ID]  # 串行执行修复（红→绿自检通过后写 child_ref）
// 退出码: 0=本轮无失败  1=存在失败(有工单未过自检)  2=输入/配置错误
//
// 边界（Director 指令）：
//   - 同一工单 REFIX 最多 refix_limit_per_order(=2) 次，第 3 次失败 → blocked 交人；
//   - attempt_count 清零只允许“换修复方案”时由人工/诊断触发，本脚本不自动清零；
//   - 每槽每天修理工任务数受 daily.fixer_tasks_per_client 限制（记账在 counters/<date>.json）。

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { sha256OfText, lockAlivePid, removeStaleLock, tryAcquireLock, releaseLock, withLockedJsonWrite } from './lib/lock.mjs';

// 主树漂移监视：cline/opencode 的工具接受绝对路径，模型可能拼主仓路径读写（d8aac99 教训）
function mainFingerprint() {
  const h = createHash('sha256');
  try { h.update(readFileSync(join(REPO, 'orchestrator', 'orchestrate.mjs'))); } catch { h.update('missing'); }
  try { h.update(execFileSync('git', ['-C', REPO, 'status', '--porcelain'], { encoding: 'utf8' })); } catch {}
  return h.digest('hex').slice(0, 16);
}
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TITAN = process.env.D_TITAN_ROOT || join(__dirname, '..');
// S-08：REPO 硬编码 'D:/TITAN_ARCHAEOLOGY' 删——统一走 TITAN（env 或 __dirname 推导），
// 克隆/指纹/隔离判定/fetch 全部同源，不再有第二条盘路径事实。
const REPO = TITAN;
const SB = join(tmpdir(), 'titan-phaseB-probes');
const CLINE = join(SB, 'node_modules', '.bin', 'cline.cmd');
const OPENCODE_EXE = join(SB, 'node_modules', 'opencode-windows-x64', 'bin', 'opencode.exe');

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const LIMIT = val('--limit') ? Number(val('--limit')) : 1;
const ONLY = val('--wo');
const DRY = has('--dry-run');
if (!has('--run') && !DRY) { console.error('用法: fixer-pool.mjs --dry-run | --run [--limit N] [--wo ID]'); process.exit(2); }

// 硬失败护栏：没有 API key 会让修理工 CLI 秒退 exit1（与模型无关），不许消耗工单 attempt
if (!process.env.FREELLMAPI_API_KEY) {
  try { process.env.FREELLMAPI_API_KEY = execFileSync('powershell', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('FREELLMAPI_API_KEY','User')"], { encoding: 'utf8' }).trim(); } catch {}
}
if (!process.env.FREELLMAPI_API_KEY) {
  console.error('[ENV] 缺 FREELLMAPI_API_KEY —— 修理工 CLI 会秒退，本次不消耗 attempt，退出 2');
  process.exit(2);
}
const limits = JSON.parse(readFileSync(join(__dirname, 'limits.json'), 'utf8'));
const FS = limits.fixer_scheduler;
// ---- 池锁：MAX_CONCURRENT_FIXERS 的进程级强制（实测两次并发跑会争抢同一克隆）----
const LOCK = join(tmpdir(), 'titan-fixer-pool.lock');
if (!DRY) {
  // M-07：陈旧池锁 unlink——锁文件还在但 PID 已死时（上次进程被强杀等），wx 抢锁会
  // 永远 EEXIST 卡死。先清死锁再抢。
  removeStaleLock(LOCK);
  if (lockAlivePid(LOCK)) { console.error('[LOCK] 另一 fixer-pool 实例在跑（PID ' + lockAlivePid(LOCK) + '），退出 2（MAX_CONCURRENT_FIXERS=' + FS.max_concurrent_fixers + ' 的进程级闸门）'); process.exit(2); }
  // wx = O_EXCL 原子创建，杜绝两实例同时通过检查（实测出过竞态）
  if (!tryAcquireLock(LOCK)) { console.error('[LOCK] 抢锁失败（另一实例刚创建锁），退出 2'); process.exit(2); }
  process.on('exit', () => releaseLock(LOCK));
}
const WO_PATH = join(__dirname, 'work-orders.json');
// S-10：锁内重读比对——加载时留快照哈希，写回时若他端已改文件则拒绝覆盖。
const woRaw = readFileSync(WO_PATH, 'utf8');
const woSnapshot = sha256OfText(woRaw);
const woDoc = JSON.parse(woRaw);
const orders = woDoc.orders;
const day = new Date().toISOString().slice(0, 10);
const counterFile = join(TITAN, 'reviews', '_autopilot', 'counters', day + '.json');
let counter = { date: day, cdp: 0, api: 0, writer: 'autopilot' };
if (existsSync(counterFile)) { try { counter = JSON.parse(readFileSync(counterFile, 'utf8')); } catch {} }
function saveCounter() { mkdirSync(dirname(counterFile), { recursive: true }); writeFileSync(counterFile, JSON.stringify(counter, null, 2), 'utf8'); }
function fixerUsed(slotKey) { return Number(counter['fixer_' + slotKey + '_tasks'] || 0); }
function slotFor(owner) {
  if (owner === 'fixer-cline') return 'fixerA';
  if (owner === 'fixer-opencode') return 'fixerB';
  return null; // 未分配 → 串行模式下按 A→B 轮转
}

function buildPrompt(o, slot, modelLabel) {
  return [
    '[工单 ' + o.id + ' | base ' + o.base_commit.slice(0, 8) + ' | 只允许改动 ' + o.target_files.join('、') + ']',
    '源问题（' + o.source_delta + '）：' + o.instruction,
    '目标：按上面的 instruction 完成最小修复；锚点文件 ' + o.anchor.file + (o.anchor.resolvedLine ? (' 第 ' + o.anchor.resolvedLine + ' 行附近') : '') + (o.anchor.pattern ? ('，匹配模式 ' + o.anchor.pattern) : '') + '。',
    '验收（必须自己在本目录跑过且通过再提交）：',
    '  1) ' + o.verify_cmd,
    '  2) ' + (o.target_cmd || '(无 target_cmd)'),
    '本地提交，提交信息严格为：[T-12] fix: ' + (o.source_title || o.source_delta).slice(0, 40) + '（' + o.source_delta.split(' ')[0] + '）',
    '改法提示（重要）：先定位【现状代码行】，把现状行替换成目标写法。目标写法只是最终状态示意，文件里现在并不存在它——不要拿它当 oldString 去搜索（搜不到会陷入死循环）。',
    '绝对禁止：修改当前工作目录之外的任何文件；访问任何 git remote；git fetch / pull / push；git checkout/reset/restore/stash；只加注释充数。改动只限白名单文件。',
    '（当前槽位: ' + slot + '，模型: ' + modelLabel + '）',
  ].join('\n');
}

function runFixer(slotKey, prompt, timeoutMs, cwd) {
  // 隔离红线：修理工进程绝不允许在主仓里跑（实测漏传 cwd 导致修理工直接改主树并提交，破坏语法）
  const norm = p => String(p).replace(/\\/g, '/').replace(/\/$/, '');
  if (!cwd || norm(cwd) === norm(REPO) || norm(cwd) === norm(TITAN)) {
    throw new Error('[ISOLATION] 拒绝在主仓执行修理工：cwd=' + cwd);
  }
  const slot = FS.slots[slotKey];
  const extra = FS.run_flags[slot.client] || '';
  let cmd, args;
  if (slot.client === 'cline') {
    const m = slot._model_now || slot.pin;
    // Windows 无法直接 spawnSync 执行 .cmd（实测 status=null 秒退）→ PowerShell 包装；prompt 走临时文件避免引号转义
    const pf = join(tmpdir(), 'titan-fixer-prompt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.txt');
    writeFileSync(pf, prompt, 'utf8');
    const q = s => String(s).replace(/'/g, "''");
    const dataDir = join(SB, '.cline-data');
    const ps = "$p = Get-Content -Raw '" + q(pf) + "'; & '" + q(CLINE) + "' $p --auto-approve true -P openai -m '" + q(m) + "' -c '" + q(cwd) + "' --data-dir '" + q(dataDir) + "' 2>&1 | Out-String";
    return spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: timeoutMs, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    const m = slot._model_now || slot.pin;
    cmd = OPENCODE_EXE;
    const parts = ['run', prompt, '--format', 'json', '-m', 'freellmapi/' + m, '--pure', '--auto'];
    return spawnSync(cmd, parts, { encoding: 'utf8', timeout: timeoutMs, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  }
}

function cloneFor(woId, base) {
  const clone = join(tmpdir(), 'titan-fix-' + woId);
  if (existsSync(clone)) rmSync(clone, { recursive: true, force: true });
  execFileSync('git', ['clone', '--no-hardlinks', '-q', REPO, clone], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-C', clone, 'checkout', '-q', '-B', 'fix/' + woId, base], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-C', clone, 'config', 'user.email', 'fixer@titan.local'], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-C', clone, 'config', 'user.name', 'TITAN-Fixer'], { stdio: ['ignore', 'pipe', 'pipe'] });
  // 屏蔽 workspace skills：cline 自动加载 titan-four-party-consult 会把修理工带跑偏（v4.1 两跑实证）
  try { if (existsSync(join(clone, '.agents'))) { renameSync(join(clone, '.agents'), join(clone, '.agents_fixer_off')); } } catch {}
  // 堵洞（r3 越界根因）：origin 泄露主仓绝对路径，模型 git remote -v 就能拿到并用绝对路径写主树
  // 主→克隆方向由本进程 git fetch 完成，修理工不需要 origin
  try { execFileSync('git', ['-C', clone, 'remote', 'remove', 'origin'], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch {}
  return clone;
}

function checkTarget(clone, targetCmd) {
  if (!targetCmd) return { ok: false, out: '(no target_cmd)' };
  try {
    const out = execFileSync(targetCmd, { cwd: clone, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, D_TITAN_ROOT: clone } });
    return { ok: true, out: out.trim() };
  } catch (e) {
    return { ok: false, out: String(e.stdout || e.stderr || e.message).trim().slice(0, 300) };
  }
}

function hasCommit(clone, base) {
  try {
    const n = execFileSync('git', ['-C', clone, 'rev-list', '--count', base + '..HEAD'], { encoding: 'utf8' }).trim();
    return Number(n) > 0;
  } catch { return false; }
}

// ---------- 队列 ----------
const queue = orders.filter(o => (ONLY ? o.id === ONLY : (o.status === 'in_progress' && !o.child_ref && o.target_cmd && o.base_commit)));
console.log('=== fixer-pool' + (DRY ? '（dry-run）' : '') + ' ===');
console.log('max_concurrent_fixers=' + FS.max_concurrent_fixers + '（串行机制验证阶段）  队列=' + queue.length + '  limit=' + LIMIT);

let roundRobin = 0;
const results = [];
const fpBefore = DRY ? null : mainFingerprint(); // 修理工跑之前主树指纹
for (const o of queue.slice(0, LIMIT)) {
  let slotKey = slotFor(o.owner);
  if (!slotKey) { slotKey = (roundRobin++ % 2 === 0) ? 'fixerA' : 'fixerB'; }
  const dailyCap = limits.daily.fixer_tasks_per_client || 4;
  if (fixerUsed(slotKey) >= dailyCap) {
    results.push({ wo: o.id, slot: slotKey, result: 'SKIP_DAILY_CAP', used: fixerUsed(slotKey), cap: dailyCap });
    continue;
  }
  if (DRY) {
    results.push({ wo: o.id, slot: slotKey, client: FS.slots[slotKey].client, pin: FS.slots[slotKey].pin, refix_used: o.refix_count || 0, attempts: o.attempt_count || 0, dry: true });
    continue;
  }
  const base = o.base_commit;
  const clone = cloneFor(o.id, base);
  const modelChain = [FS.slots[slotKey].pin, ...(FS.slots[slotKey].fallbacks || [])];
  let passed = null, tried = [];
  for (const m of modelChain) {
    FS.slots[slotKey]._model_now = m;
    const prompt = buildPrompt(o, slotKey, m);
    const r = runFixer(slotKey, prompt, FS.attempt_timeout_ms || 420000, clone);
    const logDir = join(TITAN, 'orchestrator', 'audit-evidence', 'autopilot', 'fixer-logs');
    const spawnErr = r.error ? String(r.error.code || r.error.message) : null;
    try { mkdirSync(logDir, { recursive: true }); writeFileSync(join(logDir, o.id + '-' + slotKey + '-' + m + '.log'), ('exit=' + r.status + ' spawnErr=' + spawnErr + '\n--- stdout ---\n' + (r.stdout || '') + '\n--- stderr ---\n' + (r.stderr || '')).slice(0, 200000), 'utf8'); } catch {}
    const fpNow = mainFingerprint();
    if (fpNow !== fpBefore) {
      results.push({ wo: o.id, slot: slotKey, result: 'ISOLATION_BREACH', model: m, detail: '主树在修理工运行期间被改动！立即停链交人', fpBefore, fpNow });
      console.error('[BREACH] 主树指纹变化（' + fpBefore + ' -> ' + fpNow + '），中止本工单并停链');
      break;
    }
    const committed = hasCommit(clone, base);
    const chk = committed ? checkTarget(clone, o.target_cmd) : { ok: false, out: '无提交' };
    tried.push({ model: m, spawnExit: r.status, spawnErr, committed, targetOk: chk.ok, targetOut: (chk.out || '').slice(0, 200) });
    if (committed && chk.ok) { passed = { model: m }; break; }
    // 换 fallback 前把克隆重置回 base
    execFileSync('git', ['-C', clone, 'reset', '-q', '--hard', base], { stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['-C', clone, 'clean', '-qfd', '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  counter['fixer_' + slotKey + '_tasks'] = fixerUsed(slotKey) + 1;
  saveCounter();
  if (passed) {
    // 取回分支供 autopilot/verify-delta 用
    try { execFileSync('git', ['-C', REPO, 'fetch', clone, 'refs/heads/fix/' + o.id + ':refs/heads/fix/' + o.id, '-f'], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch {}
    o.child_ref = 'fix/' + o.id;
    results.push({ wo: o.id, slot: slotKey, result: 'GREEN_LOCAL', model: passed.model, tried });
  } else {
    o.attempt_count = (o.attempt_count || 0) + 1;
    o.refix_count = (o.refix_count || 0) + 1;
    if (o.refix_count > (FS.refix_limit_per_order || 2)) { o.status = 'blocked'; o.block_reason = 'REFIX_LIMIT_EXCEEDED(' + o.refix_count + ')'; }
    results.push({ wo: o.id, slot: slotKey, result: 'FAILED', attempts: o.attempt_count, refix_count: o.refix_count, status: o.status, tried });
  }
}

if (!DRY) {
  // S-10：锁内重读比对写回（与 delta-to-registry/autopilot 同一条 lib 通道）
  const wres = withLockedJsonWrite(WO_PATH, { produceDoc: () => woDoc, baseSnapshot: woSnapshot });
  if (!wres.ok) {
    console.error('[WO-WRITE] ' + wres.status + (wres.detail ? '：' + wres.detail : '') + ' —— 本轮状态未落盘，请拉平后重跑');
    process.exit(1);
  }
  console.log('[WO-WRITE] written (locked)');
}
console.log(JSON.stringify(results, null, 1));
process.exit(results.some(r => r.result === 'FAILED') ? 1 : 0);
