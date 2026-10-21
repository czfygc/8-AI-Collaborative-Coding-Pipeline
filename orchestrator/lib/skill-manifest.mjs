// orchestrator/lib/skill-manifest.mjs — T-151 技能/插件 manifest（只读生成器 + 内容寻址发布）
//
// 目标（借鉴 cursor/plugins 的 .cursor-plugin/plugin.json + claude-plugins-official 的
//       immutable slug / renames / skill-bundle）：给 .agents/skills/ 建一份**并行事实源**，
//       记录每个技能的 name/slug/version/source/sha256/entrypoints/readOnly，
//       供四客户端与发布流程做「内容寻址（CAS）+ 并发写冲突显式失败」。
//
// 红线（台账 T-151 原文）：
//   1. **不改目录式技能发现方式**——.agents/skills/*/SKILL.md 仍是唯一发现入口；
//      manifest 只是旁路事实源，不接管加载、不替换任何东西。
//   2. 生成器**只读**技能目录；只写 manifest 文件本身。
//   3. 并发写冲突**显式失败**（不静默覆盖他人改动）：锁 + baseSnapshot 比对 + 可选 CAS 期望哈希。
//   4. 不改技能正文；readOnly 默认 true（只读），技能可显式声明 write: true 才记 false。
//
// 字段来源：frontmatter 六字段沿用 T-155 技能质量门（name/description/version/requires/tests/provenance），
//           另加本模块专属的 sha256 / treeSha256 / entrypoints / readOnly / source 拆解。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './skill-quality.mjs';
import { withLockedJsonWrite, sha256OfText } from './lock.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const MANIFEST_SCHEMA_VERSION = 'v1';
export const DEFAULT_SKILLS_ROOT = join(REPO_ROOT, '.agents', 'skills');
export const DEFAULT_MANIFEST_PATH = join(DEFAULT_SKILLS_ROOT, 'SKILL_MANIFEST.json');
export const SKIP_ENTRY_DIRS = new Set(['node_modules', '.git', '__pycache__']);

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// 技能目录内的文件清单（相对路径，去点目录），用于 entrypoints
export function listSkillFiles(skillDir) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_ENTRY_DIRS.has(e.name)) continue;
        walk(p, depth + 1);
      } else if (e.isFile()) {
        out.push(relative(skillDir, p).split('\\').join('/'));
      }
    }
  };
  walk(skillDir, 0);
  return out.sort();
}

// provenance 字符串拆解：original | adapted:<src>#<ref> | vendored:<src>#<ref>
export function parseProvenance(value) {
  const v = String(value || '').trim();
  if (!v) return { kind: 'unknown', origin: '', ref: '' };
  if (v === 'original') return { kind: 'original', origin: '', ref: '' };
  const m = v.match(/^(adapted|vendored):\s*(\S+?)(?:#(\S+))?$/);
  if (!m) return { kind: 'unknown', origin: v, ref: '' };
  return { kind: m[1], origin: m[2], ref: m[3] || '' };
}

// 单技能条目（只读扫描）
export function buildSkillEntry(skillDir, { skillsRoot = DEFAULT_SKILLS_ROOT } = {}) {
  const name = skillDir.split(/[\\/]/).pop();
  const file = join(skillDir, 'SKILL.md');
  if (!existsSync(file)) return null;
  const raw = readFileSync(file);
  const fm = parseFrontmatter(raw.toString('utf8'));
  const f = fm.fields || {};
  const files = listSkillFiles(skillDir);
  const treeParts = files.map((rel) => {
    const abs = join(skillDir, rel);
    let h = '';
    try { h = sha256(readFileSync(abs)); } catch { h = 'unreadable'; }
    return rel + ':' + h;
  });
  return {
    name: f.name || name,
    slug: f.name || name,
    version: typeof f.version === 'string' ? f.version : '',
    source: parseProvenance(f.provenance),
    sha256: sha256(raw),
    treeSha256: sha256(treeParts.join('\n')),
    entrypoints: files,
    readOnly: !(typeof f.write === 'string' && f.write.toLowerCase() === 'true'),
    requires: typeof f.requires === 'string' ? f.requires : '',
    tests: typeof f.tests === 'string' ? f.tests : '',
    provenance: typeof f.provenance === 'string' ? f.provenance : '',
    description: typeof f.description === 'string' ? f.description : '',
  };
}

// 扫全部技能 → manifest
export function buildManifest({ skillsRoot = DEFAULT_SKILLS_ROOT, base = null } = {}) {
  const root = resolve(skillsRoot);
  const entries = [];
  if (existsSync(root)) {
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const entry = buildSkillEntry(join(root, d.name), { skillsRoot: root });
      if (entry) entries.push(entry);
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    generator: 'orchestrator/skill-manifest.mjs',
    baseRevision: base ? base.revision || null : null,
    skills: entries,
  };
}

// manifest ↔ 磁盘差异（added / removed / changed / unchanged）
export function compareManifest(manifest, entries) {
  const old = new Map((manifest && manifest.skills ? manifest.skills : []).map(s => [s.name, s]));
  const cur = new Map(entries.map(s => [s.name, s]));
  const added = [];
  const changed = [];
  const unchanged = [];
  for (const [name, e] of cur) {
    const o = old.get(name);
    if (!o) { added.push(name); continue; }
    if (o.sha256 !== e.sha256 || o.treeSha256 !== e.treeSha256 || o.version !== e.version) changed.push(name);
    else unchanged.push(name);
  }
  const removed = [...old.keys()].filter(n => !cur.has(n));
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort(), unchanged: unchanged.sort() };
}

export function readManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  if (!existsSync(manifestPath)) return null;
  try { return JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { return null; }
}

// 写入（锁 + baseSnapshot 比对 + CAS 期望哈希 → 并发写冲突显式失败）
// expectSha256 语义：调用方看到的 manifest 版本哈希（CAS 期望值）。不符 = 他端已改 → 拒写。
export function applyManifest({
  manifestPath = DEFAULT_MANIFEST_PATH, skillsRoot = DEFAULT_SKILLS_ROOT,
  expectSha256 = null, generator = 'orchestrator/skill-manifest.mjs',
} = {}) {
  const current = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '';
  const currentHash = sha256OfText(current);
  if (expectSha256 && expectSha256 !== currentHash) {
    return {
      ok: false,
      status: 'conflict',
      detail: 'CAS 期望哈希不符（manifest 已被他端改动）：期望 ' + expectSha256 + '，实际 ' + currentHash + '。请重读后重试。',
    };
  }
  const result = withLockedJsonWrite(manifestPath, {
    // 锁内重读比对：他端在「读」与「写」之间改了 manifest → 冲突，拒绝覆盖
    baseSnapshot: currentHash,
    lockPath: manifestPath + '.write.lock',
    produceDoc: () => {
      const m = buildManifest({ skillsRoot, base: { revision: currentHash } });
      m.generator = generator;
      return m;
    },
  });
  if (result.ok) {
    const m = readManifest(manifestPath);
    return { ok: true, status: 'written', manifest: m, path: manifestPath, revision: sha256OfText(readFileSync(manifestPath, 'utf8')) };
  }
  return { ...result, path: manifestPath };
}

// 校验：manifest 与磁盘一致？（CI/verify 用）
export function verifyManifest({ manifestPath = DEFAULT_MANIFEST_PATH, skillsRoot = DEFAULT_SKILLS_ROOT } = {}) {
  const manifest = readManifest(manifestPath);
  if (!manifest) return { ok: false, issues: ['manifest 不存在: ' + manifestPath], diff: null };
  const issues = [];
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) issues.push('schemaVersion 不匹配: ' + manifest.schemaVersion);
  const entries = buildManifest({ skillsRoot }).skills;
  const diff = compareManifest(manifest, entries);
  if (diff.added.length) issues.push('未登记的技能: ' + diff.added.join(', '));
  if (diff.removed.length) issues.push('manifest 里已不存在的技能: ' + diff.removed.join(', '));
  if (diff.changed.length) issues.push('内容已变（需重新 build/apply）: ' + diff.changed.join(', '));
  return { ok: issues.length === 0, issues, diff };
}

export default {
  MANIFEST_SCHEMA_VERSION, DEFAULT_SKILLS_ROOT, DEFAULT_MANIFEST_PATH,
  listSkillFiles, parseProvenance, buildSkillEntry, buildManifest, compareManifest,
  readManifest, applyManifest, verifyManifest,
};
