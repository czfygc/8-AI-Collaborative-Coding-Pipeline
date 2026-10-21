// orchestrator/test/publish-sync.test.mjs — T-125 发布同步账本工具自测
// 覆盖：指纹计算与漂移检测、密钥扫描拦截、发布集边界（不猜测新文件）、账本读写、来源提交推断
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  listPublishedFiles, fingerprint, secretScan, computeDrift, inferSourceCommit,
  readLedger, writeLedger, ledgerPath, isNeverPublish, sourceOf, PUBLISH_MAP
} from '../publish-sync.mjs';

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 't125-repo-'));
  sh('git', ['init', '-q'], dir);
  sh('git', ['config', 'user.name', 't'], dir);
  sh('git', ['config', 'user.email', 't@t'], dir);
  writeFileSync(join(dir, 'a.txt'), 'A\n');
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'sub', 'b.txt'), 'B\n');
  sh('git', ['add', '-A'], dir);
  sh('git', ['commit', '-q', '-m', '[T-001] init'], dir);
  return dir;
}

test('fingerprint: stable for identical content, changes when a file changes', () => {
  const pub = makeRepo();
  try {
    const files = listPublishedFiles(pub);
    const f1 = fingerprint(pub, files);
    writeFileSync(join(pub, 'a.txt'), 'A-CHANGED\n');
    const f2 = fingerprint(pub, files);
    assert.notEqual(f1.sha256, f2.sha256, 'content change must change the fingerprint');
    assert.equal(f1.fileCount, files.length);
    const f3 = fingerprint(pub, files);
    assert.equal(f3.sha256, f2.sha256, 'unchanged content must keep the fingerprint stable');
  } finally { sh('cmd', ['/c', 'rmdir', '/s', '/q', pub]); }
});

test('listPublishedFiles: only git-tracked files count as the publish set', () => {
  const pub = makeRepo();
  try {
    writeFileSync(join(pub, 'untracked.txt'), 'x\n');
    const files = listPublishedFiles(pub);
    assert.ok(files.includes('a.txt') && files.includes('sub/b.txt'), 'tracked files must be listed');
    assert.ok(!files.includes('untracked.txt'), 'untracked files must NOT be in the publish set');
  } finally { sh('cmd', ['/c', 'rmdir', '/s', '/q', pub]); }
});

test('secretScan: blocks key-bearing files and content', () => {
  const dir = mkdtempSync(join(tmpdir(), 't125-sec-'));
  try {
    writeFileSync(join(dir, 'secrets.env'), 'A=1\n');
    writeFileSync(join(dir, 'good.txt'), 'nothing secret here\n');
    writeFileSync(join(dir, 'leak.txt'), 'key = "AIza' + 'B'.repeat(30) + '"\n');
    // PEM 标记分两段拼接：测试源码本身不得含完整特征串（否则工具扫描会把测试文件当敏感件拦截）
    writeFileSync(join(dir, 'pem.txt'), '-----BEGIN RSA ' + 'PRIVATE KEY-----\nxx\n');
    writeFileSync(join(dir, 'path-leak.txt'), 'stored at D:/' + '\u6211\u7684\u6587\u6863/x.md\n');
    writeFileSync(join(dir, 'user-leak.txt'), 'home: C:\\Users\\' + 'somebody\\x\n');
    assert.ok(secretScan(join(dir, 'secrets.env'), 'secrets.env').some((p) => p.includes('deny-path')));
    assert.equal(secretScan(join(dir, 'good.txt'), 'good.txt').length, 0);
    assert.ok(secretScan(join(dir, 'leak.txt'), 'leak.txt').some((p) => p.includes('secret-pattern')));
    assert.ok(secretScan(join(dir, 'pem.txt'), 'pem.txt').some((p) => p.includes('secret-pattern')));
    assert.ok(secretScan(join(dir, 'path-leak.txt'), 'path-leak.txt').some((p) => p.includes('internal personal path')));
    assert.ok(secretScan(join(dir, 'user-leak.txt'), 'user-leak.txt').some((p) => p.includes('machine user path')));
  } finally { sh('cmd', ['/c', 'rmdir', '/s', '/q', dir]); }
});

test('isNeverPublish: ledger-class and instance data are banned, pipeline code is not', () => {
  // 禁推（T-126 用户政策：ISSUE_REGISTRY.json 类永不推 GitHub）
  assert.equal(isNeverPublish('ISSUE_REGISTRY.json'), true);
  assert.equal(isNeverPublish('orchestrator/work-orders.json'), true);
  assert.equal(isNeverPublish('orchestrator/汇总.md'), true);
  assert.equal(isNeverPublish('orchestrator/p2-fixes.md'), true);
  assert.equal(isNeverPublish('orchestrator/audit-evidence/contract-review.md'), true);
  assert.equal(isNeverPublish('titan-memory/core/CORE.md'), true);
  assert.equal(isNeverPublish('.agents/skills/titan-publish-sync/SKILL.md'), true);
  assert.equal(isNeverPublish('PUBLISH_SYNC.json'), true);
  assert.equal(isNeverPublish('reviews/x/layer-b/delta.md'), true);
  assert.equal(isNeverPublish('dispatch-history.log'), true);
  // 可发布（V2 流水线逻辑链）
  assert.equal(isNeverPublish('orchestrator/lib/semantic-guard.mjs'), false);
  assert.equal(isNeverPublish('orchestrator/publish-sync.mjs'), false);
  assert.equal(isNeverPublish('orchestrator/test/publish-sync.test.mjs'), false);
  assert.equal(isNeverPublish('README.md'), false);
  assert.equal(isNeverPublish('.agents/skills/titan-four-party-consult/SKILL.md'), false);
  // 只发布流水线本身，不发布流水线做出的产品（研究产出/实例记忆/文档目录）
  assert.equal(isNeverPublish('docs/publish/AGENTS.md'), true);
  assert.equal(isNeverPublish('titan-memory/core/CORE.md'), true);
  assert.equal(isNeverPublish('titan-memory/notes/2026-10-21-lessons.md'), true);
  assert.equal(isNeverPublish('titan-memory/core/anything.md'), true);
  assert.equal(isNeverPublish('design-specs/anything.md'), true);
});

test('PUBLISH_MAP: 发布树里的 AGENTS.md 取本地公开版（docs/publish/AGENTS.md），不用本地宪法覆盖', () => {
  assert.equal(sourceOf('AGENTS.md'), 'docs/publish/AGENTS.md');
  assert.equal(sourceOf('README.md'), 'README.md');
  assert.equal(sourceOf('orchestrator/lib/task-card.mjs'), 'orchestrator/lib/task-card.mjs');
  // 映射生效时：本地宪法改了内容，也不会被判成"发布树待同步"（因为比对的是公开版来源）
  const local = makeRepo();
  const pub = makeRepo();
  try {
    mkdirSync(join(local, 'docs', 'publish'), { recursive: true });
    writeFileSync(join(local, 'docs', 'publish', 'AGENTS.md'), 'PUBLIC-RULES\n');
    writeFileSync(join(local, 'AGENTS.md'), 'LOCAL-CONSTITUTION\n');
    writeFileSync(join(pub, 'AGENTS.md'), 'PUBLIC-RULES\n');
    sh('git', ['add', '-A'], pub);
    sh('git', ['commit', '-q', '-m', 'add public agents'], pub);
    const files = listPublishedFiles(pub);
    const d = computeDrift(local, pub, files, [], '');
    assert.ok(!d.changed.some((c) => c.file === 'AGENTS.md'), '本地宪法变化不得触发 AGENTS.md 同步: ' + JSON.stringify(d.changed));
    // 公开版改了 → 才会被判为待同步
    writeFileSync(join(local, 'docs', 'publish', 'AGENTS.md'), 'PUBLIC-RULES-V2\n');
    const d2 = computeDrift(local, pub, files, [], '');
    assert.ok(d2.changed.some((c) => c.file === 'AGENTS.md'), '公开版变化必须触发同步: ' + JSON.stringify(d2.changed));
  } finally {
    sh('cmd', ['/c', 'rmdir', '/s', '/q', local]);
    sh('cmd', ['/c', 'rmdir', '/s', '/q', pub]);
  }
});

test('computeDrift: tracked-but-banned files are reported as prune candidates, never as sync targets', () => {
  const local = makeRepo();
  const pub = makeRepo();
  try {
    // 发布树跟踪了一个禁推文件（ISSUE_REGISTRY.json）且本地版不同
    writeFileSync(join(pub, 'ISSUE_REGISTRY.json'), '{"pub":1}\n');
    sh('git', ['add', '-A'], pub);
    sh('git', ['commit', '-q', '-m', 'track ledger'], pub);
    writeFileSync(join(local, 'ISSUE_REGISTRY.json'), '{"local":1}\n');
    const files = listPublishedFiles(pub);
    const d = computeDrift(local, pub, files, [], '');
    assert.ok(d.changedDenied.includes('ISSUE_REGISTRY.json'), 'banned tracked file must be a prune candidate: ' + JSON.stringify(d));
    assert.ok(!d.changed.some((c) => c.file === 'ISSUE_REGISTRY.json'), 'banned file must NOT be a sync target');
  } finally {
    sh('cmd', ['/c', 'rmdir', '/s', '/q', local]);
    sh('cmd', ['/c', 'rmdir', '/s', '/q', pub]);
  }
});

test('computeDrift: modified files detected by content, publish set not guessed', () => {
  const local = makeRepo();
  const pub = makeRepo();
  try {
    // 本地改了一个已发布文件 + 新增一个同目录新文件
    writeFileSync(join(local, 'a.txt'), 'A-CHANGED\n');
    writeFileSync(join(local, 'sub', 'c.txt'), 'C\n');
    const files = listPublishedFiles(pub);
    const d = computeDrift(local, pub, files, [], '');
    const modified = d.changed.map((c) => c.file);
    assert.ok(modified.includes('a.txt'), 'changed file must be detected: ' + JSON.stringify(d));
    // 无来源提交锚点 → 不猜新文件（保持发布集 = 已跟踪）
    assert.equal(d.candidates.length, 0, 'without a source commit anchor no new files may be guessed');
    // 显式指定才进
    const d2 = computeDrift(local, pub, files, ['sub/c.txt'], '');
    assert.deepEqual(d2.explicit, ['sub/c.txt']);
  } finally {
    sh('cmd', ['/c', 'rmdir', '/s', '/q', local]);
    sh('cmd', ['/c', 'rmdir', '/s', '/q', pub]);
  }
});

test('computeDrift: with a source commit anchor, newly added files become candidates', () => {
  const local = makeRepo();
  const pub = makeRepo();
  try {
    const base = sh('git', ['rev-parse', 'HEAD'], local);
    writeFileSync(join(local, 'sub', 'c.txt'), 'C\n');
    sh('git', ['add', '-A'], local);
    sh('git', ['commit', '-q', '-m', '[T-002] add c'], local);
    const files = listPublishedFiles(pub);
    const d = computeDrift(local, pub, files, [], base);
    assert.ok(d.candidates.includes('sub/c.txt'), 'new file in the commit range must be a candidate: ' + JSON.stringify(d.candidates));
  } finally {
    sh('cmd', ['/c', 'rmdir', '/s', '/q', local]);
    sh('cmd', ['/c', 'rmdir', '/s', '/q', pub]);
  }
});

test('inferSourceCommit: matches the task id in the published HEAD message', () => {
  const local = makeRepo();
  const pub = makeRepo();
  try {
    writeFileSync(join(pub, 'a.txt'), 'A-PUB\n');
    sh('git', ['add', '-A'], pub);
    sh('git', ['commit', '-q', '-m', '[T-777] sync to publish tree'], pub);
    const c = inferSourceCommit(local, pub);
    assert.equal(c, '', 'no matching local commit → empty (must not fabricate)');
    sh('git', ['commit', '-q', '--allow-empty', '-m', '[T-777] local counterpart'], local);
    const c2 = inferSourceCommit(local, pub);
    assert.equal(c2.length, 40, 'should find the local commit with the same task id');
  } finally {
    sh('cmd', ['/c', 'rmdir', '/s', '/q', local]);
    sh('cmd', ['/c', 'rmdir', '/s', '/q', pub]);
  }
});

test('ledger: write/read round-trip at the documented path', () => {
  const root = mkdtempSync(join(tmpdir(), 't125-led-'));
  try {
    const led = { schemaVersion: 1, publishTree: 'X', lastSync: { at: 'now', publishedFingerprint: 'abc' } };
    writeLedger(root, led);
    assert.ok(existsSync(ledgerPath(root)), 'ledger must live at PUBLISH_SYNC.json in repo root');
    const back = readLedger(root);
    assert.equal(back.publishTree, 'X');
    assert.equal(back.lastSync.publishedFingerprint, 'abc');
    assert.equal(readLedger(join(root, 'nope')), null, 'missing ledger → null');
  } finally { sh('cmd', ['/c', 'rmdir', '/s', '/q', root]); }
});
