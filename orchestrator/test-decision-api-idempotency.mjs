#!/usr/bin/env node
// orchestrator/test-decision-api-idempotency.mjs
// T-07 fix(decision-api): submit_verdict 幂等性单元测试（选项 1：后写覆盖 + attempt_count 追溯）
// 覆盖两种情况：
//   ① 首次写入 → attempt_count=1、previous_submitted_at=null
//   ② 第二次写入（模拟 ChatGPT 网络抖动重试）→ attempt_count=2 且 previous_submitted_at
//      保留首次的 submitted_at；裁决文本按"后写覆盖"语义更新
// 跑法：node orchestrator/test-decision-api-idempotency.mjs（自起自停 decision-api，端口 3019）
import { spawn } from 'node:child_process';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TITAN_ROOT = join(__dirname, '..');
const PORT = 3019;
const BASE = 'http://127.0.0.1:' + PORT + '/mcp';
const DISPATCH = '_fixture_decision_api';
const VERDICT_PATH = join(TITAN_ROOT, 'reviews', DISPATCH, 'layer-b', 'verdict-mcp.json');

if (!existsSync(join(__dirname, '..', 'freellmapi-src'))) {
  console.log('# skip: freellmapi-src sandbox not bundled in release tree');
  process.exit(0);
}
let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

async function rpc(method, params) {
  const r = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer <DEMO_TOKEN_REPLACE_ME>' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function submit(verdictText) {
  const res = await rpc('tools/call', { name: 'submit_verdict', arguments: { dispatchId: DISPATCH, verdict: verdictText } });
  if (!res.result) throw new Error('no result: ' + JSON.stringify(res));
  if (res.result.isError) throw new Error('tool error: ' + res.result.content[0].text);
  return JSON.parse(res.result.content[0].text);
}

function readRecord() {
  return JSON.parse(readFileSync(VERDICT_PATH, 'utf8'));
}

async function main() {
  rmSync(VERDICT_PATH, { force: true });          // 保证从 attempt=1 开始（可重复跑）

  const child = spawn(process.execPath, [join(__dirname, 'orchestrate.mjs'), '--decision-api', '--decision-port', String(PORT)], {
    cwd: join(__dirname, '..', 'freellmapi-src'), stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  try {
    // 等服务就绪（最多 10s）
    let ready = false;
    for (let i = 0; i < 50 && !ready; i++) {
      try { await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'unit', version: '0' } }); ready = true; }
      catch { await new Promise(r => setTimeout(r, 200)); }
    }
    if (!ready) { check('server ready', false, '10s 内 decision-api 未就绪'); process.exit(1); }
    check('server ready', true);

    // ① 首次写入
    const s1 = await submit('### DELTA-001\ndefer (attempt 1)');
    const r1 = readRecord();
    check('first write: response attempt_count=1', s1.attempt_count === 1, 'got ' + s1.attempt_count);
    check('first write: record attempt_count=1', r1.attempt_count === 1, 'got ' + r1.attempt_count);
    check('first write: previous_submitted_at=null', r1.previous_submitted_at === null, JSON.stringify(r1.previous_submitted_at));
    check('first write: verdict content landed', r1.verdict === '### DELTA-001\ndefer (attempt 1)');
    const firstSubmittedAt = r1.submitted_at;
    check('first write: submitted_at is string', typeof firstSubmittedAt === 'string');

    // ② 第二次写入（重试）
    const s2 = await submit('### DELTA-001\naccept (attempt 2, retry overwrite)');
    const r2 = readRecord();
    check('second write: response attempt_count=2', s2.attempt_count === 2, 'got ' + s2.attempt_count);
    check('second write: record attempt_count=2', r2.attempt_count === 2, 'got ' + r2.attempt_count);
    check('second write: previous_submitted_at keeps first submitted_at',
      Array.isArray(r2.previous_submitted_at) && r2.previous_submitted_at.length === 1 && r2.previous_submitted_at[0] === firstSubmittedAt,
      JSON.stringify(r2.previous_submitted_at) + ' vs first=' + firstSubmittedAt);
    check('second write: last-write-wins verdict', r2.verdict === '### DELTA-001\naccept (attempt 2, retry overwrite)');
    check('second write: lineage preserved', r2.lineage && r2.lineage.reviewRound === 1 && r2.lineage.trigger === 'MANUAL');
    check('second write: source still forced chatgpt-mcp', r2.source === 'chatgpt-mcp');
  } finally {
    child.kill();
    rmSync(VERDICT_PATH, { force: true });        // fixture 复原纯净（可重复跑）
  }

  console.log('---');
  console.log('decision-api idempotency: ' + pass + '/' + (pass + fail) + (fail === 0 ? ' PASS' : ' FAIL'));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('FATAL: ' + e.message); process.exit(1); });
