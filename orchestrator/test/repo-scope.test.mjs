// T-167: 目标仓范围回归 —— 仓库根判定 / 越界判据 / 目录目标展开
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateRepoRoot, expandScanTarget, isInsideRoot, assertWithinRoot, REPO_MARKERS } from '../lib/repo-scope.mjs';

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 't167-scope-'));
}

test('仓库根判定：不存在 / 非目录 / 无标记 → 拒；有 .git 或 AGENTS.md → 过', () => {
  const root = tmpRoot();
  try {
    const notExist = join(root, 'nope');
    const r1 = validateRepoRoot(notExist);
    assert.equal(r1.ok, false);
    assert.match(r1.reason, /不存在/);

    const aFile = join(root, 'f.txt');
    writeFileSync(aFile, 'x', 'utf8');
    const r2 = validateRepoRoot(aFile);
    assert.equal(r2.ok, false);
    assert.match(r2.reason, /必须指向目录/);

    const plain = join(root, 'plain');
    mkdirSync(plain);
    const r3 = validateRepoRoot(plain);
    assert.equal(r3.ok, false);
    assert.match(r3.reason, /不像仓库根/);

    const withGit = join(root, 'withgit');
    mkdirSync(join(withGit, '.git'), { recursive: true });
    const r4 = validateRepoRoot(withGit);
    assert.equal(r4.ok, true);
    assert.equal(r4.marker, '.git');

    const withAgents = join(root, 'withagents');
    mkdirSync(withAgents);
    writeFileSync(join(withAgents, 'AGENTS.md'), '# x', 'utf8');
    const r5 = validateRepoRoot(withAgents);
    assert.equal(r5.ok, true);
    assert.equal(r5.marker, 'AGENTS.md');

    const r6 = validateRepoRoot('relative/path');
    assert.equal(r6.ok, false);
    assert.match(r6.reason, /绝对路径/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('越界判据（DELTA-012 口径）：根内真、根外假、.. 穿越假', () => {
  const root = tmpRoot();
  try {
    const inside = join(root, 'a', 'b.py');
    assert.equal(isInsideRoot(inside, root), true);
    assert.equal(isInsideRoot(root, root), true);
    assert.equal(isInsideRoot(join(root, '..', 'x.py'), root), false);
    assert.equal(isInsideRoot('D:\\other\\x.py', root), false);
    const chk = assertWithinRoot(join(root, '..', 'x.py'), root);
    assert.equal(chk.ok, false);
    assert.match(chk.reason, /越界/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('目录目标展开：取源文件、跳噪声目录、按上限截断', () => {
  const root = tmpRoot();
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(root, '__pycache__'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.py'), 'x=1', 'utf8');
    writeFileSync(join(root, 'src', 'b.mjs'), 'export const a=1;', 'utf8');
    writeFileSync(join(root, 'src', 'readme.md'), '# doc', 'utf8');
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'x', 'utf8');
    writeFileSync(join(root, '__pycache__', 'a.pyc'), 'x', 'utf8');
    const ex = expandScanTarget(join(root, 'src'), { root });
    assert.equal(ex.files.length, 2, JSON.stringify(ex.files));
    assert.ok(ex.files.some(f => f.endsWith('a.py')));
    assert.ok(ex.files.some(f => f.endsWith('b.mjs')));
    assert.ok(!ex.files.some(f => f.includes('node_modules')));
    assert.ok(!ex.files.some(f => f.includes('__pycache__')));

    const capped = expandScanTarget(join(root, 'src'), { root, maxFiles: 1 });
    assert.equal(capped.files.length, 1);
    assert.equal(capped.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('目录展开：单文件目标原样返回；不存在路径给原因', () => {
  const root = tmpRoot();
  try {
    const f = join(root, 'x.py');
    writeFileSync(f, 'x=1', 'utf8');
    const one = expandScanTarget(f, { root });
    assert.deepEqual(one.files, [f]);
    assert.equal(one.truncated, false);
    const none = expandScanTarget(join(root, 'nope.py'), { root });
    assert.equal(none.files.length, 0);
    assert.match(none.reason, /不存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('标记清单含 .git 与 AGENTS.md（外仓 D:\\V8 靠 AGENTS.md 通过）', () => {
  assert.ok(REPO_MARKERS.includes('.git'));
  assert.ok(REPO_MARKERS.includes('AGENTS.md'));
});
