#!/usr/bin/env node
// orchestrator/run-gate.mjs — T-153 高风险写确认闸 CLI
// 用法:
//   node orchestrator/run-gate.mjs propose --target <path> [--target <path2>] [--content-file <file>] [--kind write|commit]
//                                              [--by <who>] [--reason <text>] [--note <text>] [--message <commit-msg>]
//   node orchestrator/run-gate.mjs diff    --proposal <id>
//   node orchestrator/run-gate.mjs confirm --proposal <id> --by <who> [--reason <text>]
//   node orchestrator/run-gate.mjs reject  --proposal <id> --by <who> [--reason <text>]
//   node orchestrator/run-gate.mjs apply   --proposal <id> [--by <who>]
//   node orchestrator/run-gate.mjs list
//   node orchestrator/run-gate.mjs runs [--limit N]
//   node orchestrator/run-gate.mjs run --id <run_id>
// 退出码: 0=成功, 1=失败, 2=用法错误
//
// 闸门口径：propose 只暂存不改文件；confirm 必须署名；apply 落盘前再校验目标哈希（TOCTOU）。

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gate } from './lib/write-gate.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] || '';
function flagValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : null;
}
function flagAll(name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) {
      const v = argv[i + 1];
      if (v && !v.startsWith('--')) { out.push(v); i++; }
    }
  }
  return out;
}
function usage() {
  console.error('用法: node orchestrator/run-gate.mjs <propose|diff|confirm|apply|list|runs|run> [options]');
  process.exit(2);
}

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

try {
  if (cmd === 'propose') {
    const targets = flagAll('--target');
    if (!targets.length) { console.error('[GATE] 缺少 --target'); process.exit(2); }
    const kind = flagValue('--kind') || 'write';
    const contentFile = flagValue('--content-file');
    const by = flagValue('--by') || process.env.TITAN_ACTOR || 'unknown';
    const reason = flagValue('--reason') || '';
    const note = flagValue('--note') || '';
    const message = flagValue('--message') || null;
    if (kind === 'write' && !contentFile) { console.error('[GATE] write 模式必须给 --content-file'); process.exit(2); }
    if (contentFile && !existsSync(contentFile)) { console.error('[GATE] 内容文件不存在: ' + contentFile); process.exit(2); }
    const content = contentFile ? readFileSync(contentFile) : null;
    const p = gate.createProposal({
      kind,
      actor: by,
      reason,
      note,
      message,
      targets: targets.map(t => ({ path: t, content, message })),
    });
    const s = gate.summarize(p);
    console.log('[GATE] PROPOSAL_ID: ' + p.id);
    console.log('[GATE] kind=' + p.kind + ' status=' + p.status + ' files=' + s.files.length + ' +' + s.added + ' -' + s.removed);
    for (const f of s.files) console.log('[GATE]   ' + f.rel + ' [' + f.category + '] +' + f.added + ' -' + f.removed);
    if (s.highRisk.length) console.log('[GATE] 高风险目标需确认: ' + s.highRisk.join(', '));
    console.log('--- diff ---');
    console.log(gate.renderDiff(p));
    process.exit(0);
  }

  if (cmd === 'diff') {
    const id = flagValue('--proposal');
    if (!id) { console.error('[GATE] 缺少 --proposal'); process.exit(2); }
    const p = gate.load(id);
    if (!p) { console.error('[GATE] 提案不存在: ' + id); process.exit(1); }
    console.log(gate.renderDiff(p));
    process.exit(0);
  }

  if (cmd === 'confirm') {
    const id = flagValue('--proposal');
    const by = flagValue('--by');
    if (!id || !by) { console.error('[GATE] confirm 需要 --proposal 与 --by'); process.exit(2); }
    const p = gate.confirmProposal(id, { by, reason: flagValue('--reason') || '' });
    console.log('[GATE] 已确认提案 ' + p.id + ' by=' + p.confirmed_by);
    process.exit(0);
  }

  if (cmd === 'reject') {
    const id = flagValue('--proposal');
    if (!id) { console.error('[GATE] 缺少 --proposal'); process.exit(2); }
    const p = gate.rejectProposal(id, { by: flagValue('--by') || 'unknown', reason: flagValue('--reason') || '' });
    console.log('[GATE] 已拒绝提案 ' + p.id + ' by=' + p.confirmed_by);
    process.exit(0);
  }

  if (cmd === 'apply') {
    const id = flagValue('--proposal');
    if (!id) { console.error('[GATE] 缺少 --proposal'); process.exit(2); }
    const p = gate.applyProposal(id, { by: flagValue('--by') || undefined });
    console.log('[GATE] 已落盘 ' + p.id + ' files=' + p.applied_files.join(', '));
    process.exit(0);
  }

  if (cmd === 'list') {
    const ps = gate.listProposals();
    if (!ps.length) { console.log('[GATE] 无提案'); process.exit(0); }
    for (const p of ps) {
      const s = gate.summarize(p);
      console.log('[GATE] ' + p.id + ' kind=' + p.kind + ' status=' + p.status + ' files=' + s.files.length +
        ' highRisk=' + s.highRisk.length + ' by=' + (p.confirmed_by || p.actor));
    }
    process.exit(0);
  }

  if (cmd === 'runs') {
    const runs = gate.ledger.list({ limit: Number(flagValue('--limit') || 20) });
    if (!runs.length) { console.log('[GATE] 无 run 记录'); process.exit(0); }
    for (const r of runs) console.log('[GATE] ' + r.runId + ' events=' + r.events + ' bytes=' + r.bytes);
    process.exit(0);
  }

  if (cmd === 'run') {
    const id = flagValue('--id');
    if (!id) { console.error('[GATE] 缺少 --id'); process.exit(2); }
    const events = gate.ledger.read(id);
    if (!events.length) { console.error('[GATE] 无此 run: ' + id); process.exit(1); }
    for (const e of events) console.log('[' + e.seq + '] ' + e.ts + ' ' + e.type + ' ' + JSON.stringify(e.payload));
    process.exit(0);
  }

  usage();
} catch (err) {
  console.error('[GATE] FAIL: ' + (err && err.message ? err.message : String(err)));
  process.exit(1);
}
