// TITAN v2 消息入口网关（titan-gateway.mjs）
// 为 LangBot/LangTARS 等消息入口层提供 HTTP 任务下发接口。
// 职责：仅负责将经过身份校验的消息指令转换为 TITAN 流水线任务，
// 真正的代码修改与验证由独立执行链（四客户端 + verify-gate）负责。
// 本网关不直接提供仓库文件、PowerShell 或任意 Shell 执行权。

import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { createHash } from 'node:crypto';
import { scanInput, summarizeFindings } from './lib/input-integrity.mjs';
import { createLedger, newRunId, EVENT_TYPES } from './lib/run-events.mjs';
import { buildIntent, writeIntentFile } from './lib/intent.mjs';

const TITAN_ROOT = resolvePath(process.env.TITAN_ROOT || 'D:\\TITAN_ARCHAEOLOGY');
const ORCHESTRATE = join(TITAN_ROOT, 'orchestrator', 'orchestrate.mjs');
const PORT = Number(process.env.TITAN_GATEWAY_PORT || 5301);
const ALLOWED_RAW = process.env.TITAN_ALLOWED_USER_IDS || '';
const ALLOWED = new Set(ALLOWED_RAW.split(',').map(s => s.trim()).filter(Boolean));
const NODE = process.env.NODE_EXECUTABLE || 'node';
// T-153：每次 /task 请求一条 run 事件链（run.start → task.end / run.error）
const ledger = createLedger();

// 日志
function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[titan-gateway ${ts}]`, ...args);
}

// 允许的跨域头（LangBot WebPanel / 自定义前端可用）
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-User-ID, X-TITAN-Token',
};

// 身份校验：仅允许白名单用户提交任务
function isAllowed(userId) {
  if (!userId || userId.length === 0) return false;
  if (ALLOWED.size === 0) return false; // 未配置白名单时，拒绝全部（安全默认）
  return ALLOWED.has(userId);
}

// 运行 TITAN 编排器，返回 { ok, dispatchId, summary, stderr }
function runTitanTask({ artifactPath, prompt, userId, trigger, mode, filePath }) {
  if (mode === 'codegen' && prompt) {
    return runCodegen({ prompt, userId, trigger });
  }
  const args = [];
  let timeoutMs = 900000; // 15 分钟：run 咨询 4 席并行 capture 实测 254s/3席，4 席贴 300s 会 ETIMEDOUT（T-122 e2e 实证）
  if (mode === 'scan' && filePath) {
    // T-122 步骤2.3：语音落地路径 → --scan <file> --auto-fix（扫描→修复→verify→commit）
    const abs = resolvePath(TITAN_ROOT, filePath);
    if (!abs.startsWith(TITAN_ROOT + '\\') && abs !== TITAN_ROOT) {
      return { ok: false, dispatchId: null, summary: 'file path outside TITAN_ROOT', stderr: '' };
    }
    args.push('--scan', abs, '--auto-fix');
    timeoutMs = 1800000; // 30 分钟：scan 实测网页席 4 席 capture ~14.5min + auto-fix 执行链（T-122 e2e：16min 上限曾掐断执行链）
  } else if (artifactPath) {
    // 绝对路径必须在 TITAN_ROOT 内
    const abs = resolvePath(TITAN_ROOT, artifactPath);
    if (!abs.startsWith(TITAN_ROOT + '\\') && abs !== TITAN_ROOT) {
      return { ok: false, dispatchId: null, summary: 'artifact path outside TITAN_ROOT', stderr: '' };
    }
    args.push('--review', abs, '--analyze', '--architect-local');
  } else if (prompt) {
    args.push('--run', prompt);
  } else {
    return { ok: false, dispatchId: null, summary: 'need artifact_path or prompt', stderr: '' };
  }
  if (trigger) args.push('--trigger', trigger);

  const res = spawnSync(NODE, [ORCHESTRATE, ...args], {
    cwd: TITAN_ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (res.error) {
    return { ok: false, dispatchId: null, summary: 'orchestrator spawn error: ' + res.error.message, stderr: res.error.message };
  }

  // 从 stdout 提取 dispatchId
  const out = res.stdout || '';
  const m = out.match(/dispatchId=([A-Za-z0-9]+)/);
  const dispatchId = m ? m[1] : null;

  // 读取 layer-b 结果
  let summary = '';
  let architectDecision = '';
  if (dispatchId) {
    const layerBDir = join(TITAN_ROOT, 'reviews', dispatchId, 'layer-b');
    if (existsSync(layerBDir)) {
      const deltaPath = join(layerBDir, 'delta.md');
      const archPath = join(layerBDir, 'architect-decision.md');
      if (existsSync(deltaPath)) {
        const d = readFileSync(deltaPath, 'utf8');
        summary = d.slice(0, 2000); // 截断，避免过长
      }
      if (existsSync(archPath)) {
        architectDecision = readFileSync(archPath, 'utf8').slice(0, 1000);
      }
    }
  }

  // T-122: --run 咨询模式无 layer-b，从 stdout 的 [OUT] 目录读取 raw/*.md，
  // 拼接各席位（deepseek/qwen/grok/chatgpt）意见摘要，经 bot 回传 TG。
  if (!summary) {
    const outM = out.match(/\[OUT\] (\S+)/);
    if (outM) {
      const rawDir = join(outM[1], 'raw');
      if (existsSync(rawDir)) {
        const parts = [];
        for (const f of readdirSync(rawDir).filter(f => f.endsWith('.md')).sort()) {
          const t = readFileSync(join(rawDir, f), 'utf8').trim();
          const body = t.replace(/^#[^\n]*\n+URL:[^\n]*\n+Title:[^\n]*\n*/i, '').trim();
          if (body) parts.push('【' + f.replace(/\.md$/, '') + '】' + body.slice(0, 600));
        }
        if (parts.length) summary = parts.join('\n\n').slice(0, 3000);
      }
    }
  }

  // T-122 步骤2.5：--scan 落地模式摘要（findings + delta + 执行链结果）回传 TG
  if (!summary && mode === 'scan') {
    const sm = out.match(/\[SCAN\] findings=(\d+) -> (.+?)delta\.md/);
    if (sm) {
      const scanDir = sm[2]; // 形如 D:\...\reviews\scan-xxx\layer-b\
      const bits = ['扫描发现 ' + sm[1] + ' 项问题'];
      const deltaPath = join(scanDir, 'delta.md');
      if (existsSync(deltaPath)) bits.push(readFileSync(deltaPath, 'utf8').slice(0, 1500));
      const execPath = join(scanDir, 'execute-result.json');
      if (existsSync(execPath)) {
        try {
          const er = JSON.parse(readFileSync(execPath, 'utf8'));
          bits.push('执行链: ' + (er.success ? '成功，修复已 verify 通过并 commit' : '失败: ' + (er.error || ('exit ' + er.exitCode))));
        } catch (e) { /* execute-result.json 解析失败不影响摘要 */ }
      } else {
        const noFind = out.includes('--auto-fix：无 findings');
        bits.push(noFind ? '无问题，未触发执行链' : '执行链未产出 execute-result.json');
      }
      summary = bits.join('\n').slice(0, 2500);
    }
  }

  return {
    ok: res.status === 0,
    dispatchId,
    summary: summary || (res.stdout || '').slice(0, 500),
    stderr: res.stderr || '',
    architectDecision,
    exitCode: res.status,
  };
}

function runCodegen({ prompt, userId, trigger }) {
  const codegenPath = join(TITAN_ROOT, 'orchestrator', 'titan-codegen.mjs');
  if (!existsSync(codegenPath)) {
    return { ok: false, dispatchId: null, summary: 'titan-codegen.mjs 不存在', stderr: '' };
  }
  const res = spawnSync(NODE, [codegenPath, prompt], {
    cwd: TITAN_ROOT, encoding: 'utf8', timeout: 900000, maxBuffer: 10 * 1024 * 1024,
  });
  if (res.error) {
    return { ok: false, dispatchId: null, summary: 'codegen spawn error: ' + res.error.message, stderr: res.error.message };
  }
  const out = res.stdout || '';
  const vM = out.match(/\[CODEGEN\]\s*verdict=(PASS|FAIL)/i);
  const fM = out.match(/\[CODEGEN\]\s*files=(.+)/i);
  const sM = out.match(/\[CODEGEN\]\s*summary=(.+)/i);
  const pM = out.match(/\[CODEGEN\]\s*proposal_id=(\S+)/i);
  const verdict = vM ? vM[1].toUpperCase() : 'FAIL';
  const files = fM ? fM[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
  const summary = sM ? sM[1] : (out.slice(0, 2000));
  return {
    ok: verdict === 'PASS',
    dispatchId: null,
    summary: (verdict === 'PASS' ? summary + '\n（等待用户回「提交」才会 commit）' : summary),
    stderr: res.stderr || '',
    exitCode: res.status,
    files,
    verdict,
    proposalId: pM ? pM[1] : null,
  };
}

// 处理请求
function handleRequest(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  // GET /health
  if (method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify({ ok: true, service: 'titan-gateway', port: PORT }));
    return;
  }

  // POST /task
  if (method === 'POST' && pathname === '/task') {
    const userId = req.headers['x-user-id'] || '';
    if (!isAllowed(userId)) {
      res.writeHead(403, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ ok: false, error: 'user not allowed: ' + userId }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: 'invalid json body' }));
        return;
      }

      const { prompt, artifact_path, trigger, mode, file_path, intent, reply_channel } = parsed;
      // T-153：run 事件链（run.start → task.end / run.error）——事后可回放这次请求发生了什么
      const runId = newRunId('gw');
      ledger.append(runId, EVENT_TYPES.RUN_START, { mode: mode || 'auto', trigger: trigger || null, user_id: userId, has_prompt: !!prompt });
      // T-166（R6）：意图落盘 reviews/_pending/intent-<ts>.json（审计面；失败不阻断主链）
      let intentFile = null;
      if (typeof intent === 'string' && intent.trim()) {
        try {
          const obj = buildIntent({
            intent: intent.trim(),
            target: file_path || artifact_path || '',
            constraints: prompt || '',
            replyChannel: reply_channel || '',
            runId,
            source: 'telegram-bot',
          });
          intentFile = writeIntentFile(obj);
        } catch (e) {
          console.warn('[INTENT] 意图落盘失败（不阻断）: ' + (e && e.message ? e.message : String(e)));
        }
      }
      // T-154 不可信输入完整性闸门：任务文本按不可信输入检测（隐藏文本/不可见字符/
      // 指令形状行/隐藏链接）。**只报警不阻断**——命中不改变执行语义，只在响应里
      // 附带 inputIntegrity 并写日志，由上游决定处置（红线：findings 不回显原文）。
      let inputIntegrity = null;
      if (typeof prompt === 'string' && prompt) {
        const scan = scanInput(prompt);
        if (!scan.ok) {
          inputIntegrity = { ok: false, counts: scan.counts, summary: summarizeFindings(scan) };
          console.warn('[INPUT-INTEGRITY] 任务文本命中完整性检查（不阻断）: ' + inputIntegrity.summary);
        }
      }
      let result;
      try {
        result = runTitanTask({ artifactPath: artifact_path, prompt, userId, trigger, mode, filePath: file_path });
      } catch (err) {
        ledger.append(runId, EVENT_TYPES.RUN_ERROR, { message: String(err && err.message ? err.message : err).slice(0, 300) });
        throw err;
      }
      ledger.append(runId, EVENT_TYPES.TASK_END, {
        ok: !!result.ok,
        exit_code: result.exitCode ?? null,
        dispatch_id: result.dispatchId || null,
        verdict: result.verdict || null,
        proposal_id: result.proposalId || null,
        summary_len: (result.summary || '').length,
      });

      const status = result.ok ? 200 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({
        ok: result.ok,
        dispatchId: result.dispatchId,
        summary: result.summary,
        architectDecision: result.architectDecision,
        stderr: result.stderr,
        exitCode: result.exitCode,
        runId,
        ...(intentFile ? { intentFile } : {}),
        ...(result.verdict ? { verdict: result.verdict, files: result.files || [], proposalId: result.proposalId || null } : {}),
        ...(inputIntegrity ? { inputIntegrity } : {})
      }));
    });
    return;
  }

  // GET /task/:dispatchId
  if (method === 'GET' && pathname.startsWith('/task/')) {
    const dispatchId = pathname.split('/').pop();
    const layerBDir = join(TITAN_ROOT, 'reviews', dispatchId, 'layer-b');
    if (!existsSync(layerBDir)) {
      res.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ ok: false, error: 'dispatch not found: ' + dispatchId }));
      return;
    }
    let summary = '';
    const deltaPath = join(layerBDir, 'delta.md');
    if (existsSync(deltaPath)) {
      summary = readFileSync(deltaPath, 'utf8').slice(0, 3000);
    }
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify({
      ok: true,
      dispatchId,
      summary,
      files: readdirSync(layerBDir),
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain', ...corsHeaders });
  res.end('not found');
}

const server = createServer(handleRequest);
server.listen(PORT, '127.0.0.1', () => {
  log('TITAN gateway listening on 127.0.0.1:' + PORT);
  log('TITAN_ROOT=' + TITAN_ROOT);
  log('ALLOWED_USER_IDS=' + (ALLOWED_RAW || '(none - all rejected)'));
});

server.on('error', (e) => {
  log('server error: ' + e.message);
  process.exit(1);
});
