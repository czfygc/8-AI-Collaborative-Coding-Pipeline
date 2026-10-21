// orchestrator/lib/license-notice-check.mjs — T-175 产物闸门 ②/4：第三方许可证 / NOTICE 随包核对
//
// 定位：产物能跑 ≠ 可以分发。第三方代码必须**随包署名**：每个运行时依赖都要能在 NOTICE 里找到
//   "<pkg>@<version> <LICENSE标识>" 这样的条目，且许可证标识不在禁用名单里。
//
// 三种结局（严格区分，不糊）：
//   PASS    —— 每个运行时依赖都被署名，且没有禁用许可证，必要的 LICENSE/NOTICE 文件在位；
//   FAIL    —— 有依赖没被署名 / 有禁用许可证 / 缺必需文件 / 格式坏导致可判定失败；
//   UNKNOWN —— **判不了**（如 NOTICE 格式无法解析、依赖清单不存在、依赖条目里没写许可证标识）→
//              显式未知，不当通过（本仓铁律：不存在的数据就是 UNKNOWN）。
//
// 只读：不改产物目录、不联网查许可证（离线可判；需要联网核对时留给人工/发布流程）。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const LICENSE_STATUSES = Object.freeze(['PASS', 'FAIL', 'UNKNOWN']);

// 交付物类型 profile（用户拍板：node-cli + python-package；gui / installer 本期只留位不实现）
export const ARTIFACT_PROFILES = Object.freeze({
  'node-cli': {
    description: '免安装 Node.js CLI（目录即产物）',
    implemented: true,
    manifestFile: 'package.json',
    licenseFile: 'LICENSE',
    noticeFile: 'NOTICE',
    noticeRequired: true,
  },
  'python-package': {
    description: 'Python 包（免安装，源码目录即产物）',
    implemented: true,
    manifestFile: 'pyproject.toml',
    licenseFile: 'LICENSE',
    noticeFile: 'NOTICE',
    noticeRequired: true,
  },
  gui: { description: '图形界面产物（预留，本期不实现）', implemented: false },
  installer: { description: '安装器产物（预留，本期不实现）', implemented: false },
});

// 默认禁用许可证（copyleft / 源码可用条款，分发前需人工确认）
export const DEFAULT_DENY_LICENSES = Object.freeze(['AGPL-3.0', 'AGPL-3.0-only', 'SSPL-1.0', 'BUSL-1.1', 'Elastic-2.0']);

const NAME_RE = /^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;
const LICENSE_RE = /^[A-Za-z0-9.+-]+(?:-[A-Za-z0-9.+-]+)*$/;

// 从 NOTICE 里解析 "<pkg>@<version> <LICENSE>" 或 "<pkg> <version> <LICENSE>" 条目
export function parseNotice(text) {
  const entries = new Map();
  const unparsed = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*[-*]\s*/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const tokens = line.split(/\s+/).filter(Boolean);
    if (tokens.length === 1) {
      // 只有 "pkg@version"：署名在、但没写许可证 → 记为 license=''（判不了 → 显式未知）
      const only = tokens[0];
      let nm = only; let ver = '';
      if (only.includes('@')) { const idx = only.lastIndexOf('@'); ver = only.slice(idx + 1); nm = only.slice(0, idx); }
      if (!NAME_RE.test(nm)) { unparsed.push(line); continue; }
      entries.set(nm, { name: nm, version: ver, license: '' });
      continue;
    }
    if (tokens.length < 2) { unparsed.push(line); continue; }
    const license = tokens[tokens.length - 1];
    let name = tokens[0];
    let version = '';
    if (tokens.length >= 3 && /^v?\d/.test(tokens[1])) {
      version = tokens[1].replace(/^v/, '');
      name = tokens[0];
    } else if (name.includes('@')) {
      const idx = name.lastIndexOf('@');
      version = name.slice(idx + 1);
      name = name.slice(0, idx);
    }
    if (!NAME_RE.test(name) || !LICENSE_RE.test(license)) { unparsed.push(line); continue; }
    entries.set(name, { name, version, license });
  }
  return { entries, unparsed };
}

export function findNoticeFile(root, profile) {
  const p = profile && profile.noticeFile ? profile.noticeFile : 'NOTICE';
  const candidates = [p, 'NOTICE.md', 'NOTICE.txt', 'THIRD-PARTY-NOTICES', 'THIRD-PARTY-NOTICES.md', 'LICENSES'];
  for (const c of candidates) {
    const abs = join(resolve(root), c);
    if (existsSync(abs) && statSync(abs).isFile()) return { name: c, abs };
  }
  return null;
}

export function findLicenseFile(root, profile) {
  const p = profile && profile.licenseFile ? profile.licenseFile : 'LICENSE';
  const candidates = [p, 'LICENSE.md', 'LICENSE.txt', 'COPYING'];
  for (const c of candidates) {
    const abs = join(resolve(root), c);
    if (existsSync(abs) && statSync(abs).isFile()) return { name: c, abs };
  }
  return null;
}



// 从依赖清单里取运行时依赖：node → package.json 的 dependencies；python → requirements.txt
export function readDependencies(root, profile) {
  const absRoot = resolve(root);
  if (profile && profile.manifestFile === 'package.json') {
    const abs = join(absRoot, 'package.json');
    if (!existsSync(abs)) return { status: 'UNKNOWN', reason: '缺 package.json', deps: [] };
    let pkg;
    try { pkg = JSON.parse(readFileSync(abs, 'utf8')); } catch (e) { return { status: 'UNKNOWN', reason: 'package.json 解析失败: ' + e.message, deps: [] }; }
    const deps = Object.entries(pkg.dependencies || {}).map(([name, version]) => ({ name, version: String(version).replace(/^[\^~>=<\s]+/, '') }));
    return { status: 'OK', deps, kind: 'node' };
  }
  if (profile && profile.manifestFile === 'pyproject.toml') {
    const abs = join(absRoot, 'requirements.txt');
    if (!existsSync(abs)) return { status: 'OK', deps: [], kind: 'python' };
    const deps = readFileSync(abs, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => {
      const m = l.match(/^([A-Za-z0-9._-]+)\s*(?:[=<>!~]=?\s*([0-9][A-Za-z0-9.*-]*))?/);
      return m ? { name: m[1], version: m[2] || '' } : null;
    }).filter(Boolean);
    return { status: 'OK', deps, kind: 'python' };
  }
  return { status: 'UNKNOWN', reason: '未知 profile 或无依赖清单', deps: [] };
}

// 主检查
export function checkLicenses({
  root, profileName = 'node-cli', denyLicenses = DEFAULT_DENY_LICENSES, noticeRequired = null,
} = {}) {
  const profile = ARTIFACT_PROFILES[profileName];
  if (!profile) return { status: 'UNKNOWN', issues: [{ type: 'profile', detail: '未知 profile: ' + profileName }], checked: [] };
  if (profile.implemented === false) {
    return { status: 'UNKNOWN', issues: [{ type: 'profile', detail: profile.description + '（本期不实现，无闸门）' }], checked: [] };
  }
  const absRoot = resolve(root);
  if (!existsSync(absRoot)) {
    return { status: 'UNKNOWN', issues: [{ type: 'root', detail: '产物目录不存在: ' + absRoot }], checked: [] };
  }
  const issues = [];
  const checked = [];

  const licenseFile = findLicenseFile(absRoot, profile);
  const noticeFile = findNoticeFile(absRoot, profile);

  const depInfo = readDependencies(absRoot, profile);
  if (depInfo.status === 'UNKNOWN') {
    issues.push({ type: 'deps_unknown', detail: depInfo.reason });
  }
  const deps = depInfo.deps || [];

  // NOTICE 只在"确有第三方依赖"时才是必需（没有依赖就不该凭空要求一个空署名文件）
  const needNotice = (noticeRequired === null ? profile.noticeRequired : noticeRequired) && deps.length > 0;

  if (!licenseFile) {
    issues.push({ type: 'missing_license_file', detail: '产物目录缺少 ' + profile.licenseFile + '（分发必须自带许可证）' });
  }
  if (needNotice && !noticeFile) {
    issues.push({ type: 'missing_notice', detail: '产物目录缺少 NOTICE / THIRD-PARTY-NOTICES（第三方署名不可省）' });
  }

  let noticeEntries = new Map();
  if (noticeFile) {
    const parsed = parseNotice(readFileSync(noticeFile.abs, 'utf8'));
    noticeEntries = parsed.entries;
    if (!parsed.entries.size && parsed.unparsed.length) {
      issues.push({ type: 'notice_unparsable', detail: 'NOTICE 存在但没有一行能解析成 "<pkg>@<version> <LICENSE>"（无法判定 → 显式未知）' });
    }
  }

  for (const dep of deps) {
    const hit = noticeEntries.get(dep.name);
    if (!hit) {
      issues.push({ type: 'dep_unattributed', detail: '依赖 ' + dep.name + ' 未在 ' + (noticeFile ? noticeFile.name : 'NOTICE') + ' 中署名' });
      checked.push({ dep: dep.name, version: dep.version, status: 'FAIL' });
      continue;
    }
    if (hit.version && dep.version && !dep.version.startsWith(hit.version) && !hit.version.startsWith(dep.version)) {
      issues.push({ type: 'version_mismatch', detail: '依赖 ' + dep.name + ' 版本与 NOTICE 不符：清单 ' + dep.version + '，NOTICE ' + hit.version });
    }
    const lic = String(hit.license || '').toUpperCase();
    if (!lic) {
      issues.push({ type: 'license_unknown', detail: '依赖 ' + dep.name + ' 在 NOTICE 里没写许可证标识（判不了 → 显式未知）' });
      checked.push({ dep: dep.name, version: dep.version, status: 'UNKNOWN' });
      continue;
    }
    const denied = denyLicenses.find((d) => lic === d.toUpperCase() || lic.includes(d.toUpperCase()));
    if (denied) {
      issues.push({ type: 'denied_license', detail: '依赖 ' + dep.name + ' 许可证 ' + hit.license + ' 在禁用名单里（' + denied + '）' });
      checked.push({ dep: dep.name, version: dep.version, status: 'FAIL' });
      continue;
    }
    checked.push({ dep: dep.name, version: dep.version, license: hit.license, status: 'PASS' });
  }

  const hasUnknown = issues.some((i) => i.type === 'license_unknown' || i.type === 'notice_unparsable' || i.type === 'deps_unknown');
  const hasFail = issues.some((i) => i.type !== 'license_unknown' && i.type !== 'notice_unparsable' && i.type !== 'deps_unknown');
  let status = 'PASS';
  if (hasFail) status = 'FAIL';
  else if (hasUnknown) status = 'UNKNOWN';

  return {
    status, issues, checked,
    license_file: licenseFile ? licenseFile.name : null,
    notice_file: noticeFile ? noticeFile.name : null,
    deps_count: deps.length,
    profile: profileName,
  };
}

export default {
  LICENSE_STATUSES, ARTIFACT_PROFILES, DEFAULT_DENY_LICENSES,
  findNoticeFile, findLicenseFile, parseNotice, readDependencies, checkLicenses,
};
