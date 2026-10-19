// lib/scan-entry.mjs — T-61 P8 提取（scan 顶层 if 块 cuts + 手工 async 包装；块体逐字节 + 2 处动态 import 路径适配）
// 符号集（计划 C-9：scan 块胶水与模式注册外侧 lib 化）：
//   块体（原 L808-991，位于顶层 if (mode === scan) L807 与闭括号 L992 之间）整块搬移，
//   手工包装为 async 函数 runScanEntry(ctx)：与入口原顶层 await 语义等价（入口保留调用位）。
//   export 面 1 符号：runScanEntry；入口回迁 import 行，调用点=原 if 块处。
// 包装层（本阶段等值口径=块内容逐字节+包装层单独列出，见 tmp/t61/p8-manifest.json）：
//   - wrapperHead: export async function runScanEntry({ scanFile, args, getFlagValue, getIntFlag }) {
//   - wrapperTail: }
//   - bodySubs 2 处（模块说明符随文件位置适配，非语义变更）：
//       './scan-flow.mjs' -> '../scan-flow.mjs'（lib/ 到 orchestrator/ 上层）；
//       './lib/scan-args.mjs' -> './scan-args.mjs'（lib/ 内同目录）。
//   - 入口侧：原 L806 注释重写为指向本模块；L330-332 指针注释增补 P8 行。
// ctx 面（入口顶层作用域经参数传入；块内自由标识符实测恰此 4 个）：scanFile/args/getFlagValue/getIntFlag。
// 依赖（块内自由标识符扫描实证 tmp/t61/p8-genmanifest.mjs；误报已逐一剔除）：
//   node:fs readFileSync/mkdirSync/writeFileSync/existsSync、node:fs promises as fsPromises、
//   node:path resolve as resolvePath/normalize as normalizePath/join/sep as pathSep、
//   node:child_process spawnSync、js-yaml yaml、constants TITAN_ROOT/CDP_HOST/REVIEWERS_YAML、
//   cdp-client CDP（块内自建连接）、session-send runTabUpload。
//   动态导入（块内执行）：../scan-flow.mjs（runScanMode/parseFindingsJson）、./scan-args.mjs（forceLocalOnly）。
// 入口 import 收窄：node:child_process 行整删（spawnSync 块外零引用实证）。
// 回归：--analyze 66c0f00e 冻结值不涉本块；scan 冒烟=不存在文件 exit 1（路径校验链证明动态导入可达）。
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { resolve as resolvePath, normalize as normalizePath, join, sep as pathSep } from 'node:path';
import * as yaml from 'js-yaml';
import { TITAN_ROOT, CDP_HOST, REVIEWERS_YAML } from './constants.mjs';
import { CDP } from '../cdp-client.mjs';
import { runTabUpload } from './session-send.mjs';
import { runProcess } from './proc-tree.mjs';

export async function runScanEntry({ scanFile, args, getFlagValue, getIntFlag }) {
  const { runScanMode, parseFindingsJson } = await import('../scan-flow.mjs');
  // T-49 R2：--scan 支持逗号分隔多文件（完整逻辑链）；--local-only 只跑本地 4 席
  //（多文件交叉引用只有本地 agentic 席能做，网页席单附件通道不参与 R2）。
  const scanAbsList = scanFile.split(',').map((p) => resolvePath(p.trim())).filter(Boolean);
  const scanRootNorm = normalizePath(TITAN_ROOT);
  for (const p of scanAbsList) {
    if (!normalizePath(p).startsWith(scanRootNorm + pathSep)) { console.error('ERROR: --scan 文件越界（必须位于工作区内）: ' + p); process.exit(1); }
    if (!existsSync(p)) { console.error('ERROR: 文件不存在: ' + p); process.exit(1); }
  }
const scanIsMulti = scanAbsList.length > 1;
const { forceLocalOnly } = await import('./scan-args.mjs');
const localOnly = forceLocalOnly(scanIsMulti, args.includes('--local-only'));
   const scanId = 'scan-' + Date.now().toString(36);
  const scanOutDir = join(TITAN_ROOT, 'reviews', scanId, 'layer-b');
  const scanRawDir = join(scanOutDir, 'raw');
  const scanShotDir = join(scanOutDir, 'shots');
  mkdirSync(scanRawDir, { recursive: true });
  mkdirSync(scanShotDir, { recursive: true });

  // 弱回复质量门（T-40）：回复中解析不出任何带合法 severity+title 的 finding → 判弱，
  // 触发刷新/重发。注意 prompt 已删除"无问题输出 []"诱导句（实测该句会让 grok/chatgpt 直接回空数组）。
  const webRegenGate = (text) => {
    let findings = [];
    try { findings = parseFindingsJson(String(text || '')); } catch { findings = []; }
    const valid = (Array.isArray(findings) ? findings : []).filter(
      (f) => f && f.title && ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(String(f.severity || '').toUpperCase())
    );
    return valid.length === 0; // true = 弱回复，需要重生成
  };

  // 网页 4 席 runner：gemini/deepseek/qwen（reviewers_role 中 enabled:true 才扫——T-58：grok
  // 备胎 enabled:false 后不再每轮产生 tab missing 噪音；enabled 语义与 --review 对齐）
  // 缺 tab/超时逐席降级为 error，不拖垮其他席
  // + chatgpt（architect 段合成 reviewer 形态）。
  // 扫描走附件通道：完整文件 + 简短描述 prompt（runTabUpload 落 raw md/log + 截图作为席位证据）。
  const webSeatRunner = async (scanFilePath, webPrompt) => {
    let doc;
    try {
      const text = readFileSync(REVIEWERS_YAML, 'utf8').replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
      doc = yaml.load(text);
    } catch (e) {
      return ['gemini', 'deepseek', 'qwen', 'chatgpt'].map((s) => ({ source: s, replyText: '', error: 'reviewers.yaml: ' + e.message }));
    }
    // 与 --review 主流程（loadEnabledReviewers）严格对齐——只有显式启用
    // （true / 'true' / 1 / '1'）才纳入扫描；enabled 未定义、0、'false' 等一律视为未启用。
    const seatEnabled = (r) => !!r && (r.enabled === true || r.enabled === 'true' || r.enabled === 1 || r.enabled === '1');
    const roleSeats = (doc && Array.isArray(doc.reviewers_role)) ? doc.reviewers_role.filter(seatEnabled) : [];
    // chatgpt 扫描席：submit_method='enter' 防 Enter+按钮同拍双发；skip_fresh_chat=false
    // 每轮开新会话（否则同页累积同 prompt 气泡、且上轮答案泄入本轮上下文）。
    const arch = (doc && doc.architect && doc.architect.name) ? { ...doc.architect, skip_fresh_chat: false, submit_method: 'enter' } : null;
    const allSeats = arch ? [...roleSeats, arch] : [...roleSeats];
    if (allSeats.length === 0) return [{ source: 'web', replyText: '', error: 'reviewers_role 与 architect 均为空' }];
    let version, list;
    try {
      version = await fetch('http://' + CDP_HOST + '/json/version').then((r) => r.json());
      list = await fetch('http://' + CDP_HOST + '/json/list').then((r) => r.json());
    } catch (e) {
      return allSeats.map((rv) => ({ source: rv.name, replyText: '', error: 'CDP 9222 不可达: ' + e.message }));
    }
    const cdp = new CDP(version.webSocketDebuggerUrl);
    try {
      await cdp.connect();
    } catch (e) {
      return allSeats.map((rv) => ({ source: rv.name, replyText: '', error: 'CDP ws: ' + e.message }));
    }
    try {
      return await Promise.all(allSeats.map(async (rv) => {
        const urlRe = rv.url_match ? new RegExp(rv.url_match) : null;
        const page = urlRe ? list.find((x) => x.type === 'page' && urlRe.test(x.url)) : null;
        if (!page) return { source: rv.name, replyText: '', error: 'tab missing: ' + (rv.url_match || '(no url_match)') };
        // 附件通道（用户指令：网页 4 席完整文件走附件 + 简短描述 prompt，不要频繁测试）。
        // 重试：抛错 / UPLOAD_FAILED 可重试（共 3 次，fresh-chat 每次开新会话）；
        // response-timeout / 空回复不重试（上轮已发出，重发只会造成重复气泡）。
        const attempt = async () => runTabUpload(cdp, page, rv, scanFilePath, webPrompt,
          scanRawDir, scanShotDir, { regenGate: webRegenGate, maxRegen: 1 });
        let log = null;
        try {
          for (let t = 0; t < 3; t++) {
            try {
              log = await attempt();
            } catch (e) {
              const em = String((e && e.message) || e);
              if (t >= 2) return { source: rv.name, replyText: '', error: em };
              console.log('[SCAN] seat ' + rv.name + ' attempt-' + (t + 1) + ' 抛错，3s 后重试: ' + em);
              await new Promise((r) => setTimeout(r, 3000));
              continue;
            }
            const uploadFailed = log && (log.ok === false || String(log.error || '').startsWith('UPLOAD_FAILED'));
            if (!uploadFailed || t >= 2) break;
            console.log('[SCAN] seat ' + rv.name + ' attempt-' + (t + 1) + ' 上传失败（' + log.error + '），3s 后重试');
            await new Promise((r) => setTimeout(r, 3000));
          }
          const replyText = (log && log.snapshot && log.snapshot.lastText) || '';
          if (log && log.error) {
            const kind = String(log.error).startsWith('UPLOAD_FAILED') ? 'upload-failed' : 'response-timeout';
            return { source: rv.name, replyText, error: kind + ': ' + log.error };
          }
          if (!replyText) return { source: rv.name, replyText: '', error: 'empty-reply (fallback=' + ((log && log.snapshot && log.snapshot.fallback) || 'n/a') + ')' };
          return { source: rv.name, replyText, error: null };
        } catch (e) {
          return { source: rv.name, replyText: '', error: String((e && e.message) || e) };
        }
      }));
    } finally {
      cdp.close();
    }
  };

  const scanRes = await runScanMode(scanIsMulti ? scanAbsList : scanAbsList[0], {
    maxIssues: getIntFlag('--max-issues', 50),
    autoFix: args.includes('--auto-fix'),
    webSeatRunner,
    localOnly,
    allow: {
      placeholder: args.includes('--allow-placeholder'),
      refactor: args.includes('--allow-refactor'),
      'new-file': args.includes('--allow-new-file'),
    },
  });
  writeFileSync(join(scanOutDir, 'delta.md'), scanRes.deltaMd, 'utf8');
  console.log('[SCAN] findings=' + scanRes.findings.length + ' -> ' + join(scanOutDir, 'delta.md'));

  // --auto-fix 执行链：scan delta -> architect-decision.md（全量 ACCEPT，显式 opt-in）
  //   -> titan-execute.mjs <scanId>（verify 前置 + diff 范围 + 按文件串行 + PASS 才 commit）
  if (args.includes('--auto-fix')) {
    if (scanRes.findings.length === 0) {
      console.log('[SCAN] --auto-fix：无 findings，跳过执行链');
    } else {
      const decBody = scanRes.findings
        .map((f, i) => 'DELTA-' + String(i + 1).padStart(3, '0') + '\nDecision: ACCEPT')
        .join('\n\n');
      writeFileSync(join(scanOutDir, 'architect-decision.md'),
        '# Auto-fix Decision（--auto-fix 自动生成：scan findings 全量 ACCEPT）\n\n' + decBody + '\n', 'utf8');
       const executorName = getFlagValue('--executor') || 'opencode';
       const validExecutors = ['opencode', 'cline', 'kilo', 'harness'];
       if (!validExecutors.includes(executorName)) {
         console.error(`ERROR: --executor 必须是以下值之一: ${validExecutors.join(', ')}`);
         process.exit(1);
       }
       const execArgs = ['orchestrator/titan-execute.mjs', scanId, '--executor', executorName];
      // scan dispatch 无 review verdict 基线（verify-baseline 校验的是 role 档 raw 表），
      // 必 FAIL→回滚；自动跳过，diff 范围检查 + 执行器退出码验证仍生效。
      execArgs.push('--skip-baseline');
       // R2 多文件：--files 白名单（delta.file 必须落在扫描清单内，防幻觉路径）；
       // 单文件维持 --file 强制单文件模式（模型回报的 delta.file 实测会幻觉成
       // unknown/code.js，导致假 PASS 与根目录污染）
       const rootNorm = TITAN_ROOT.replace(/\\/g, '/');
       const relOf = (absNorm) => (absNorm.startsWith(rootNorm + '/') ? absNorm.slice(rootNorm.length + 1) : absNorm);
       if (scanIsMulti) {
         const relList = scanAbsList.map((p) => relOf(p.replace(/\\/g, '/'))).join(',');
         execArgs.push('--files', relList);
         console.log('[SCAN] auto-fix -> node ' + execArgs.join(' ') + ' （多文件白名单 --files，scan 无基线自动 --skip-baseline）');
       } else {
         execArgs.push('--file', relOf(scanAbsList[0].replace(/\\/g, '/')));
         console.log('[SCAN] auto-fix -> node ' + execArgs.join(' ') + ' （scan 无基线，自动 --skip-baseline + --file 单文件模式）');
       }
        // T-124：外层改 runProcess（超时杀整棵树）——旧 spawnSync 超时只杀直接子进程，
        // titan-execute 与其 LLM 孙进程变孤儿继续跑，可在本轮判失败后仍改动工作树甚至提交。
        const r = await runProcess({ cmd: 'node', args: execArgs, cwd: TITAN_ROOT, env: process.env, timeoutMs: 900000, idleMs: 0, label: 'scan-auto-fix' });
        if (r.stdout) process.stdout.write(r.stdout);
        if (r.stderr) process.stderr.write(r.stderr);
        console.log('[SCAN] auto-fix exit=' + r.exitCode + ' -> ' + join(scanOutDir, 'execute-result.json'));
        if (r.error || r.timedOut || r.exitCode !== 0) {
          const errText = r.timedOut
            ? 'executor timeout (process tree killed)'
            : (r.error || `Non-zero exit code: ${r.exitCode}`);
          console.error('[SCAN] auto-fix failed:', errText);
          await fsPromises.writeFile(join(scanOutDir, 'execute-result.json'), JSON.stringify({
            success: false,
            error: errText,
            exitCode: r.exitCode,
            timedOut: !!r.timedOut,
            durationMs: r.durationMs
          }, null, 2));
          process.exit(1);
        } else {
          console.log('[SCAN] auto-fix succeeded');
          await fsPromises.writeFile(join(scanOutDir, 'execute-result.json'), JSON.stringify({
            success: true,
            exitCode: r.status
          }, null, 2));
          process.exit(0);
      }
    }
  }
  // P-20（T-49 R2-A3 实战）：scan 模式正常出口。执行器 021/035 号修复重构 auto-fix 分支时
  // 吞掉了无 --auto-fix 路径的终止——扫描完掉进 role 审查流，还误启一次 null-artifact
  // 网页分发（db3204c7）。scan 无论是否 auto-fix，走到这里都已完结，必须退出。
  process.exit(0);
}
