#!/usr/bin/env node
// orchestrator/run-tests.mjs — 四客户端共享测试运行器 CLI
// 用法: node orchestrator/run-tests.mjs [--cwd <dir>] [--framework auto|vitest|jest|pytest|node|npm-test]
//                                      [--target <pattern>] [--last-failed] [--timeout <ms>]
//                                      [--command <cmd>] [--json] [--tail <chars>] [--max-failures <n>]
// 退出码: 0=测试全绿, 1=有失败/超时/执行错误, 2=用法错误
//
// 设计：只回结构化摘要（统计 + 失败用例名与错误 + 输出尾部），不倒整段原始输出——省 token、省一轮。
// 客户端无关：四客户端（OpenCode / Cline / Kilo / DeepSeek Harness）共用这一条命令。

import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests, formatText, detectFramework } from './lib/test-runner.mjs';

const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : null;
}
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cwd = resolve(flagValue('--cwd') || REPO_ROOT);
const framework = flagValue('--framework') || 'auto';
const target = flagValue('--target') || '';
const lastFailed = argv.includes('--last-failed');
const command = flagValue('--command') || '';
const asJson = argv.includes('--json');
const timeoutMs = Number(flagValue('--timeout') || 120000);
const tailChars = Number(flagValue('--tail') || 800);
const maxFailures = Number(flagValue('--max-failures') || 8);

if (argv.includes('--help') || argv.includes('-h')) {
  console.log([
    '用法: node orchestrator/run-tests.mjs [options]',
    '  --cwd <目录>            在哪跑（默认仓库根）',
    '  --framework <fw>        auto|vitest|jest|pytest|node|npm-test（默认 auto）',
    '  --target <模式>         文件/目录/用例（多目标空格分隔）',
    '  --last-failed           只重跑上次失败（vitest/jest/pytest 支持）',
    '  --timeout <ms>          超时（默认 120000）',
    '  --command <命令>        自定义命令（跳过框架探测）',
    '  --json                  输出 JSON',
    '  --tail <字符数>         输出尾部长度（默认 800）',
    '  --max-failures <n>      摘要最多列几个失败（默认 8）',
    '退出码: 0=全绿 1=有失败/超时 2=用法错误',
  ].join('\n'));
  process.exit(0);
}

if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error('[TEST-RUN] --timeout 需要正整数毫秒');
  process.exit(2);
}

if (asJson) {
  const r = runTests({ cwd, framework, target, lastFailed, timeoutMs, command });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}

if (framework === 'auto' && !command) {
  const d = detectFramework(cwd);
  console.log('[TEST-RUN] 探测框架: ' + (d.framework || 'unknown') + '（' + d.evidence + '）');
}

const result = runTests({ cwd, framework, target, lastFailed, timeoutMs, command });
console.log(formatText(result, { maxFailures, tailChars }));
process.exit(result.ok ? 0 : 1);
