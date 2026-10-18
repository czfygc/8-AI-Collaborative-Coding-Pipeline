// lib/decision-api.mjs — T-61 P5 提取（机械搬移自 orchestrate.mjs；块体逐字节未动，仅加 export 前缀）
// 符号集（计划 C-5：--decision-api 无状态 MCP 裁决面 + dispatchId 互斥对归 P5）：
//   块A（原 L45-76）：dispatchLocks + lockDispatchId/unlockDispatchId（submitVerdict 串行化
//     互斥对，模块内部使用，不入 export 面）；
//   块B（原 L2064-2482）：DECISION_API_VERSION/DECISION_VERDICT_SCHEMA_VERSION/MAX_VERDICT_CHARS/
//     MAX_DECISIONS/MAX_RPC_BODY_BYTES/MAX_BATCH_ITEMS/MAX_VERDICT_PER_REQUEST/DECISION_DISPATCH_ID_RE/
//     DECISION_KNOWN_PROTOCOL_VERSIONS + SUBMIT_VERDICT_TOOL + decisionToolError/submitVerdict/
//     decisionHandleRpc/getExpectedBearerToken/createDecisionApiServer/runDecisionApi。
// 依赖（块内自由标识符扫描实证 tmp/t61/p5-depscan.mjs，注释/字符串/属性名已逐一剔除）：
//   node:http createServer、node:child_process execFile、node:crypto randomBytes/createHash、
//   node:fs existsSync+fsPromises、node:path join/normalizePath/pathSep、
//   constants __dirname（P0 已导出，dirname(dirname(...))=orchestrator/ 目录，与入口 L43 取值等价）/
//   TITAN_ROOT/MAX_REPORT_CHARS。CDP/execFileSync 仅存在于块内注释，非依赖。
// 入口面：仅回迁 import { runDecisionApi }（唯一块外调用点原 L1474）；其余 15 个搬移符号零块外引用
//（反向核查 PASS）；decision-api.test.mjs 走 CLI spawn 面不受影响。
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, promises as fsPromises } from 'node:fs';
import { join, normalize as normalizePath, sep as pathSep } from 'node:path';
import { __dirname, TITAN_ROOT, MAX_REPORT_CHARS } from './constants.mjs';

// Lock for dispatchId to prevent race conditions in submitVerdict
const dispatchLocks = new Map();

function lockDispatchId(dispatchId) {
  if (!dispatchLocks.has(dispatchId)) {
    dispatchLocks.set(dispatchId, { locked: false, queue: [] });
  }
  const lockInfo = dispatchLocks.get(dispatchId);
  return new Promise((resolve, reject) => {
    if (!lockInfo.locked) {
      lockInfo.locked = true;
      resolve();
    } else {
      lockInfo.queue.push({ resolve, reject });
    }
  });
}

function unlockDispatchId(dispatchId) {
  const lockInfo = dispatchLocks.get(dispatchId);
  if (lockInfo) {
    if (lockInfo.queue.length > 0) {
      const next = lockInfo.queue.shift();
      next.resolve();
    } else {
      lockInfo.locked = false;
    }
  }
}




// ---------- T-07 P0：--decision-api 无状态 MCP 裁决面（记忆【4方会诊续2】） ----------
// 分工裁定：裁决面换 MCP、唤醒面留 CDP 单行、Reviewer 上传 CDP 不动。本子命令=裁决面最小落地：
//   1. 不另起代码库 —— 挂在 orchestrate.mjs 内的独立子命令；
//   2. 无状态 —— 每个 POST 独立处理，不发 Mcp-Session-Id，不保留任何内存会话；
//   3. 只监听 127.0.0.1 —— 公网入口 = cloudflared quick tunnel + freellmapi-src/mcp-proxy.cjs，
//      Bearer 由代理注入（本进程只校验 Authorization: Bearer <非空> 头存在，不持有密钥）；
//   4. 仅挂 submit_verdict 写工具 —— P0 验收第 0 条（生死判据）= ChatGPT 免费账号实测写权限；
//      get_delta / get_issue_context 读工具闭环是 P1，本批不加。
//
// 双轨版本 bump 规则（两个版本号随每条 verdict 一起落盘，互不联动）：
//   - DECISION_API_VERSION：API 面变化（工具集/参数 schema/路由/鉴权方式）→ minor+；
//     行为修复 → patch。调用方（ChatGPT 连接器 / 代理 / 冒烟脚本）按它判断兼容性。
//   - DECISION_VERDICT_SCHEMA_VERSION：verdict-mcp.json 记录结构变化（字段增删/改名）→ +0.1。
//     读取方（后续 --analyze 消费 verdict、报表）按它判断解析方式。
//
// verdict 血缘 source 枚举：chatgpt-mcp（本服务写入，服务端强制，客户端传了也覆盖）|
//   chatgpt-cdp（--architect CDP 捕获）| local-placeholder（--architect-local 占位）。

// 2026-10-01 幂等性修复：记录结构新增 attempt_count / previous_submitted_at →
// schema_version 1.0→1.1（记录结构变化 +0.1）；工具结果 summary 同步携带 attempt_count
// → decision_api_version 0.1.0→0.1.1（行为修复走 patch，API 面未变）。
const DECISION_API_VERSION = '0.1.1';
const DECISION_VERDICT_SCHEMA_VERSION = '1.1';
const MAX_VERDICT_CHARS = MAX_REPORT_CHARS;
const MAX_DECISIONS = 200;
const MAX_RPC_BODY_BYTES = 4 * 1024 * 1024;
const MAX_BATCH_ITEMS = 200;
const MAX_VERDICT_PER_REQUEST = 5;
// dispatchId 现有正则（_session_memory.md §4）：test001 违反此正则，不可用作测试 id
const DECISION_DISPATCH_ID_RE = /^(_?[0-9a-f]{8}|_[a-zA-Z0-9_]+)$/;
const DECISION_KNOWN_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];

const SUBMIT_VERDICT_TOOL = {
  name: 'submit_verdict',
  description: '提交某次四方会诊 dispatch 的架构师裁决（唯一写工具）。落盘 reviews/<dispatchId>/layer-b/verdict-mcp.json：服务端校验 dispatchId、现算 delta_sha256、读取 dispatch-meta.json 血缘，并强制 source=chatgpt-mcp（客户端不可伪造）。',
  inputSchema: {
    type: 'object',
    properties: {
      dispatchId: { type: 'string', description: '8 位 hex（如 df05265b）或下划线名（如 _fixture_stest2）' },
      verdict: { type: 'string', description: '完整裁决文本（markdown，逐条 DELTA-### 给出 accept/reject/defer + 一句理由）' },
      decisions: {
        type: 'array',
        description: '可选：结构化逐条判定（与 verdict 文本一起落盘；deltaId 必须真实存在于 delta.md）',
        items: {
          type: 'object',
          properties: {
            deltaId: { type: 'string', description: 'DELTA-001 形式' },
            decision: { type: 'string', enum: ['accept', 'reject', 'defer'] },
            reason: { type: 'string', description: '一句理由' }
          },
          required: ['deltaId', 'decision']
        }
      }
    },
    required: ['dispatchId', 'verdict']
  }
};

function decisionToolError(msg) {
  return { isError: true, content: [{ type: 'text', text: 'SUBMIT_VERDICT_ERROR: ' + msg }] };
}

// submit_verdict 实现：校验 → 现算 delta_sha256 → 读血缘 → 原子落盘
async function submitVerdict(args, transport) {
  if (!args || typeof args !== 'object') return decisionToolError('参数必须是对象');
  const dispatchId = typeof args.dispatchId === 'string' ? args.dispatchId.trim() : '';
  if (!DECISION_DISPATCH_ID_RE.test(dispatchId)) {
    return decisionToolError('dispatchId 格式错误（需 8 位 hex 或 _name）: ' + JSON.stringify(dispatchId));
  }
  const verdict = typeof args.verdict === 'string' ? args.verdict : '';
  if (!verdict.trim()) return decisionToolError('verdict 不能为空');
  if (verdict.length > MAX_VERDICT_CHARS) {
    return decisionToolError('verdict 超长: ' + verdict.length + ' > ' + MAX_VERDICT_CHARS);
  }

  // Acquire lock to prevent race conditions for the same dispatchId
   await lockDispatchId(dispatchId);
   try {
     const outDir = join(TITAN_ROOT, 'reviews', dispatchId);
     const norm = normalizePath(outDir);
     if (!norm.startsWith(TITAN_ROOT + pathSep)) {
       return decisionToolError('dispatchId 路径穿越: ' + dispatchId);
     }
     const layerBDir = join(outDir, 'layer-b');
     const deltaPath = join(layerBDir, 'delta.md');
     if (!existsSync(deltaPath)) {
       return decisionToolError('缺少 delta.md（该 dispatch 未跑 --analyze，或 dispatchId 不存在）: ' + deltaPath);
     }
 
     // delta_sha256 服务端现算 —— 不信任客户端传入的任何哈希
      // 一次性读取 Buffer，基于同一 Buffer 计算 SHA256 并转换为文本，避免两次读取间文件被修改导致不一致
      const deltaBuffer = await fsPromises.readFile(deltaPath);
      const deltaSha256 = createHash('sha256').update(deltaBuffer).digest('hex').toUpperCase();
      const deltaText = deltaBuffer.toString('utf8');
 
     // 血缘三元组 {parentDispatchId, reviewRound, trigger}：读 layer-a/dispatch-meta.json，缺失如实标记
     let lineage = null;
     let lineageSource = 'missing-dispatch-meta';
     let artifactSha256 = null;
     const metaPath = join(outDir, 'layer-a', 'dispatch-meta.json');
     if (existsSync(metaPath)) {
       try {
         const meta = JSON.parse(await fsPromises.readFile(metaPath, 'utf8'));
         lineage = {
           parentDispatchId: meta.parentDispatchId === undefined ? null : meta.parentDispatchId,
           reviewRound: Number.isFinite(Number(meta.reviewRound)) ? Number(meta.reviewRound) : 1,
           trigger: (typeof meta.trigger === 'string' && meta.trigger) ? meta.trigger : 'MANUAL'
         };
         artifactSha256 = (typeof meta.artifactSha256 === 'string' && meta.artifactSha256) ? meta.artifactSha256 : null;
         lineageSource = 'dispatch-meta.json';
       } catch (e) {
         lineageSource = 'dispatch-meta-parse-error: ' + e.message;
       }
     }
 
     // 结构化 decisions：deltaId 必须真实存在于 delta.md（防调用方幻觉 id），且逐项校验
     let decisions = null;
     if (args.decisions !== undefined && args.decisions !== null) {
       if (!Array.isArray(args.decisions)) return decisionToolError('decisions 必须是数组');
       if (args.decisions.length > MAX_DECISIONS) return decisionToolError('decisions 超长: ' + args.decisions.length + ' > ' + MAX_DECISIONS);
       const validIds = new Set(deltaText.match(/DELTA-\d{3}/g) || []);
       decisions = [];
       for (const d of args.decisions) {
         if (!d || typeof d !== 'object') return decisionToolError('decisions 每项必须是对象');
         const deltaId = (typeof d.deltaId === 'string') ? d.deltaId.trim() : '';
         const decision = (typeof d.decision === 'string') ? d.decision.trim().toLowerCase() : '';
         if (!/^DELTA-\d{3}$/.test(deltaId)) return decisionToolError('deltaId 格式错误: ' + JSON.stringify(deltaId));
         if (decision !== 'accept' && decision !== 'reject' && decision !== 'defer') {
           return decisionToolError('decision 必须 accept/reject/defer: ' + JSON.stringify(d.decision));
         }
         if (!validIds.has(deltaId)) {
           return decisionToolError('deltaId 不存在于 delta.md: ' + deltaId + '（有效: ' + Array.from(validIds).join(',') + '）');
         }
         decisions.push({ deltaId: deltaId, decision: decision, reason: (typeof d.reason === 'string') ? d.reason : '' });
       }
     }
 
     // 幂等性语义（选项 1）：ChatGPT 侧网络抖动重试是常态，重复提交**不拒绝**（拒绝会让
     // Harness 收不到裁决、需人工介入），保持后写覆盖，但每次覆盖留追溯：
     //   attempt_count 从 1 起递增；previous_submitted_at 累积全部历史 submitted_at（首次为 null）。
     const outPath = join(layerBDir, 'verdict-mcp.json');
     let attemptCount = 1;
     let previousSubmittedAt = null;
     let outPathExists = false;
     try {
       await fsPromises.access(outPath);
       outPathExists = true;
     } catch (_) {
       // file does not exist
     }
 
     if (outPathExists) {
       try {
         const old = JSON.parse(await fsPromises.readFile(outPath, 'utf8'));
         const oldAttempts = Number(old.attempt_count);
         attemptCount = (Number.isFinite(oldAttempts) && oldAttempts >= 1) ? oldAttempts + 1 : 2;
         const prevList = Array.isArray(old.previous_submitted_at)
           ? old.previous_submitted_at.filter(x => typeof x === 'string')
           : [];
         if (typeof old.submitted_at === 'string') prevList.push(old.submitted_at);
         previousSubmittedAt = prevList.length > 0 ? prevList : null;
       } catch (e) {
         // 旧文件损坏/非本服务产物：仍按一次重试计数，但不继承无法解析的历史
         attemptCount = 2;
         previousSubmittedAt = null;
         console.warn('[DECISION-API] 旧 verdict-mcp.json 解析失败，attempt_count 从 2 起且不继承历史: ' + e.message);
       }
     }
 
     const record = {
       schema_version: DECISION_VERDICT_SCHEMA_VERSION,
       decision_api_version: DECISION_API_VERSION,
       source: 'chatgpt-mcp',                    // source 枚举三选一，服务端强制，客户端不可伪造
       dispatchId: dispatchId,
       delta_sha256: deltaSha256,
       artifact_sha256: artifactSha256,
       lineage: lineage,                          // {parentDispatchId, reviewRound, trigger} | null
       lineage_source: lineageSource,
       verdict: verdict,
       decisions: decisions,
       submitted_at: new Date().toISOString(),
       attempt_count: attemptCount,               // 幂等性追溯：第 N 次提交（含 ChatGPT 重试）
       previous_submitted_at: previousSubmittedAt, // string[] 累积历史（首次=null）
       transport: transport                       // {remote, userAgent}：调用方身份旁证，不进血缘枚举
     };
 
     await fsPromises.mkdir(layerBDir, { recursive: true });
     const tmp = outPath + '.' + randomBytes(8).toString('hex') + '.tmp';
     await fsPromises.writeFile(tmp, JSON.stringify(record, null, 2), 'utf8');
     await fsPromises.rename(tmp, outPath);                   // 原子落盘（与 dispatch-history 原子写同规）
 
     const summary = {
       ok: true,
       path: outPath,
       dispatchId: dispatchId,
       delta_sha256: deltaSha256,
       source: 'chatgpt-mcp',
       attempt_count: attemptCount,
       decisions: decisions ? decisions.length : null,
       schema_version: DECISION_VERDICT_SCHEMA_VERSION,
       decision_api_version: DECISION_API_VERSION
     };
     console.log('[DECISION-API] submit_verdict ok dispatchId=' + dispatchId +
       ' delta_sha256=' + deltaSha256.slice(0, 12) + '... decisions=' + (decisions ? decisions.length : 0) +
       (attemptCount > 1 ? ' (retry attempt=' + attemptCount + ')' : ''));
     return { content: [{ type: 'text', text: JSON.stringify(summary) }] };
   } finally {
     unlockDispatchId(dispatchId);
   }
}

// JSON-RPC 2.0 → MCP 方法分发（返回对象=应答，null=通知，202 空体）
async function decisionHandleRpc(msg, transport) {
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const method = msg.method;
  if (method.startsWith('notifications/')) return null;         // initialized/cancelled 等：202 无体
  const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result: result });
  const err = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code: code, message: message } });

  if (method === 'initialize') {
    const clientPv = (msg.params && typeof msg.params.protocolVersion === 'string') ? msg.params.protocolVersion : null;
    const pv = (clientPv && DECISION_KNOWN_PROTOCOL_VERSIONS.includes(clientPv)) ? clientPv : '2025-06-18';
    return ok({
      protocolVersion: pv,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'titan-decision-api', title: 'TITAN Four-Party Consult Decision API', version: DECISION_API_VERSION },
      instructions: 'TITAN 四方会诊裁决面（P0）。唯一工具 submit_verdict：把对 delta.md 的逐条 accept/reject/defer 裁决写回 reviews/<dispatchId>/layer-b/verdict-mcp.json。服务端现算 delta_sha256 并强制 source=chatgpt-mcp。'
    });
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: [SUBMIT_VERDICT_TOOL] });
  if (method === 'tools/call') {
    const p = msg.params || {};
    if (p.name !== 'submit_verdict') {
      return err(-32602, 'unknown tool: ' + String(p.name) + '（P0 仅挂 submit_verdict，get_delta 等读工具属 P1）');
    }
    try {
      const result = await submitVerdict(p.arguments || {}, transport);
      return ok(result);
    } catch (e) {
      return ok(decisionToolError('服务端异常: ' + e.message));
    }
  }
  return err(-32601, 'method not found: ' + method);
}

// --decision-api 主入口：127.0.0.1 单监听、无状态、Bearer 由代理注入
// DELTA-021（T-59 批2c）：token 读取异步化——execFileSync 在启动期同步阻塞事件循环
//（get-key.cjs 慢/挂起时 --decision-api 整个起不来）；改 execFile 回调包 Promise。
// 每进程只读一次、由 createDecisionApiServer 持有，等价"启动前一次性读取并缓存"。
function getExpectedBearerToken() {
  return new Promise((resolve) => {
    const tokenPath = join(__dirname, '..', 'freellmapi-src', 'get-key.cjs');
    execFile('node', [tokenPath], { encoding: 'utf8' }, (err, stdout) => {
      if (err) {
        console.error('[DECISION-API] Failed to read expected bearer token: ' + err.message);
        resolve(null);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

function createDecisionApiServer(port, expectedBearerToken) {
  const allowHeaders = 'content-type, authorization, mcp-protocol-version, mcp-session-id, accept';
  const sendJson = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'access-control-allow-origin': '*',
      'cache-control': 'no-store'
    });
    res.end(body);
  };

  const server = createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': allowHeaders,
        'access-control-allow-methods': 'POST, GET, OPTIONS',
        'access-control-max-age': '600'
      });
      res.end();
      return;
    }
    if (req.method === 'GET') {
      res.writeHead(405, { 'allow': 'POST, OPTIONS', 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' });
      res.end('titan-decision-api: stateless MCP, POST only');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'allow': 'POST, OPTIONS', 'content-type': 'text/plain; charset=utf-8' });
      res.end('method not allowed');
      return;
    }
    if (url !== '/' && url !== '/mcp') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found (use POST /mcp)');
      return;
    }
    // Bearer 由 mcp-proxy.cjs 注入；验证 token 值（格式、长度和已知好值）
    const auth = String(req.headers['authorization'] || '');
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      res.setHeader('www-authenticate', 'Bearer');
      return sendJson(res, 401, { error: 'missing Bearer token' });
    }
    const token = match[1];
    // 验证token格式：仅允许字母、数字、连字符和下划线
    if (!/^[a-zA-Z0-9_-]+$/.test(token)) {
      return sendJson(res, 401, { error: 'invalid bearer token format' });
    }
    // 验证token长度：16-64个字符
    if (token.length < 16 || token.length > 64) {
      return sendJson(res, 401, { error: 'invalid bearer token length' });
    }
    if (expectedBearerToken === null) {
      // Unable to validate token; reject for safety
      return sendJson(res, 500, { error: 'internal configuration error' });
    }
    if (token !== expectedBearerToken) {
      return sendJson(res, 401, { error: 'invalid bearer token' });
    }
    const ct = String(req.headers['content-type'] || '');
    if (!ct.includes('application/json')) {
      sendJson(res, 415, { error: 'content-type must be application/json' });
      return;
    }

    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      size += c.length;
       if (size > MAX_RPC_BODY_BYTES) {
         aborted = true;
         sendJson(res, 413, { error: 'payload too large' });
         req.destroy();
         return;
       }
      chunks.push(c);
    });
     req.on('end', async () => {
       if (aborted) return;
       const transport = {
         remote: req.socket.remoteAddress || null,
         userAgent: req.headers['user-agent'] || null
       };
       let parsed;
       try {
         parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
       } catch (e) {
         sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: ' + e.message } });
         return;
       }
       try {
          if (Array.isArray(parsed)) {
            // 批量请求：限制项数和 verdict 次数
            if (parsed.length > MAX_BATCH_ITEMS) {
              return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32603, message: `Batch size exceeds limit ${MAX_BATCH_ITEMS}` } });
            }
            let verdictCount = 0;
            for (const m of parsed) {
              if (m && typeof m === 'object' && m.method === 'tools/call' && (m.params || {}).name === 'submit_verdict') {
                verdictCount++;
                if (verdictCount > MAX_VERDICT_PER_REQUEST) {
                  return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32603, message: `submit_verdict count exceeds limit ${MAX_VERDICT_PER_REQUEST}` } });
                }
              }
            }
            // 逐条处理
            const out = [];
            for (const m of parsed) {
              const result = await decisionHandleRpc(m, transport);
              if (result !== null) {
                out.push(result);
              }
            }
            if (out.length === 0) { res.writeHead(202).end(); return; }
            sendJson(res, 200, out);
            return;
          }
          // 单条请求（可选：也可检查 verdict 次数，但单条最多1，已在常量内）
          const one = await decisionHandleRpc(parsed, transport);
          if (one === null) { res.writeHead(202).end(); return; }
          sendJson(res, 200, one);
       } catch (e) {
         sendJson(res, 500, { jsonrpc: '2.0', id: (parsed && parsed.id) || null, error: { code: -32603, message: 'Internal error: ' + e.message } });
       }
     });
    req.on('error', () => { /* 客户端断开：无状态服务无需清理 */ });
  });

  return server;
}

export async function runDecisionApi(port) {
  const expectedBearerToken = await getExpectedBearerToken();
  const server = createDecisionApiServer(port, expectedBearerToken);
  server.listen(port, '127.0.0.1', () => {
    console.log('[DECISION-API] titan-decision-api v' + DECISION_API_VERSION + ' listening http://127.0.0.1:' + port + '/mcp (stateless, 127.0.0.1 only)');
    console.log('[DECISION-API] tools: submit_verdict (write only; get_delta/get_issue_context = P1)');
    console.log('[DECISION-API] auth: Bearer injected by mcp-proxy.cjs; verdict schema v' + DECISION_VERDICT_SCHEMA_VERSION);
    console.log('[DECISION-API] tunnel path: cloudflared quick tunnel -> mcp-proxy.cjs -> 127.0.0.1:' + port + ' (用完即杀)');
  });
  server.on('error', (e) => {
    console.error('[DECISION-API] listen error: ' + e.message);
    process.exit(1);
  });
}


