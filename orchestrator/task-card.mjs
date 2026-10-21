#!/usr/bin/env node
// orchestrator/task-card.mjs — 台账任务卡 CLI（T-171）
// 用法: node orchestrator/task-card.mjs <T-xx> [--json]
//       node orchestrator/task-card.mjs --all [--json]
// 退出码: 0=无纪律问题, 1=有 discipline issues, 2=用法错误, 3=未知（条目不存在/台账读不出）
//
// 用途：把 T-171 的 5 条纪律变成**可执行检查**——
//   证据分级（firsthand / local_report / unverified）、一次修正后停止、OUT_OF_SCOPE、
//   阶段语义（代码 / 产物 / 发布三段独立 PASS）、YAML 任务卡渲染。

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateEntry, renderTaskCardYaml, parseTaskCardYaml, summarizeEntry,
  EVIDENCE_LEVEL_LABELS, STAGE_LABELS, STAGE_RESULTS,
} from './lib/task-card.mjs';

const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : null;
}
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

if (argv.includes('--help') || argv.includes('-h') || (!argv.includes('--all') && !argv.some((a) => /^T-\d+$/.test(a)))) {
  console.log([
    '用法: node orchestrator/task-card.mjs <T-xx> [--json]',
    '      node orchestrator/task-card.mjs --all [--json]',
    '  --registry <path>   台账路径（默认 ISSUE_REGISTRY.json）',
    '  --json              输出 JSON',
    '退出码: 0=无纪律问题 1=有 issues 2=用法错误 3=未知（条目不存在）',
    '',
    '证据分级: ' + Object.entries(EVIDENCE_LEVEL_LABELS).map(([k, v]) => k + '=' + v).join(' | '),
    '阶段语义: ' + Object.entries(STAGE_LABELS).map(([k, v]) => k + '（' + v + '）').join(' | ') + ' 取值 ' + STAGE_RESULTS.join('/'),
  ].join('\n'));
  process.exit(argv.includes('--help') || argv.includes('-h') ? 0 : 2);
}

const registryPath = resolve(flagValue('--registry') || 'ISSUE_REGISTRY.json');
const asJson = argv.includes('--json');
const wantAll = argv.includes('--all');
const id = argv.find((a) => /^T-\d+$/.test(a)) || null;

if (!existsSync(registryPath)) {
  console.error('[TASK-CARD] 台账不存在: ' + registryPath);
  process.exit(3);
}
let root;
try {
  root = JSON.parse(readFileSync(registryPath, 'utf8'));
} catch (e) {
  console.error('[TASK-CARD] 台账不可解析: ' + e.message);
  process.exit(3);
}
const issues = (root && root.issues && typeof root.issues === 'object') ? root.issues : {};

if (wantAll) {
  const rows = Object.keys(issues).sort().map((k) => {
    const entry = issues[k];
    const ev = evaluateEntry(entry);
    return { id: k, title: entry.title, status: entry.status, owner: entry.owner, summary: summarizeEntry(entry), issues: ev.issues, warnings: ev.warnings };
  });
  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    for (const r of rows) console.log(r.summary + (r.issues.length ? ' :: ' + r.issues.join(' | ') : ''));
    console.log('[TASK-CARD] 共 ' + rows.length + ' 条；带 ISSUES 的条目数: ' + rows.filter((r) => r.issues.length).length);
  }
  const bad = rows.filter((r) => r.issues.length).length;
  process.exit(bad === 0 ? 0 : 1);
}

const entry = issues[id];
if (!entry) {
  console.error('[TASK-CARD] 台账里没有 ' + id);
  process.exit(3);
}
const ev = evaluateEntry(entry);
if (asJson) {
  console.log(JSON.stringify({ id, entry, evaluation: ev, yaml: renderTaskCardYaml(entry) }, null, 2));
} else {
  console.log(renderTaskCardYaml(entry).trimEnd());
  console.log('---');
  console.log('evidence_level: ' + ev.evidence_level + ' — ' + EVIDENCE_LEVEL_LABELS[ev.evidence_level]);
  console.log('stage_results: code=' + ev.stage_results.code + ' artifact=' + ev.stage_results.artifact + ' release=' + ev.stage_results.release);
  console.log('fix_rounds: ' + ev.fix_rounds + '（>' + 1 + ' 必须移交他人复核）');
  for (const w of ev.warnings) console.log('WARN: ' + w);
  for (const i of ev.issues) console.log('ISSUE: ' + i);
  console.log(ev.ok ? 'RESULT: OK' : 'RESULT: ISSUES=' + ev.issues.length);
}
process.exit(ev.ok ? 0 : 1);
