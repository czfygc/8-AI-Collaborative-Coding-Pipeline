#!/usr/bin/env node
// witness-live.mjs — 实况显示"当前会话实际出战模型"（② 即用版）
// 数据源：%USERPROFILE%\.dsh\logs\jev-router\dispatch.log 的 WITNESS 行（派发后真相）。
// 用法: node orchestrator/witness-live.mjs [--session <sid>] [--follow] [--last N]
// 设计说明（②完整版=让 dsh-agent 的 model-changed notice 用派发后模型，见
//   audit-evidence/autopilot/routing-fix-20261002.md §② —— 需随应用重启生效，续5 实施）。
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSH = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
const LOG = join(DSH, 'logs', 'jev-router', 'dispatch.log');
const argv = process.argv.slice(2);
const val = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const follow = argv.includes('--follow');
const lastN = val('--last') ? Number(val('--last')) : 10;
let sid = val('--session');
if (!sid) {
  sid = process.env.DSH_SESSION_ID || null;           // 本会话自动识别
}
if (!existsSync(LOG)) { console.error('[NO_LOG] ' + LOG); process.exit(2); }

const rows = [];
async function scanAll() {
  const rl = createInterface({ input: createReadStream(LOG), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('WITNESS_LLM_STREAM')) continue;
    if (sid && !line.includes(sid)) continue;
    const ts = (line.match(/^\[([^\]]+)\]/) || [])[1];
    const final = (line.match(/final_model=([^ ]+)/) || [])[1];
    const provider = (line.match(/final_provider=([^ ]+)/) || [])[1];
    if (ts && final) rows.push({ ts, provider, final });
  }
}
function printTail(n) {
  const show = rows.slice(-n);
  console.log('=== 实际出战（witness）' + (sid ? ' session=' + sid.slice(0, 20) : ' 全部') + ' 最后 ' + show.length + ' 条 ===');
  const tally = {};
  for (const r of show) { tally[r.final] = (tally[r.final] || 0) + 1; }
  for (const r of show) console.log('  ' + r.ts + '  ' + (r.provider || '?') + '/' + r.final);
  console.log('--- 汇总: ' + JSON.stringify(tally));
}
await scanAll();
printTail(lastN);
if (!follow) process.exit(0);
console.log('[FOLLOW] 每 5s 增量（Ctrl-C 退出）…');
const rl2 = createInterface({ input: createReadStream(LOG), crlfDelay: Infinity });
rl2.on('line', line => {
  if (!line.includes('WITNESS_LLM_STREAM')) return;
  if (sid && !line.includes(sid)) return;
  const ts = (line.match(/^\[([^\]]+)\]/) || [])[1];
  const final = (line.match(/final_model=([^ ]+)/) || [])[1];
  const provider = (line.match(/final_provider=([^ ]+)/) || [])[1];
  if (ts && final) console.log('  ' + ts + '  ' + (provider || '?') + '/' + final + '   ← 实际');
});
