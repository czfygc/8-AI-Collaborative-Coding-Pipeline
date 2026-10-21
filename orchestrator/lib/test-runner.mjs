// orchestrator/lib/test-runner.mjs — 四客户端共享测试运行器（零依赖、客户端无关）
//
// 目的：把「改代码 → 跑测试 → 修」闭环从"读一整段原始测试输出"变成"读一份结构化摘要"，
//       省 token、省一轮往返。OpenCode / Cline / Kilo / DeepSeek Harness 都能用同一条命令。
//
// 借鉴：DeepSeek Harness 插件 dsh-test-runner（github.com/suimi8/dsh-test-runner，MIT）——
//       自动探测框架 + 只回结构化摘要。本文件是仓内重写（零依赖、可测、客户端无关），
//       解析口径与上游兼容（vitest/jest/pytest/node:test/npm-test），出处见技能
//       .agents/skills/titan-test-runner/SKILL.md 的 provenance 字段。
//
// 三条硬约束：
//   1. 目标串（target）严格白名单校验后再进命令——不可信文本不进 shell。
//   2. 解析失败必须退化安全：只回 exitCode + 输出尾部，绝不崩、绝不谎报通过。
//   3. 不修改被测项目任何文件；只读 + 执行测试命令。
//
// 用法（CLI：orchestrator/run-tests.mjs）：
//   import { detectFramework, buildCommand, parseOutput, runTests } from './test-runner.mjs';

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const FRAMEWORKS = ['vitest', 'jest', 'pytest', 'node', 'npm-test'];
export const DEFAULT_TIMEOUT_MS = 120000;

// target 白名单：路径、glob、pytest 的 `::` 用例名、node 的 `--test-name-pattern` 片段
const TARGET_SAFE_RE = /^[A-Za-z0-9_\-./\\:*?=\[\]@,~ ]*$/;

export function stripAnsi(s) {
  return String(s == null ? '' : s).replace(/\u001b\[[0-9;]*m/g, '');
}

export function isSafeTarget(target) {
  const t = String(target == null ? '' : target).trim();
  if (!t) return true;
  if (!TARGET_SAFE_RE.test(t)) return false;
  if (t.includes('..')) return false;
  return true;
}

function readJsonFile(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function hasNodeTestFiles(dir, depth = 0) {
  if (depth > 2) return false;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    if (e.isDirectory()) {
      if (e.name === 'test' || e.name === 'tests' || e.name === '__tests__') return true;
      if (depth < 2 && hasNodeTestFiles(join(dir, e.name), depth + 1)) return true;
    } else if (/\.(test|spec)\.(js|ts|mjs|cjs|jsx|tsx)$/.test(e.name)) {
      return true;
    }
  }
  return false;
}

// 返回 { framework, evidence }；探测不到返回 { framework: null, evidence: '...' }
export function detectFramework(cwd) {
  const dir = resolve(cwd);
  const pkg = readJsonFile(join(dir, 'package.json'));
  if (pkg) {
    const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
    if (deps && (deps.vitest || deps['@vitest/runner'] || deps['@vitest/ui'])) {
      return { framework: 'vitest', evidence: 'package.json 依赖含 vitest' };
    }
    if (deps && (deps.jest || deps['@jest/core'])) {
      return { framework: 'jest', evidence: 'package.json 依赖含 jest' };
    }
    if (pkg.scripts && typeof pkg.scripts.test === 'string' && pkg.scripts.test.trim()) {
      return { framework: 'npm-test', evidence: 'package.json scripts.test' };
    }
  }
  for (const marker of ['pyproject.toml', 'pytest.ini', 'conftest.py', 'setup.cfg', 'tox.ini']) {
    if (existsSync(join(dir, marker))) {
      return { framework: 'pytest', evidence: '存在 ' + marker };
    }
  }
  if (hasNodeTestFiles(dir)) return { framework: 'node', evidence: '存在 test 目录或 *.test.* 文件' };
  return { framework: null, evidence: '未找到 vitest/jest 依赖、npm test 脚本、pytest 标记文件或 test 目录' };
}

export function buildCommand(framework, { target = '', lastFailed = false, custom = '' } = {}) {
  if (custom && custom.trim()) return custom.trim();
  const t = String(target || '').trim();
  switch (framework) {
    case 'vitest':
      if (lastFailed) return 'npx vitest run --lastFailed';
      return t ? 'npx vitest run ' + t : 'npx vitest run';
    case 'jest':
      if (lastFailed) return 'npx jest --onlyFailures --ci';
      return (t ? 'npx jest ' + t : 'npx jest') + ' --ci';
    case 'pytest':
      if (lastFailed) return 'python -m pytest -q --lf';
      return 'python -m pytest -q' + (t ? ' ' + t : '');
    case 'node':
      return t ? 'node --test ' + t : 'node --test';
    case 'npm-test':
      return 'npm test';
    default:
      return null;
  }
}

function emptySummary() {
  return { total: 0, passed: 0, failed: 0, skipped: 0 };
}

export function parseOutput(framework, text) {
  const t = stripAnsi(text);
  const summary = emptySummary();
  const failures = [];
  let parsed = false;

  if (framework === 'vitest') {
    const line = (t.match(/Tests\s+[^\n]*/) || [''])[0];
    if (line) {
      const fm = line.match(/(\d+)\s+failed/);
      const pm = line.match(/(\d+)\s+passed/);
      const sm = line.match(/(\d+)\s+skipped/);
      const tm = line.match(/\((\d+)\)/);
      if (fm) summary.failed = Number(fm[1]);
      if (pm) summary.passed = Number(pm[1]);
      if (sm) summary.skipped = Number(sm[1]);
      if (tm) summary.total = Number(tm[1]);
      parsed = !!(fm || pm || sm || tm);
    }
    let cur = null;
    for (const raw of t.split('\n')) {
      const line2 = raw.trim();
      const x = line2.match(/^[×✕✖✗✘x]\s+(.+)$/);
      if (x) { cur = { name: x[1].trim(), message: '' }; failures.push(cur); continue; }
      const a = line2.match(/^→\s+(.+)$/);
      if (a && cur && !cur.message) cur.message = a[1].trim().slice(0, 300);
    }
  } else if (framework === 'jest') {
    const m = t.match(/Tests:\s+(\d+)\s+failed,\s+(\d+)\s+passed,\s+(\d+)\s+total/);
    if (m) { summary.failed = Number(m[1]); summary.passed = Number(m[2]); summary.total = Number(m[3]); parsed = true; }
    else {
      const m2 = t.match(/Tests:\s+(\d+)\s+passed,\s+(\d+)\s+total/);
      if (m2) { summary.passed = Number(m2[1]); summary.total = Number(m2[2]); parsed = true; }
    }
    let cur = null;
    for (const raw of t.split('\n')) {
      const line2 = raw.trim();
      const b = line2.match(/^●\s+(.+)$/);
      if (b) { cur = { name: b[1].trim(), message: '' }; failures.push(cur); continue; }
      if (cur && !cur.message && line2 && !/^at\s/.test(line2) && !/^FAIL\s/.test(line2)) cur.message = line2.slice(0, 300);
    }
  } else if (framework === 'pytest') {
    const fm = t.match(/(\d+)\s+failed/);
    const pm = t.match(/(\d+)\s+passed/);
    const sm = t.match(/(\d+)\s+skipped/);
    const em = t.match(/(\d+)\s+error/);
    if (fm) summary.failed = Number(fm[1]);
    if (pm) summary.passed = Number(pm[1]);
    if (sm) summary.skipped = Number(sm[1]);
    if (em) summary.failed += Number(em[1]);
    if (fm || pm || sm) {
      summary.total = summary.passed + summary.failed + summary.skipped;
      parsed = true;
    }
    for (const raw of t.split('\n')) {
      const line2 = raw.trim();
      const m = line2.match(/^FAILED\s+(.+)$/);
      if (m) {
        const rest = m[1];
        const parts = rest.split(/\s+-\s+/);
        failures.push({ name: parts[0].trim(), message: parts[1] ? parts[1].trim().slice(0, 300) : '' });
      }
    }
  } else if (framework === 'node') {
    // node:test：TAP reporter 用 `# tests N`，spec reporter 用 `ℹ tests N`
    const tM = t.match(/(?:^|\n)[#ℹ]\s*tests\s+(\d+)/);
    const pM = t.match(/(?:^|\n)[#ℹ]\s*pass(?:ed)?\s+(\d+)/);
    const fM = t.match(/(?:^|\n)[#ℹ]\s*fail(?:ed)?\s+(\d+)/);
    const sM = t.match(/(?:^|\n)[#ℹ]\s*skipped\s+(\d+)/);
    if (tM) { summary.total = Number(tM[1]); parsed = true; }
    if (pM) { summary.passed = Number(pM[1]); parsed = true; }
    if (fM) { summary.failed = Number(fM[1]); parsed = true; }
    if (sM) { summary.skipped = Number(sM[1]); parsed = true; }
    if (!tM && (pM || fM || sM)) summary.total = summary.passed + summary.failed + summary.skipped;
    const lines = t.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].trim().match(/^not ok\s+\d+\s+-\s+(.+)$/);
      if (!m) continue;
      let message = '';
      for (let j = i + 1; j < Math.min(i + 20, lines.length); j++) {
        const mm = lines[j].trim().match(/^message:\s*(.+)$/);
        if (mm) { message = mm[1].trim(); break; }
        if (/^error:\s*\|?-?/.test(lines[j].trim())) {
          const errLines = [];
          for (let k = j + 1; k < Math.min(j + 15, lines.length); k++) {
            const l = lines[k];
            if (l.indexOf('  ') !== 0) break;
            const trimmed = l.trim();
            if (!trimmed) continue;
            errLines.push(trimmed);
            if (errLines.length >= 4) break;
          }
          message = errLines.join(' | ').slice(0, 300);
          break;
        }
      }
      failures.push({ name: m[1].trim(), message });
    }
    // spec reporter（Node ≥22 默认输出）：`✖ <case> (Nms)` + 紧随其后的错误行
    for (let i = 0; i < lines.length; i++) {
      const x = lines[i].trim().match(/^[×✕✖✗✘]\s+(.+)$/);
      if (!x) continue;
      const name = x[1].trim().replace(/\s*\([\d.]+ms\)$/, '');
      if (failures.some(f => f.name === name)) continue;
      let message = '';
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const l = lines[j].trim();
        if (!l) continue;
        if (/Error|Expected|assert/i.test(l)) { message = l.slice(0, 300); break; }
        if (l.startsWith('at ')) break;
      }
      failures.push({ name, message });
    }
  } else {
    // 退化：通用关键字统计（npm-test 等无专用解析器的场景）
    const fm = t.match(/(\d+)\s+failed/);
    const pm = t.match(/(\d+)\s+passed/);
    if (fm || pm) {
      if (fm) summary.failed = Number(fm[1]);
      if (pm) summary.passed = Number(pm[1]);
      summary.total = summary.passed + summary.failed;
      parsed = true;
    }
  }

  if (!parsed) return { summary: emptySummary(), failures, parsed: false };
  if (!summary.total) summary.total = summary.passed + summary.failed + summary.skipped;
  if (!summary.failed && failures.length) summary.failed = failures.length;
  return { summary, failures, parsed: true };
}

export function runTests({
  cwd = process.cwd(), framework = 'auto', target = '', lastFailed = false,
  timeoutMs = DEFAULT_TIMEOUT_MS, command = '', env = process.env,
} = {}) {
  const startedAt = Date.now();
  const base = {
    ok: false, framework: String(framework || 'auto'), command: null, exitCode: null,
    timedOut: false, aborted: false, durationMs: 0, summary: emptySummary(), failures: [],
    outputTail: '', error: null, note: null, parsed: false,
  };

  const custom = typeof command === 'string' ? command.trim() : '';
  let fw = String(framework || 'auto');
  if (fw === 'auto') {
    if (custom) fw = 'custom';
    else {
      const d = detectFramework(cwd);
      fw = d.framework || '';
      base.detectEvidence = d.evidence;
      if (!fw) {
        return { ...base, framework: 'unknown', error: '无法自动探测测试框架：' + d.evidence + '。请用 --framework 指定，或用 --command 自定义命令。' };
      }
    }
  } else if (framework !== 'custom' && !FRAMEWORKS.includes(fw)) {
    return { ...base, framework: fw, error: '未知框架：' + fw + '，可选：' + FRAMEWORKS.join(' / ') };
  }

  if (!isSafeTarget(target)) {
    return { ...base, framework: fw, error: 'target 含不安全字符（只允许路径/glob/:: 用例名），已拒绝：' + String(target).slice(0, 120) };
  }

  const cmd = buildCommand(fw, { target, lastFailed, custom });
  if (!cmd) return { ...base, framework: fw, error: '无法为框架 ' + fw + ' 构造命令' };

  let result;
  try {
    // 关键：子进程不能继承 NODE_TEST_CONTEXT——node --test 在该变量存在时会切到
    // "child 模式"（把结果回传给父 runner 并立刻退 0），导致"测试里再跑测试"假绿。
    const childEnv = { ...env };
    delete childEnv.NODE_TEST_CONTEXT;
    result = spawnSync(cmd, {
      cwd: resolve(cwd),
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      shell: true,
      env: childEnv,
      windowsHide: true,
    });
  } catch (err) {
    return { ...base, framework: fw, command: cmd, error: '执行失败：' + (err && err.message ? err.message : String(err)) };
  }

  if (result.error && result.error.code === 'ETIMEDOUT') {
    return { ...base, framework: fw, command: cmd, timedOut: true, durationMs: Date.now() - startedAt, error: '超时（' + timeoutMs + 'ms）已终止' };
  }
  if (result.error) {
    return { ...base, framework: fw, command: cmd, durationMs: Date.now() - startedAt, error: '执行失败：' + result.error.message };
  }

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const raw = stdout + (stderr ? '\n[stderr]\n' + stderr : '');
  const parsed = parseOutput(fw, raw);
  let note = null;
  if (lastFailed && (fw === 'node' || fw === 'npm-test')) {
    note = 'last_failed 不被 ' + fw + ' 支持，已忽略并运行全部测试';
  }
  if (custom && fw === 'custom') {
    note = (note ? note + '；' : '') + '自定义命令，框架自动解析已跳过（按通用关键字统计）';
  }

  return {
    ...base,
    ok: result.status === 0 && !result.timedOut && !result.aborted,
    framework: fw,
    command: cmd,
    exitCode: result.status,
    timedOut: !!result.timedOut,
    aborted: !!result.aborted,
    durationMs: Date.now() - startedAt,
    summary: parsed.summary,
    failures: parsed.failures,
    parsed: parsed.parsed,
    outputTail: raw.slice(-3000),
    note,
  };
}

export function formatText(result, { maxFailures = 8, tailChars = 800 } = {}) {
  const lines = [];
  const head = ['framework=' + result.framework, 'exit=' + String(result.exitCode)];
  if (result.timedOut) head.push('TIMED_OUT');
  if (typeof result.durationMs === 'number') head.push((result.durationMs / 1000).toFixed(1) + 's');
  lines.push('test_run ' + head.join(' '));
  if (result.command) lines.push('command: ' + result.command);
  if (result.error) lines.push('ERROR: ' + result.error);
  if (result.note) lines.push('note: ' + result.note);
  const s = result.summary || emptySummary();
  lines.push('SUMMARY: ' + s.total + ' tests -> ' + s.passed + ' passed, ' + s.failed + ' failed, ' + s.skipped + ' skipped');
  if (!result.parsed && !result.error) lines.push('note: 未解析到框架摘要（已退化：只看 exitCode + 输出尾部）');
  const failures = result.failures || [];
  for (let i = 0; i < Math.min(failures.length, maxFailures); i++) {
    lines.push((i + 1) + ') ' + failures[i].name);
    if (failures[i].message) lines.push('   ' + String(failures[i].message).split('\n')[0].slice(0, 200));
  }
  if (failures.length > maxFailures) lines.push('... 及另外 ' + (failures.length - maxFailures) + ' 个失败');
  if (result.outputTail) lines.push('--- output tail ---\n' + String(result.outputTail).slice(-tailChars));
  return lines.join('\n');
}

export default { detectFramework, buildCommand, parseOutput, runTests, formatText, isSafeTarget, FRAMEWORKS, DEFAULT_TIMEOUT_MS };
