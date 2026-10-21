#!/usr/bin/env node
// orchestrator/lineage.mjs — 产物血缘查询 CLI（T-165）
// 用法: node orchestrator/lineage.mjs [--stage <stage>] [--project <project>] [--dispatch <id>] [--json] [--limit N]
// 退出码: 0=成功（查到或查不到都算成功），1=参数错误
//
// 用途：按 stage/project 把同一条链上的产物捞出来（拆后 P11 多仓分桶、P12 串链追溯的读侧）。

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listLineage, readLineage, validateStage, validateProject, STAGE_ENUM } from './lib/lineage.mjs';

const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : null;
}
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

if (argv.includes('--help') || argv.includes('-h')) {
  console.log([
    '用法: node orchestrator/lineage.mjs [options]',
    '  --stage <stage>     ' + STAGE_ENUM.join('|'),
    '  --project <name>    仓/项目标识',
    '  --dispatch <id>     查单个 dispatch 的血缘',
    '  --limit <N>         最多返回条数（默认 200）',
    '  --json              输出 JSON',
  ].join('\n'));
  process.exit(0);
}

const asJson = argv.includes('--json');
const dispatchId = flagValue('--dispatch');
const stageRaw = flagValue('--stage');
const projectRaw = flagValue('--project');
const limit = Number(flagValue('--limit') || 200);

const stageCheck = validateStage(stageRaw);
if (!stageCheck.ok) { console.error('[LINEAGE] ' + stageCheck.reason); process.exit(1); }
const projectCheck = validateProject(projectRaw);
if (!projectCheck.ok) { console.error('[LINEAGE] ' + projectCheck.reason); process.exit(1); }

if (dispatchId) {
  const lin = readLineage(dispatchId);
  if (!lin) { console.error('[LINEAGE] 无该 dispatch 的血缘记录: ' + dispatchId); process.exit(1); }
  if (asJson) console.log(JSON.stringify(lin, null, 2));
  else console.log('[LINEAGE] ' + lin.dispatchId + ' stage=' + (lin.stage || '-') + ' project=' + (lin.project || '-') + ' parent=' + (lin.parentDispatchId || '-') + ' ts=' + (lin.timestamp || '-'));
  process.exit(0);
}

const rows = listLineage({ stage: stageCheck.value, project: projectCheck.value, limit });
if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  if (!rows.length) {
    console.log('[LINEAGE] 无匹配记录（stage=' + (stageCheck.value || '*') + ' project=' + (projectCheck.value || '*') + '）');
  }
  for (const r of rows) {
    console.log('[LINEAGE] ' + r.dispatchId + ' stage=' + (r.stage || '-') + ' project=' + (r.project || '-') +
      ' parent=' + (r.parentDispatchId || '-') + ' ts=' + (r.timestamp || '-'));
  }
}
process.exit(0);
