#!/usr/bin/env node
// orchestrator/skill-quality.mjs — T-155 技能质量门 CLI
// 用法: node orchestrator/skill-quality.mjs [--skills-dir <path>] [--json] [--strict]
// 退出码: 0=全绿, 1=有不合规技能（--strict 时告警也算不合规）
//
// 逐技能打印 PASS/FAIL + 原因，末尾给汇总行。CI 步骤与本地体检共用同一实现。

import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSkills } from './lib/skill-quality.mjs';

const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : null;
}
const asJson = argv.includes('--json');
const strict = argv.includes('--strict');
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const skillsRoot = resolve(flagValue('--skills-dir') || join(REPO_ROOT, '.agents', 'skills'));

const r = scanSkills({ skillsRoot, repoRoot: REPO_ROOT });

if (asJson) {
  console.log(JSON.stringify({
    root: r.root,
    total: r.total,
    passed: r.passed,
    failed: r.failed,
    warned: r.warned,
    skills: r.skills.map(s => ({
      name: s.name, ok: s.ok, errors: s.errors, warnings: s.warnings,
      version: s.meta ? s.meta.version : null,
      versionNormalized: s.meta ? s.meta.versionNormalized : null,
      provenance: s.meta ? s.meta.provenance : null,
    })),
  }, null, 2));
  process.exit(r.failed > 0 || (strict && r.warned > 0) ? 1 : 0);
}

if (r.missing) {
  console.error('[SKILL-QUALITY] 技能目录不存在: ' + skillsRoot);
  process.exit(1);
}

for (const s of r.skills) {
  if (s.ok) {
    const warn = s.warnings.length ? ' (warn: ' + s.warnings.join('; ') + ')' : '';
    console.log('[SKILL-QUALITY] PASS ' + s.name + ' v' + (s.meta.versionNormalized || s.meta.version || '?') + warn);
  } else {
    console.log('[SKILL-QUALITY] FAIL ' + s.name);
    for (const e of s.errors) console.log('    - ' + e);
    for (const w of s.warnings) console.log('    ~ ' + w);
  }
}
console.log('[SKILL-QUALITY] 技能 ' + r.total + ' 个：合规 ' + r.passed + '，不合规 ' + r.failed + '，带告警 ' + r.warned);
if (r.failed > 0 || (strict && r.warned > 0)) {
  console.log('[SKILL-QUALITY] RESULT: FAIL');
  process.exit(1);
}
console.log('[SKILL-QUALITY] RESULT: OK');
process.exit(0);
