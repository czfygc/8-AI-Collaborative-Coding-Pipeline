// orchestrator/lib/verify-profiles.mjs — T-164 verify 命令注册槽（读侧）
//
// 定位：把「某个语言/仓该用什么 verify 命令」从代码里搬到配置文件（拆分计划 §4 R4）：
//   orchestrator/config/verify-profiles.json = 事实源；本模块只读它、解析它、执行它。
//
// 三条硬约束（对应计划与台账红线）：
//   1. UNKNOWN 传播：profile 或 capability 缺失 → 显式 UNKNOWN，**不静默当通过**；
//      UNKNOWN ≠ FAIL（由调用方决定是否阻断）——这是 P1_A 仓 sealed-baseline 的同源语义。
//   2. 不污染被检仓：python 档用 ast.parse（不写 __pycache__）、pytest 禁 cacheprovider；
//      否则执行器的「diff 范围检查」会把这些新文件判成越界。
//   3. 纯配置不执行：config 里的命令由本模块在受控调用点执行（spawn 无 shell，避免元字符注入）。
//
// 用法：
//   import { resolveProfile, getCapability, runCapability, detectLanguage } from './verify-profiles.mjs';

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const DEFAULT_CONFIG = join(REPO_ROOT, 'orchestrator', 'config', 'verify-profiles.json');

export const VERIFY_STATUS = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', UNKNOWN: 'UNKNOWN' });

let cached = null;

export function loadProfiles(configPath = DEFAULT_CONFIG) {
  if (cached && cached.path === configPath) return cached.data;
  if (!existsSync(configPath)) {
    throw new Error('verify-profiles 配置不存在: ' + configPath);
  }
  const data = JSON.parse(readFileSync(configPath, 'utf8'));
  cached = { path: configPath, data };
  return data;
}

export function clearCache() {
  cached = null;
}

// 语言 → profile key（配置里 languages 表）；未知语言 → null（调用方转 UNKNOWN）
export function resolveProfile(language, configPath = DEFAULT_CONFIG) {
  const cfg = loadProfiles(configPath);
  const key = cfg.languages && cfg.languages[String(language || '').toLowerCase()];
  if (!key) return null;
  if (!cfg.profiles || !cfg.profiles[key]) return null;
  return key;
}

// 由文件扩展名猜语言（js|mjs|cjs|jsx|tsx → js；py → py；其余 → null）
export function detectLanguage(filePath) {
  const p = String(filePath || '').toLowerCase().replace(/\\/g, '/');
  if (p.endsWith('.py') || p.endsWith('.pyi')) return 'py';
  if (/\.(mjs|cjs|js|jsx|ts|tsx)$/.test(p)) return 'js';
  return null;
}

// 取某 profile 某 capability 的命令；缺失 → UNKNOWN 描述（不抛错）
export function getCapability(profileKey, capability, configPath = DEFAULT_CONFIG) {
  const cfg = loadProfiles(configPath);
  if (!profileKey) {
    return { status: VERIFY_STATUS.UNKNOWN, reason: '未指定 profile（语言未识别或无映射）', command: null };
  }
  const profile = cfg.profiles && cfg.profiles[profileKey];
  if (!profile) {
    return { status: VERIFY_STATUS.UNKNOWN, reason: 'profile 不存在: ' + profileKey, command: null };
  }
  const cap = profile[capability];
  if (!cap || !Array.isArray(cap.command) || !cap.command.length) {
    return {
      status: VERIFY_STATUS.UNKNOWN,
      reason: 'profile ' + profileKey + ' 无 ' + capability + ' 能力（显式 UNKNOWN，不静默当通过）',
      command: null,
    };
  }
  return { status: 'OK', reason: '', command: cap.command.slice(), kind: cap.kind || '' };
}

// 执行某 capability。file 非空时替换命令里的 {file} 占位符。
export function runCapability({
  language, file = '', capability = 'syntax', cwd = REPO_ROOT,
  timeoutMs = 120000, configPath = DEFAULT_CONFIG, env = process.env,
} = {}) {
  const profileKey = resolveProfile(language, configPath);
  const cap = getCapability(profileKey, capability, configPath);
  if (cap.status === VERIFY_STATUS.UNKNOWN) {
    return {
      status: VERIFY_STATUS.UNKNOWN, profile: profileKey, capability, reason: cap.reason,
      command: null, exitCode: null, output: '', durationMs: 0,
    };
  }
  const cmd = cap.command.map((part) => String(part).replace('{file}', file));
  const cfg = loadProfiles(configPath);
  const extraEnv = (cfg.env && cfg.env[profileKey]) || {};
  const startedAt = Date.now();
  const r = spawnSync(cmd[0], cmd.slice(1), {
    cwd: resolve(cwd),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    shell: false, // 不走 shell：配置里的命令按 argv 逐个执行，天然免元字符注入
    env: { ...env, ...extraEnv },
    windowsHide: true,
  });
  const output = ((r.stdout || '') + (r.stderr || '')).trim();
  if (r.error) {
    return {
      status: VERIFY_STATUS.UNKNOWN, profile: profileKey, capability, reason: '执行失败: ' + r.error.message,
      command: cmd, exitCode: null, output, durationMs: Date.now() - startedAt,
    };
  }
  return {
    status: r.status === 0 ? VERIFY_STATUS.PASS : VERIFY_STATUS.FAIL,
    profile: profileKey,
    capability,
    reason: '',
    command: cmd,
    exitCode: r.status,
    output: output.slice(-2000),
    durationMs: Date.now() - startedAt,
  };
}

export default { loadProfiles, clearCache, resolveProfile, detectLanguage, getCapability, runCapability, VERIFY_STATUS, DEFAULT_CONFIG };
