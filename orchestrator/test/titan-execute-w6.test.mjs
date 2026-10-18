// orchestrator/test/titan-execute-w6.test.mjs — T-56 W6（P-11/P-12）端到端（landmine-001 沙箱）
// 前置：test-projects/landmine-001 是独立 git 测试仓（D_TITAN_ROOT 重定向，T-41 机制）；
// 本测试只在其内新增 untracked fixture（start 前就绪 → titan-execute 的 preDirty 豁免），
// 无 commit 产生；结束清理回原状（不动其历史与既有脏区）。
// 契约：
//   A. 超时 → 退避 → 降档（kilo fake）→ ALREADY_RESOLVED + PROOF 逐字校验 → PASS exit 0
//   （覆盖 P-11 全链 + P-12 强证明真 fixture）
//   B. 全链超时耗尽 → BLOCKED 记账 exit 3
//   C. PROOF 无效（无 PROOF 行）→ 协议提醒重试一次仍无效 → FAIL（P-12 假 fixture）
//   D. 首答无 PROOF → 重试后二次强证明 → PASS exit 0（T-59 RETRY 缺口补丁锁定）

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ORCH = join(dirname(fileURLToPath(import.meta.url)), '..');
const LAND = join(ORCH, '..', 'test-projects', 'landmine-001');
const TE = join(ORCH, 'titan-execute.mjs');
const CFG = join(LAND, 'config', 'executor-profiles.json');
// 发布树不打包 241MB 沙箱仓（test-projects/landmine-001 本地 git 测试仓）：
// 沙箱缺失时整套 e2e 自动 skip，gate 仍绿；repo 内沙箱在则 4/4 照跑。
const SANDBOX_OK = existsSync(CFG);
const origCfg = SANDBOX_OK ? readFileSync(CFG, 'utf8') : '';
const SKIP = SANDBOX_OK ? false : 'sandbox test-projects/landmine-001 not bundled (241MB, local-only)';

const RSA = () => Math.random().toString(16).slice(2, 10);
const fixtures = [];

function writeFixtureProfile(...profiles) {
  const doc = {};
  for (const p of profiles) doc[p.name] = p.profile;
  writeFileSync(CFG, JSON.stringify(doc, null, 2), 'utf8');
}

const createdIds = [];
function setupDispatch(id) {
  createdIds.push(id);
  const dir = join(LAND, 'reviews', id, 'layer-b');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'delta.md'), '### DELTA-001\n**文件** target.js\n**发现** 需要修复\n**动作** 修复它\n', 'utf8');
  writeFileSync(join(dir, 'architect-decision.md'), 'DELTA-001\nDecision: ACCEPT\n', 'utf8');
  writeFileSync(join(LAND, 'target.js'), '// fixture line 1\n// fixture line 2\nconst proofTarget = true; // fixture proof line\n// fixture line 4\n', 'utf8');
}

function runExec(id, executor, env = {}) {
  return spawnSync(process.execPath, [TE, id, '--executor', executor, '--skip-baseline'], {
    cwd: LAND,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, D_TITAN_ROOT: LAND, TITAN_EXEC_TIMEOUT_MS: '600', TITAN_EXEC_BACKOFF_MS: '120', ...env },
  });
}

before(() => {
  if (!SANDBOX_OK) return;
  // 沙箱 fixture 脚本（slow = 只挂起不输出；already = 输出 AR+PROOF；noproof = AR 无 PROOF；
  // proofretry = 有状态：首答 AR 无 PROOF、二次答 AR+PROOF，T-59）
  writeFileSync(join(LAND, 'slow.mjs'), 'setTimeout(()=>process.exit(0), 20000);\n', 'utf8');
  writeFileSync(join(LAND, 'already.mjs'), 'console.log("该 finding 已被同轮修复。");\nconsole.log("ALREADY_RESOLVED");\nconsole.log("PROOF: target.js:3: const proofTarget = true; // fixture proof line");\nprocess.exit(0);\n', 'utf8');
  writeFileSync(join(LAND, 'noproof.mjs'), 'console.log("该 finding 已被同轮修复。");\nconsole.log("ALREADY_RESOLVED");\nprocess.exit(0);\n', 'utf8');
  writeFileSync(join(LAND, 'proofretry.mjs'), 'import { existsSync, writeFileSync, mkdirSync } from "node:fs";\nimport { join } from "node:path";\nconst dir = join(process.cwd(), "tmp");\nmkdirSync(dir, { recursive: true });\nconst flag = join(dir, "proofretry.flag");\nif (!existsSync(flag)) { writeFileSync(flag, "1"); console.log("该 finding 已被同轮修复。"); console.log("ALREADY_RESOLVED"); process.exit(0); }\nconsole.log("该 finding 已被同轮修复。");\nconsole.log("ALREADY_RESOLVED");\nconsole.log("PROOF: target.js:3: const proofTarget = true; // fixture proof line");\nprocess.exit(0);\n', 'utf8');
  rmSync(join(LAND, 'tmp', 'proofretry.flag'), { force: true });
  fixtures.push('slow.mjs', 'already.mjs', 'noproof.mjs', 'proofretry.mjs', 'target.js');
});

after(() => {
  if (!SANDBOX_OK) return;
  writeFileSync(CFG, origCfg, 'utf8');
  for (const f of fixtures) { try { rmSync(join(LAND, f), { force: true }); } catch {} }
  // 只清本测试创建的 dispatch 目录（reviews 下既有 T-41 遗产都要保留）
  for (const id of createdIds) { try { rmSync(join(LAND, 'reviews', id), { recursive: true, force: true }); } catch {} }
  // proofretry 状态旗标（landmine tmp/ 内，scope 豁免区）清掉
  try { rmSync(join(LAND, 'tmp', 'proofretry.flag'), { force: true }); } catch {}
  // 本测试 spawn titan-execute 产生的 tmp 留档 prompt 也清掉（CreationTime 一分钟内的）
  const tmpDir = join(LAND, 'tmp');
  try {
    for (const f of readdirSync(tmpDir)) {
      if (!f.startsWith('titan-prompt-DELTA-001-')) continue;
      const p = join(tmpDir, f);
      try { if (Date.now() - statSync(p).mtimeMs < 3600000) rmSync(p, { force: true }); } catch {}
    }
  } catch {}
});

test('A. 超时→退避→降档→AR+PROOF 强证明真 fixture → PASS exit 0（P-11 全链 + P-12）', { skip: SKIP }, () => {
  const id = 'w6a' + RSA();
  setupDispatch(id);
  writeFixtureProfile(
    {
      name: 'test-slow',
      profile: { cmd: [process.execPath, 'slow.mjs'], modelFlag: '--model', defaultModel: 'x', extraArgs: [], env: {}, cwd: '.', timeoutMs: 600000 },
    },
    {
      name: 'kilo',
      profile: { cmd: [process.execPath, 'already.mjs'], modelFlag: '--model', defaultModel: 'x', extraArgs: [], env: {}, cwd: '.', timeoutMs: 600000 },
    }
  );
  const r = runExec(id, 'test-slow');
  assert.equal(r.status, 0, '应 PASS exit 0\n' + (r.stdout || '') + (r.stderr || ''));
  assert.ok(/\[TIMEOUT\]/.test(r.stdout), '应出现超时退避日志');
  assert.ok(/PASS \(ALREADY_RESOLVED \+ PROOF verified @target\.js:3\)/.test(r.stdout), '应打印 PROOF 验证通过\n' + r.stdout);
  const result = JSON.parse(readFileSync(join(LAND, 'reviews', id, 'layer-b', 'execute-result.json'), 'utf8'));
  assert.equal(result.verifyStatus, 'PASS');
  assert.equal(result.deltas[0].status, 'PASS');
  assert.ok(/PROOF/.test(JSON.stringify(result.deltas[0].reason || '')), 'reason 应记 PROOF 验证');
});

test('B. 全链超时耗尽 → BLOCKED 记账 exit 3', { skip: SKIP }, () => {
  const id = 'w6b' + RSA();
  setupDispatch(id);
  writeFixtureProfile({
    name: 'test-slow',
    profile: { cmd: [process.execPath, 'slow.mjs'], modelFlag: '--model', defaultModel: 'x', extraArgs: [], env: {}, cwd: '.', timeoutMs: 600000 },
  });
  const r = runExec(id, 'test-slow');
  assert.equal(r.status, 3, '应 BLOCKED exit 3\n' + (r.stdout || '') + (r.stderr || ''));
  assert.ok(/BLOCKED 记账/.test(r.stdout), '应打印 BLOCKED 记账');
  const result = JSON.parse(readFileSync(join(LAND, 'reviews', id, 'layer-b', 'execute-result.json'), 'utf8'));
  assert.equal(result.verifyStatus, 'BLOCKED');
  assert.equal(result.deltas[0].status, 'BLOCKED');
});

test('C. AR 无 PROOF（假 fixture）→ FAIL（P-12 视为需修）', { skip: SKIP }, () => {
  const id = 'w6c' + RSA();
  setupDispatch(id);
  writeFixtureProfile({
    name: 'test-noproof',
    profile: { cmd: [process.execPath, 'noproof.mjs'], modelFlag: '--model', defaultModel: 'x', extraArgs: [], env: {}, cwd: '.', timeoutMs: 600000 },
  });
  const r = runExec(id, 'test-noproof');
  assert.equal(r.status, 1, '应 FAIL exit 1\n' + (r.stdout || '') + (r.stderr || ''));
  assert.ok(/ALREADY_RESOLVED 但 PROOF 无效，协议提醒重试一次/.test(r.stdout), '应先触发协议提醒重试\n' + r.stdout);
  assert.ok(/ALREADY_RESOLVED 但 PROOF 无效/.test(r.stdout), '应打印 PROOF 无效\n' + r.stdout);
  const result = JSON.parse(readFileSync(join(LAND, 'reviews', id, 'layer-b', 'execute-result.json'), 'utf8'));
  assert.equal(result.verifyStatus, 'FAIL');
  assert.ok(/P-12/.test(result.deltas[0].reason || ''), 'reason 应标注 P-12');
});

test('D. 首答 AR 无 PROOF → 协议提醒重试 → 二次强证明 → PASS exit 0（T-59 RETRY 补丁）', { skip: SKIP }, () => {
  const id = 'w6d' + RSA();
  setupDispatch(id);
  writeFixtureProfile({
    name: 'test-proofretry',
    profile: { cmd: [process.execPath, 'proofretry.mjs'], modelFlag: '--model', defaultModel: 'x', extraArgs: [], env: {}, cwd: '.', timeoutMs: 600000 },
  });
  const r = runExec(id, 'test-proofretry');
  assert.equal(r.status, 0, '应 PASS exit 0\n' + (r.stdout || '') + (r.stderr || ''));
  assert.ok(/ALREADY_RESOLVED 但 PROOF 无效，协议提醒重试一次/.test(r.stdout), '应出现协议提醒重试日志\n' + r.stdout);
  assert.ok(/PASS \(ALREADY_RESOLVED \+ PROOF verified @target\.js:3\)/.test(r.stdout), '重试后应 PROOF 验证通过\n' + r.stdout);
  const result = JSON.parse(readFileSync(join(LAND, 'reviews', id, 'layer-b', 'execute-result.json'), 'utf8'));
  assert.equal(result.verifyStatus, 'PASS');
  assert.equal(result.deltas[0].status, 'PASS');
});