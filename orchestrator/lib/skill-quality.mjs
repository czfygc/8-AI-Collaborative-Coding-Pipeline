// orchestrator/lib/skill-quality.mjs — T-155 技能质量门（零依赖确定性校验器）
//
// 目的：让 .agents/skills/ 下每个技能都带可机器校验的质量元数据，
//       避免"技能越加越多、没人知道哪个还活着/哪个缺依赖/哪个能验证"。
// 来源：T-149 报告 §七 P2-6（借鉴 scientific-agent-skills 的 version/requires/tests/provenance）。
//
// 必填字段（frontmatter）：
//   name        与目录名一致，^[a-z0-9][a-z0-9-]*$
//   description 20..1200 字符（T-146 既有口径）
//   version     MAJOR.MINOR[.PATCH]（支持 metadata.version 回退，2 段视为 2 段告警）
//   requires    非空依赖清单（逗号分隔），禁 shell 元字符；无依赖写 none
//   tests       验证方式：node --test <file> | node <script> | manual: <步骤>
//   provenance  original | adapted:<src>#<ref> | vendored:<src>#<ref>
//
// 设计约束：
//   1. 零依赖、纯函数、无网络、无模型判断——同一份输入永远同一份结论（可回归）。
//   2. 只做结构校验，不评价技能内容质量（内容质量靠人/评审）。
//   3. tests 指向 orchestrator/test/ 下的文件时必须真实存在——防"声明了不存在的测试"。
//
// 用法：
//   import { scanSkills, validateSkill } from './skill-quality.mjs';
//   const r = scanSkills({ skillsRoot: 'D:/x/.agents/skills' });
//   if (r.failed) console.error(r.skills.filter(s => !s.ok));

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_FIELDS = Object.freeze([
  'name', 'description', 'version', 'requires', 'tests', 'provenance',
]);

export const SEMVER_RE = /^\d+\.\d+(\.\d+)?$/;
export const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
export const SHELL_META_RE = /[&|;<>$`\\]/;
export const DESCRIPTION_MIN = 20;
export const DESCRIPTION_MAX = 1200;

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

// ---------- frontmatter 解析 ----------

export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return { present: false, fields: {}, raw: null };
  const fields = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim().replace(/^["']|["']$/g, '');
    if (val !== '') {
      fields[key] = val;
      continue;
    }
    // 空值 -> 可能是嵌套映射（例：metadata:\n  version: "2.6"）
    const nested = {};
    let j = i + 1;
    for (; j < lines.length; j++) {
      const sub = lines[j].match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!sub) break;
      nested[sub[1]] = sub[2].trim().replace(/^["']|["']$/g, '');
    }
    if (Object.keys(nested).length) {
      fields[key] = nested;
      i = j - 1;
    } else {
      fields[key] = '';
    }
  }
  return { present: true, fields, raw: m[1] };
}

function pickVersion(fields) {
  if (typeof fields.version === 'string' && fields.version !== '') return { value: fields.version, from: 'version' };
  if (fields.metadata && typeof fields.metadata === 'object' && typeof fields.metadata.version === 'string' && fields.metadata.version !== '') {
    return { value: fields.metadata.version, from: 'metadata.version' };
  }
  return { value: '', from: null };
}

function pickTestsPath(tests) {
  const m = String(tests).match(/orchestrator[\\/]test[\\/][\w.\-]+\.(?:mjs|js|cjs)/);
  return m ? m[0].replace(/\\/g, '/') : null;
}

function parseProvenance(value) {
  const v = String(value || '').trim();
  if (!v) return { ok: false, kind: '', source: '', ref: '' };
  if (v === 'original') return { ok: true, kind: 'original', source: '', ref: '' };
  const m = v.match(/^(adapted|vendored):\s*(\S+?)(?:#(\S+))?$/);
  if (!m) return { ok: false, kind: '', source: '', ref: '' };
  if (!m[3]) return { ok: false, kind: m[1], source: m[2], ref: '' };
  return { ok: true, kind: m[1], source: m[2], ref: m[3] };
}

// ---------- 单技能校验 ----------

export function validateSkill({ dirName, raw, repoRoot = REPO_ROOT }) {
  const errors = [];
  const warnings = [];
  const meta = {
    name: '', version: '', versionNormalized: '', versionFrom: null,
    requires: '', tests: '', provenance: '', provenanceKind: '',
  };

  if (raw && raw.charCodeAt(0) === 0xfeff) errors.push('SKILL.md 带 BOM');
  const fm = parseFrontmatter(raw || '');
  if (!fm.present) {
    errors.push('缺 frontmatter（--- 包裹的元数据块）');
    return { name: dirName, ok: false, errors, warnings, meta, fields: {} };
  }
  const f = fm.fields;

  // name
  meta.name = typeof f.name === 'string' ? f.name : '';
  if (!meta.name) errors.push('缺 name');
  else if (meta.name !== dirName) errors.push('name 与目录名不一致：' + meta.name + ' != ' + dirName);
  else if (!NAME_RE.test(meta.name)) errors.push('name 非法（只允许小写字母/数字/连字符）：' + meta.name);

  // description
  const desc = typeof f.description === 'string' ? f.description : '';
  if (!desc) errors.push('缺 description');
  else if (desc.length < DESCRIPTION_MIN) errors.push('description 太短（' + desc.length + ' < ' + DESCRIPTION_MIN + '）');
  else if (desc.length > DESCRIPTION_MAX) errors.push('description 过长（' + desc.length + ' > ' + DESCRIPTION_MAX + '）');

  // version
  const v = pickVersion(f);
  meta.versionFrom = v.from;
  meta.version = v.value;
  if (!v.value) errors.push('缺 version（或 metadata.version）');
  else if (!SEMVER_RE.test(v.value)) errors.push('version 非法（应为 MAJOR.MINOR[.PATCH]）：' + v.value);
  else {
    meta.versionNormalized = v.value.split('.').length === 2 ? v.value + '.0' : v.value;
    if (v.value.split('.').length === 2) warnings.push('version 只写两段，建议补 PATCH：' + v.value);
    if (v.from === 'metadata.version') warnings.push('version 走 metadata.version 回退，建议提到顶层 version');
  }

  // requires
  const req = typeof f.requires === 'string' ? f.requires.trim() : '';
  meta.requires = req;
  if (!req) errors.push('缺 requires（无依赖写 none）');
  else if (SHELL_META_RE.test(req)) errors.push('requires 含 shell 元字符：' + req);
  else {
    const items = req.split(',').map(s => s.trim()).filter(Boolean);
    if (!items.length) errors.push('requires 为空');
    if (items.length > 1 && items.includes('none')) warnings.push('requires 同时含 none 与其它依赖');
  }

  // tests
  const t = typeof f.tests === 'string' ? f.tests.trim() : '';
  meta.tests = t;
  if (!t) errors.push('缺 tests（写验证命令，或 manual: <步骤>）');
  else if (SHELL_META_RE.test(t)) errors.push('tests 含 shell 元字符：' + t);
  else {
    const testPath = pickTestsPath(t);
    if (testPath) {
      const abs = join(repoRoot, testPath);
      if (!existsSync(abs)) errors.push('tests 指向的测试文件不存在：' + testPath);
    } else if (!/^manual:/i.test(t) && !/^(node|npm|python|bash|pwsh)\b/i.test(t)) {
      warnings.push('tests 既非命令也非 manual: 前缀，难以机器复现');
    }
  }

  // provenance
  const prov = typeof f.provenance === 'string' ? f.provenance.trim() : '';
  meta.provenance = prov;
  if (!prov) errors.push('缺 provenance（original | adapted:<src>#<ref> | vendored:<src>#<ref>）');
  else {
    const p = parseProvenance(prov);
    meta.provenanceKind = p.kind;
    if (!p.ok) {
      if (p.kind) errors.push('provenance 缺 ref（需 <src>#<ref>）：' + prov);
      else errors.push('provenance 非法：' + prov);
    }
  }

  return { name: dirName, ok: errors.length === 0, errors, warnings, meta, fields: f };
}

// ---------- 目录扫描 ----------

export function scanSkills({ skillsRoot = join(REPO_ROOT, '.agents', 'skills'), repoRoot = REPO_ROOT } = {}) {
  const root = resolve(skillsRoot);
  const skills = [];
  if (!existsSync(root)) {
    return { root, total: 0, passed: 0, failed: 0, warned: 0, skills: [], missing: true };
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(root, entry.name, 'SKILL.md');
    if (!existsSync(file)) continue;
    let raw = '';
    try { raw = readFileSync(file, 'utf8'); } catch (e) {
      skills.push({ name: entry.name, ok: false, errors: ['读取失败：' + e.message], warnings: [], meta: {}, bytes: 0 });
      continue;
    }
    const r = validateSkill({ dirName: entry.name, raw, repoRoot });
    skills.push({ name: entry.name, ok: r.ok, errors: r.errors, warnings: r.warnings, meta: r.meta, bytes: statSync(file).size });
  }
  const passed = skills.filter(s => s.ok).length;
  const warned = skills.filter(s => s.ok && s.warnings.length).length;
  return { root, total: skills.length, passed, failed: skills.length - passed, warned, skills, missing: false };
}

export function findSkillDir(skillsRoot, name) {
  const dir = join(resolve(skillsRoot), basename(name));
  const file = join(dir, 'SKILL.md');
  return existsSync(file) ? { dir, file } : null;
}

export default { parseFrontmatter, validateSkill, scanSkills, findSkillDir, REQUIRED_FIELDS };
