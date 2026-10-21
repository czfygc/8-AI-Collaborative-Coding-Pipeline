// T-161: 共享测试运行器回归 —— 框架探测 / 命令构造 / 输出解析 / 退化安全 / target 白名单 / 端到端
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectFramework, buildCommand, parseOutput, runTests, formatText, isSafeTarget, FRAMEWORKS } from '../lib/test-runner.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CLI = fileURLToPath(new URL('../run-tests.mjs', import.meta.url));

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 't161-tests-'));
}

test('框架探测：vitest / jest / npm-test / pytest / node:test 各能识别', () => {
  const root = tmpRoot();
  try {
    const a = join(root, 'vit'); mkdirSync(a);
    writeFileSync(join(a, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^2' } }));
    assert.equal(detectFramework(a).framework, 'vitest');

    const b = join(root, 'jes'); mkdirSync(b);
    writeFileSync(join(b, 'package.json'), JSON.stringify({ dependencies: { jest: '^29' } }));
    assert.equal(detectFramework(b).framework, 'jest');

    const c = join(root, 'npm'); mkdirSync(c);
    writeFileSync(join(c, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    assert.equal(detectFramework(c).framework, 'npm-test');

    const d = join(root, 'py'); mkdirSync(d);
    writeFileSync(join(d, 'pyproject.toml'), '[project]\nname="x"\n');
    assert.equal(detectFramework(d).framework, 'pytest');

    const e = join(root, 'nd'); mkdirSync(join(e, 'test'), { recursive: true });
    writeFileSync(join(e, 'test', 'a.test.js'), '//\n');
    assert.equal(detectFramework(e).framework, 'node');

    const f = join(root, 'none'); mkdirSync(f);
    assert.equal(detectFramework(f).framework, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('命令构造：各框架默认命令与 last_failed 变体', () => {
  assert.equal(buildCommand('node', {}), 'node --test');
  assert.equal(buildCommand('node', { target: 'test/a.test.js' }), 'node --test test/a.test.js');
  assert.equal(buildCommand('vitest', { lastFailed: true }), 'npx vitest run --lastFailed');
  assert.equal(buildCommand('jest', { lastFailed: true }), 'npx jest --onlyFailures --ci');
  assert.equal(buildCommand('pytest', { lastFailed: true }), 'python -m pytest -q --lf');
  assert.equal(buildCommand('pytest', { target: 'tests/t.py::test_login' }), 'python -m pytest -q tests/t.py::test_login');
  assert.equal(buildCommand('npm-test', {}), 'npm test');
  assert.equal(buildCommand('vitest', { custom: 'pnpm vitest run' }), 'pnpm vitest run');
  assert.equal(buildCommand('unknown-fw', {}), null);
  assert.deepEqual([...FRAMEWORKS], ['vitest', 'jest', 'pytest', 'node', 'npm-test']);
});

test('target 白名单：路径/glob/:: 用例名放行，元字符与 .. 拒绝', () => {
  assert.equal(isSafeTarget('orchestrator/test/run-tests.test.mjs'), true);
  assert.equal(isSafeTarget('tests/t.py::test_login'), true);
  assert.equal(isSafeTarget('test/**/*.test.js'), true);
  assert.equal(isSafeTarget('a & calc'), false);
  assert.equal(isSafeTarget('a; rm -rf /'), false);
  assert.equal(isSafeTarget('$(whoami)'), false);
  assert.equal(isSafeTarget('../outside'), false);
  assert.equal(isSafeTarget(''), true);
});

test('解析：node:test（spec 与 TAP 两种 reporter）+ 失败用例名与错误', () => {
  const spec = [
    'ℹ tests 3',
    'ℹ suites 0',
    'ℹ pass 2',
    'ℹ fail 1',
    '',
    '✖ broken case (1.234ms)',
    "  Error: expected 'WORLD' to equal 'WRLD'",
  ].join('\n');
  const r1 = parseOutput('node', spec);
  assert.equal(r1.parsed, true);
  assert.equal(r1.summary.total, 3);
  assert.equal(r1.summary.passed, 2);
  assert.equal(r1.summary.failed, 1);
  assert.equal(r1.failures.length, 1);
  assert.match(r1.failures[0].name, /broken case/);

  const tap = [
    'TAP version 13',
    'not ok 1 - string: broken case',
    '  ---',
    '  error: |',
    '    Expected values to be strictly equal',
    '  ...',
    '# tests 1',
    '# pass 0',
    '# fail 1',
  ].join('\n');
  const r2 = parseOutput('node', tap);
  assert.equal(r2.parsed, true);
  assert.equal(r2.summary.failed, 1);
  assert.match(r2.failures[0].name, /broken case/);
  assert.ok(r2.failures[0].message.length > 0);
});

test('解析：vitest / jest / pytest 三种输出形态', () => {
  const vitest = 'Tests  1 failed | 4 passed (5)\n × vitest case\n → expected 1 to be 2\n';
  const rv = parseOutput('vitest', vitest);
  assert.equal(rv.summary.total, 5);
  assert.equal(rv.summary.failed, 1);
  assert.equal(rv.summary.passed, 4);
  assert.match(rv.failures[0].name, /vitest case/);

  const jest = 'Tests: 2 failed, 3 passed, 5 total\n● jest case\n  expect(received).toBe(expected)\n';
  const rj = parseOutput('jest', jest);
  assert.equal(rj.summary.total, 5);
  assert.equal(rj.summary.failed, 2);
  assert.equal(rj.summary.passed, 3);

  const pytest = 'FAILED tests/t.py::test_login - AssertionError: bad\n1 failed, 2 passed, 1 skipped in 0.12s\n';
  const rp = parseOutput('pytest', pytest);
  assert.equal(rp.summary.failed, 1);
  assert.equal(rp.summary.passed, 2);
  assert.equal(rp.summary.skipped, 1);
  assert.match(rp.failures[0].name, /test_login/);
});

test('退化安全：无法解析的输出不崩、不谎报通过', () => {
  const r = parseOutput('node', 'hello world, no test summary at all');
  assert.equal(r.parsed, false);
  assert.equal(r.summary.total, 0);
  assert.equal(r.summary.failed, 0);
  assert.deepEqual(r.failures, []);
});

test('runTests：实测跑一组 node:test，产出结构化摘要', () => {
  const root = tmpRoot();
  try {
    const dir = join(root, 'test'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.test.mjs'), [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('good case', () => { assert.equal(1, 1); });",
      "test('bad case', () => { assert.equal(1, 2); });",
    ].join('\n'), 'utf8');
    const r = runTests({ cwd: root, framework: 'auto', timeoutMs: 60000 });
    assert.equal(r.framework, 'node');
    assert.equal(r.ok, false);
    assert.equal(r.exitCode, 1);
    assert.ok(r.summary.total >= 2, 'total=' + r.summary.total);
    assert.equal(r.summary.failed, 1);
    assert.ok(r.failures.some(f => /bad case/.test(f.name)), JSON.stringify(r.failures));
    const text = formatText(r);
    assert.match(text, /SUMMARY: \d+ tests/);
    assert.match(text, /bad case/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runTests：全绿时 ok=true 且失败数为 0', () => {
  const root = tmpRoot();
  try {
    const dir = join(root, 'test'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.test.mjs'), [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('good case', () => { assert.equal(1, 1); });",
    ].join('\n'), 'utf8');
    const r = runTests({ cwd: root, framework: 'auto', timeoutMs: 60000 });
    assert.equal(r.ok, true);
    assert.equal(r.summary.failed, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runTests：危险 target 被拒（不进 shell）', () => {
  const r = runTests({ cwd: tmpRoot(), framework: 'node', target: 'a & calc.exe' });
  assert.equal(r.ok, false);
  assert.match(r.error, /不安全字符/);
});

test('runTests：探测不到框架时给明确错误而不是空跑', () => {
  const root = tmpRoot();
  try {
    const r = runTests({ cwd: root, framework: 'auto' });
    assert.equal(r.ok, false);
    assert.equal(r.framework, 'unknown');
    assert.match(r.error, /无法自动探测测试框架/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI：--json 输出可解析 JSON，退出码反映成败', () => {
  const root = tmpRoot();
  try {
    const dir = join(root, 'test'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.test.mjs'), [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('good case', () => { assert.equal(1, 1); });",
    ].join('\n'), 'utf8');
    const ok = spawnSync(process.execPath, [CLI, '--cwd', root, '--json'], { encoding: 'utf8', timeout: 120000 });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    const parsed = JSON.parse(ok.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.summary.failed, 0);
    assert.ok(parsed.command);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI：默认模式打印人读摘要（不含整段原始输出）', () => {
  const root = tmpRoot();
  try {
    const dir = join(root, 'test'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.test.mjs'), [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('bad case', () => { assert.equal(1, 2); });",
    ].join('\n'), 'utf8');
    const bad = spawnSync(process.execPath, [CLI, '--cwd', root], { encoding: 'utf8', timeout: 120000 });
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /SUMMARY: \d+ tests/);
    assert.match(bad.stdout, /bad case/);
    assert.ok(bad.stdout.length < 8000, '输出过长（省 token 目标失效）: ' + bad.stdout.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('本仓自检：run-tests 能跑出本仓 node --test 摘要', () => {
  // 注意：目标不能是本文件自己（会递归 spawn 自己）——用另一个独立快测文件
  const r = runTests({ cwd: REPO_ROOT, framework: 'node', target: 'orchestrator/test/input-integrity.test.mjs', timeoutMs: 120000 });
  assert.equal(r.framework, 'node');
  assert.equal(r.parsed, true);
  assert.ok(r.summary.total > 0, '未解析出用例数');
  assert.equal(r.summary.failed, 0, JSON.stringify(r.failures));
});
