// T-164: verify-profiles 读侧回归 —— profile 解析 / UNKNOWN 传播 / 命令执行 / 不污染被检仓
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadProfiles, clearCache, resolveProfile, detectLanguage, getCapability, runCapability, VERIFY_STATUS,
} from '../lib/verify-profiles.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = fileURLToPath(new URL('../verify-profile.mjs', import.meta.url));
const CONFIG = join(REPO_ROOT, 'orchestrator', 'config', 'verify-profiles.json');

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 't164-profile-'));
}

test('配置存在且结构完整（version/languages/profiles/capabilities）', () => {
  const cfg = loadProfiles();
  assert.equal(cfg.version, 'v1-r4');
  assert.ok(cfg.languages.js);
  assert.ok(cfg.languages.py);
  assert.ok(cfg.profiles['node:mjs']);
  assert.ok(cfg.profiles['python:pkg']);
  assert.ok(cfg.profiles['node:mjs'].syntax);
  assert.ok(cfg.profiles['node:mjs'].test);
  assert.ok(cfg.profiles['python:pkg'].syntax);
  assert.ok(cfg.profiles['python:pkg'].test);
});

test('语言 → profile 映射；未知语言返回 null（调用方转 UNKNOWN）', () => {
  assert.equal(resolveProfile('js'), 'node:mjs');
  assert.equal(resolveProfile('py'), 'python:pkg');
  assert.equal(resolveProfile('PY'), 'python:pkg');
  assert.equal(resolveProfile('rust'), null);
  assert.equal(resolveProfile(''), null);
});

test('扩展名 → 语言推断', () => {
  assert.equal(detectLanguage('a/b.mjs'), 'js');
  assert.equal(detectLanguage('a\\b.cjs'), 'js');
  assert.equal(detectLanguage('x/y.py'), 'py');
  assert.equal(detectLanguage('x/y.md'), null);
  assert.equal(detectLanguage(''), null);
});

test('UNKNOWN 传播：未知 profile / 缺能力都显式 UNKNOWN，不返回命令', () => {
  const unknownProfile = getCapability(null, 'syntax');
  assert.equal(unknownProfile.status, VERIFY_STATUS.UNKNOWN);
  assert.equal(unknownProfile.command, null);
  assert.ok(unknownProfile.reason.includes('未指定 profile'));

  const missingProfile = getCapability('nope:xx', 'syntax');
  assert.equal(missingProfile.status, VERIFY_STATUS.UNKNOWN);
  assert.ok(missingProfile.reason.includes('profile 不存在'));

  const cap = getCapability('node:mjs', 'syntax');
  assert.equal(cap.status, 'OK');
  assert.deepEqual(cap.command, ['node', '--check', '{file}']);
});

test('执行 node syntax：好文件 PASS、坏文件 FAIL', () => {
  const root = tmpRoot();
  try {
    const good = join(root, 'good.mjs');
    const bad = join(root, 'bad.mjs');
    writeFileSync(good, 'export const a = 1;\n', 'utf8');
    writeFileSync(bad, 'export const a = ;\n', 'utf8');
    const r1 = runCapability({ language: 'js', file: good, capability: 'syntax', cwd: root });
    assert.equal(r1.status, VERIFY_STATUS.PASS, r1.output);
    assert.equal(r1.profile, 'node:mjs');
    const r2 = runCapability({ language: 'js', file: bad, capability: 'syntax', cwd: root });
    assert.equal(r2.status, VERIFY_STATUS.FAIL);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('执行 python syntax：好文件 PASS、坏文件 FAIL，且不写 __pycache__（不污染被检仓）', () => {
  const root = tmpRoot();
  try {
    const good = join(root, 'good.py');
    const bad = join(root, 'bad.py');
    writeFileSync(good, 'def f():\n    return 1\n', 'utf8');
    writeFileSync(bad, 'def f(:\n    return 1\n', 'utf8');
    const r1 = runCapability({ language: 'py', file: good, capability: 'syntax', cwd: root });
    assert.equal(r1.status, VERIFY_STATUS.PASS, r1.output + ' / ' + r1.reason);
    const r2 = runCapability({ language: 'py', file: bad, capability: 'syntax', cwd: root });
    assert.equal(r2.status, VERIFY_STATUS.FAIL);
    const entries = readdirSync(root);
    assert.ok(!entries.includes('__pycache__'), '不应写 __pycache__：' + entries.join(','));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('未知语言执行 → UNKNOWN（不等于通过，也不等于失败）', () => {
  const r = runCapability({ language: 'rust', file: 'x.rs', capability: 'syntax' });
  assert.equal(r.status, VERIFY_STATUS.UNKNOWN);
  assert.equal(r.exitCode, null);
  assert.equal(r.command, null);
});

test('CLI：PASS 退 0 / FAIL 退 1 / UNKNOWN 退 3', () => {
  const root = tmpRoot();
  try {
    const good = join(root, 'good.mjs');
    const bad = join(root, 'bad.mjs');
    writeFileSync(good, 'export const a = 1;\n', 'utf8');
    writeFileSync(bad, 'export const a = ;\n', 'utf8');
    const ok = spawnSync(process.execPath, [CLI, '--language', 'js', '--file', good], { encoding: 'utf8', timeout: 120000 });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /status=PASS/);
    const fail = spawnSync(process.execPath, [CLI, '--language', 'js', '--file', bad], { encoding: 'utf8', timeout: 120000 });
    assert.equal(fail.status, 1);
    const unknown = spawnSync(process.execPath, [CLI, '--file', 'x.rs'], { encoding: 'utf8', timeout: 120000, cwd: root });
    assert.equal(unknown.status, 3, unknown.stdout + unknown.stderr);
    assert.match(unknown.stdout + unknown.stderr, /UNKNOWN/);
    const badLang = spawnSync(process.execPath, [CLI, '--language', 'rust', '--file', 'x.rs'], { encoding: 'utf8', timeout: 120000 });
    assert.equal(badLang.status, 2, '显式非法 --language 属用法错误');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI：--json 输出可解析；用法错误退 2', () => {
  const j = spawnSync(process.execPath, [CLI, '--language', 'js', '--file', 'x.mjs', '--json'], { encoding: 'utf8', timeout: 120000 });
  const parsed = JSON.parse(j.stdout);
    assert.ok(['PASS', 'FAIL', 'UNKNOWN'].includes(parsed.status));
  const bad = spawnSync(process.execPath, [CLI, '--language', 'java'], { encoding: 'utf8', timeout: 120000 });
  assert.equal(bad.status, 2);
  const missingFile = spawnSync(process.execPath, [CLI, '--language', 'js'], { encoding: 'utf8', timeout: 120000 });
  assert.equal(missingFile.status, 2);
});

test('python test 能力命令带禁 cache/禁字节码的环境（不留 .pytest_cache）', () => {
  const cfg = loadProfiles();
  const env = cfg.env['python:pkg'];
  assert.equal(env.PYTHONDONTWRITEBYTECODE, '1');
  assert.ok(env.PYTEST_ADDOPTS.includes('no:cacheprovider'));
});

test('读侧不依赖 shell（配置命令按 argv 逐个执行，元字符不会注入）', () => {
  const cap = getCapability('node:mjs', 'syntax');
  assert.ok(!cap.command.some(p => /[&|;<>$`]/.test(String(p))), '命令里不该有 shell 元字符');
  clearCache();
  assert.equal(loadProfiles().version, 'v1-r4');
});
