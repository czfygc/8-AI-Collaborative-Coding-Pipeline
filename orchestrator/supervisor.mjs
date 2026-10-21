#!/usr/bin/env node
// orchestrator/supervisor.mjs — 常驻子进程监督器 CLI（T-173）
// 用法:
//   node orchestrator/supervisor.mjs daemon                     # 前台跑守护循环（计划任务就是调它）
//   node orchestrator/supervisor.mjs add <jobId> -- <cmd> [args...]  # 登记一个受管任务
//   node orchestrator/supervisor.mjs list                        # 任务清单 + 运行状态
//   node orchestrator/supervisor.mjs remove <jobId>             # 移除任务
//   node orchestrator/supervisor.mjs install [--task-name X]     # 装成 Windows 计划任务（跨会话存活）
//   node orchestrator/supervisor.mjs uninstall [--task-name X]   # 卸载计划任务
//   node orchestrator/supervisor.mjs status [--task-name X]      # 计划任务 + 状态
// 退出码: 0=OK, 1=有失败, 2=用法错误, 3=UNKNOWN（环境不支持/状态读不出）
//
// 实证（2026-10-21）：计划任务启动的进程**能在会话结束后继续存活**（本机 Start-Process 起的会被清理链杀）。

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_JOBS_PATH, DEFAULT_STATE_PATH, DEFAULT_TASK_NAME, upsertJob, removeJob, readJobs, readState,
  runDaemon, taskExists, installScheduledTask, uninstallScheduledTask, summarizeState, writeJobs,
  acquireDaemonLock, releaseDaemonLock,
} from './lib/supervisor.mjs';
import { ledger } from './lib/run-events.mjs';

const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : null;
}
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cmd = argv[0];
const jobsPath = resolve(flagValue('--jobs') || DEFAULT_JOBS_PATH);
const statePath = resolve(flagValue('--state') || DEFAULT_STATE_PATH);
const taskName = flagValue('--task-name') || DEFAULT_TASK_NAME;

const HELP = [
  '用法: node orchestrator/supervisor.mjs <command> [options]',
  '  daemon                          前台跑守护循环（计划任务调用这个）',
  '  add <jobId> -- <cmd> [args...]   登记受管任务（--restart always|on-failure|never --max-restarts N --backoff-ms N）',
  '  list                            任务清单 + 运行状态',
  '  remove <jobId>                  移除任务',
  '  install                         装成 Windows 计划任务（跨会话存活）',
  '  uninstall                       卸载计划任务',
  '  status                          计划任务状态 + 受管任务状态',
  '  --jobs <path> --state <path>    覆盖清单/状态路径',
  '退出码: 0=OK 1=有失败 2=用法错误 3=UNKNOWN',
].join('\n');

if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
  console.log(HELP);
  process.exit(cmd ? 0 : 2);
}

if (cmd === 'daemon') {
  const tickMs = Number(flagValue('--tick-ms') || 2000);
  const lock = acquireDaemonLock();
  if (!lock.ok) {
    console.log('[SUPERVISOR] 已有守护进程在跑（pid=' + lock.pid + '），本次不重复启动');
    process.exit(0);
  }
  const onExit = () => { try { releaseDaemonLock(); } catch { /* 忽略 */ } };
  process.on('exit', onExit);
  process.on('SIGINT', () => { onExit(); process.exit(0); });
  process.on('SIGTERM', () => { onExit(); process.exit(0); });
  const result = await runDaemon({ jobsPath, statePath, tickMs, ledger });
  onExit();
  console.log('[SUPERVISOR] 守护循环结束，ticks=' + result.ticks);
  process.exit(0);
}

if (cmd === 'add') {
  const sep = argv.indexOf('--');
  const id = argv[1];
  const command = sep > 0 ? argv.slice(sep + 1) : [];
  if (!id || !command.length) {
    console.error('[SUPERVISOR] 用法: add <jobId> -- <cmd> [args...]');
    process.exit(2);
  }
  const restart = flagValue('--restart') || 'on-failure';
  const maxRestarts = flagValue('--max-restarts');
  const backoffMs = flagValue('--backoff-ms');
  const label = flagValue('--label');
  const cwd = flagValue('--cwd');
  try {
    const job = upsertJob({
      id, command, restart,
      ...(maxRestarts !== null ? { max_restarts: Number(maxRestarts) } : {}),
      ...(backoffMs !== null ? { backoff_ms: Number(backoffMs) } : {}),
      ...(label !== null ? { label } : {}),
      ...(cwd !== null ? { cwd } : {}),
    }, { jobsPath });
    console.log('[SUPERVISOR] 已登记 job: ' + job.id + '（restart=' + job.restart + ' max_restarts=' + job.max_restarts + '）');
    console.log('[SUPERVISOR] 清单: ' + jobsPath);
    process.exit(0);
  } catch (e) {
    console.error('[SUPERVISOR] 登记失败: ' + e.message);
    process.exit(2);
  }
}

if (cmd === 'remove') {
  const id = argv[1];
  if (!id) { console.error('[SUPERVISOR] 用法: remove <jobId>'); process.exit(2); }
  const ok = removeJob(id, { jobsPath });
  console.log(ok ? '[SUPERVISOR] 已移除 ' + id : '[SUPERVISOR] 没找到 ' + id);
  process.exit(ok ? 0 : 1);
}

if (cmd === 'list' || cmd === 'status') {
  const jobs = readJobs(jobsPath);
  const state = readState(statePath);
  if (cmd === 'status') {
    console.log('[SUPERVISOR] 计划任务 ' + taskName + ': ' + (taskExists(taskName) ? '存在' : '不存在'));
  }
  console.log('[SUPERVISOR] 任务清单（' + jobs.length + '）: ' + jobsPath);
  for (const j of jobs) console.log('  ' + j.id + ' | ' + j.label + ' | ' + j.restart + ' | ' + j.command.join(' '));
  const rows = summarizeState(state);
  console.log('[SUPERVISOR] 运行状态（' + (state.updated_at || '尚无心跳') + '）:');
  console.log(rows || '  （无）');
  process.exit(0);
}

if (cmd === 'install') {
  const r = installScheduledTask({ taskName });
  console.log('[SUPERVISOR] install: ' + JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
}

if (cmd === 'uninstall') {
  const r = uninstallScheduledTask(taskName);
  console.log('[SUPERVISOR] uninstall: ' + JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
}

console.error('[SUPERVISOR] 未知命令: ' + cmd + '\n' + HELP);
process.exit(2);
