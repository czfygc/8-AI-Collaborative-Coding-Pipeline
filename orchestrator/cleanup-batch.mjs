// cleanup-batch.mjs —— 批次进程清理（autopilot 运维工具）
// 用法: node cleanup-batch.mjs <batchId>        例: node cleanup-batch.mjs 20261002-a
//
// 输入: reviews/_autopilot/batch-<batchId>/pids.json
//   支持三种写法（逐条容忍）:
//     [123, {"pid": 456, "keep_alive": true}, "789"]
//     {"pids": [ ... 同上 ... ]}
//     {"123": {"keep_alive": true}, "456": true}     // 键=PID
//
// 流程:
//   1. 读 pids.json
//   2. 跳过 keep_alive
//   3. 杀前查命令行（保险一）: Get-CimInstance Win32_Process
//        含 chrome.exe                      -> [REFUSE] chrome.exe 保护，不杀
//        含 decision-api / mcp-proxy / cloudflared -> [REFUSE] daemon 保护，不杀
//        命令行读不到                        -> [REFUSE] 无法读取命令行，保守跳过
//   4. taskkill /PID <pid> /T /F
//   5. Get-Process 复核该 PID 是否已消失
//   6. 汇总：杀掉 / 保留(keep_alive) / 保护跳过 / 本就不存在 / 残留
//   7. 日志归档（保险二）: 全部输出追加到 reviews/_autopilot/batch-<id>/cleanup.log
//
// 退出码: 0 = 全部清干净（被保护/keep_alive 属有意保留，不算残留）
//         1 = 有残留（杀不掉且 Get-Process 仍能看到）
//         2 = 输入错误（pids.json 缺失/无法解析）

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TITAN = process.env.D_TITAN_ROOT || join(__dirname, '..');

const batchId = process.argv[2];
if (!batchId || !/^[A-Za-z0-9._-]+$/.test(batchId)) {
  console.error('用法: node cleanup-batch.mjs <batchId>（batchId 只允许字母数字 . _ -）');
  process.exit(2);
}
const batchDir = join(TITAN, 'reviews', '_autopilot', 'batch-' + batchId);
const pidsFile = join(batchDir, 'pids.json');
if (!existsSync(pidsFile)) {
  console.error('[MISSING] ' + pidsFile);
  process.exit(2);
}

// ---------- 日志归档（保险二）：输出既打控制台也攒起来，结束时追加 cleanup.log ----------
const logLines = [];
function log(msg) {
  console.log(msg);
  logLines.push(msg);
}
function flushLog() {
  try {
    mkdirSync(batchDir, { recursive: true });
    const ts = '==== ' + new Date().toISOString() + ' ====';
    appendFileSync(join(batchDir, 'cleanup.log'), ts + '\n' + logLines.join('\n') + '\n', 'utf8');
    log('[LOG] 已追加 ' + logLines.length + ' 行到 ' + join(batchDir, 'cleanup.log'));
  } catch (e) {
    console.error('[LOG_FAILED] ' + e.message);
  }
}

// ---------- 1. 解析 pids.json ----------
let raw;
try {
  raw = JSON.parse(readFileSync(pidsFile, 'utf8'));
} catch (e) {
  console.error('[BAD_INPUT] pids.json 解析失败: ' + e.message);
  process.exit(2);
}

const entries = [];
function addEntry(pid, keepAlive, startTime) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return;
  entries.push({ pid: n, keepAlive: !!keepAlive, startTime: startTime || null });
}
// S-12：条目可带 startTime/createTime/create_time（ISO）——提供时杀前逐字核对，
// 不匹配（PID 复用）即 REFUSE。
if (Array.isArray(raw)) {
  for (const it of raw) {
    if (typeof it === 'number' || typeof it === 'string') addEntry(it, false);
    else if (it && typeof it === 'object') addEntry(it.pid ?? it.processId ?? it.id, it.keep_alive ?? it.keepAlive, it.startTime ?? it.start_time ?? it.createTime);
  }
} else if (raw && typeof raw === 'object') {
  if (Array.isArray(raw.pids)) {
    for (const it of raw.pids) {
      if (typeof it === 'number' || typeof it === 'string') addEntry(it, false);
      else if (it && typeof it === 'object') addEntry(it.pid ?? it.processId ?? it.id, it.keep_alive ?? it.keepAlive, it.startTime ?? it.start_time ?? it.createTime);
    }
  } else {
    for (const [k, v] of Object.entries(raw)) addEntry(k, typeof v === 'object' ? (v.keep_alive ?? v.keepAlive) : v === true ? false : v, typeof v === 'object' ? (v.startTime ?? v.start_time) : null);
  }
}
if (entries.length === 0) {
  console.error('[BAD_INPUT] pids.json 中没有可识别的 PID');
  process.exit(2);
}
log('批次 ' + batchId + '：待处理 ' + entries.length + ' 项（' + pidsFile + '）');

// ---------- 工具 ----------
function isRunning(pid) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      'if (Get-Process -Id ' + pid + ' -ErrorAction SilentlyContinue) { "RUNNING" } else { "GONE" }'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return out.includes('RUNNING');
  } catch {
    return false;
  }
}

// 保险一：杀前三重校验（S-12）—— pid + 启动时间 + cmdline 三者必须全部齐备，缺一项即 REFUSE。
// 可选：pids.json 条目带 startTime（ISO）时逐字比对，不匹配（PID 被复用）也 REFUSE。
// 返回 { allowed, reason, gone, pid, startTime, cmdline }
function inspectProcess(pid, expectedStartTime) {
  let rec = null;
  let cmdline = null, startTime = null;
  try {
    const ps = [
      '$p = Get-CimInstance Win32_Process -Filter "ProcessId=' + pid + '" -ErrorAction SilentlyContinue;',
      'if ($null -eq $p) { "NO_PROCESS" } else {',
      '  [PSCustomObject]@{ Pid = $p.ProcessId; Start = $p.CreationDate.ToUniversalTime().ToString("o"); Cmd = $p.CommandLine } | ConvertTo-Json -Compress',
      '}'
    ].join(' ');
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (out === 'NO_PROCESS') return { allowed: false, reason: '进程已不存在', gone: true, pid };
    rec = JSON.parse(out);
  } catch (e) {
    return { allowed: false, reason: '三重校验查询失败，保守跳过（' + String(e.message).slice(0, 60) + '）', pid, cmdline: null };
  }
  if (!rec || !Number.isInteger(rec.Pid)) {
    return { allowed: false, reason: '无法确认 PID（三重校验缺其一），保守跳过', pid, cmdline: null };
  }
  cmdline = rec.Cmd;
  startTime = rec.Start;
  if (!cmdline || String(cmdline).trim() === '') {
    return { allowed: false, reason: '无法读取命令行（三重校验缺其一），保守跳过', pid, startTime };
  }
  if (!startTime) {
    return { allowed: false, reason: '无法读取启动时间（三重校验缺其一），保守跳过', pid, cmdline };
  }
  if (expectedStartTime) {
    const exp = new Date(expectedStartTime).getTime();
    const got = new Date(startTime).getTime();
    if (!Number.isFinite(exp) || Math.abs(exp - got) > 2000) {
      return { allowed: false, reason: '启动时间不匹配（PID 可能已被复用），拒绝杀', pid, startTime, cmdline };
    }
  }
  const lc = cmdline.toLowerCase();
  if (lc.includes('chrome.exe')) return { allowed: false, reason: 'chrome.exe 保护', pid, startTime, cmdline };
  if (lc.includes('decision-api') || lc.includes('mcp-proxy') || lc.includes('cloudflared')) {
    return { allowed: false, reason: 'daemon 保护（decision-api/mcp-proxy/cloudflared）', pid, startTime, cmdline };
  }
  return { allowed: true, reason: '', pid, startTime, cmdline };
}

function killTree(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

// ---------- 2..5. keep_alive → 查命令行 → 杀 → 复核 ----------
let killed = 0, kept = 0, refused = 0, gone = 0;
const residue = [];
for (const entry of entries) {
  const { pid, keepAlive, startTime } = entry;
  if (keepAlive) {
    kept++;
    log('[KEEP] PID ' + pid + '（keep_alive）');
    continue;
  }
  if (!isRunning(pid)) {
    gone++;
    log('[GONE] PID ' + pid + ' 已不存在，无需清理');
    continue;
  }
  const insp = inspectProcess(pid, startTime);
  if (insp.gone) {
    gone++;
    log('[GONE] PID ' + pid + ' 在检查期间已退出');
    continue;
  }
  if (!insp.allowed) {
    refused++;
    log('[REFUSE] PID ' + pid + ' ' + insp.reason);
    continue;
  }
  killTree(pid);
  if (isRunning(pid)) {
    residue.push(pid);
    log('[RESIDUE] PID ' + pid + ' 杀不掉，仍在运行（命令行: ' + String(insp.cmdline).slice(0, 120) + '）');
  } else {
    killed++;
    log('[KILLED] PID ' + pid + ' :: ' + String(insp.cmdline).slice(0, 120));
  }
}

// ---------- 6. 汇总 ----------
log('---');
log('本批次杀掉: ' + killed + ' ｜ 保留(keep_alive): ' + kept + ' ｜ 保护跳过(REFUSE): ' + refused + ' ｜ 本就不存在: ' + gone + ' ｜ 残留: ' + residue.length);

// ---------- 7. 归档 ----------
flushLog();

// ---------- 退出码 ----------
process.exit(residue.length > 0 ? 1 : 0);
