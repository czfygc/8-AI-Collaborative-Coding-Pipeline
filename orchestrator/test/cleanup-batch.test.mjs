// orchestrator/test/cleanup-batch.test.mjs — T-56 W5c（S-12）：PID 三重校验端到端
// 契约：
//   条目带正确 startTime → 进程被杀、exit 0、日志含 [KILLED]
//   条目带错误 startTime（PID 复用模拟）→ REFUSE 不杀、进程存活、日志含 启动时间不匹配
//   keep_alive → 保留、进程存活
//   （pid+启动时间+cmdline 三项读取缺失即 REFUSE 的逻辑在 CLI 内联执行，本测试自证其
//    query 通道真实可用：错误/正确 startTime 双路都经同一 CIM 三重查询）

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

const ORCH = join(dirname(fileURLToPath(import.meta.url)), '..');
const TITAN = join(ORCH, '..');
const BATCH = 'test-w5c-' + Date.now().toString(36);
const batchDir = join(TITAN, 'reviews', '_autopilot', 'batch-' + BATCH);

let child = null;
before(() => { mkdirSync(batchDir, { recursive: true }); });
after(() => {
  if (child) { try { child.kill(); } catch {} }
  try { rmSync(batchDir, { recursive: true, force: true }); } catch {}
});

function startChild() {
  child = spawn(process.execPath, ['--input-type=module', '-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  return child.pid;
}

function realStartTime(pid) {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    '(Get-CimInstance Win32_Process -Filter "ProcessId=' + pid + '").CreationDate.ToUniversalTime().ToString("o")'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return out;
}

function isAlive(pid) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', 'if (Get-Process -Id ' + pid + ' -ErrorAction SilentlyContinue) { "RUNNING" } else { "GONE" }'], { encoding: 'utf8' });
  return String(r.stdout).includes('RUNNING');
}

function runCleanup(pidsJsonObj) {
  writeFileSync(join(batchDir, 'pids.json'), JSON.stringify(pidsJsonObj), 'utf8');
  return spawnSync(process.execPath, [join(ORCH, 'cleanup-batch.mjs'), BATCH], { encoding: 'utf8', timeout: 120000 });
}

test('正确 startTime → 三重校验全过，进程被杀 exit 0', async () => {
  const pid = startChild();
  await new Promise(r => setTimeout(r, 400));
  const st = realStartTime(pid);
  assert.ok(st, '应能读到启动时间');
  const r = runCleanup([{ pid, startTime: st }]);
  assert.equal(r.status, 0);
  assert.ok(/\[KILLED\]/.test(r.stdout), '日志应含 [KILLED]\n' + r.stdout);
  await new Promise(r => setTimeout(r, 300));
  assert.ok(!isAlive(pid), '进程应已被杀');
});

test('错误 startTime（PID 复用模拟）→ REFUSE 不杀', async () => {
  const pid = startChild();
  await new Promise(r => setTimeout(r, 400));
  const r = runCleanup([{ pid, startTime: '2001-01-01T00:00:00.000Z' }]);
  assert.equal(r.status, 0, 'REFUSE 属有意保留，不算残留');
  assert.ok(/启动时间不匹配/.test(r.stdout), '日志应含 启动时间不匹配\n' + r.stdout);
  assert.ok(isAlive(pid), '进程应仍存活');
  child.kill();
});

test('keep_alive → 保留，进程存活', async () => {
  const pid = startChild();
  await new Promise(r => setTimeout(r, 400));
  const r = runCleanup([{ pid, keep_alive: true }]);
  assert.equal(r.status, 0);
  assert.ok(/\[KEEP\]/.test(r.stdout), '日志应含 [KEEP]\n' + r.stdout);
  assert.ok(isAlive(pid), 'keep_alive 进程应存活');
  child.kill();
});