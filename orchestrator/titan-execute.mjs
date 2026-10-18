// titan-execute.mjs —— v2 薄执行器（读 delta+decision，执行 ACCEPT，verify 前置，同文件串行）
// 用法: node titan-execute.mjs <dispatchId> [--executor opencode|cline|kilo|harness]
// 约束: <200 行、不碰 orchestrate.mjs、verify 前置、同文件串行、edit→verify→PASS 才 commit

import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { extractAlreadyResolvedProof, proofLineMatches } from './lib/already-resolved-proof.mjs';
import { checkFileSanity } from './lib/file-sanity.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// P-27 修复（R3-002，kilo 席发现）：执行器修复轮曾在 ESM 里写 require('./config')/
// require('dotenv')——require 在 ESM 未定义，被 try/catch 静默吞掉，config/.env 加载
// 成死代码。改为 fs 直读（config.json → .env 逐行 → 默认，与 orchestrate 四级回退对齐）。
const TITAN_ROOT = (() => {
  if (process.env.D_TITAN_ROOT) return process.env.D_TITAN_ROOT;
  try {
    const cfgPath = join(__dirname, 'config.json');
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      if (cfg.TITAN_ROOT) return cfg.TITAN_ROOT;
    }
  } catch (_) {}
  try {
    const envPath = join(__dirname, '.env');
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const m = line.trim().match(/^D_TITAN_ROOT\s*=\s*(.+)$/);
        if (m) return m[1].trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch (_) {}
  return resolve(__dirname, '..');
})();

const argv = process.argv.slice(2);
const dispatchId = argv[0];
const executorName = argv.includes('--executor') ? argv[argv.indexOf('--executor') + 1] : 'opencode';
const skipBaseline = argv.includes('--skip-baseline');
// --file <path>：强制所有 ACCEPT DELTA 指向该文件（scan 单文件模式专用——
// 模型回报的 delta.file 实测有 unknown/code.js 幻觉，会导致假 PASS 与根目录污染）
const forceFile = argv.includes('--file')
  ? (argv[argv.indexOf('--file') + 1] || '').replace(/\\/g, '/')
  : '';
// T-49 R2 --files <a,b,c>：多文件白名单模式（不强制覆盖，但 delta.file 必须落在
// 清单内——含 basename 唯一匹配归一；越界/幻觉路径直接 FAIL，不派执行器）
const allowFiles = argv.includes('--files')
  ? (argv[argv.indexOf('--files') + 1] || '').split(',').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean)
  : null;
// R3 预留接口层（T-61 C-11 注册，计划 §4 R3）：任务类型槽——默认 'fix'（现有实装路径不变）；
// implement|scaffold 为 V8/P12 实施链预留，命中即报"未实现"退 0（与 R1 stub 同口径，便于探活）。
// language 槽（js|py）：拆分期仅解析存槽，不消费——"透传到 verify 选择"属拆后 P11 实装。
const taskTypeArg = argv.includes('--task-type') ? argv[argv.indexOf('--task-type') + 1] : null;
const taskType = (taskTypeArg && !taskTypeArg.startsWith('--')) ? taskTypeArg : 'fix';
const languageArg = argv.includes('--language') ? argv[argv.indexOf('--language') + 1] : null;
const language = (languageArg && !languageArg.startsWith('--')) ? languageArg : 'js';

if (argv.includes('--help') || argv.includes('-h')) {
  console.log([
    '用法: node titan-execute.mjs <dispatchId> [选项]',
    '',
    '薄执行器：读 reviews/<dispatchId>/layer-b/delta.md 与 architect-decision.md，',
    '对 ACCEPT 的 DELTA 派执行器修复，verify 前置通过才 commit（edit→verify→PASS）。',
    '',
    '选项:',
    '  --executor <name>   执行器 opencode|cline|kilo|harness（默认 opencode）',
    '  --file <path>       强制所有 ACCEPT DELTA 指向该文件（scan 单文件模式防幻觉路径）',
    '  --files <a,b,c>     多文件白名单模式（delta.file 必须落在清单内）',
    '  --skip-baseline     跳过范围基线检查（慎用）',
    '  --task-type <fix|implement|scaffold>  R3 预留槽：implement/scaffold 未实现退 0（默认 fix）',
    '  --language <js|py>  R3 预留槽：语言字段仅解析存槽（verify 选择接入属 P11；默认 js）',
    '  --help, -h          显示本帮助'
  ].join('\n'));
  process.exit(0);
}

// R3 预留：implement|scaffold 任务类型未实现（P11/P12 实装前堵在入口，探活友好退出 0）
if (taskType === 'implement' || taskType === 'scaffold') {
  console.log('[R3] taskType=' + taskType + ' 已注册但未实现（R3 预留槽，见计划 §8 P11/P12；当前实装仅 fix）。');
  process.exit(0);
}

if (!dispatchId) {
  console.error('用法: node titan-execute.mjs <dispatchId> [--executor opencode|cline|kilo|harness] [--file <path>] [--skip-baseline] [--help]');
  process.exit(2);
}

// 读配置
const profilesPath = join(TITAN_ROOT, 'config', 'executor-profiles.json');
if (!existsSync(profilesPath)) {
  console.error('[MISSING] config/executor-profiles.json 不存在');
  process.exit(2);
}
const profiles = JSON.parse(readFileSync(profilesPath, 'utf8'));
const profile = profiles[executorName];
if (!profile) {
  console.error('[BAD_EXECUTOR] 未知执行器: ' + executorName + '，可选: ' + Object.keys(profiles).join(', '));
  process.exit(2);
}

// Kilo VS Code 扩展会静默自动更新（实测 7.8.3→7.8.8，2026-10-08），版本化目录名使硬编码路径失效：
// cmd[0] 指向 kilocode.kilo-code-*\bin\kilo.exe 且不存在时，扫描扩展目录按语义版本取最新可用档。
if (profile.cmd && profile.cmd[0] && /kilocode\.kilo-code-/.test(profile.cmd[0]) && !existsSync(profile.cmd[0])) {
  const m = profile.cmd[0].match(/^(.*)kilocode\.kilo-code-[^\\/]+[\\/]bin[\\/]kilo\.exe$/);
  if (m) {
    try {
      let best = null, bestV = [-1, -1, -1];
      for (const d of readdirSync(m[1])) {
        const vm = d.match(/^kilocode\.kilo-code-(\d+)\.(\d+)\.(\d+)/);
        if (!vm) continue;
        const exe = join(m[1], d, 'bin', 'kilo.exe');
        if (!existsSync(exe)) continue;
        const v = [+vm[1], +vm[2], +vm[3]];
        if (v[0] > bestV[0] || (v[0] === bestV[0] && v[1] > bestV[1]) || (v[0] === bestV[0] && v[1] === bestV[1] && v[2] > bestV[2])) {
          bestV = v; best = exe;
        }
      }
      if (best) {
        console.log('[RESOLVE] kilo 路径失效，按最新版本重定向: ' + best);
        profile.cmd[0] = best;
      }
    } catch { /* 目录不可读则保持原路径，由 spawn 报错 */ }
  }
}

// 读 delta.md + architect-decision.md
const layerB = join(TITAN_ROOT, 'reviews', dispatchId, 'layer-b');
const deltaPath = join(layerB, 'delta.md');
const decisionPath = join(layerB, 'architect-decision.md');
if (!existsSync(deltaPath) || !existsSync(decisionPath)) {
  console.error('[MISSING] delta.md 或 architect-decision.md 不存在，请先跑 --analyze/--architect');
  process.exit(2);
}

const deltaMd = readFileSync(deltaPath, 'utf8');
const decisionMd = readFileSync(decisionPath, 'utf8');

// 解析 ACCEPT 的 DELTA（兼容实时格式：### DELTA-001 + Decision: ACCEPT）
function parseAcceptDeltas(deltaText, decisionText) {
  const acceptIds = new Set();
  // architect-decision: 支持 "DELTA-001" 单独一行 + 下一行 "Decision: ACCEPT"
  const decisionLines = decisionText.split('\n');
  for (let i = 0; i < decisionLines.length; i++) {
    const m = decisionLines[i].match(/^(DELTA-\d{3})$/);
    if (m && i + 1 < decisionLines.length) {
      const next = decisionLines[i + 1].trim();
      if (/^Decision:\s*(ACCEPT|REJECT|DEFER)/i.test(next) && /ACCEPT/i.test(next)) {
        acceptIds.add(m[1]);
      }
    }
    // 兼容 "DELTA-001 | ACCEPT" 表格格式
    const m2 = decisionLines[i].match(/DELTA-(\d{3})\s*[|:]\s*(ACCEPT|REJECT|DEFER)/i);
    if (m2 && m2[2].toUpperCase() === 'ACCEPT') acceptIds.add('DELTA-' + m2[1]);
  }

  // delta.md: 支持 "### DELTA-001" 标题
  const deltaSections = deltaText.split(/^###\s*(DELTA-\d{3})\b/m);
  const deltas = [];
  for (let i = 1; i < deltaSections.length; i += 2) {
    const id = deltaSections[i];
    const content = deltaSections[i + 1] || '';
    if (acceptIds.has(id)) {
      // 尝试提取文件/发现/动作（兼容多种格式）
      const fileMatch = content.match(/\*\*文件\*\*[:\s]*`?([^`\n]+)`?/i) || content.match(/\*\*File\*\*[:\s]*`?([^`\n]+)`?/i) || content.match(/文件[:\s]*`?([^`\n]+)`?/i);
      const findingMatch = content.match(/\*\*发现\*\*[:\s]*(.+)/i) || content.match(/\*\*Finding\*\*[:\s]*(.+)/i) || content.match(/Finding[:\s]*(.+)/i);
      const actionMatch = content.match(/\*\*动作\*\*[:\s]*(.+)/i) || content.match(/\*\*Action\*\*[:\s]*(.+)/i) || content.match(/Action[:\s]*(.+)/i);
      // 兜底：从内容第一行提取
      const firstLine = content.trim().split('\n')[0];
      const fallbackFile = firstLine.match(/([a-zA-Z]:[\\\/][^\s:]+|[.\/][^\s:]+)/);
      deltas.push({
        id,
        file: fileMatch ? fileMatch[1].trim() : (fallbackFile ? fallbackFile[1] : ''),
        finding: findingMatch ? findingMatch[1].trim() : content.trim().slice(0, 200),
        action: actionMatch ? actionMatch[1].trim() : '按建议修复'
      });
    }
  }
  // --file 模式：文件字段稍后被强制覆盖，此处不因空 file 丢弃 DELTA
  return forceFile ? deltas : deltas.filter(d => d.file); // 必须有文件
}

// 按文件分组（同文件串行）
const acceptDeltas = parseAcceptDeltas(deltaMd, decisionMd);
if (forceFile) {
  for (const d of acceptDeltas) d.file = forceFile;
  console.log('[SCOPE] --file 强制单文件模式: ' + forceFile + '（' + acceptDeltas.length + ' 个 DELTA）');
} else if (allowFiles) {
  // R2 白名单归一：精确命中 → 原样；basename 唯一命中 → 归一；否则剔除（幻觉/越界路径）
  const baseMap = new Map();
  for (const af of allowFiles) {
    const b = af.split('/').pop();
    baseMap.set(b, baseMap.has(b) ? null : af);
  }
  let dropped = 0;
  for (const d of acceptDeltas) {
    const raw = String(d.file || '').replace(/\\/g, '/');
    if (allowFiles.includes(raw)) continue;
    const byBase = baseMap.get(raw.split('/').pop());
    if (byBase) { d.file = byBase; continue; }
    dropped++;
    d._drop = 'file-not-in-allowlist';
  }
  const kept = acceptDeltas.filter((d) => !d._drop);
  console.log('[SCOPE] --files 白名单模式: ' + allowFiles.length + ' 个文件，' + kept.length + '/' + acceptDeltas.length + ' 个 DELTA 通过归一' + (dropped ? '，剔除 ' + dropped + ' 个幻觉/越界路径' : ''));
  // 重排 accepted 列表为白名单通过项（分组由下方 groups 循环统一完成）
  acceptDeltas.length = 0;
  acceptDeltas.push(...kept);
  if (acceptDeltas.length === 0) {
    writeResult(dispatchId, executorName, [], 'FAIL', '', 2);
    console.error('[SCOPE] 白名单内无可执行 DELTA');
    process.exit(2);
  }
}
if (acceptDeltas.length === 0) {
  console.log('✅ 无 ACCEPT DELTA，无需执行');
  writeResult(dispatchId, executorName, [], 'PASS', '', 0);
  process.exit(0);
}

const groups = new Map();
for (const d of acceptDeltas) {
  const arr = groups.get(d.file) || [];
  arr.push(d);
  groups.set(d.file, arr);
}

// 执行器配置
const cmd = profile.cmd;
const modelFlag = profile.modelFlag;
const defaultModel = profile.defaultModel;
const extraArgs = profile.extraArgs || [];
const env = { ...process.env, ...Object.fromEntries(Object.entries(profile.env).map(([k, v]) => [k, v.replace('${FREELLMAPI_API_KEY}', process.env.FREELLMAPI_API_KEY || '').replace('${TITAN_ROOT}', TITAN_ROOT)])) };
const cwd = profile.cwd.replace('${TITAN_ROOT}', TITAN_ROOT);
const timeoutMs = profile.timeoutMs;

// P-11：超时退避链（600s→等30s→重试→降档 executor→BLOCKED 记账）。
// env TITAN_EXEC_TIMEOUT_MS / TITAN_EXEC_BACKOFF_MS 供测试用小超时模拟（不破坏生产默认）。
const TIMEOUT_OVERRIDE_MS = Number(process.env.TITAN_EXEC_TIMEOUT_MS) > 0 ? Number(process.env.TITAN_EXEC_TIMEOUT_MS) : 0;
const BACKOFF_MS = Number(process.env.TITAN_EXEC_BACKOFF_MS) > 0 ? Number(process.env.TITAN_EXEC_BACKOFF_MS) : 30000;
const DEGRADE_ORDER = ['opencode', 'cline', 'kilo', 'harness'];

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 以指定档案名执行一次（原 runExecutor 泛化：cline 走 PowerShell 包装，其余走通用 cmd 数组）
function execAs(profileName, promptText, label) {
  const p = profiles[profileName];
  if (!p || !p.cmd || !p.cmd[0]) return { exitCode: null, stdout: '', stderr: '', unavailable: true, error: 'no profile: ' + profileName };
  const t = TIMEOUT_OVERRIDE_MS || p.timeoutMs || 600000;
  const pCwd = (p.cwd || '.').replace('${TITAN_ROOT}', TITAN_ROOT);
  const pEnv = { ...process.env, ...Object.fromEntries(Object.entries(p.env || {}).map(([k, v]) => [k, v.replace('${FREELLMAPI_API_KEY}', process.env.FREELLMAPI_API_KEY || '').replace('${TITAN_ROOT}', TITAN_ROOT)])) };
  const tmpDir = join(TITAN_ROOT, 'tmp');
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  const promptFile = join(tmpDir, `titan-prompt-${label}-${profileName}-${Date.now()}.txt`);
  writeFileSync(promptFile, promptText, 'utf8');
  let child;
  if (profileName === 'cline') {
    // Cline requires pre-seeded providers.json in --data-dir (OPENAI_BASE_URL env doesn't work)
    const dataDir = p.dataDir ? p.dataDir.replace('${TITAN_ROOT}', TITAN_ROOT) : join(TITAN_ROOT, 'tmp', 'cline-data');
    const provider = p.provider || 'openai-compatible';
    const providerBaseUrl = p.providerBaseUrl || 'http://127.0.0.1:3001/v1';
    const apiKey = (p.apiKeyEnv && process.env[p.apiKeyEnv]) || process.env.FREELLMAPI_API_KEY || 'local';
    pEnv.OPENAI_API_KEY = apiKey;
    if (!existsSync(dataDir)) mkdirSync(dataDir + '/settings', { recursive: true });
    const providersJson = join(dataDir, 'settings', 'providers.json');
    writeFileSync(providersJson, JSON.stringify({
      version: 1,
      lastUsedProvider: provider,
      modes: {},
      providers: {
        [provider]: {
          settings: {
            provider,
            apiKey,
            model: p.defaultModel,
            protocol: 'openai-chat',
            client: 'openai-compatible',
            contextWindow: 1048576,
            baseUrl: providerBaseUrl,
            capabilities: ['streaming', 'tools'],
          },
          updatedAt: new Date().toISOString(),
          tokenSource: 'manual',
        },
      },
    }, null, 2), 'utf8');
    const ps = `$p = Get-Content -Raw "${promptFile}"; & '${p.cmd[0]}' $p ${p.modelFlag} "${p.defaultModel}" ${(p.extraArgs || []).join(' ')} -c "${pCwd}" --data-dir "${dataDir}" 2>&1 | Out-String`;
    child = spawnSync('powershell', ['-NoProfile', '-Command', ps], { cwd: pCwd, env: pEnv, timeout: t, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    child = spawnSync(p.cmd[0], [...p.cmd.slice(1), promptText, ...(p.modelFlag && p.defaultModel ? [p.modelFlag, p.defaultModel] : []), ...(p.extraArgs || [])], { cwd: pCwd, env: pEnv, timeout: t, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }
  return { exitCode: child.status, stdout: child.stdout || '', stderr: child.stderr || '', timedOut: !!child.error && child.error.code === 'ETIMEDOUT', error: child.error ? child.error.message : null };
}

// 超时退避链：primary 一次 + 重试一次 + 降档（opencode→cline→kilo→harness，缺失档案跳过）。
// 全部超时 → timedOutAll（BLOCKED 记账，exit 3），有非超时结果（含 exit!=0）即返回。
async function runWithTimeoutChain(promptText, label) {
  const chain = [executorName, executorName, ...DEGRADE_ORDER.filter((x) => x !== executorName)];
  const tried = [];
  for (const name of chain) {
    const r = execAs(name, promptText, label);
    tried.push({ executor: name, exitCode: r.exitCode, timedOut: !!r.timedOut, unavailable: !!r.unavailable });
    if (r.unavailable) continue;
    if (r.timedOut) {
      console.log('[TIMEOUT] ' + name + ' 超时（' + (TIMEOUT_OVERRIDE_MS || (profiles[name] && profiles[name].timeoutMs) || 600000) + 'ms）→ 退避 ' + BACKOFF_MS + 'ms 后继续');
      await sleepMs(BACKOFF_MS);
      continue;
    }
    return { ...r, tried };
  }
  return { exitCode: null, stdout: '', stderr: '', timedOutAll: true, tried };
}

// 结果收集
const results = [];
let allPass = true;

// 记录运行前的基准提交
let baseCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: TITAN_ROOT, encoding: 'utf8' }).stdout.trim();

// 运行前脏文件基线（含未跟踪）：调用方自己未提交的工作不算执行器越界。
// 历史事故：曾用全树 diff 把调用方未提交源码判为越界 → reset --hard 抹掉（M7 违规）。
function captureDirtySet() {
  const set = new Set();
  const st = spawnSync('git', ['status', '--porcelain'], { cwd: TITAN_ROOT, encoding: 'utf8' }).stdout || '';
  for (const l of st.split('\n')) {
    if (!l.trim()) continue;
    const p = l.slice(3).trim();
    for (const part of p.split(' -> ')) set.add(part.replace(/\\/g, '/'));
  }
  const others = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: TITAN_ROOT, encoding: 'utf8' }).stdout || '';
  for (const p of others.split('\n')) if (p.trim()) set.add(p.trim().replace(/\\/g, '/'));
  return set;
}
const preDirty = captureDirtySet();

// T-49 sanity 护栏（T-56 W7 提取至 lib/file-sanity.mjs 成正式 titan-sanity suite）：
// 执行器曾把 3665 行文件删成一行 "ALREADY_RESOLVED"，verify 只查 scope/范围照样 PASS——
// 毁灭性删改必须当场拦截（协议标记/体积减半/语法/导入冒烟，见 checkFileSanity）。
function checkSanity(file, pre, diffText) {
  return checkFileSanity(join(TITAN_ROOT, file), pre || null, { diffText });
}

// T-49 孤儿清理：范围违例回滚只还原目标文件，执行器新建的孤儿文件会留在盘上毒化
// 后续所有 delta 的范围检查（run2 实测：008 建 decision-api.mjs → 009-022 全灭）。
// 原则：只删"本 delta 执行器运行期间新出现"的未跟踪文件（运行前已存在的受 untrackedBefore 保护）。
function listUntracked() {
  return (spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: TITAN_ROOT, encoding: 'utf8' }).stdout || '')
    .split('\n').filter(Boolean);
}
function cleanupOrphans(untrackedBefore, tag) {
  const now = listUntracked();
  const orphans = now.filter((f) => !untrackedBefore.has(f) && !f.startsWith('reviews/') && !f.startsWith('tmp/'));
  for (const f of orphans) {
    try { unlinkSync(join(TITAN_ROOT, f)); console.log('[ORPHAN-CLEAN] 删除执行器残留孤儿文件(' + tag + '):', f); } catch (e) { console.log('[ORPHAN-CLEAN] 删除失败:', f, e.message); }
  }
}

// P-23（T-49 R2 实测）：错挂文件的 delta 失败时，旧回滚只还原 delta.file——执行器实际
// 编辑的其他文件留在脏区（008 错挂 cdp-client、实改 A-orchestrate，半截 import 手术遗留）。
// 正确回滚 = 还原本 delta 基线以来的全部已跟踪改动；preDirty（运行前已脏=他人未提交工作，
// M7 绝不碰）与 reviews/tmp（证据/日志）豁免。
function rollbackExecutorChanges(base, tag) {
  const changed = (spawnSync('git', ['diff', '--name-only', base], { cwd: TITAN_ROOT, encoding: 'utf8' }).stdout || '')
    .split('\n').filter(Boolean).map((f) => f.replace(/\\/g, '/'));
  for (const f of changed) {
    if (preDirty.has(f)) continue;
    if (f.startsWith('reviews/') || f.startsWith('tmp/')) continue;
    spawnSync('git', ['restore', '--source=' + base, '--staged', '--worktree', '--', f], { cwd: TITAN_ROOT });
    console.log('[ROLLBACK] 还原执行器改动(' + tag + '):', f);
  }
}

// 验证函数：target 必改（scoped diff）+ 范围检查（全树 diff，排除 preDirty）+ verify-baseline（可选）
async function verify(delta, fullDiff, scopedDiff, requireTargetChange = true) {
  // 0. 目标文件必须真的被改了（scoped diff 为空 = 执行器没动它 → 空验证假 PASS 风险；
  // 仅当执行器按协议显式回报 ALREADY_RESOLVED 时，调用方降级为不要求）
  if (requireTargetChange && !scopedDiff.trim()) {
    console.log('❌ 目标文件未被修改（' + delta.file + ' 的 diff 为空）');
    return false;
  }
  // 1. diff 范围检查：只改目标文件 + 允许的附属变更；运行前已脏的文件豁免
  const diffFiles = fullDiff.split('\n').filter(l => l.startsWith('diff --git')).map(l => l.split(' ')[2].slice(2).replace(/\\/g, '/'));
  const untrackedNow = (spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: TITAN_ROOT, encoding: 'utf8' }).stdout || '')
    .split('\n').filter(Boolean).map(f => f.replace(/\\/g, '/'));
  const changed = [...new Set([...diffFiles, ...untrackedNow])];
  const allowedExtra = ['node_modules/', '.vite/', 'dist/', 'build/', '.git/', 'tmp/',
    // P-24（T-49 R2-final 实测）：操作员文档区豁免——用户手动存网页席工作文件
    // （design-specs/*.txt）落盘在运行中，被未跟踪检查误判执行器越界，团灭 4 条
    // already-resolved A- 席 delta。执行器只该产出代码，docs/design-specs 类目录
    // 的运行中新文件一律不算执行器责任。
    'design-specs/', 'docs/', 'archive/'];
  const unexpected = changed.filter(f => {
    if (f === delta.file) return false;
    if (f.startsWith('reviews/')) return false;
    if (allowedExtra.some(p => f.startsWith(p))) return false;
    if (preDirty.has(f)) return false; // 运行前就已脏：调用方自己的未提交工作，不是执行器的锅
    // 允许同目录下的测试文件变更（同模块测试同步）
    if (f.startsWith('tests/') && delta.file.startsWith('src/')) return false;
    if (f.startsWith('src/') && delta.file.startsWith('tests/')) return false;
    return true;
  });
  if (unexpected.length) {
    console.log('❌ diff 范围违规，意外文件:', unexpected.join(', '));
    return false;
  }

  // 2. target_cmd（若 delta 有指定） —— 这里简化
  // 3. verify-baseline（可跳过）
  const skipBaseline = process.argv.includes('--skip-baseline');
    if (!skipBaseline) {
    const vb = spawnSync('node', ['orchestrator/verify-baseline.mjs', dispatchId], {
      cwd: TITAN_ROOT, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe']
    });
    if (vb.status !== 0) {
      console.log('❌ verify-baseline FAIL');
      console.log(vb.stdout);
      return false;
    }
  }
  return true;
}

// 主循环：按文件分组串行
for (const [file, deltas] of groups) {
  console.log('\n=== 处理文件:', file, '(', deltas.length, '个 DELTA ) ===');
  for (const delta of deltas) {
    console.log('\n---', delta.id, '---');
    console.log('文件:', delta.file);
    console.log('发现:', delta.finding);
    console.log('动作:', delta.action);

    // P-16（T-49 runs4-7 实测）：历史已有本 delta 的修复提交 → 跳过重跑。全量重跑会诱发
    // 执行器对已修项"再优化"（非确定性），部分改法炸语法被 sanity 拦下 → 每轮 verifyStatus
    // 振荡、永不收敛。git log 从 HEAD 走，命中=修复在当前历史内有效（revert 过的不命中）。
    // P-18 根治（R2 实测第二击）：delta ID 跨 dispatch 撞号——R1 的 [DELTA-xxx] 提交与 R2
    // 同号且同文件，路径过滤仍误判"已修"。修复提交必须带 dispatchId 前缀，skip 检查同缀匹配。
    // 强制重跑用 --no-skip-prior-fixed。
    if (!argv.includes('--no-skip-prior-fixed')) {
      const priorFix = spawnSync('git', ['log', '--oneline', '-1', '--grep=^\\[' + dispatchId + '\\]\\[' + delta.id + '\\]', '--', delta.file], { cwd: TITAN_ROOT, encoding: 'utf8' });
      if (priorFix.stdout && priorFix.stdout.trim()) {
        results.push({ deltaId: delta.id, file: delta.file, status: 'PASS', exitCode: 0, reason: 'fixed-in-prior-run', finding: delta.finding, action: delta.action });
        console.log('⏭', delta.id, 'PASS (fixed-in-prior-run：历史已有修复提交，防再编辑抖动)');
        continue;
      }
    }

    // P-15 修复（T-49 run3 实战）：范围基线每 delta 刷新到当前 HEAD。旧实现把基线钉在
    // 开跑时的 commit（仅 PASS 后刷新），导致"运行期间的外部提交"（并行开发/其他客户端/
    // 编排者自己的设施提交）全部落进 git diff baseCommit 的范围检查——run3 实测 023-039
    // 共 16 条 already-resolved 被误判"范围违例"团灭。每 delta 刷新后，diff 窗口只剩
    // 本 delta 执行器的改动；preDirty 仍豁免运行前已脏文件。
    baseCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: TITAN_ROOT, encoding: 'utf8' }).stdout.trim();

    // 构建 prompt（不让执行器提交，验证后由 titan-execute 统一 commit）
    const prompt = `改 ${delta.file}：${delta.finding}。建议：${delta.action}。
约束：只改这个文件；**不提交**，改完直接返回。
编辑方式硬约束（违反会被 sanity 护栏当场拦截并整单回滚）：
1) 禁止整文件重写——必须用编辑工具做最小定点替换；若需改动超过 50 行，停下并在输出中说明（拆小重派），不要强改。
2) 禁止用 PowerShell/echo/tee/重定向等 shell 命令写文件（含 Set-Content/Out-File）。
3) 禁止改变编码与行尾——保持 UTF-8 无 BOM、LF，禁止引入 CR（回车符）。
你只允许修改上面指定的这一个文件；改动任何其他文件都会被范围检查拒绝并回滚。
ALREADY_RESOLVED 判断（如适用）必须写在你 stdout 回复文本里，**绝对禁止把 ALREADY_RESOLVED 或任何协议标记写进文件**。
若该 finding 对本文件当前代码已不成立（例如同轮前序 DELTA 已修复同一问题），不要做无意义改动，
改为在输出中单独包含一行：ALREADY_RESOLVED
提交信息将由系统生成：[${delta.id}] fix: ${delta.finding.slice(0, 60)}`;

    // 执行器调用（runExecutor 内部落 promptFile 留档审计）
    // T-49：捕获执行前基线（行数，供 sanity 体积护栏）与本 delta 运行前未跟踪集（供孤儿清理）
    let preState = null;
    try { preState = { lines: readFileSync(join(TITAN_ROOT, delta.file), 'utf8').split('\n').length }; } catch {}
    const untrackedBefore = new Set(listUntracked());
    const exec = await runWithTimeoutChain(prompt, delta.id);
    let { exitCode, stdout } = exec;
    const stderr = exec.stderr;

    if (exec.timedOutAll) {
      console.log('❌ 执行器超时链耗尽（重试+降档后仍超时）→ BLOCKED 记账');
      console.log('  tried:', JSON.stringify(exec.tried));
      cleanupOrphans(untrackedBefore, 'timeout-chain');
      results.push({ deltaId: delta.id, file: delta.file, status: 'BLOCKED', exitCode: null, reason: 'executor-timeout-chain', tried: exec.tried });
      continue;
    }

    if (exitCode !== 0) {
      console.log('❌ 执行器退出码:', exitCode);
      console.log('stdout:', stdout.slice(0, 500));
      console.log('stderr:', stderr.slice(0, 500));
      cleanupOrphans(untrackedBefore, 'executor-exit');
      results.push({ deltaId: delta.id, file: delta.file, status: 'FAIL', exitCode });
      allPass = false;
      continue;
    }

    // 获取 git diff（对比本 DELTA 的基准提交）：全树用于范围检查，scoped 用于"目标必须被改"
    let full;
    let scoped;
    
    // 主路径：初始化值（后续仅在retry分支中重新赋值）
    {
      const fullTemp = spawnSync('git', ['diff', baseCommit], { cwd: TITAN_ROOT, encoding: 'utf8' }).stdout;
      const scopedTemp = spawnSync('git', ['diff', baseCommit, '--', delta.file], { cwd: TITAN_ROOT, encoding: 'utf8' }).stdout;
      full = fullTemp;
      scoped = scopedTemp;
    }

    // 协议漏报补救（实测 opencode 会用自然语言代替标记行）：空 diff 且无标记 →
    // 提醒执行器二选一（输出标记行 或 真正改文件），重试后重取 diff 再判。
    if (!scoped.trim() && !/\bALREADY_RESOLVED\b/.test(stdout)) {
      console.log('[RETRY] ' + delta.id + ' 空 diff 且未回报 ALREADY_RESOLVED，协议提醒重试一次');
      const retryPrompt = `读取并检查文件 ${delta.file}。finding：${delta.finding}。
只能二选一：
1) 该 finding 对当前代码已不成立（含被同轮前序 DELTA 修复）→ 在你 stdout 回复文本里输出单独一行：ALREADY_RESOLVED（禁止写进文件），不要改文件；并且**必须**另起一行输出强证明（否则视为未证明，判 FAIL）：
PROOF: ${delta.file}:<行号>: <该行原文片段（逐字，>=8 字符）>
2) 仍成立 → 直接修改该文件（只改它、不提交，改完直接返回；禁止改动其他任何文件）。编辑方式硬约束：最小定点替换、禁用 shell 写文件、保持 UTF-8 无 BOM/LF。`;
      const retry = await runWithTimeoutChain(retryPrompt, delta.id + '-retry');
      if (retry.timedOutAll) {
        results.push({ deltaId: delta.id, file: delta.file, status: 'BLOCKED', exitCode: null, reason: 'retry-timeout-chain', tried: retry.tried });
        continue;
      }
       if (retry.exitCode === 0) {
         stdout = retry.stdout;
         // 重试分支：使用 let 声明临时变量
         let retryFull = spawnSync('git', ['diff', baseCommit], { cwd: TITAN_ROOT, encoding: 'utf8' }).stdout;
         let retryScoped = spawnSync('git', ['diff', baseCommit, '--', delta.file], { cwd: TITAN_ROOT, encoding: 'utf8' }).stdout;
         // 赋值回外部作用域的 full/scoped
         full = retryFull;
         scoped = retryScoped;
       } else {
         console.log('  协议提醒重试失败（exit=' + retry.exitCode + '），按原输出继续判定');
       }
    }

    // 空 diff 双分支：执行器按协议显式回报 ALREADY_RESOLVED → 必须附 PROOF 强证明
// （P-12：file 一致 + 行号存在 + 该行原文逐字命中，缺一视为需修）；通过则免改 PASS
// （不提交、base 不动、stdout 尾部留档供 M4 审计）。
// T-59 试点补丁（RETRY 缺口）：首答 PROOF 无效时先发一次协议提醒重试——codestral 对小修
// 裸报 ALREADY_RESOLVED 3/3 FAIL 实录（重试把判断压力还给执行器）；重试后仍无有效证明才拒判 FAIL。
    if (!scoped.trim() && /\bALREADY_RESOLVED\b/.test(stdout)) {
      let arProof = extractAlreadyResolvedProof(stdout);
      let proofOk = proofLineMatches(join(TITAN_ROOT, delta.file), delta.file, arProof.proof);
      if (!proofOk) {
        console.log('[RETRY] ' + delta.id + ' ALREADY_RESOLVED 但 PROOF 无效，协议提醒重试一次');
        const proofRetryPrompt = `读取并检查文件 ${delta.file}。你上一条回复主张 ALREADY_RESOLVED，但缺失或无效的强证明已被系统拒绝（判定规则：PROOF 行必须逐字引用该文件现存的真实行，file 一致 + 行号存在 + 原文片段 >=8 字符逐字命中）。
只能二选一：
1) 主张仍成立 → 在你 stdout 回复文本里输出单独一行：ALREADY_RESOLVED，并另起一行输出：PROOF: ${delta.file}:<行号>: <该行原文片段（逐字，>=8 字符）>（禁止写进文件，禁止改动文件）
2) 不再主张 → 直接修改该文件（只改它、不提交，改完直接返回；禁止改动其他任何文件）。编辑方式硬约束：最小定点替换、禁用 shell 写文件、保持 UTF-8 无 BOM/LF。`;
        const proofRetry = await runWithTimeoutChain(proofRetryPrompt, delta.id + '-proof-retry');
        if (proofRetry.timedOutAll) {
          results.push({ deltaId: delta.id, file: delta.file, status: 'BLOCKED', exitCode: null, reason: 'proof-retry-timeout-chain', tried: proofRetry.tried });
          continue;
        }
        if (proofRetry.exitCode === 0) {
          stdout = proofRetry.stdout;
          full = spawnSync('git', ['diff', baseCommit], { cwd: TITAN_ROOT, encoding: 'utf8' }).stdout;
          scoped = spawnSync('git', ['diff', baseCommit, '--', delta.file], { cwd: TITAN_ROOT, encoding: 'utf8' }).stdout;
          arProof = extractAlreadyResolvedProof(stdout);
          proofOk = !scoped.trim() && proofLineMatches(join(TITAN_ROOT, delta.file), delta.file, arProof.proof);
        } else {
          console.log('  协议提醒重试失败（exit=' + proofRetry.exitCode + '），按原输出继续判定');
        }
      }
      // 重试后仍为"空 diff + ALREADY_RESOLVED"：按 P-12 强证明终判
      if (!scoped.trim() && /\bALREADY_RESOLVED\b/.test(stdout)) {
        if (!proofOk) {
          rollbackExecutorChanges(baseCommit, 'already-resolved-no-proof');
          cleanupOrphans(untrackedBefore, 'already-resolved-no-proof');
          results.push({ deltaId: delta.id, file: delta.file, status: 'FAIL', exitCode: 0, reason: 'ALREADY_RESOLVED 无有效 PROOF（P-12 强证明：file:line:原文逐字校验不通过，视为需修）', proof: arProof.proof });
          console.log('❌', delta.id, 'ALREADY_RESOLVED 但 PROOF 无效:', JSON.stringify(arProof.proof));
          allPass = false;
          continue;
        }
        const okR = await verify(delta, full, scoped, false);
        if (!okR) {
          rollbackExecutorChanges(baseCommit, 'already-resolved-scope');
          cleanupOrphans(untrackedBefore, 'already-resolved-scope');
          results.push({ deltaId: delta.id, file: delta.file, status: 'FAIL', exitCode: 0, reason: 'verify failed (already-resolved but scope violated)' });
          allPass = false;
          continue;
        }
        results.push({ deltaId: delta.id, file: delta.file, status: 'PASS', exitCode: 0, reason: 'ALREADY_RESOLVED (PROOF verified)', proof: arProof.proof, finding: delta.finding, action: delta.action });
        console.log('⏭', delta.id, 'PASS (ALREADY_RESOLVED + PROOF verified @' + arProof.proof.file + ':' + arProof.proof.line + ')');
        console.log('  执行器判词:', stdout.slice(-300).replace(/\s+/g, ' '));
        continue;
      }
      // 重试后变为真修改或无标记 → 落入下方常规 verify 通道
    }

    // 验证
    const ok = await verify(delta, full, scoped);
    if (!ok) {
      console.log('  执行器输出尾部:', stdout.slice(-300).replace(/\s+/g, ' '));
      // P-23：全量回滚本 delta 执行器改动（错挂文件时旧逻辑只还原 delta.file，实改文件
      // 留脏区）；preDirty=他人未提交工作，M7 绝不碰。
      rollbackExecutorChanges(baseCommit, 'verify-fail');
      cleanupOrphans(untrackedBefore, 'verify-fail');
      results.push({ deltaId: delta.id, file: delta.file, status: 'FAIL', exitCode: 0, reason: 'verify failed' });
      allPass = false;
      continue;
    }

    // T-49 sanity 护栏：verify 只管"改没改+范围"，不管"改成了什么"。毁灭性删改
    // （文件被删成壳/被写成协议标记/语法炸）必须在此拦截回滚，不许进提交。
    const sanity = checkSanity(delta.file, preState, scoped);
    if (sanity.problems.length) {
      console.log('❌ sanity 护栏拦截:', sanity.problems.join(' ; '));
      rollbackExecutorChanges(baseCommit, 'sanity');
      cleanupOrphans(untrackedBefore, 'sanity');
      results.push({ deltaId: delta.id, file: delta.file, status: 'FAIL', exitCode: 0, reason: 'sanity: ' + sanity.problems.join(' ; ') });
      allPass = false;
      continue;
    }

    // 验证通过，提交这次改动（add/commit 状态必须检查——静默失败会产生"PASS 但没提交"的假证据）
    // P-18：提交消息带 dispatchId 前缀，skip 检查同缀匹配，跨 dispatch 撞号免疫。
    const commitMsg = `[${dispatchId}][${delta.id}] fix: ${delta.finding.slice(0, 60)}`;
    const addR = spawnSync('git', ['add', delta.file], { cwd: TITAN_ROOT, encoding: 'utf8' });
    if (addR.status !== 0) {
      console.log('❌ git add 失败:', (addR.stderr || '').trim());
      results.push({ deltaId: delta.id, file: delta.file, status: 'FAIL', exitCode: addR.status, reason: 'git-add-failed' });
      allPass = false;
      continue;
    }
    const commitR = spawnSync('git', ['commit', '-m', commitMsg], { cwd: TITAN_ROOT, encoding: 'utf8' });
    if (commitR.status !== 0) {
      console.log('❌ git commit 失败:', (commitR.stderr || commitR.stdout || '').trim().slice(0, 300));
      results.push({ deltaId: delta.id, file: delta.file, status: 'FAIL', exitCode: commitR.status, reason: 'git-commit-failed' });
      allPass = false;
      continue;
    }

    // 更新基准提交为最新提交
    const newBase = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: TITAN_ROOT, encoding: 'utf8' }).stdout.trim();
    baseCommit = newBase;

    // 验证通过，结果已提交
    results.push({ deltaId: delta.id, file: delta.file, status: 'PASS', exitCode: 0 });
    console.log('✅', delta.id, 'PASS');
  }
}

// 写结果
const blockedCount = results.filter(r => r.status === 'BLOCKED').length;
const finalVerdict = allPass ? (blockedCount > 0 ? 'BLOCKED' : 'PASS') : 'FAIL';
const finalExit = allPass ? (blockedCount > 0 ? 3 : 0) : 1;
writeResult(dispatchId, executorName, results, finalVerdict, '', 0);
if (blockedCount > 0) console.log('⛔ BLOCKED 记账: ' + blockedCount + ' 条（超时链耗尽/降档失败，非回归失败，交人核）');
process.exit(finalExit);

// 写 execute-result.json
function writeResult(dispatchId, executor, deltas, verifyStatus, gitDiff, exitCode) {
  const result = {
    dispatchId,
    deltas: deltas.map(d => ({ deltaId: d.deltaId || d.id, file: d.file, finding: d.finding, action: d.action, status: d.status, reason: d.reason })),
    executor,
    verifyStatus,
    gitDiff: '',
    exitCode,
    timestamp: new Date().toISOString()
  };
  const outPath = join(TITAN_ROOT, 'reviews', dispatchId, 'layer-b', 'execute-result.json');
  writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
  console.log('📝 结果已写入:', outPath);
}