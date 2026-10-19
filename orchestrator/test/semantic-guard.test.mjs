// orchestrator/test/semantic-guard.test.mjs — T-123 语义护栏自测
// 覆盖：配对测试发现、未声明标识符静态检查（真阳性/假阳性）、基线对照语义回归判定、SKIP 记账。
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverPairedTest, detectUndeclaredIdentifiers, runSemanticGuard, runPairedTest } from '../lib/semantic-guard.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const REPO_TEST_DIR = join(REPO_ROOT, 'orchestrator', 'test');

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 't123-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
  return dir;
}

function diffAdd(...lines) {
  return lines.map((l) => '+' + l).join('\n') + '\n';
}

test('discoverPairedTest：同名精确命中 lib/file-sanity.mjs', () => {
  const hit = discoverPairedTest(join(REPO_ROOT, 'orchestrator', 'lib', 'file-sanity.mjs'), REPO_TEST_DIR);
  assert.ok(hit && hit.endsWith('file-sanity.test.mjs'), '应命中 file-sanity.test.mjs，实际: ' + hit);
});

test('discoverPairedTest：base- 前缀唯一命中 titan-execute → titan-execute-w6.test.mjs', () => {
  const hit = discoverPairedTest(join(REPO_ROOT, 'orchestrator', 'titan-execute.mjs'), REPO_TEST_DIR);
  assert.ok(hit && hit.endsWith('titan-execute-w6.test.mjs'), '应命中 w6 用例，实际: ' + hit);
});

test('discoverPairedTest：无配对 → null', () => {
  const hit = discoverPairedTest(join(REPO_ROOT, 'orchestrator', 'lib', 'no-such-module-xyz.mjs'), REPO_TEST_DIR);
  assert.equal(hit, null);
});

test('静态检查：T-122 run#1 真阳性（s += i 漂移成 sum += i）', () => {
  const dir = fixture({
    'target.js': 'function sumTo(n) {\n  let s = 0;\n  for (let i = 1; i < n; i++) {\n    s += i;\n  }\n  return s;\n}\nmodule.exports = { sumTo };\n'
  });
  try {
    const r = detectUndeclaredIdentifiers(join(dir, 'target.js'), diffAdd('    sum += i;'));
    assert.equal(r.problems.length, 1, '应恰好报 1 条：' + JSON.stringify(r.problems));
    assert.ok(r.problems[0].includes('sum'), '应点名 sum：' + r.problems[0]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('静态检查：新声明变量不误报（let total = 0; total += 1;）', () => {
  // 盘上文件 = 改后内容（护栏读改后文件），diff = 本次新增行
  const dir = fixture({ 'target.js': 'function f() {\n  let total = 0;\n  total += 1;\n  return total;\n}\n' });
  try {
    const r = detectUndeclaredIdentifiers(join(dir, 'target.js'), diffAdd('  let total = 0;', '  total += 1;'));
    assert.equal(r.problems.length, 0, '不应误报：' + JSON.stringify(r.problems));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('静态检查：属性赋值/全局赋值不误报', () => {
  const dir = fixture({ 'target.js': 'function f(obj) {\n  return obj;\n}\n' });
  try {
    const r = detectUndeclaredIdentifiers(join(dir, 'target.js'), diffAdd('  obj.total += 1;', "  process.env.X = '1';", '  console.log(total);'));
    assert.equal(r.problems.length, 0, '不应误报：' + JSON.stringify(r.problems));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('静态检查：标识符在文件他处出现过 → 保守放过', () => {
  const dir = fixture({ 'target.js': 'let counter = 0;\nfunction bump() {\n  return counter;\n}\n' });
  try {
    const r = detectUndeclaredIdentifiers(join(dir, 'target.js'), diffAdd('  counter += 1;'));
    assert.equal(r.problems.length, 0, '不应误报：' + JSON.stringify(r.problems));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runSemanticGuard：基线绿→修复后红 = 语义回归（FAIL 拦截）', () => {
  // 真实场景：测试断的是被改模块的行为——模块改坏，测试随之变红
  const dir = fixture({
    'lib/foo.mjs': 'export function foo() { return 1; }\n',
    'test/foo.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { foo } from '../lib/foo.mjs';\ntest('foo', () => { assert.equal(foo(), 1); });\n"
  });
  try {
    const target = join(dir, 'lib', 'foo.mjs');
    writeFileSync(target, 'export function foo() { return 2; }\n', 'utf8');
    const base = { testFile: join(dir, 'test', 'foo.test.mjs'), ok: true };
    const g = runSemanticGuard(target, { root: dir, testDir: join(dir, 'test'), diffText: diffAdd('export function foo() { return 2; }'), baseline: base });
    assert.equal(g.status, 'FAIL', '应判 FAIL：' + JSON.stringify(g.checks));
    assert.ok(g.problems.some((p) => p.includes('semantic-regression')), '应报 semantic-regression');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runSemanticGuard：基线本就红 → PREEXISTING-FAIL 不阻塞', () => {
  const dir = fixture({
    'lib/foo.mjs': 'export function foo() { return 1; }\n',
    'test/foo.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { foo } from '../lib/foo.mjs';\ntest('foo', () => { assert.equal(foo(), 99); });\n"
  });
  try {
    const target = join(dir, 'lib', 'foo.mjs');
    const base = { testFile: join(dir, 'test', 'foo.test.mjs'), ok: false };
    const g = runSemanticGuard(target, { root: dir, testDir: join(dir, 'test'), diffText: diffAdd('export function foo() { return 3; }'), baseline: base });
    assert.equal(g.problems.length, 0, '既有红测试不应阻塞：' + JSON.stringify(g.problems));
    const chk = g.checks.find((c) => c.name === 'paired-regression-test');
    assert.equal(chk.status, 'PREEXISTING-FAIL');
    assert.equal(g.status, 'SKIP', '无行为证据 → 记 SKIP，实际: ' + g.status);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runSemanticGuard：无配对测试 → SKIP 记账（不阻塞，但显式）', () => {
  const dir = fixture({ 'lib/bar.mjs': 'export function bar() { return 1; }\n' });
  try {
    const g = runSemanticGuard(join(dir, 'lib', 'bar.mjs'), { root: dir, testDir: join(dir, 'test'), diffText: diffAdd('  return 1;') });
    assert.equal(g.problems.length, 0);
    assert.equal(g.status, 'SKIP', '应记 SKIP，实际: ' + g.status);
    const chk = g.checks.find((c) => c.name === 'paired-regression-test');
    assert.equal(chk.status, 'SKIP');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runPairedTest：无配对 → status SKIP', () => {
  const r = runPairedTest(join(REPO_ROOT, 'orchestrator', 'lib', 'no-such-module-xyz.mjs'), { root: REPO_ROOT, testDir: REPO_TEST_DIR });
  assert.equal(r.status, 'SKIP');
});
