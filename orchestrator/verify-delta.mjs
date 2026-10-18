// verify-delta.mjs  —— 合同 #4 步 C 之二（红→绿验收执行器）
// 双树并行挂载（父=base_commit，子=child ref），依赖注入，环境错误不计 FAIL，git 写操作锁重试。
//
// 用法:
//   node verify-delta.mjs --wo WO-20261001-001 [--child <ref>] [--workorders work-orders.json]
//                         [--evidence <path>] [--keep]
// 退出码: 0=GREEN(红→绿成立)  1=RED(子树回归)  2=ENV(环境错误，不计 FAIL)  3=BASELINE_BROKEN(父树即红，交 #3 分类)
//
// 环境错误细分（errors.code）: ENV_LOCK / ENV_DEPS / ENV_WORKTREE / ENV_VERIFY_BASE / ENV_BAD_ORDER

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, cpSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TITAN = process.env.D_TITAN_ROOT || join(__dirname, '..');

const argv = process.argv.slice(2);
const val = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const has = f => argv.includes(f);
const woId = val('--wo');
const childRef = val('--child') || 'HEAD';
const woPath = val('--workorders') || join(__dirname, 'work-orders.json');
const evidencePath = val('--evidence');
const keep = has('--keep');

if (!woId) { console.error('用法: node verify-delta.mjs --wo <WO-id> [--child <ref>]'); process.exit(2); }

// ---------- git 锁重试（G14：3 次 × 2s；index.lock 冲突归环境错误） ----------
function git(args, opts = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return execFileSync('git', args, { encoding: 'utf8', cwd: opts.cwd || TITAN, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      lastErr = e;
      const msg = String(e.stderr || e.message || '');
      const isLock = /index\.lock|Unable to create.*lock|another git process/i.test(msg);
      if (isLock && attempt < 3) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000); continue; }
      const err = new Error(msg || e.message);
      err.code = isLock ? 'ENV_LOCK' : (opts.envCode || 'ENV_GIT');
      throw err;
    }
  }
  const err = new Error(String(lastErr && (lastErr.stderr || lastErr.message)));
  err.code = 'ENV_LOCK';
  throw err;
}

function failEnv(code, msg) { return { exit: 2, result: { status: 'ENV', code, message: msg } }; }
// ENV 退出也要落证据（autopilot 读 ev.errors[0].code 分类，缺失会退化成 UNKNOWN）
function bailEnv(payload) {
  payload.status = 'ENV';
  if (evidencePath) { try { writeFileSync(evidencePath, JSON.stringify(payload, null, 2), 'utf8'); } catch { /* 尽力 */ } }
  console.log(JSON.stringify(payload, null, 2));
  process.exit(2);
}

// ---------- 读工单 ----------
if (!existsSync(woPath)) { console.error('[MISSING] ' + woPath); process.exit(2); }
const doc = JSON.parse(readFileSync(woPath, 'utf8'));
const wo = (doc.orders || []).find(o => o.id === woId);
if (!wo) { console.error('[BAD_ORDER] 工单不存在: ' + woId); process.exit(2); }
const missing = ['base_commit', 'target_files', 'verify_cmd'].filter(k => wo[k] === undefined || wo[k] === null);
if (missing.length) { console.error('[BAD_ORDER] 缺必填字段: ' + missing.join(',')); process.exit(2); }
if (wo.verifier && wo.owner && wo.verifier === wo.owner) {
  console.error('[BAD_ORDER] verifier 必须 ≠ owner（M4）'); process.exit(2);
}

const treeRoot = join(tmpdir(), 'titan-verify-' + wo.id);
const parentTree = join(treeRoot, 'parent');
const childTree = join(treeRoot, 'child');
const out = { wo: wo.id, base_commit: wo.base_commit, child: childRef, treeRoot, steps: [], errors: [], checks: null };

function step(name, ok, detail) { out.steps.push({ name, ok, detail }); }

function cleanup() {
  for (const t of [parentTree, childTree]) {
    if (existsSync(t)) { try { git(['worktree', 'remove', '--force', t], { envCode: 'ENV_WORKTREE' }); } catch { /* 尽力 */ } }
  }
  try { git(['worktree', 'prune'], { envCode: 'ENV_WORKTREE' }); } catch { /* 尽力 */ }
}

function addWorktree(path, ref) {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  mkdirSync(dirname(path), { recursive: true });
  git(['worktree', 'add', '--detach', path, ref], { envCode: 'ENV_WORKTREE' });
  step('worktree:' + ref, true, path);
}

// ---------- 0. 依赖注入（G10）----------
function injectDeps(tree) {
  const deps = wo.verify_cmd_deps || [];
  for (const d of deps) {
    const src = join(TITAN, d);
    const dst = join(tree, d);
    if (!existsSync(src)) { const e = new Error('依赖不存在: ' + d); e.code = 'ENV_DEPS'; throw e; }
    try {
      const st = statSync(src);
      if (st.isDirectory()) cpSync(src, dst, { recursive: true });
      else { mkdirSync(dirname(dst), { recursive: true }); cpSync(src, dst); }
    } catch (e) { const err = new Error('依赖注入失败: ' + d + ' - ' + e.message); err.code = 'ENV_DEPS'; throw err; }
  }
  step('deps-inject', true, '注入 ' + deps.length + ' 项（' + deps.join(',') + '）');
}

// ---------- 1. 挂双树 ----------
try {
  rmSync(treeRoot, { recursive: true, force: true });
  addWorktree(parentTree, wo.base_commit);
  addWorktree(childTree, childRef);
} catch (e) {
  cleanup();
  bailEnv({ ...out, errors: [{ code: e.code || 'ENV_WORKTREE', message: e.message }] });
}

try { injectDeps(parentTree); injectDeps(childTree); }
catch (e) {
  cleanup();
  bailEnv({ ...out, errors: [{ code: e.code || 'ENV', message: e.message }] });
}

// ---------- 2a. 跑 target_cmd（红→绿新断言，合同 #4 语义补充）----------
// target_cmd 断言“修好之后的状态”：父树（未修）必须失败=红，子树（修好）必须通过=绿。
// verify_cmd 是回归门禁：两树都必须通过。缺 target_cmd 时退化为旧语义（两树同跑 verify_cmd）。
function runCmd(cmd, cwd, allowFail) {
  try {
    const stdout = execFileSync(cmd, { cwd, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, D_TITAN_ROOT: cwd } });
    return { code: 0, out: stdout };
  } catch (e) {
    const code = typeof e.status === 'number' ? e.status : -1;
    if (code === 2) { const err = new Error(cmd + ' exit 2（缺文件/环境）: ' + String(e.stdout || '') + String(e.stderr || '')); err.code = 'ENV_VERIFY'; throw err; }
    if (code === -1) { const err = new Error(cmd + ' 无法执行: ' + String(e.message)); err.code = 'ENV_VERIFY'; throw err; }
    const outStr = String(e.stdout || '') + String(e.stderr || '');
    // G10 假红护栏：依赖模块缺失不是修复失败，归环境错误（红线 11）
    if (/Cannot find module|MODULE_NOT_FOUND/.test(outStr)) {
      const err = new Error('依赖缺失(假红): ' + outStr.slice(0, 300));
      err.code = 'ENV_DEPS';
      throw err;
    }
    return { code, out: outStr };
  }
}

// ---------- 2b. 跑 verify_cmd ----------
function runVerify(cwd) {
  try {
    const stdout = execFileSync(wo.verify_cmd, { cwd, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, D_TITAN_ROOT: cwd } });
    return { code: 0, out: stdout };
  } catch (e) {
    const code = typeof e.status === 'number' ? e.status : -1;
    if (code === 2) { const err = new Error('verify_cmd exit 2（缺文件/环境）: ' + String(e.stdout || '') + String(e.stderr || '')); err.code = 'ENV_VERIFY'; throw err; }
    if (code === -1) { const err = new Error('verify_cmd 无法执行: ' + String(e.message)); err.code = 'ENV_VERIFY'; throw err; }
    const outStr = String(e.stdout || '') + String(e.stderr || '');
    // G10 假红护栏：依赖模块缺失不是修复失败，归环境错误（红线 11）
    if (/Cannot find module|MODULE_NOT_FOUND/.test(outStr)) {
      const err = new Error('依赖缺失(假红): ' + outStr.slice(0, 300));
      err.code = 'ENV_DEPS';
      throw err;
    }
    return { code, out: outStr };
  }
}

let parentRun, childRun, targetParent = null, targetChild = null;
try {
  parentRun = runVerify(parentTree);
  childRun = runVerify(childTree);
  if (wo.target_cmd) {
    targetParent = runCmd(wo.target_cmd, parentTree);
    targetChild = runCmd(wo.target_cmd, childTree);
  }
} catch (e) {
  cleanup();
  bailEnv({ ...out, errors: [{ code: e.code || 'ENV', message: e.message }] });
}
step('verify:parent', parentRun.code === 0, 'exit=' + parentRun.code);
step('verify:child', childRun.code === 0, 'exit=' + childRun.code);
if (wo.target_cmd) {
  step('target:red(parent)', targetParent.code !== 0, 'exit=' + targetParent.code + '（期望非 0=红）');
  step('target:green(child)', targetChild.code === 0, 'exit=' + targetChild.code + '（期望 0=绿）');
}

// ---------- 3. 越界检查 ----------
let boundaryOk = true, changed = [];
try {
  const diff = git(['diff', '--name-only', wo.base_commit + '..' + childRef]);
  changed = diff.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const allowed = new Set(wo.target_files);
  const offenders = changed.filter(f => !allowed.has(f));
  boundaryOk = offenders.length === 0;
  step('boundary', boundaryOk, boundaryOk ? ('改动均在白名单内: ' + changed.join(',')) : ('越界文件: ' + offenders.join(',')));
} catch (e) {
  step('boundary', false, 'diff 失败: ' + e.message);
  boundaryOk = false;
}
out.changed_files = changed;

// ---------- 3b. 语法检查（d8aac99 事故教训：修复若把 .mjs 改成语法坏，verify_cmd 不一定查得出来）----------
let syntaxOk = true;
const mjsChanged = changed.filter(f => /\.(mjs|cjs)$/.test(f));
for (const f of mjsChanged) {
  try {
    execFileSync('node', ['--check', join(childTree, f)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    syntaxOk = false;
    step('syntax:child', false, f + ' node --check 失败: ' + String(e.stderr || e.message).split(/\r?\n/).filter(Boolean).slice(0, 4).join(' | '));
    break;
  }
}
if (syntaxOk && mjsChanged.length) step('syntax:child', true, 'node --check 通过: ' + mjsChanged.join(','));
out.syntax_ok = syntaxOk;

// ---------- 4. 分类 ----------
let exitCode, status;
if (parentRun.code !== 0) { status = 'BASELINE_BROKEN'; exitCode = 3; }
else if (childRun.code !== 0) { status = 'RED'; exitCode = 1; }
else if (wo.target_cmd && targetParent.code === 0) { status = 'TARGET_NOT_RED'; exitCode = 1; } // 新断言在父树就绿 = 断言写错或已被别处满足
else if (wo.target_cmd && targetChild.code !== 0) { status = 'TARGET_NOT_GREEN'; exitCode = 1; } // 修复没生效
else if (!boundaryOk) { status = 'BOUNDARY_VIOLATION'; exitCode = 1; }
else if (!syntaxOk) { status = 'SYNTAX_BROKEN'; exitCode = 1; } // 新增：改动文件语法坏（d8aac99 教训）
else { status = 'GREEN'; exitCode = 0; }

out.checks = {
  parent: parentRun.code, child: childRun.code, boundaryOk,
  target_cmd: wo.target_cmd || null,
  targetParent: targetParent ? targetParent.code : null,
  targetChild: targetChild ? targetChild.code : null,
  verdict: status,
  childOutputTail: childRun.out.split(/\r?\n/).slice(-8).join('\n'),
  failId: (() => { const m = childRun.out.match(/\[(\d+)\/\d+\][^\n]*❌/); return m ? Number(m[1]) : null; })(),
};
out.status = status;

cleanup();
if (evidencePath) writeFileSync(evidencePath, JSON.stringify(out, null, 2), 'utf8');
console.log(JSON.stringify(out, null, 2));
process.exit(exitCode);
