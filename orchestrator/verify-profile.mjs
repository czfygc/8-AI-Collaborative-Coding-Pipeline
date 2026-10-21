#!/usr/bin/env node
// orchestrator/verify-profile.mjs — 按 verify profile 执行某能力的 CLI（T-164）
// 用法: node orchestrator/verify-profile.mjs [--language js|py] [--file <path>] [--capability syntax|test]
//                                       [--cwd <dir>] [--timeout <ms>] [--json]
// 退出码: 0=PASS, 1=FAIL, 3=UNKNOWN（能力缺失/语言未知——显式未知，不当通过）, 2=用法错误
//
// 用途：给「外仓/Python 仓」一条与执行器同口径的 verify 命令（不再各处硬写 python -m py_compile）。

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCapability, resolveProfile, detectLanguage, VERIFY_STATUS } from './lib/verify-profiles.mjs';

const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : null;
}
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

if (argv.includes('--help') || argv.includes('-h')) {
  console.log([
    '用法: node orchestrator/verify-profile.mjs [options]',
    '  --language <js|py>      语言（缺省按 --file 扩展名推断）',
    '  --file <path>           目标文件（syntax 能力必填，作为 {file} 占位符）',
    '  --capability <cap>      syntax|test（默认 syntax）',
    '  --cwd <dir>             工作目录（默认仓库根）',
    '  --timeout <ms>          超时（默认 120000）',
    '  --json                  输出 JSON',
    '退出码: 0=PASS 1=FAIL 3=UNKNOWN 2=用法错误',
  ].join('\n'));
  process.exit(0);
}

const capability = flagValue('--capability') || 'syntax';
const file = flagValue('--file') || '';
const cwd = resolve(flagValue('--cwd') || REPO_ROOT);
const timeoutMs = Number(flagValue('--timeout') || 120000);
const asJson = argv.includes('--json');

if (!['syntax', 'test'].includes(capability)) {
  console.error('[VERIFY-PROFILE] --capability 必须是 syntax 或 test');
  process.exit(2);
}
const languageArg = flagValue('--language');
const language = languageArg ? languageArg.toLowerCase() : (file ? detectLanguage(file) : null);
if (languageArg && !['js', 'py'].includes(language)) {
  console.error('[VERIFY-PROFILE] --language 必须是 js 或 py');
  process.exit(2);
}
if (capability === 'syntax' && !file) {
  console.error('[VERIFY-PROFILE] syntax 能力需要 --file');
  process.exit(2);
}

const result = runCapability({ language, file, capability, cwd, timeoutMs });

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('[VERIFY-PROFILE] status=' + result.status + ' profile=' + (result.profile || 'none') +
    ' capability=' + result.capability + (result.command ? ' command=' + result.command.join(' ') : ''));
  if (result.reason) console.log('[VERIFY-PROFILE] reason: ' + result.reason);
  if (result.output) console.log(result.output);
}
if (!asJson && result.status === VERIFY_STATUS.UNKNOWN) {
  console.log('[VERIFY-PROFILE] UNKNOWN = 该 profile 无此能力/语言未知——显式未知，不等于通过');
}

process.exit(result.status === VERIFY_STATUS.PASS ? 0 : (result.status === VERIFY_STATUS.FAIL ? 1 : 3));
