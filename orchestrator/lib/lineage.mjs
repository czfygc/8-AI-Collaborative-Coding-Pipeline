// orchestrator/lib/lineage.mjs — T-165 产物血缘（R5 拆后实装）
//
// 定位：把 dispatch-meta.json 里已有的可选字段 stage/project（拆分期只登记不实现）
//       变成「有枚举、有校验、有读取端消费者」的血缘面：
//   - 写侧：orchestrate.mjs 解析 --stage/--project 时做枚举/字符集校验（非法即拒，不静默）。
//   - 读侧：本模块按 stage/project 扫 reviews/*/layer-a/dispatch-meta.json，筛出同源产物。
//
// 语义约定：
//   stage   ∈ design|plan|scan|fix|implement|deliver（缺省 null = 不参与血缘筛选）
//   project = 仓/项目标识（缺省 null；给 --repo 时按仓名派生）
//   读取端一律「未知字段容错忽略」：老产物的 dispatch-meta.json 没有这两个字段 → 跳过，不报错。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export const STAGE_ENUM = Object.freeze(['design', 'plan', 'scan', 'fix', 'implement', 'deliver']);
export const PROJECT_SAFE_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function validateStage(stage) {
  if (stage === null || stage === undefined || stage === '') return { ok: true, value: null, reason: '' };
  const s = String(stage).toLowerCase();
  if (!STAGE_ENUM.includes(s)) {
    return { ok: false, value: null, reason: '--stage 非法（可选: ' + STAGE_ENUM.join('|') + '）: ' + stage };
  }
  return { ok: true, value: s, reason: '' };
}

export function validateProject(project) {
  if (project === null || project === undefined || project === '') return { ok: true, value: null, reason: '' };
  const p = String(project).trim();
  if (!PROJECT_SAFE_RE.test(p)) {
    return { ok: false, value: null, reason: '--project 非法（只允许字母/数字/._-，≤64 字符）: ' + project };
  }
  return { ok: true, value: p, reason: '' };
}

// 仓根 → project 名（派生规则：取目录名，去掉非法字符）
export function deriveProjectFromRepo(repoRoot) {
  if (!repoRoot) return null;
  const name = String(repoRoot).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '');
  return cleaned && PROJECT_SAFE_RE.test(cleaned) ? cleaned : null;
}

function metaPath(dispatchId, reviewsRoot) {
  return join(reviewsRoot, dispatchId, 'layer-a', 'dispatch-meta.json');
}

// 读单个 dispatch 的血缘字段（老产物无字段 → 返回 null，不报错）
export function readLineage(dispatchId, { reviewsRoot = join(REPO_ROOT, 'reviews') } = {}) {
  const p = metaPath(dispatchId, reviewsRoot);
  if (!existsSync(p)) return null;
  try {
    const meta = JSON.parse(readFileSync(p, 'utf8'));
    return {
      dispatchId,
      stage: meta.stage ?? null,
      project: meta.project ?? null,
      parentDispatchId: meta.parentDispatchId ?? null,
      reviewRound: meta.reviewRound ?? null,
      trigger: meta.trigger ?? null,
      timestamp: meta.timestamp ?? null,
    };
  } catch {
    return null;
  }
}

// 扫全部 dispatch 的血缘，按 stage/project 过滤
export function listLineage({ stage = null, project = null, reviewsRoot = join(REPO_ROOT, 'reviews'), limit = 200 } = {}) {
  if (!existsSync(reviewsRoot)) return [];
  const out = [];
  let dirs;
  try { dirs = readdirSync(reviewsRoot, { withFileTypes: true }); } catch { return []; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const lin = readLineage(d.name, { reviewsRoot });
    if (!lin) continue;
    if (stage && lin.stage !== stage) continue;
    if (project && lin.project !== project) continue;
    out.push(lin);
    if (out.length >= limit) break;
  }
  out.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
  return out;
}

export default { STAGE_ENUM, PROJECT_SAFE_RE, validateStage, validateProject, deriveProjectFromRepo, readLineage, listLineage };
