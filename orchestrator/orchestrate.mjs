#!/usr/bin/env node
// D:\TITAN_ARCHAEOLOGY\orchestrator\orchestrate.mjs
// TITAN Multi-Review Dispatch — Orchestrator (STEP A + B + upload)
//
// 接口：
//   node orchestrate.mjs --ensure-tabs                              仅检测环境
//   node orchestrate.mjs --probe                                    探测 enabled reviewer tab
//   node orchestrate.mjs --screenshot                               enabled reviewer tab 截图
//   node orchestrate.mjs --run "prompt"                             单 prompt 分发（inline）
//   node orchestrate.mjs --run-file <path>                          长 prompt 从文件读（inline）
//   node orchestrate.mjs --review <artifact-path>                   分发 + Layer A 落盘
//     [--round <N>] [--parent <dispatchId>] [--trigger <string>] [--force]
//     [--upload]    走文件上传通道（适用于代码/大文件），prompt 只写短指令
//   node orchestrate.mjs --analyze <dispatchId>                     STEP B：八桶分类写 layer-b
//   node orchestrate.mjs --architect <dispatchId>                  注入 delta.md 到 ChatGPT，写 architect-decision.md
//   node orchestrate.mjs --architect-local <dispatchId>            本地测试: 不依赖 CDP，直接从 delta.md 生成占位裁决
//   node orchestrate.mjs --decision-api [--decision-port <N>]       P0: 无状态 MCP 裁决面（仅 submit_verdict 写工具）
//   node orchestrate.mjs --design|--plan|--implement|--deliver|--pipeline   预留模式（R1，P9 注册）：未实现，打印提示退出 0
//
// --decision-api（T-07 P0，记忆【4方会诊续2】）：
//   裁决面换 MCP 的第一步。只监听 127.0.0.1，公网入口 = cloudflared quick tunnel +
//   freellmapi-src/mcp-proxy.cjs（Bearer 由代理注入，本进程不持有密钥）；无状态
//   （不发 Mcp-Session-Id，每请求独立处理）；仅挂 submit_verdict 一个写工具，
//   delta_sha256 服务端现算，verdict 血缘 source 强制 chatgpt-mcp。默认端口 3003。
//
// Reviewer 从同目录 reviewers.yaml 的 reviewers 段读取（enabled:true 生效）。
// --upload 仅与 --review 组合有效。不加 --upload 时行为与之前完全一致。
// --analyze / --architect / --architect-local 作为 bare flag 与 --review 组合时为连运标记，
// 可一条命令跑完 分发 + Layer A + Layer B + 架构师裁决。
//
// 依赖：Node.js 22+（全局 WebSocket + fetch）

import { writeFileSync, mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { join, resolve as resolvePath, dirname, basename, normalize as normalizePath, relative as relativePath, isAbsolute as isAbsolutePath, sep as pathSep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as yaml from 'js-yaml';

// P-19 修复：__dirname 必须在首个使用点（loadEnvFile）之前初始化——执行器修复轮曾把它
// 挪到 260 行，43/73/180 行先于定义使用 → 模块加载即 TDZ ReferenceError。
const __dirname = dirname(fileURLToPath(import.meta.url));




// 自检模式实现
function runSelfCheck() {
  const errors = [];
  
  // 验证两种模式
  for (const mode of ['role', 'scan']) {
    let reviewers;
    try {
      reviewers = loadReviewersArray(mode);
      errors.push('[SELFCHECK] PASS [' + mode + ']: reviewers.yaml 可解析');
    } catch (e) {
      errors.push('[SELFCHECK] FAIL [' + mode + ']: reviewers.yaml 解析失败: ' + e.message);
      continue;
    }
    
    const enabled = reviewers.filter(r => {
      const v = r.enabled;
      return v === true || v === 'true' || v === 1 || v === '1';
    });
    if (enabled.length >= 2) {
      errors.push('[SELFCHECK] PASS [' + mode + ']: enabled reviewer 数 = ' + enabled.length + ' (≥2)');
    } else {
      errors.push('[SELFCHECK] FAIL [' + mode + ']: enabled reviewer 数 = ' + enabled.length + ' (<2)');
    }
    
    for (const r of enabled) {
      const missing = [];
      if (mode === 'scan') {
        if (!r.provider) missing.push('provider');
        if (!r.model_id) missing.push('model_id');
        if (!r.scan_focus) missing.push('scan_focus');
      } else {
        if (!r.url_match) missing.push('url_match');
        if (!r.perspective) missing.push('perspective');
        if (!r.prefix) missing.push('prefix');
      }
      if (missing.length === 0) {
        errors.push('[SELFCHECK] PASS [' + mode + ']: ' + r.name + ' 字段完整');
      } else {
        errors.push('[SELFCHECK] FAIL [' + mode + ']: ' + r.name + ' 缺少字段: ' + missing.join(', '));
      }
    }
  }
  
  // thresholds 段存在且含 single_reviewer_to_delta 键
  let thresholdsObj;
  try {
    const raw = readFileSync(REVIEWERS_YAML, 'utf8').replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
    const doc = yaml.load(raw);
    thresholdsObj = doc.thresholds;
  } catch (e) {
    errors.push('[SELFCHECK] FAIL: 读取 thresholds 段失败: ' + e.message);
    thresholdsObj = null;
  }
  if (thresholdsObj && thresholdsObj.single_reviewer_to_delta !== undefined) {
    errors.push('[SELFCHECK] PASS: thresholds 段存在且含 single_reviewer_to_delta');
  } else {
    errors.push('[SELFCHECK] FAIL: thresholds 段缺失或 missing single_reviewer_to_delta 键');
  }
  
  // 目录存在
  const reviewsDir = join(TITAN_ROOT, 'reviews');
  const auditEvidenceDir = join(TITAN_ROOT, 'orchestrator', 'audit-evidence');
  if (existsSync(reviewsDir)) {
    errors.push('[SELFCHECK] PASS: 目录存在: reviews/');
  } else {
    errors.push('[SELFCHECK] FAIL: 目录不存在: reviews/');
  }
  if (existsSync(auditEvidenceDir)) {
    errors.push('[SELFCHECK] PASS: 目录存在: orchestrator/audit-evidence/');
  } else {
    errors.push('[SELFCHECK] FAIL: 目录不存在: orchestrator/audit-evidence/');
  }
  
  // 输出所有结果
  for (const e of errors) {
    console.log(e);
  }
  
  // 判定：只要有一个 FAIL 则 exit 1
  const hasFail = errors.some(e => e.includes('[SELFCHECK] FAIL'));
  if (hasFail) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

// ---------- CLI 解析 ----------
const args = process.argv.slice(2);
const ensureTabsFlag = args.includes('--ensure-tabs');
const forceFlag = args.includes('--force');
const uploadFlag = args.includes('--upload');

function getFlagValue(flag) {
  const i = args.indexOf(flag);
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  const eq = args.find(a => a.startsWith(flag + '='));
  if (eq) return eq.slice(flag.length + 1);
  return null;
}

function getIntFlag(flag, def) {
  const v = getFlagValue(flag);
  if (v === null) return def;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1) {
    console.error('ERROR: ' + flag + ' 需要正整数');
    process.exit(1);
  }
  return n;
}

// ---------- MODES 分发表（R1 预留接口层，T-61 P9 注册；拆分期只登记不实现） ----------
// 注册点：CLI 解析出的 mode → 分发描述（kind=active 现有实装 / kind=stub 为 P11/P12 生命周期
// 模式占位）。注册纪律：任何新模式必须先入表——下方"模式未注册守卫"强制；stub 命中即打印
// 未实现提示并退出 0（与 R3 taskType 的未实现退出 0 口径一致，便于 OpenClaw 探活）。
// 注：OpenClaw intent 解码器的惰性 import 形态属拆后 P10/P12 实装；拆分期维持顶部静态 import，
// 避免模式间加载时序差异（P-19 __dirname TDZ 教训）。
const PIPELINE_STUB_MODES = ['design', 'plan', 'implement', 'deliver', 'pipeline'];
const MODES = {
  help: { kind: 'active', dispatch: '入口内联 help 块' },
  probe: { kind: 'active', dispatch: 'main() probe 分支' },
  screenshot: { kind: 'active', dispatch: 'main() screenshot 分支' },
  run: { kind: 'active', dispatch: 'main() run 分支' },
  review: { kind: 'active', dispatch: 'main() review 主链' },
  analyze: { kind: 'active', dispatch: 'main() 早退分支' },
  architect: { kind: 'active', dispatch: 'main() 早退分支' },
  'architect-local': { kind: 'active', dispatch: 'main() 早退分支' },
  selfcheck: { kind: 'active', dispatch: 'main() 早退分支（runSelfCheck）' },
  'decision-api': { kind: 'active', dispatch: 'main() 早退分支' },
  'ensure-tabs': { kind: 'active', dispatch: 'main() 前置（可与任意模式组合）' },
  scan: { kind: 'active', dispatch: '顶层 if → lib/scan-entry.mjs runScanEntry' },
  design: { kind: 'stub', dispatch: '未实现：退出 0（P12 pipeline stage-01 预留）' },
  plan: { kind: 'stub', dispatch: '未实现：退出 0（P12 pipeline stage-02 预留）' },
  implement: { kind: 'stub', dispatch: '未实现：退出 0（P12 pipeline stage-03 预留）' },
  deliver: { kind: 'stub', dispatch: '未实现：退出 0（P12 pipeline stage-04 预留）' },
  pipeline: { kind: 'stub', dispatch: '未实现：退出 0（P12 串链预留）' },
};

// Step 0: Determine review mode from --mode flag (if present)
let reviewMode = 'role'; // default
// Check for --mode value
const modeIndex = args.indexOf('--mode');
if (modeIndex !== -1) {
  if (args[modeIndex + 1]) {
    const m = args[modeIndex + 1];
    if (['role', 'scan'].includes(m)) {
      reviewMode = m;
    } else {
      console.error('ERROR: --mode 必须为 role 或 scan');
      process.exit(1);
    }
  } else {
    console.error('ERROR: --mode 需要一个值');
    process.exit(1);
  }
}
// Check for --mode=value format
const modeEqArg = args.find(a => a.startsWith('--mode='));
if (modeEqArg) {
  const m = modeEqArg.slice('--mode='.length);
  if (['role', 'scan'].includes(m)) {
    reviewMode = m;
  } else {
    console.error('ERROR: --mode 必须为 role 或 scan');
    process.exit(1);
  }
}

// Initialize REVIEWERS with the determined reviewMode
// 时序占位（T-61 P9/R1）：本调用必须在任何 getReviewers() 消费者之前于模块加载期执行，
// 禁止后移（P-19 __dirname TDZ 同源教训；analyze/scan 等消费面依赖此初始化）。
setReviewers(loadEnabledReviewers(reviewMode));

let mode = 'help';
let prompt = null;
let reviewPath = null;
let analyzeId = null;
let architectId = null;
let scanFile = null;

// 连运标记：bare flag 形式（--review <path> --analyze）时由 --review 主流程结束后依次触发。
// mode 选择链中 --review 优先，故 bare flag 不会抢夺独立模式（--analyze <id> 单独跑时 mode='analyze' 提前 return）。
const chainAnalyze = args.includes('--analyze');
const chainArchitect = args.includes('--architect');
const chainArchitectLocal = args.includes('--architect-local');

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  mode = 'help';
} else if (args.includes('--probe')) {
  mode = 'probe';
} else if (args.includes('--screenshot')) {
  mode = 'screenshot';
} else if (args.includes('--review')) {
   mode = 'review';
   reviewPath = getFlagValue('--review');
   if (!reviewPath) { console.error('ERROR: --review 需要报告文件路径'); process.exit(1); }
   const reviewPathAbs = normalizePath(resolvePath(reviewPath));
   const titanRootNormalized = normalizePath(TITAN_ROOT);
   // DELTA-012: 用 path.relative 做跨平台越界判定，替代大小写/分隔符敏感的字符串前缀比较。
   // Windows 下 relative 内部按不区分大小写比较且跨盘符会返回绝对路径，故绝对路径同样拒绝。
   const reviewPathRel = relativePath(titanRootNormalized, reviewPathAbs);
   if (reviewPathRel === '' || reviewPathRel === '..' || reviewPathRel.startsWith('..' + pathSep) || isAbsolutePath(reviewPathRel)) {
        console.error('ERROR: --review 路径必须在 TITAN_ARCHAEOLOGY 工作区内');
        process.exit(1);
   }
} else if (args.includes('--analyze')) {
  mode = 'analyze';
  analyzeId = getFlagValue('--analyze');
  if (!analyzeId) { console.error('ERROR: --analyze 需要 dispatchId'); process.exit(1); }
} else if (args.includes('--architect')) {
  mode = 'architect';
  architectId = getFlagValue('--architect');
  if (!architectId) { console.error('ERROR: --architect 需要 dispatchId'); process.exit(1); }
} else if (args.includes('--architect-local')) {
  // 本地测试模式：不依赖 CDP，直接从 delta.md 生成占位裁决
  mode = 'architect-local';
  architectId = getFlagValue('--architect-local');
  if (!architectId) { console.error('ERROR: --architect-local 需要 dispatchId'); process.exit(1); }
} else if (args.includes('--self-check')) {
   mode = 'selfcheck';
} else if (args.includes('--decision-api')) {
   // T-07 P0: 无状态 MCP 裁决面（仅 submit_verdict 写工具），与 CDP 全链路无关
   mode = 'decision-api';
} else if (PIPELINE_STUB_MODES.some(m => args.includes('--' + m))) {
   // R1（T-61 P9）：design/plan/implement/deliver/pipeline 五 key 注册同一 stub（只注册不实现）
   mode = PIPELINE_STUB_MODES.find(m => args.includes('--' + m));
} else if (args.includes('--scan')) {
   // Step 4: 8 方并行扫描入口（实现于 scan-flow.mjs；网页/harness 席位见 T-40）
   mode = 'scan';
   scanFile = getFlagValue('--scan');
   if (!scanFile) { console.error('ERROR: --scan 需要文件路径'); process.exit(1); }
   const scanFileAbs = normalizePath(resolvePath(scanFile));
   const titanRootNormalized = normalizePath(TITAN_ROOT);
   if (!scanFileAbs.startsWith(titanRootNormalized + pathSep)) {
        console.error('ERROR: --scan 路径必须在 TITAN_ARCHAEOLOGY 工作区内');
        process.exit(1);
   }
} else if (args.some(a => a === '--mode' || a.startsWith('--mode='))) {
  // Step 4: 模式切换 —— role (角色化) | scan (代码扫描)
  const m = getFlagValue('--mode');
  if (!m || !['role', 'scan'].includes(m)) {
    console.error('ERROR: --mode 必须为 role 或 scan');
    process.exit(1);
  }
  // DELTA-008：--mode 单独出现不构成任何可执行模式（此前静默落入 help 打印帮助后退出）
  console.error('ERROR: --mode 需要与具体模式组合使用（如 --scan <file> / --review <path>），单独 --mode ' + m + ' 不会进入任何模式');
  process.exit(1);
} else if (args.includes('--run-file')) {
  mode = 'run';
  const fp = getFlagValue('--run-file');
  if (!fp) { console.error('ERROR: --run-file 需要文件路径'); process.exit(1); }
  const abs = resolvePath(fp);
  if (!existsSync(abs)) { console.error('ERROR: 文件不存在: ' + abs); process.exit(1); }
  prompt = readFileSync(abs, 'utf8');
} else if (args.includes('--run')) {
  mode = 'run';
  prompt = getFlagValue('--run');
  if (!prompt) { console.error('ERROR: --run 需要 prompt 参数'); process.exit(1); }
} else if (ensureTabsFlag) {
  mode = 'ensure-tabs';
}

// --upload 仅与 --review 组合有效
if (uploadFlag && mode !== 'review') {
  console.error('ERROR: --upload 仅与 --review 组合有效');
  process.exit(1);
}

const reviewRound = getIntFlag('--round', 1);
const parentDispatchId = getFlagValue('--parent') || null;
const trigger = getFlagValue('--trigger') || 'MANUAL';
// R5 预留接口层（T-61 C-11 注册，计划 §4 R5）：产物血缘可选字段——全流程链式追溯 +
// V8 多项目分桶的服务槽。拆分期只登记不实现：不校验枚举、不参与任何路由行为，
// 缺省 null；写入 dispatch-meta.json 后由读取端按"未知字段容错忽略"处理（analyze 等
// 只取自有字段）；枚举收紧（design|plan|scan|fix|implement|deliver）属 P11/P12 实装。
const lineageStage = getFlagValue('--stage') || null;
const lineageProject = getFlagValue('--project') || null;
// T-07 P0: decision-api 监听端口。3001=FreeLLMAPI 网关、3002=mcp-proxy，3003 起避开
const decisionPort = getIntFlag('--decision-port', 3003);

if (mode === 'help') {
console.log('TITAN Multi-Review Dispatch — Orchestrator');
  console.log('');
  console.log('用法:');
  console.log('  node orchestrate.mjs --ensure-tabs                     仅检测环境');
  console.log('  node orchestrate.mjs --probe                           探测 enabled reviewer tab');
  console.log('  node orchestrate.mjs --screenshot                      enabled reviewer tab 截图');
  console.log('  node orchestrate.mjs --run "prompt"                    单 prompt 分发');
  console.log('  node orchestrate.mjs --run-file <path>                 长 prompt 从文件读');
  console.log('  node orchestrate.mjs --review <artifact-path>          分发 + Layer A 落盘');
  console.log('    [--round <N>] [--parent <dispatchId>] [--trigger  ] [--force]');
  console.log('    [--upload]                                            走文件上传通道');
  console.log('    [--mode role|scan]                                   模式切换：role=角色化(默认), scan=代码扫描');
  console.log('  node orchestrate.mjs --analyze <dispatchId>            STEP B：八桶分类写 layer-b');
  console.log('  node orchestrate.mjs --architect <dispatchId>           注入 delta.md 到 ChatGPT，写 architect-decision.md');
  console.log('  node orchestrate.mjs --architect-local <dispatchId>     本地测试：不依赖 CDP，生成占位裁决');
  console.log('  node orchestrate.mjs --decision-api [--decision-port N] P0：无状态 MCP 裁决面（仅 submit_verdict，监听 127.0.0.1，默认 3003）');
  console.log('  node orchestrate.mjs --design|--plan|--implement|--deliver|--pipeline  预留模式（R1，未实现：打印提示并退出 0）');
  console.log('  node orchestrate.mjs --scan <file> [--max-issues N] [--auto-fix] [--executor <name>] [--skip-baseline]  Step 4：8 方并行扫描（本地3席+harness+网页4席CDP），delta 写 reviews/scan-<id>/layer-b，--auto-fix 接 titan-execute 执行链（T-40）');
  console.log('');
  console.log('Reviewers (来自 reviewers.yaml enabled:true):');
  for (const r of getReviewers()) {
    console.log('  - ' + r.name + ' [' + r.perspective + '] upload=' + r.upload_strategy);
  }
  console.log('');
  console.log('组合:');
  console.log('  --ensure-tabs 可与任意模式组合');
  console.log('  --force 跳过 artifactSha256 防重复分发检查');
  console.log('  --upload 仅与 --review 组合，走文件上传通道（大文件/代码）');
  console.log('  --mode role|scan 模式切换：role=角色化(默认), scan=代码扫描');
  console.log('  --review <path> --analyze --architect                  连运：分发 + Layer A + Layer B + 架构师裁决一条命令完成');
  console.log('  --review <path> --analyze --architect-local            同上，但裁决走本地占位（免 CDP 自检闭环）');
  console.log('');
  console.log('环境:');
  console.log('  CDP: http://' + CDP_HOST);
  console.log('  若不可达，请运行 ' + START_BAT);
  console.log('  review 输出: ' + join(TITAN_ROOT, 'reviews', '<dispatchId>'));
  process.exit(0);
}

// ---------- MODES 守卫与 stub 分发（T-61 P9/R1：只注册不实现） ----------
if (!MODES[mode]) {
  console.error('ERROR: 模式未注册于 MODES 分发表（R1）：' + mode);
  process.exit(1);
}
if (MODES[mode].kind === 'stub') {
  if (ensureTabsFlag) console.log('[WARN] --ensure-tabs 与预留模式 ' + mode + ' 组合无效（该模式未实现，不依赖 CDP），已忽略');
  console.log('[MODES] 模式 ' + mode + ' 已注册但未实现（R1 预留，见设计规范 P11/P12：V8/外仓支持 + 全流程自动化）。');
  process.exit(0);
}

// ---------- R7 预留接口层（T-61 C-11 注册，计划 §4 R7）：目标仓库解析位 ----------
// 供 V8/P1_A 类外部仓扫描/实施参数化。拆分期纪律="只登记不实现"：本块仅解析+校验+登记，
// repoOverride 无任何消费者——TITAN_ROOT 仍是唯一工作根，全部执行路径不变；"多仓 root 校验、
// scan 全仓接"（含文件级越界拒绝）属拆后 P11 在消费点实装。越界判据同 --review/--scan
// （path.relative + isAbsolutePath，DELTA-012 口径）：此处仅用于登记日志的工作区内/外分类。
const repoOverride = (() => {
  const raw = getFlagValue('--repo');
  if (raw === null) return null;
  if (!isAbsolutePath(raw)) {
    console.error('ERROR: --repo 需要绝对路径（<abs>）');
    process.exit(1);
  }
  const abs = normalizePath(resolvePath(raw));
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    console.error('ERROR: --repo 必须指向已存在的目录: ' + abs);
    process.exit(1);
  }
  const relToTitan = relativePath(normalizePath(TITAN_ROOT), abs);
  const scope = (relToTitan === '' || (!isAbsolutePath(relToTitan) && relToTitan !== '..' && !relToTitan.startsWith('..' + pathSep)))
    ? '工作区内'
    : '工作区外（外部仓，P11 目标场景）';
  console.log('[R7] --repo 解析位已登记（拆分期只登记不实现）：' + abs + '（' + scope + '）');
  return abs;
})();

// ---------- Step 4: --scan 8 方并行扫描（实现于 scan-flow.mjs）----------
// T-40：scan 处理块下移至文件末尾 main().catch 之前（需复用 CDP/runTab/navigateToFreshChat
// 等全部函数声明 + REVIEWERS 顶层初始化），旧位置（此处）仅留指针，勿在此恢复。
// T-61 P8 更新：块体已搬移至 lib/scan-entry.mjs（runScanEntry，async 包装），此处仍仅留指针。

// ---------- CDP 客户端 ----------
// T-49 R2 手术（002/008，执行器两轮假声明 ALREADY_RESOLVED 后人工接管）：删除与
// cdp-client.mjs 逐字节相同的内联 class CDP，改为 import——孪生重复实现正是 P-03
// （镜像文件同步教训）的代码级根源：一处修 bug 另一处不知道。
import { CDP_HOST, TITAN_ROOT, OUT_ROOT_PROBE, MAX_REPORT_CHARS, AUTO_UPLOAD_CHARS, MAX_UPLOAD_BYTES, START_BAT, REVIEWERS_YAML } from './lib/constants.mjs';
import { buildSourceHeader, buildReviewPrompt, buildUploadPrompt } from './lib/prompts.mjs';
import { loadReviewersArray, loadEnabledReviewers, setReviewers, getReviewers } from './lib/reviewers.mjs';
import { registerDailyDispatch, generateDispatchId, appendDispatchHistory, historyHasSha } from './lib/history-locks.mjs';
import { buildCanonicalIssues, buildAggregatedFeedback, writeLayerBSkeletons, runAnalyze } from './lib/analyze-core.mjs';
import { runDecisionApi } from './lib/decision-api.mjs';
import { ensureTabs, probeTab, screenshotTab } from './lib/session-nav.mjs';
import { runTab, runTabUpload } from './lib/session-send.mjs';
import { runArchitect, runArchitectLocal } from './lib/architect.mjs';
import { CDP } from './cdp-client.mjs';
import { setDispatchMarkers, withDispatchSuffix } from './lib/markers.mjs';
import { readRawResponse } from './lib/verdict-parse.mjs';
import { runScanEntry } from './lib/scan-entry.mjs';



// ---------- SHA256 ----------
function sha256OfText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').toUpperCase();
}
async function sha256OfFile(path) {
  return await sha256OfBinaryFile(path);
}
async function sha256OfBinaryFile(path) {
  const data = await fsPromises.readFile(path);
  return createHash('sha256').update(data).digest('hex').toUpperCase();
}




// ---------- 读取 raw md 的响应段（T-56 W8 迁 lib/verdict-parse.mjs，调用点必须 await——
// M-14 根因即 async 后一处调用点漏 await；analyze 路径已补，见 runAnalyze 内 rawByReviewer 构建） ----------

// ---------- 主流程 ----------
async function main() {
  // DELTA-020（T-59 批2c）：--ensure-tabs 前移到所有早退分支之前，组合不再静默失效。
  // CDP-free 模式（P3-12 selfcheck / T-07 decision-api / 本地 analyze）按设计不依赖
  // 浏览器：组合时明确提示忽略；architect/architect-local/review/scan 真跑环境检测。
  if (ensureTabsFlag) {
    if (mode === 'selfcheck' || mode === 'decision-api' || mode === 'analyze') {
      console.log('[WARN] --ensure-tabs 与 ' + mode + ' 组合无效（该模式不依赖 CDP），已忽略');
    } else {
      const ok = await ensureTabs();
      if (!ok) {
        console.error('[FATAL] ensure-tabs failed: CDP 不可达或 reviewer tab 缺失');
        console.error('请双击运行 ' + START_BAT + ' 启动 CDP Chrome，确认 enabled reviewer 网站已打开并登录后重试。');
        process.exit(1);
      }
      if (mode === 'ensure-tabs') {
        console.log('[DONE] ensure-tabs only');
        return;
      }
    }
  }
  if (mode === 'selfcheck') {
    // P3-12: 自动化自检不依赖 CDP/浏览器 —— 在一切连接前短路（否则会挂进 CDP 连接）
    runSelfCheck(); // 内部按结果 process.exit(0/1)
    return;
  }
  if (mode === 'decision-api') {
    // T-07 P0: 裁决面 MCP 服务常驻，不走 CDP 闸门（无 reviewer tab 依赖）
    await runDecisionApi(decisionPort);
    return;
  }
  if (mode === 'analyze') {
    await runAnalyze(analyzeId);
    return;
  }
  if (mode === 'architect') {
    await runArchitect(architectId);
    return;
  }
  if (mode === 'architect-local') {
    await runArchitectLocal(architectId);
    return;
  }

  let version;
  try {
    version = await fetch('http://' + CDP_HOST + '/json/version').then(r => r.json());
  } catch (e) {
    console.error('[FATAL] CDP 9222 不可达: ' + e.message);
    console.error('请双击运行 ' + START_BAT + ' 启动 CDP Chrome，确认 enabled reviewer 网站已打开并登录后重试。');
    process.exit(1);
  }
  const list = await fetch('http://' + CDP_HOST + '/json/list').then(r => r.json());
  const browserWS = version.webSocketDebuggerUrl;
  console.log('[CDP] browser: ' + version.Browser);
  console.log('[CDP] ws: ' + browserWS);

  const pages = {};
  const missing = [];
  for (const rv of getReviewers()) {
    const p = list.find(x => x.type === 'page' && rv.url_match && rv.url_match.test(x.url));
    if (p) pages[rv.name] = p;
    else missing.push(rv.name);
  }
  if (missing.length > 0) {
    console.error('[ERROR] 缺少 enabled reviewer tab: ' + missing.join(', '));
    for (const p of list.filter(x => x.type === 'page')) console.error('  ' + p.id + '  ' + p.url);
    process.exit(1);
  }
  for (const rv of getReviewers()) console.log('[MATCH] ' + rv.name + ' = ' + pages[rv.name].id);

  // R-01: dispatchId 必须在 try/finally 之外声明（函数作用域），
  // 否则连运钩子（在 finally 之后执行的 --analyze/--architect）读不到它。
  let dispatchId = null;
  const cdp = new CDP(browserWS);
  try {
    await cdp.connect();
    console.log('[WS] connected');

  if (mode === 'probe') {
    const out = {};
    for (const rv of getReviewers()) {
      try {
        const pr = await probeTab(cdp, pages[rv.name], rv);
        out[rv.name] = { sessionId: pr.sessionId, snapshot: pr.snapshot };
        console.log('[PROBE] ' + rv.name + ': title="' + pr.snapshot.title + '" bodyLen=' + pr.snapshot.bodyLen + ' generating=' + pr.snapshot.generating);
      } catch (e) {
        out[rv.name] = { error: e.message };
        console.error('[PROBE] ' + rv.name + ' FAILED: ' + e.message);
      }
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const outDir = join(OUT_ROOT_PROBE, ts);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'probe.json'), JSON.stringify(out, null, 2), 'utf8');
    console.log('[OUT] ' + join(outDir, 'probe.json'));
    return;
  }

  if (mode === 'screenshot') {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const outDir = join(OUT_ROOT_PROBE, ts);
    mkdirSync(outDir, { recursive: true });
    for (const rv of getReviewers()) {
      try {
        const attach = await cdp.send('Target.attachToTarget', { targetId: pages[rv.name].id, flatten: true });
        const sessionId = attach.sessionId;
        await cdp.send('Page.enable', {}, sessionId);
        const shot = await screenshotTab(cdp, sessionId, join(outDir, rv.name + '.png'));
        console.log('[SHOT] ' + rv.name + ': ' + shot.bytes + ' bytes');
      } catch (e) {
        console.error('[SHOT] ' + rv.name + ' FAILED: ' + e.message);
      }
    }
    console.log('[OUT] ' + outDir);
    return;
  }

  if (mode === 'run') {
    // P2-18: --run/--review 统一哈希（均用文本 binary hash）；记录模式字段；ABORTED/FAILED 统一 dedup 不拦截重跑
    const promptSha256 = sha256OfText(prompt);
    console.log('[RUN] promptSha256=' + promptSha256);
    if (!forceFlag && historyHasSha(promptSha256)) {
      console.warn('[DEDUP] --run prompt SHA256 已分发过，跳过。如需强制请加 --force');
      process.exit(1);
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const outDir = join(OUT_ROOT_PROBE, ts);
    const rawDir = join(outDir, 'raw');
    const shotDir = join(outDir, 'screenshots');
    mkdirSync(rawDir, { recursive: true });
    mkdirSync(shotDir, { recursive: true });
    dispatchId = generateDispatchId();
    setDispatchMarkers(dispatchId);
    const dts = new Date().toISOString();
    const promptForAll = buildSourceHeader('通用', dispatchId, dts, 'inline') + prompt;
    writeFileSync(join(outDir, 'prompt.txt'), promptForAll, 'utf8');
    console.log('[RUN] dispatchId=' + dispatchId);
    console.log('[RUN] prompt: ' + prompt.slice(0, 80) + (prompt.length > 80 ? '...' : ''));
    // Check daily dispatch before writing history
    { const reg = await registerDailyDispatch('cdp'); if (!reg.ok) { console.error('[DAILY_CAP] ' + reg.reason + ' → 停批回合同'); process.exit(2); } console.log('[LIMITS] dispatch cdp ' + reg.used + '/' + reg.cap + ' (' + reg.day + ')'); }
    const histLine = appendDispatchHistory(promptSha256, dispatchId, dts, reviewRound, trigger, 'run', null);
    console.log('[HISTORY] ' + histLine);
    const results = await withDispatchSuffix(dispatchId, async () => Promise.allSettled(getReviewers().map(rv => runTab(cdp, pages[rv.name], rv, promptForAll, rawDir, shotDir))));
    for (let i = 0; i < getReviewers().length; i++) {
      const rv = getReviewers()[i], r = results[i];
      // T-122 步骤1.4：席位日志带角色标签，咨询席(chatgpt consultant)与架构师席出场可区分
      const roleTag = rv.role ? '(' + rv.role + ')' : '';
      if (r.status === 'fulfilled') {
        console.log('  ' + rv.name + roleTag + ': OK  textLen=' + (r.value.snapshot?.lastTextLen || 0) + '  phases=' + r.value.phase.join(' -> '));
      } else {
        console.log('  ' + rv.name + roleTag + ': FAILED  ' + (r.reason?.message || r.reason));
      }
    }
    console.log('[OUT] ' + outDir);
    return;
  }

  // P3-01: 移除死代码（mode === 'run' 已在 L1841 处理并返回，下方重复块不会执行）
  // if (mode === 'run') { ... }

  // ---------- review: 输入校验（P1-09）先于 CDP 连接 ----------
  // 原先这段在 CDP connect 之后，CDP 不可达时永远跑不到字符上限 guard；
  // 输入校验不依赖浏览器，前移后可在无 CDP 环境直接验证。
  const isReviewDelivery = mode === 'review';
  let abs = null, artifactFileName = null, artifactSizeBytes = 0;
  let report = '';
  let artifactSha256 = '';
  let artifactSizeChars = null;
  let delivery = null;

  // P3-07: --review 目标 stat 校验（存在性 + 普通文件 + 大小一次读完）
  if (reviewMode) {
    abs = resolvePath(reviewPath);
    if (!existsSync(abs)) { console.error('ERROR: 报告不存在: ' + abs); process.exit(1); }
     const st = await fsPromises.stat(abs);
    if (!st.isFile()) { console.error('ERROR: 报告必须是普通文件: ' + abs); process.exit(1); }

    artifactFileName = basename(abs);
    artifactSizeBytes = st.size;

    if (artifactSizeBytes > MAX_UPLOAD_BYTES) {
      console.error('ERROR: 文件 ' + artifactSizeBytes + ' 字节，超过 ' + MAX_UPLOAD_BYTES + ' 上限。');
      process.exit(1);
    }
    // SHA256 统一用 binary hash（inline/upload 一致），避免同文件两 hash 破坏 dedup
     artifactSha256 = await sha256OfBinaryFile(abs);

    // R-02: 大文件自动切 upload。字符数先于 delivery 计算（upload 分支也要记录该数值），
    // 超过 AUTO_UPLOAD_CHARS 且未显式 --upload 时走 upload 通道，与 reviewers.yaml 声明对齐。
     const buf = await fsPromises.readFile(abs, 'utf8');
     artifactSizeChars = buf.length;

    // T-89：bundle manifest（*.manifest.json + kind=titan-bundle）——上传 prompt 给
    // reviewer 展开真实文件名清单（manifest 本身不会作为芯片出现），并强制 upload 通道。
    let isBundleArtifact = false;
    if (/\.manifest\.json$/i.test(artifactFileName)) {
      try {
        const bm = JSON.parse(buf);
        if (bm && bm.kind === 'titan-bundle' && Array.isArray(bm.files) && bm.files.length) {
          isBundleArtifact = true;
          artifactFileName = bm.files.map(f => basename(typeof f === 'string' ? f : f.path)).join('、');
        }
      } catch (e) { /* 非 bundle JSON，按单文件处理 */ }
    }

    if (uploadFlag || isBundleArtifact) {
      delivery = 'upload';
    } else if (artifactSizeChars > AUTO_UPLOAD_CHARS) {
      delivery = 'upload';
      console.log('[AUTO-UPLOAD] artifact ' + artifactSizeChars + ' 字符超过 ' + AUTO_UPLOAD_CHARS + '，自动切换 upload 通道');
      // upload 通道要求每个 enabled reviewer 都配 file_input_selector，缺一个都无法投递
      const noUpload = getReviewers().filter(rv => !rv.file_input_selector).map(rv => rv.name);
      if (noUpload.length > 0) {
        console.error('[FATAL] 自动 upload 切换失败：以下 reviewer 未配置上传通道（file_input_selector）: ' + noUpload.join(', '));
        console.error('请在 reviewers.yaml 补 file_input_selector，或缩小 artifact 后再分发。');
        process.exit(1);
      }
    } else {
      delivery = 'inline';
    }

    // P1-09: 按 per-reviewer 实际 delivery 检查字符上限，避免因 upload_strategy: null
    // 强制 inline 绕过 MAX_REPORT_CHARS 保护。任一 reviewer 实际走 inline 通道
    // （upload_strategy === null 或 delivery === 'inline'）时加载全文并检查。
    const anyInline = getReviewers().some(rv => rv.upload_strategy === null || delivery === 'inline');
    if (anyInline) {
       if (!report) report = await fsPromises.readFile(abs, 'utf8');
      // 对实际走 inline 的 reviewer 检查字符上限
      const inlineReviewers = getReviewers().filter(rv => rv.upload_strategy === null || delivery === 'inline');
      if (inlineReviewers.length > 0 && report.length > MAX_REPORT_CHARS) {
        console.error('ERROR: 报告 ' + report.length + ' 字符，超过 ' + MAX_REPORT_CHARS + ' 上限。');
        console.error('若为大文件，请显式加 --upload 走文件上传通道，或缩小 artifact 后再分发。');
        process.exit(1);
      }
    }
  }

  if (mode === 'probe') {
    const out = {};
    for (const rv of getReviewers()) {
      try {
        const pr = await probeTab(cdp, pages[rv.name], rv);
        out[rv.name] = { sessionId: pr.sessionId, snapshot: pr.snapshot };
        console.log('[PROBE] ' + rv.name + ': title="' + pr.snapshot.title + '" bodyLen=' + pr.snapshot.bodyLen + ' generating=' + pr.snapshot.generating);
      } catch (e) {
        out[rv.name] = { error: e.message };
        console.error('[PROBE] ' + rv.name + ' FAILED: ' + e.message);
      }
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const outDir = join(OUT_ROOT_PROBE, ts);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'probe.json'), JSON.stringify(out, null, 2), 'utf8');
    console.log('[OUT] ' + join(outDir, 'probe.json'));
    return;
  }

  if (mode === 'screenshot') {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const outDir = join(OUT_ROOT_PROBE, ts);
    mkdirSync(outDir, { recursive: true });
    for (const rv of getReviewers()) {
      try {
        const attach = await cdp.send('Target.attachToTarget', { targetId: pages[rv.name].id, flatten: true });
        const sessionId = attach.sessionId;
        await cdp.send('Page.enable', {}, sessionId);
        const shot = await screenshotTab(cdp, sessionId, join(outDir, rv.name + '.png'));
        console.log('[SHOT] ' + rv.name + ': ' + shot.bytes + ' bytes');
      } catch (e) {
        console.error('[SHOT] ' + rv.name + ' FAILED: ' + e.message);
      }
    }
    console.log('[OUT] ' + outDir);
    return;
  }

  // P3-01: 死代码块（mode === 'run' 已在 L1841 处理并返回，此处不会执行）
  // if (mode === 'run') { ... }

  console.log('[REVIEW] artifact: ' + abs + ' (' + artifactSizeBytes + ' bytes)');
  console.log('[REVIEW] delivery=' + delivery + ' file=' + artifactFileName);
  console.log('[SHA256] artifact=' + artifactSha256);

  if (!forceFlag && historyHasSha(artifactSha256)) {
    console.warn('[DEDUP] 该 artifactSha256 已分发过，跳过。如需强制请加 --force');
    process.exit(1);
  }

  // 赋值给函数作用域的 dispatchId（R-01：声明已在 try 外）
  dispatchId = generateDispatchId();
  setDispatchMarkers(dispatchId);
  const dispatchTimestamp = new Date().toISOString();
  const outDir = join(TITAN_ROOT, 'reviews', dispatchId);
  const layerADir = join(outDir, 'layer-a');
  const rawDir = join(layerADir, 'raw');
  const shotDir = join(layerADir, 'screenshots');
  const layerBDir = join(outDir, 'layer-b');
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(shotDir, { recursive: true });
  mkdirSync(layerBDir, { recursive: true });

  console.log('[REVIEW] dispatchId=' + dispatchId);
  console.log('[REVIEW] round=' + reviewRound + ' parent=' + parentDispatchId + ' trigger=' + trigger);
  console.log('[REVIEW] reviewers=' + getReviewers().map(r => r.name).join(','));
  console.log('[REVIEW] outDir=' + outDir);
  { const reg = await registerDailyDispatch('cdp'); if (!reg.ok) { console.error('[DAILY_CAP] ' + reg.reason + ' → 停批回合同'); process.exit(2); } console.log('[LIMITS] dispatch cdp ' + reg.used + '/' + reg.cap + ' (' + reg.day + ')'); }

  const dispatchMeta = {
    dispatchId,
    parentDispatchId,
    reviewRound,
    trigger,
    // R5 预留（T-61 C-11 注册）：可选血缘字段，缺省 null（P11/P12 注入值；读取端容错忽略）
    stage: lineageStage,
    project: lineageProject,
    delivery,
    deliveryTrigger: delivery === 'upload' ? (uploadFlag ? 'flag' : 'auto-size') : 'inline-small',
    artifactPath: abs,
    artifactFileName,
    artifactSha256,
    artifactSizeBytes,
    artifactSizeChars,
    timestamp: dispatchTimestamp,
    reviewerCount: getReviewers().length,
    reviewers: getReviewers().map(rv => ({
      name: rv.name,
      display_name: rv.display_name,
      perspective: rv.perspective,
      upload_strategy: rv.upload_strategy,
      editor_selector: rv.editor_selector,
      file_input_selector: rv.file_input_selector,
      upload_button_selector: rv.upload_button_selector,
      upload_menu_item_text: rv.upload_menu_item_text,
      rawPath: 'layer-a/raw/' + rv.name + '.md',
      rawSha256: null,
    })),
  };

  // 分发：按 per-reviewer delivery 走 inline 或 upload 路径
  // （upload_strategy === null 的 reviewer 强制 inline 全文注入；其余跟随 --upload）
  const results = await withDispatchSuffix(dispatchId, async () => Promise.allSettled(getReviewers().map(rv => {
    const rvDelivery = rv.upload_strategy === null ? 'inline' : delivery;
    if (rvDelivery === 'upload') {
      const promptForThis = buildUploadPrompt(rv, dispatchId, dispatchTimestamp, artifactFileName);
      return runTabUpload(cdp, pages[rv.name], rv, abs, promptForThis, rawDir, shotDir);
    } else {
      const promptForThis = buildReviewPrompt(report, rv, dispatchId, dispatchTimestamp);
      return runTab(cdp, pages[rv.name], rv, promptForThis, rawDir, shotDir);
    }
  })));

  const summary = {};
  const rawByReviewer = {};
  for (let i = 0; i < getReviewers().length; i++) {
    const rv = getReviewers()[i];
    const r = results[i];
    if (r.status === 'fulfilled' && r.value.ok === false) {
      // P1-15: runTabUpload 上传失败返回 ok:false，allSettled 视为 fulfilled
      // → 这里必须标 failed，否则 aggregated-feedback 把失败显示为 "ok / 反馈长度 0"
      summary[rv.name] = { status: 'failed', error: r.value.error || r.value.log?.error || 'reviewer returned ok:false', phases: r.value.phase };
      rawByReviewer[rv.name] = { ok: false, error: summary[rv.name].error };
      console.log('  ' + rv.name + ': FAILED  ' + summary[rv.name].error);
    } else if (r.status === 'fulfilled') {
      const mdPath = join(rawDir, rv.name + '.md');
       const sha = await sha256OfFile(mdPath);
      summary[rv.name] = { status: 'ok', textLen: r.value.snapshot?.lastTextLen || 0, sha, phases: r.value.phase };
       rawByReviewer[rv.name] = { ok: true, sha, responseText: await readRawResponse(mdPath) };
      const mi = dispatchMeta.reviewers.findIndex(x => x.name === rv.name);
      if (mi !== -1) dispatchMeta.reviewers[mi].rawSha256 = sha;
      console.log('  ' + rv.name + ': OK  textLen=' + summary[rv.name].textLen + '  sha256=' + sha);
    } else {
      summary[rv.name] = { status: 'failed', error: r.reason?.message || String(r.reason) };
      rawByReviewer[rv.name] = { ok: false, error: summary[rv.name].error };
      console.log('  ' + rv.name + ': FAILED  ' + summary[rv.name].error);
    }
  }

  // artifact SHA256 一致性校验（inline 模式：文本哈希；upload 模式：二进制哈希）
   const shaAfter = await sha256OfBinaryFile(abs);
  if (shaAfter !== artifactSha256) {
    // P2-11: 中止状态落 history + 明确退出码（drift = 2），便于上层区分 drift 与常规失败
    appendDispatchHistory('DISPATCH_ABORTED', artifactSha256, dispatchId, dispatchTimestamp, reviewRound, trigger, 'drift');
    console.error('[DISPATCH_ABORTED] artifact SHA256 不一致: before=' + artifactSha256 + ' after=' + shaAfter);
    console.error('[DISPATCH_ABORTED] reviews/' + dispatchId + ' 已保留失败现场；可用 --force 重跑');
    process.exit(2);
  }

  // P1-06: 仅在至少一个 reviewer 成功时写"正常"history 行；
  // 全失败写 FAILED 行（格式：DISPATCH_FAILED <sha> <id> <ts> <round> <trigger>）。
  // historyHasSha 对 ABORTED/FAILED 统一不拦截重跑。
  const anyOk = getReviewers().some(rv => summary[rv.name] && summary[rv.name].status === 'ok');
  if (anyOk) {
    writeFileSync(join(layerADir, 'dispatch-meta.json'), JSON.stringify(dispatchMeta, null, 2), 'utf8');
  } else {
    dispatchMeta.allFailed = true;
    writeFileSync(join(layerADir, 'dispatch-meta.json'), JSON.stringify(dispatchMeta, null, 2), 'utf8');
    appendDispatchHistory('DISPATCH_FAILED', artifactSha256, dispatchId, dispatchTimestamp, reviewRound, trigger, 'failed');
    console.error('[DISPATCH_FAILED] 全部 reviewer 失败，写 FAILED 行；reviews/' + dispatchId + ' 可用 --force 重跑');
  }
  const canonicalIssues = buildCanonicalIssues(rawByReviewer);
  writeFileSync(join(layerADir, 'issues-normalized.json'), JSON.stringify(canonicalIssues, null, 2), 'utf8');
  const aggregated = buildAggregatedFeedback(summary, rawByReviewer, dispatchMeta);
  writeFileSync(join(layerADir, 'aggregated-feedback.md'), aggregated, 'utf8');
  writeLayerBSkeletons(layerBDir);
  if (anyOk) {
    const histLine = appendDispatchHistory(artifactSha256, dispatchId, dispatchTimestamp, reviewRound, trigger, 'review', parentDispatchId);
    console.log('[HISTORY] ' + histLine);
  }

  console.log('');
  console.log('=== review 结果 ===');
  for (const rv of getReviewers()) {
    const s = summary[rv.name];
    if (s.status === 'ok') console.log('  ' + rv.name + ': OK  textLen=' + s.textLen);
    else console.log('  ' + rv.name + ': FAILED  ' + s.error);
  }
  console.log('[OUT] ' + outDir);
  console.log('[NEXT] layer-a 已落盘；Layer B 由 --analyze 填充');
  } finally {
    cdp.close();
  }

  // 连运：--review <path> --analyze --architect[--local] 一条命令跑完整链。
  // 各阶段独立 try/catch，前一阶段失败不阻断后续落盘的尝试，错误经控制台可见。
  if (chainAnalyze) {
    try {
      console.log('[CHAIN] 启动 --analyze 阶段...');
      if (!dispatchId) console.error('[CHAIN] dispatchId 为空，跳过 --analyze'); else await runAnalyze(dispatchId);
    } catch (e) {
      console.error('[CHAIN] --analyze 失败: ' + e.message);
    }
  }
  if (chainArchitect) {
    try {
      console.log('[CHAIN] 启动 --architect 阶段...');
      if (!dispatchId) console.error('[CHAIN] dispatchId 为空，跳过 --architect'); else await runArchitect(dispatchId);
    } catch (e) {
      console.error('[CHAIN] --architect 失败: ' + e.message);
    }
  }
  if (chainArchitectLocal) {
    try {
      console.log('[CHAIN] 启动 --architect-local 阶段...');
      if (!dispatchId) console.error('[CHAIN] dispatchId 为空，跳过 --architect-local'); else await runArchitectLocal(dispatchId);
    } catch (e) {
      console.error('[CHAIN] --architect-local 失败: ' + e.message);
    }
  }
}



// ---------- Step 4: --scan 8 方并行扫描（T-61 P8：块体已搬至 lib/scan-entry.mjs（runScanEntry），
// 入口仅留调用位；T-40 历史：下移至此以复用 CDP/runTab 接入网页 4 席 + --auto-fix 链） ----------
if (mode === 'scan') {
  await runScanEntry({ scanFile, args, getFlagValue, getIntFlag });
}

// DELTA-015: 未处理拒绝全局兜底——深层/游离 Promise 不再默认杀进程，仅告警留证
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED_REJECTION]', (reason && reason.stack) || reason);
});

main().catch(e => {
  console.error('FATAL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
