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

const TITAN_ROOT = resolvePath(process.env.TITAN_ROOT || 'D:\\TITAN_ARCHAEOLOGY');
const ORCHESTRATE = join(TITAN_ROOT, 'orchestrator', 'orchestrate.mjs');
const PORT = Number(process.env.TITAN_GATEWAY_PORT || 5301);
const ALLOWED_RAW = process.env.TITAN_ALLOWED_USER_IDS || '';
const ALLOWED = new Set(ALLOWED_RAW.split(',').map(s => s.trim()).filter(Boolean));
const NODE = process.env.NODE_EXECUTABLE || 'node';

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
function runTitanTask({ artifactPath, prompt, userId, trigger }) {
  const args = [];
  if (artifactPath) {
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
    timeout: 300000, // 5 分钟
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

  return {
    ok: res.status === 0,
    dispatchId,
    summary: summary || (res.stdout || '').slice(0, 500),
    stderr: res.stderr || '',
    architectDecision,
    exitCode: res.status,
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

      const { prompt, artifact_path, trigger } = parsed;
      const result = runTitanTask({ artifactPath: artifact_path, prompt, userId, trigger });

      const status = result.ok ? 200 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({
        ok: result.ok,
        dispatchId: result.dispatchId,
        summary: result.summary,
        architectDecision: result.architectDecision,
        stderr: result.stderr,
        exitCode: result.exitCode,
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
