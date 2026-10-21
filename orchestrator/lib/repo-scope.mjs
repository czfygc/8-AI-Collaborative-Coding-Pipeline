// orchestrator/lib/repo-scope.mjs — T-167 目标仓库范围（R7 拆后实装）
//
// 定位：把「目标仓根」从硬编码 TITAN_ROOT 变成可参数化（--repo），并给三条硬判据：
//   1. 仓库根判定：目标目录必须像仓库（有 .git 或项目标记文件）——否则拒（防把任意目录当仓扫）。
//   2. 越界判据（DELTA-012 口径）：path.relative + isAbsolutePath —— 目标必须在有效根内。
//   3. 目录目标展开：--scan 指向目录时展开成源文件清单（有界、可控、跳过噪声目录）。
//
// 设计约束：
//   - 有效根 = --repo（若给且合法）否则 TITAN_ROOT；**产物仍落主仓**（reviews/<id>/），
//     外仓只读不写（避免污染别人的仓）。
//   - 展开默认上限 50 个文件；跳过 .git/node_modules/__pycache__/.venv/venv/dist/build 等噪声目录；
//     只取常见源文件扩展名（可配）。

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';

// 仓库根标记：.git 最强；其余是 TITAN 生态常见的"这是个仓"信号
//（AGENTS.md = 协作仓标志；package.json/pyproject.toml 等 = 项目标志）
export const REPO_MARKERS = ['.git', 'AGENTS.md', 'package.json', 'pyproject.toml', 'setup.py', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle'];
export const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'env', '.mypy_cache', '.pytest_cache', '.idea', '.vscode', 'dist', 'build', 'out', 'target', 'coverage', '.next', '.cache']);
export const SOURCE_EXTS = ['.mjs', '.js', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.rb', '.php', '.cs', '.sql', '.sh', '.ps1'];
export const DEFAULT_MAX_FILES = 50;

// 越界判据（DELTA-012 口径）：在根内 → true；在根外或路径穿越 → false
export function isInsideRoot(absPath, root) {
  if (!absPath || !root) return false;
  const rel = relative(resolve(root), resolve(absPath));
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith('..' + sep);
}

// 仓库根判定：必须是已存在目录，且含 .git 或项目标记文件
export function validateRepoRoot(absPath) {
  if (!absPath) return { ok: false, reason: '未指定 --repo', marker: null };
  const abs = resolve(absPath);
  if (!isAbsolute(absPath)) return { ok: false, reason: '--repo 需要绝对路径（收到: ' + absPath + '）', marker: null };
  if (!existsSync(abs)) return { ok: false, reason: '--repo 路径不存在: ' + abs, marker: null };
  let st;
  try { st = statSync(abs); } catch (e) { return { ok: false, reason: '--repo 不可读: ' + e.message, marker: null }; }
  if (!st.isDirectory()) return { ok: false, reason: '--repo 必须指向目录: ' + abs, marker: null };
  const marker = REPO_MARKERS.find(m => existsSync(join(abs, m)));
  if (!marker) {
    return {
      ok: false,
      reason: '--repo 不像仓库根（缺 ' + REPO_MARKERS.slice(0, 4).join('/') + ' 等标记）: ' + abs,
      marker: null,
    };
  }
  return { ok: true, reason: '', marker, root: abs };
}

// 目录目标 → 源文件清单（有界）；文件目标 → 原样单元素
export function expandScanTarget(target, { root, maxFiles = DEFAULT_MAX_FILES, exts = SOURCE_EXTS, skipDirs = SKIP_DIRS } = {}) {
  const abs = resolve(target);
  if (!existsSync(abs)) return { files: [], truncated: false, reason: '路径不存在: ' + abs };
  let st;
  try { st = statSync(abs); } catch (e) { return { files: [], truncated: false, reason: '不可读: ' + e.message }; }
  if (!st.isDirectory()) {
    return { files: [abs], truncated: false, reason: '' };
  }
  const out = [];
  let truncated = false;
  const walk = (dir, depth) => {
    if (depth > 6 || truncated) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= maxFiles) { truncated = true; return; }
      if (e.name.startsWith('.') && e.name !== '.') { if (e.isDirectory()) continue; }
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue;
        walk(p, depth + 1);
      } else if (e.isFile()) {
        const lower = e.name.toLowerCase();
        if (exts.some(x => lower.endsWith(x))) out.push(p);
      }
    }
  };
  walk(abs, 0);
  return { files: out.slice(0, maxFiles), truncated, reason: '' };
}

// 目标是否落在有效根内（越界即拒）
export function assertWithinRoot(absPath, root) {
  if (isInsideRoot(absPath, root)) return { ok: true, reason: '' };
  const rel = relative(resolve(root), resolve(absPath));
  return { ok: false, reason: '目标越界（必须位于 ' + resolve(root) + ' 内）: ' + absPath + '（相对 ' + rel + '）' };
}

export default { validateRepoRoot, expandScanTarget, isInsideRoot, assertWithinRoot, REPO_MARKERS, SKIP_DIRS, SOURCE_EXTS, DEFAULT_MAX_FILES };
