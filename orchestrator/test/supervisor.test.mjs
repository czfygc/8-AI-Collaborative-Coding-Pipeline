// T-173: supervisor 回归 —— 任务清单校验 / env 白名单 / 守护循环重启策略 / 计划任务探测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  normalizeJob, readJobs, writeJobs, upsertJob, removeJob, readState, writeState, childEnv,
  runDaemon, taskExists, installScheduledTask, uninstallScheduledTask, summarizeState,
  acquireDaemonLock, releaseDaemonLock,
  DEFAULT_TASK_NAME, ENV_ALLOWLIST,
} from '../lib/supervisor.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = fileURLToPath(new URL('../supervisor.mjs', import.meta.url));

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 't173-sup-'));
}

// 可控假 spawner：返回带 exitCode / on('exit') / kill 的假子进程
function fakeSpawner(behavior = {}) {
  const spawned = [];
  const fn = (cmd, args, opts) => {
    const child = {
      pid: 10000 + spawned.length,
      exitCode: null,
      killed: false,
      kill() { this.killed = true; },
      on(ev, cb) { if (ev === 'exit') this._exitCb = cb; return this; },
    };
    spawned.push({ cmd, args, opts, child });
    const b = behavior[cmd];
    if (b && b.exitCode !== undefined) {
      setImmediate(() => {
        child.exitCode = b.exitCode;
        if (child._exitCb) child._exitCb(b.exitCode);
      });
    }
    return child;
  };
  return { fn, spawned };
}

test('job 规范校验：id / command / restart / max_restarts / env 白名单', () => {
  const ok = normalizeJob({ id: 'job-1', command: ['node', 'x.mjs'], restart: 'on-failure', max_restarts: 3 });
  assert.equal(ok.id, 'job-1');
  assert.equal(ok.restart, 'on-failure');
  assert.equal(ok.max_restarts, 3);
  assert.throws(() => normalizeJob({ id: 'bad id!', command: ['node'] }), /id 非法/);
  assert.throws(() => normalizeJob({ id: 'x', command: [] }), /缺 command/);
  assert.throws(() => normalizeJob({ id: 'x', command: [''] }), /非空字符串数组/);
  assert.throws(() => normalizeJob({ id: 'x', command: ['node'], restart: 'sometimes' }), /restart 非法/);
  assert.throws(() => normalizeJob({ id: 'x', command: ['node'], max_restarts: -1 }), /max_restarts/);
  assert.throws(() => normalizeJob({ id: 'x', command: ['node'], env_allow: ['MY_API_KEY'] }), /疑似密钥变量/);
});

test('任务清单：upsert / list / remove（临时目录）', () => {
  const dir = tmpDir();
  try {
    const jobsPath = join(dir, 'jobs.json');
    assert.equal(readJobs(jobsPath).length, 0);
    upsertJob({ id: 'a', command: ['node', 'a.mjs'] }, { jobsPath });
    upsertJob({ id: 'b', command: ['node', 'b.mjs'], restart: 'always' }, { jobsPath });
    assert.equal(readJobs(jobsPath).length, 2);
    upsertJob({ id: 'a', label: 'renamed' }, { jobsPath });
    const jobs = readJobs(jobsPath);
    assert.equal(jobs.length, 2);
    assert.equal(jobs.find((j) => j.id === 'a').label, 'renamed');
    assert.equal(removeJob('a', { jobsPath }), true);
    assert.equal(readJobs(jobsPath).length, 1);
    assert.equal(removeJob('zzz', { jobsPath }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('子进程 env：只传白名单 + 显式允许项；密钥类不落盘', () => {
  const job = { env_allow: ['TITAN_WORKSPACE'] };
  const env = { PATH: 'x', TEMP: 't', FREELLMAPI_API_KEY: 'secret', TITAN_WORKSPACE: 'w', OTHER: 'o' };
  const out = childEnv(job, env);
  assert.equal(out.PATH, 'x');
  assert.equal(out.TITAN_WORKSPACE, 'w');
  assert.equal(out.FREELLMAPI_API_KEY, undefined, '密钥不该进子进程 env');
  assert.equal(out.OTHER, undefined);
  assert.ok(ENV_ALLOWLIST.includes('PATH'));
});

test('守护循环：restart=never 的任务退出后不再拉起，状态记 exited', async () => {
  const dir = tmpDir();
  try {
    const jobsPath = join(dir, 'jobs.json');
    const statePath = join(dir, 'state.json');
    writeJobs([normalizeJob({ id: 'once', command: ['fake'], restart: 'never' })], jobsPath);
    const { fn, spawned } = fakeSpawner({ fake: { exitCode: 0 } });
    await runDaemon({ jobsPath, statePath, tickMs: 10, maxTicks: 5, spawnFn: fn, ledger: null });
    const state = readState(statePath);
    assert.equal(state.jobs.once.status, 'exited');
    assert.equal(state.jobs.once.exit_code, 0);
    assert.equal(spawned.length, 1, 'never 不应重启');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('守护循环：restart=on-failure 且退出码非 0 → 拉起一次；退出码 0 → 不拉起', async () => {
  const dir = tmpDir();
  try {
    const jobsPath = join(dir, 'jobs.json');
    const statePath = join(dir, 'state.json');
    writeJobs([
      normalizeJob({ id: 'fails', command: ['bad'], restart: 'on-failure', max_restarts: 2, backoff_ms: 0 }),
      normalizeJob({ id: 'passes', command: ['good'], restart: 'on-failure', max_restarts: 2, backoff_ms: 0 }),
    ], jobsPath);
    const { fn, spawned } = fakeSpawner({ bad: { exitCode: 1 }, good: { exitCode: 0 } });
    await runDaemon({ jobsPath, statePath, tickMs: 10, maxTicks: 12, spawnFn: fn, ledger: null });
    const badSpawns = spawned.filter((s) => s.cmd === 'bad').length;
    const goodSpawns = spawned.filter((s) => s.cmd === 'good').length;
    assert.ok(badSpawns >= 2, '失败的应被拉起（至少 2 次），实际 ' + badSpawns);
    assert.equal(goodSpawns, 1, '成功的不应被拉起');
    const state = readState(statePath);
    assert.equal(state.jobs.passes.status, 'exited');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('守护循环：真实子进程被拉起并写心跳状态（不依赖假 spawner）', async () => {
  const dir = tmpDir();
  try {
    const jobsPath = join(dir, 'jobs.json');
    const statePath = join(dir, 'state.json');
    writeJobs([normalizeJob({ id: 'alive', command: [process.execPath, '-e', 'setInterval(()=>{},1000)'], restart: 'never' })], jobsPath);
    const res = await runDaemon({ jobsPath, statePath, tickMs: 50, maxTicks: 2, ledger: null });
    assert.ok(res.ticks >= 1);
    const state = readState(statePath);
    assert.equal(state.jobs.alive.status, 'running');
    assert.ok(state.jobs.alive.pid, '应有 pid');
    assert.ok(state.jobs.alive.last_beat_at, '应有心跳时间');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('守护循环：daemon 不在清单里的 job 会被杀掉并从状态移除', async () => {
  const dir = tmpDir();
  try {
    const jobsPath = join(dir, 'jobs.json');
    const statePath = join(dir, 'state.json');
    writeJobs([normalizeJob({ id: 'tmp', command: [process.execPath, '-e', 'setInterval(()=>{},1000)'], restart: 'never' })], jobsPath);
    const promise = runDaemon({ jobsPath, statePath, tickMs: 30, maxTicks: 50, ledger: null });
    await new Promise((r) => setTimeout(r, 120));
    writeJobs([], jobsPath);
    await promise;
    const state = readState(statePath);
    assert.equal(state.jobs.tmp, undefined, '移出清单后状态里不该再有它');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('计划任务：不存在时 taskExists=false；install/uninstall 成对可用（Windows）', () => {
  if (process.platform !== 'win32') return;
  const probeName = 'TITAN-Supervisor-Probe-' + Date.now();
  assert.equal(taskExists(probeName), false);
  const ins = installScheduledTask({ taskName: probeName, runNow: false });
  try {
    assert.equal(ins.ok, true, JSON.stringify(ins));
    assert.equal(taskExists(probeName), true);
  } finally {
    const del = uninstallScheduledTask(probeName);
    assert.equal(del.ok, true);
  }
  assert.equal(taskExists(probeName), false);
});

test('单实例锁：第二个守护进程拿不到锁；释放后可再拿', () => {
  const dir = tmpDir();
  try {
    const lockPath = join(dir, 'daemon.lock');
    const first = acquireDaemonLock({ lockPath, pid: process.pid });
    assert.equal(first.ok, true);
    const second = acquireDaemonLock({ lockPath, pid: process.pid + 1 });
    assert.equal(second.ok, false, '已有存活守护进程时应拿不到锁');
    assert.equal(second.pid, process.pid);
    assert.equal(releaseDaemonLock({ lockPath, pid: process.pid }), true);
    const third = acquireDaemonLock({ lockPath, pid: process.pid + 1 });
    assert.equal(third.ok, true, '释放后应能再拿');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('状态摘要可读；状态文件原子写盘', () => {
  const dir = tmpDir();
  try {
    const statePath = join(dir, 'state.json');
    writeState({ jobs: { a: { id: 'a', status: 'running', pid: 5, restarts: 0, exit_code: null, last_beat_at: 'now' } } }, statePath);
    const text = summarizeState(readState(statePath));
    assert.ok(text.includes('a'));
    assert.ok(text.includes('running'));
    assert.ok(existsSync(statePath));
    assert.ok(!existsSync(statePath + '.tmp'), '临时文件应被 rename 掉');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI：--help 退 0；add/list 往返（临时清单）', () => {
  const help = spawnSync(process.execPath, [CLI, '--help'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(help.status, 0);
  const dir = tmpDir();
  try {
    const jobsPath = join(dir, 'jobs.json');
    const statePath = join(dir, 'state.json');
    const add = spawnSync(process.execPath, [CLI, 'add', 'cli-job', '--', 'node', 'x.mjs', '--jobs', jobsPath, '--state', statePath], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(add.status, 0, add.stderr);
    const list = spawnSync(process.execPath, [CLI, 'list', '--jobs', jobsPath, '--state', statePath], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(list.status, 0);
    assert.ok(list.stdout.includes('cli-job'));
    const rm = spawnSync(process.execPath, [CLI, 'remove', 'cli-job', '--jobs', jobsPath], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(rm.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
