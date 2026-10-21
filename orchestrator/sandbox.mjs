#!/usr/bin/env node
// T-145: 工具输出沙箱 CLI（原型）—— 把大输出关在本地，只把摘要送回上下文
// 用法:
//   node orchestrator/sandbox.mjs run --label <名字> [--dir <目录>] [--max-bytes N] -- <命令> [参数...]
//   node orchestrator/sandbox.mjs file <文件路径> [--label <名字>] [--dir <目录>] [--max-bytes N]
//   node orchestrator/sandbox.mjs search <artifact路径> <关键词> [--max N] [--context N] [--regex]
//   node orchestrator/sandbox.mjs stats [--dir <目录>]
// 退出码: 0=成功, 1=执行/校验失败, 2=用法错误
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_DIR, DEFAULT_BUDGET, sandboxOutput, searchArtifact, statsText,
} from './lib/output-sandbox.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];

function take(name, fallback) {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

function has(name) {
  return argv.includes(name);
}

function usage() {
  console.log([
    '工具输出沙箱（T-145 原型）',
    '',
    '  run --label <名字> [--dir <目录>] [--max-bytes N] -- <命令> [参数...]',
    '      执行命令，stdout/stderr 全量落盘，只打印摘要',
    '  file <文件路径> [--label <名字>] [--dir <目录>] [--max-bytes N]',
    '      把已有大文件变成"落盘 + 摘要"',
    '  search <artifact路径> <关键词> [--max N] [--context N] [--regex]',
    '      按需检索原始输出（默认子串、忽略大小写）',
    '  stats [--dir <目录>]',
    '      查看累计节省量测',
    '',
    '默认目录: ' + DEFAULT_DIR,
    '默认摘要预算: ' + DEFAULT_BUDGET + ' B',
  ].join('\n'));
}

function fail(msg) {
  console.error('[SANDBOX] ' + msg);
  process.exit(2);
}

function printResult(result, label) {
  console.log(result.digest.text);
  console.log('[SANDBOX] artifact=' + result.meta.artifact);
  console.log('[SANDBOX] label=' + label + ' original=' + result.measured.originalBytes + 'B digest=' + result.measured.digestBytes + 'B saved=' + result.measured.savedBytes + 'B (' + result.measured.savingPct + '%)');
}

if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
  usage();
  process.exit(0);
}

const dir = resolve(take('--dir', DEFAULT_DIR));
const maxBytes = Number(take('--max-bytes', DEFAULT_BUDGET));

if (cmd === 'run') {
  const sep = argv.indexOf('--');
  if (sep === -1 || sep === argv.length - 1) fail('run 需要 "-- <命令> [参数...]"');
  const label = take('--label', 'run');
  const child = argv.slice(sep + 1);
  const r = spawnSync(child[0], child.slice(1), { encoding: 'utf8', timeout: Number(take('--timeout-ms', 600000)), maxBuffer: 256 * 1024 * 1024 });
  if (r.error) {
    const msg = r.error.code === 'ENOENT' ? '命令不存在: ' + child[0] : r.error.message;
    fail(msg);
  }
  const out = String(r.stdout || '') + String(r.stderr || '');
  const result = sandboxOutput({ content: out, label, source: child.join(' '), dir, maxBytes });
  printResult(result, label);
  console.log('[SANDBOX] child-exit=' + r.status);
  process.exit(r.status === 0 ? 0 : 1);
}

if (cmd === 'file') {
  const file = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;
  if (!file) fail('file 需要 <文件路径>');
  const abs = resolve(file);
  if (!existsSync(abs)) fail('文件不存在: ' + abs);
  const label = take('--label', abs.replace(/[\\/]/g, '_'));
  const content = readFileSync(abs, 'utf8');
  const result = sandboxOutput({ content, label, source: abs, dir, maxBytes });
  printResult(result, label);
  process.exit(0);
}

if (cmd === 'search') {
  const file = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;
  const needle = argv[2] && !argv[2].startsWith('--') ? argv[2] : null;
  if (!file || !needle) fail('search 需要 <artifact路径> <关键词>');
  let r;
  try {
    r = searchArtifact(file, needle, {
      max: Number(take('--max', 20)),
      context: Number(take('--context', 0)),
      regex: has('--regex'),
    });
  } catch (e) {
    fail(e.message);
  }
  console.log(r.text);
  console.log('[SANDBOX] matches=' + r.matches + ' shown=' + r.shown + ' lines=' + r.totalLines + ' truncated=' + r.truncated);
  process.exit(0);
}

if (cmd === 'stats') {
  console.log(statsText(dir));
  process.exit(0);
}

usage();
process.exit(2);
