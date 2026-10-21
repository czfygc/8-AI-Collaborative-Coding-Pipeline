#!/usr/bin/env node
// orchestrator/artifact-gate.mjs — 产物级闸门 CLI（T-175 四件套）
// 用法:
//   node orchestrator/artifact-gate.mjs manifest --root <dir> [--out <file.json>] [--profile <name>]
//   node orchestrator/artifact-gate.mjs verify-manifest --root <dir> --manifest <file.json>
//   node orchestrator/artifact-gate.mjs license --root <dir> [--profile node-cli|python-package] [--deny-license <id> ...]
//   node orchestrator/artifact-gate.mjs anon-download --page <url> [--release <url>] --download <url>
//        [--sha256 <hex>] [--bytes <n>] [--private <url>] [--json] [--out <file.json>]
//   node orchestrator/artifact-gate.mjs stage-gate --root <dir> [--manifest <file.json>] [--profile <name>]
//        [--code PASS|FAIL|UNKNOWN] [--anon-result <file.json>]
// 退出码: 0=PASS, 1=FAIL, 3=UNKNOWN（显式未知，不当通过）, 2=用法错误
//
// 边界（用户拍板）：**不碰安装器 / 打包 / GUI / 公开发布**；交付物类型只做 node-cli 与 python-package。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildManifest, writeManifest, readManifest, verifyManifest, manifestFingerprint,
} from './lib/artifact-manifest.mjs';
import { checkLicenses, ARTIFACT_PROFILES, DEFAULT_DENY_LICENSES } from './lib/license-notice-check.mjs';
import { verifyAnonDownload, renderAnonReport } from './lib/anon-download-verify.mjs';
import { runStageGate, renderStageGate } from './lib/stage-gate.mjs';

const argv = process.argv.slice(2);
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
const cmd = argv[0];
const asJson = argv.includes('--json');

const HELP = [
  '用法: node orchestrator/artifact-gate.mjs <command> [options]',
  '  manifest --root <dir>            生成产物清单（文件+大小+SHA256）',
  '  verify-manifest --root <dir> --manifest <file>   校验产物与清单严格一致',
  '  license --root <dir>             第三方许可证 / NOTICE 随包核对',
  '  anon-download --page <url> --download <url>      匿名可下载性验收（可抄 EP07 脚本）',
  '  stage-gate --root <dir>          代码/产物/发布 三段独立 PASS 总判',
  '  --profile node-cli|python-package   交付物类型（gui / installer 本期不实现）',
  '  --code PASS|FAIL|UNKNOWN           代码段结论（stage-gate 用；不给 = 未判 = UNKNOWN）',
  '  --anon-result <file.json>          复用 anon-download 的 JSON 结果',
  '退出码: 0=PASS 1=FAIL 3=UNKNOWN 2=用法错误',
].join('\n');

function exitFor(status) {
  return status === 'PASS' ? 0 : (status === 'FAIL' ? 1 : 3);
}

if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
  console.log(HELP);
  process.exit(cmd ? 0 : 2);
}

if (cmd === 'manifest') {
  const root = flagValue('--root');
  if (!root) { console.error('[ARTIFACT-GATE] manifest 需要 --root'); process.exit(2); }
  const profile = flagValue('--profile') || null;
  if (profile && !ARTIFACT_PROFILES[profile]) { console.error('[ARTIFACT-GATE] 未知 profile: ' + profile); process.exit(2); }
  try {
    const manifest = buildManifest({ root, profile, exclude: flagAll('--exclude') });
    const out = flagValue('--out');
    if (out) writeManifest(manifest, out);
    if (asJson) console.log(JSON.stringify(manifest, null, 2));
    else {
      console.log('[ARTIFACT-GATE] profile=' + (profile || 'none') + ' 文件数=' + manifest.file_count + ' 总字节=' + manifest.total_bytes);
      console.log('[ARTIFACT-GATE] 清单指纹 sha256=' + manifestFingerprint(manifest));
      if (out) console.log('[ARTIFACT-GATE] 已写: ' + resolve(out));
    }
    process.exit(0);
  } catch (e) {
    console.error('[ARTIFACT-GATE] 生成清单失败: ' + e.message);
    process.exit(3);
  }
}

if (cmd === 'verify-manifest') {
  const root = flagValue('--root');
  const mpath = flagValue('--manifest');
  if (!root || !mpath) { console.error('[ARTIFACT-GATE] verify-manifest 需要 --root 与 --manifest'); process.exit(2); }
  try {
    const manifest = readManifest(mpath);
    const ignore = [];
    const rel = relative(resolve(root), resolve(mpath)).split('\\').join('/');
    if (rel && !rel.startsWith('..')) ignore.push(rel);
    const res = verifyManifest({ root, manifest, exclude: flagAll('--exclude'), ignore });
    if (asJson) console.log(JSON.stringify(res, null, 2));
    else {
      console.log('[ARTIFACT-GATE] status=' + res.status + ' 清单文件=' + res.checked + ' 磁盘文件=' + res.disk_files);
      for (const i of res.issues.slice(0, 50)) console.log('  ' + i.type.padEnd(12) + i.path + '：' + i.detail);
    }
    process.exit(exitFor(res.status));
  } catch (e) {
    console.error('[ARTIFACT-GATE] 校验失败: ' + e.message);
    process.exit(3);
  }
}

if (cmd === 'license') {
  const root = flagValue('--root');
  if (!root) { console.error('[ARTIFACT-GATE] license 需要 --root'); process.exit(2); }
  const profile = flagValue('--profile') || 'node-cli';
  const deny = flagAll('--deny-license');
  const res = checkLicenses({
    root, profileName: profile,
    denyLicenses: deny.length ? deny : DEFAULT_DENY_LICENSES,
    noticeRequired: argv.includes('--no-notice-required') ? false : null,
  });
  if (asJson) console.log(JSON.stringify(res, null, 2));
  else {
    console.log('[ARTIFACT-GATE] status=' + res.status + ' profile=' + profile + ' 运行时依赖=' + (res.deps_count || 0));
    if (res.license_file) console.log('  LICENSE 文件: ' + res.license_file);
    if (res.notice_file) console.log('  NOTICE 文件: ' + res.notice_file);
    for (const i of res.issues) console.log('  ' + String(i.type).padEnd(20) + i.detail);
  }
  process.exit(exitFor(res.status));
}

if (cmd === 'anon-download') {
  const download = flagValue('--download');
  if (!download) { console.error('[ARTIFACT-GATE] anon-download 需要 --download'); process.exit(2); }
  const expected = {};
  const sha = flagValue('--sha256');
  const bytes = flagValue('--bytes');
  if (sha) expected.sha256 = sha;
  if (bytes) {
    const n = Number(bytes);
    if (!Number.isInteger(n) || n < 0) { console.error('[ARTIFACT-GATE] --bytes 必须是非负整数'); process.exit(2); }
    expected.bytes = n;
  }
  const res = await verifyAnonDownload({
    page: flagValue('--page'), release: flagValue('--release'), download,
    privateRepo: flagValue('--private'), expected,
  });
  const out = flagValue('--out');
  if (out) { mkdirSync(join(resolve(out), '..'), { recursive: true }); writeFileSync(out, JSON.stringify(res, null, 2) + '\n', 'utf8'); }
  if (asJson) console.log(JSON.stringify(res, null, 2));
  else console.log(renderAnonReport(res));
  process.exit(exitFor(res.status));
}

if (cmd === 'stage-gate') {
  const root = flagValue('--root');
  if (!root) { console.error('[ARTIFACT-GATE] stage-gate 需要 --root'); process.exit(2); }
  const profile = flagValue('--profile') || 'node-cli';
  const mpath = flagValue('--manifest');
  let manifestRes = null;
  if (mpath && existsSync(mpath)) {
    try {
      const manifest = readManifest(mpath);
      const relM = relative(resolve(root), resolve(mpath)).split('\\').join('/');
      manifestRes = verifyManifest({ root, manifest, ignore: (relM && !relM.startsWith('..')) ? [relM] : [] });
    } catch (e) {
      manifestRes = { status: 'UNKNOWN', issues: [{ type: 'manifest', detail: '清单读不了: ' + e.message }] };
    }
  } else {
    manifestRes = { status: 'UNKNOWN', issues: [{ type: 'manifest', detail: '未提供可读清单（--manifest）' }] };
  }
  const licenseRes = checkLicenses({ root, profileName: profile });
  const codeArg = flagValue('--code');
  const anonPath = flagValue('--anon-result');
  let anonRes = null;
  if (anonPath && existsSync(anonPath)) {
    try { anonRes = JSON.parse(readFileSync(anonPath, 'utf8')); } catch (e) { anonRes = { status: 'UNKNOWN', checks: [{ name: 'anon_result', status: 'UNKNOWN', detail: '结果文件读不了: ' + e.message }] }; }
  }
  const res = runStageGate({ code: codeArg, manifest: manifestRes, license: licenseRes, anonDownload: anonRes });
  if (asJson) console.log(JSON.stringify(res, null, 2));
  else console.log(renderStageGate(res));
  process.exit(exitFor(res.status));
}

console.error('[ARTIFACT-GATE] 未知命令: ' + cmd + '\n' + HELP);
process.exit(2);
