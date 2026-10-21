// orchestrator/lib/artifact-manifest.mjs — T-175 产物闸门 ①/4：产物清单（文件 + 大小 + SHA256）
//
// 定位：交付链第一道闸。**代码过了 ≠ 产物对了**——产物必须有一份可复核的清单：
//   每个文件：相对路径 + 字节数 + SHA256；清单本身可重算、可比对。
//
// 口径：
//   1. 路径统一用**正斜杠相对路径**（跨平台一致，Windows 上也用 / 分隔）；
//   2. 文件顺序**按路径字典序**（同一份产物两次生成 → 同一份清单，便于 diff 与签名）；
//   3. 默认排除：.git / node_modules / .DS_Store / *.log / *.tmp（运行期与依赖目录不进产物清单）；
//   4. **只算文件不算目录**（目录结构由路径隐含）；
//   5. 校验（verifyManifest）分三类问题：missing（清单里有、磁盘没有）/ mismatched（大小或哈希变了）/
//      extra（磁盘有、清单没有）——extra 也算 FAIL：产物目录必须与清单严格一致。
//
// 红线：只读；不改产物目录；不打包、不签名、不安装。

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';

export const MANIFEST_VERSION = 'v1';
export const DEFAULT_EXCLUDES = Object.freeze([
  '.git', 'node_modules', '.DS_Store', 'Thumbs.db', '__pycache__', '.venv', 'venv', '.pytest_cache',
]);

export function toPosix(p) {
  return String(p).split(sep).join('/');
}

export function sha256File(absPath) {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

function isExcluded(rel, excludes) {
  const parts = rel.split('/');
  for (const ex of excludes) {
    if (ex.includes('*')) {
      const re = new RegExp('^' + ex.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      if (parts.some((p) => re.test(p)) || re.test(rel)) return true;
    } else if (parts.includes(ex)) {
      return true;
    }
  }
  return false;
}

export function listFiles(root, { exclude = [] } = {}) {
  const excludes = DEFAULT_EXCLUDES.concat(exclude);
  const out = [];
  const walk = (dir, prefix) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = prefix ? prefix + '/' + e.name : e.name;
      if (isExcluded(rel, excludes)) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) { walk(abs, rel); continue; }
      if (!e.isFile()) continue;
      out.push(rel);
    }
  };
  walk(resolve(root), '');
  return out.sort();
}

// 生成产物清单
export function buildManifest({ root, exclude = [], profile = null, generatedAt = null } = {}) {
  if (!root || !existsSync(root)) throw new Error('产物目录不存在: ' + root);
  const absRoot = resolve(root);
  const files = listFiles(absRoot, { exclude }).map((rel) => {
    const abs = join(absRoot, rel.split('/').join(sep));
    const st = statSync(abs);
    return { path: rel, bytes: st.size, sha256: sha256File(abs) };
  });
  return {
    version: MANIFEST_VERSION,
    profile: profile || null,
    generated_at: generatedAt || new Date().toISOString(),
    root_name: absRoot.split(sep).pop(),
    file_count: files.length,
    total_bytes: files.reduce((s, f) => s + f.bytes, 0),
    files,
  };
}

export function writeManifest(manifest, outPath) {
  const abs = resolve(outPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return abs;
}

export function readManifest(manifestPath) {
  if (!existsSync(manifestPath)) throw new Error('清单文件不存在: ' + manifestPath);
  const j = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!j || !Array.isArray(j.files)) throw new Error('清单文件格式不对（缺 files 数组）: ' + manifestPath);
  return j;
}

// 校验：产物目录与清单是否严格一致
// ignore：额外忽略的相对路径（例如清单文件自己就放在产物目录里 → 它不是产物的一部分）
export function verifyManifest({ root, manifest, exclude = [], ignore = [] }) {
  const issues = [];
  const absRoot = resolve(root);
  const ignoreSet = new Set(ignore.map((p) => toPosix(p)));
  const onDisk = new Map(listFiles(absRoot, { exclude }).filter((rel) => !ignoreSet.has(rel)).map((rel) => [rel, null]));
  const listed = new Map();
  for (const f of manifest.files || []) {
    listed.set(f.path, f);
    const abs = join(absRoot, f.path.split('/').join(sep));
    if (!existsSync(abs)) {
      issues.push({ type: 'missing', path: f.path, detail: '清单里有、磁盘上没有' });
      continue;
    }
    const st = statSync(abs);
    if (st.size !== f.bytes) {
      issues.push({ type: 'mismatched', path: f.path, detail: '大小不一致：清单 ' + f.bytes + '，实际 ' + st.size });
      continue;
    }
    const h = sha256File(abs);
    if (h !== String(f.sha256).toLowerCase()) {
      issues.push({ type: 'mismatched', path: f.path, detail: 'SHA256 不一致：清单 ' + f.sha256 + '，实际 ' + h });
    }
  }
  for (const rel of onDisk.keys()) {
    if (!listed.has(rel)) issues.push({ type: 'extra', path: rel, detail: '磁盘上有、清单里没有' });
  }
  return {
    ok: issues.length === 0,
    status: issues.length === 0 ? 'PASS' : 'FAIL',
    issues,
    checked: listed.size,
    disk_files: onDisk.size,
  };
}

// 清单摘要（人读的指纹）：清单自身的 SHA256 + 文件数 + 总字节
export function manifestFingerprint(manifest) {
  const canonical = JSON.stringify({
    version: manifest.version, profile: manifest.profile,
    files: (manifest.files || []).map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export default {
  MANIFEST_VERSION, DEFAULT_EXCLUDES,
  toPosix, sha256File, listFiles, buildManifest, writeManifest, readManifest, verifyManifest, manifestFingerprint,
};
