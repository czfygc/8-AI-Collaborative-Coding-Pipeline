// orchestrator/test/semantic-guard-integration.test.mjs — T-123 executor-level integration
// Goal: prove the semantic guard is really wired into titan-execute — a bad fix gets
// intercepted, rolled back and never committed. Deterministic fake executor (no LLM):
//   FAKE_MODE=bad  -> rewrites `s += i;` into `sum += i;` (undeclared identifier, T-122 incident shape)
//   FAKE_MODE=good -> adds a comment only (legit fix, must pass)
// Fixtures are ASCII-only on purpose: delta.md labels use **File** (supported by the
// executor parser) so nothing depends on CJK round-tripping through argv/console.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const EXECUTOR = join(REPO_ROOT, 'orchestrator', 'titan-execute.mjs');

const TARGET = 'lib/foo.mjs';
const TARGET_SRC = [
  'export function sumTo(n) {',
  '  let s = 0;',
  '  for (let i = 1; i <= n; i++) {',
  '    s += i;',
  '  }',
  '  return s;',
  '}',
  ''
].join('\n');

const PAIRED_TEST = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert';",
  "import { sumTo } from '../../lib/foo.mjs';",
  "test('sumTo', () => { assert.equal(sumTo(5), 15); });",
  ''
].join('\n');

const FAKE_EXECUTOR = [
  "import { readFileSync, writeFileSync } from 'node:fs';",
  "const target = process.env.FAKE_TARGET || 'lib/foo.mjs';",
  "let src = readFileSync(target, 'utf8');",
  "if (process.env.FAKE_MODE === 'bad') {",
  "  src = src.replace('s += i;', 'sum += i;');",
  "} else {",
  "  src = src.replace('export function sumTo(n) {', 'export function sumTo(n) {\\n  // verified fix');",
  "}",
  "writeFileSync(target, src, 'utf8');",
  "console.log('fake-executor edited ' + target);",
  ''
].join('\n');

function sh(cmd, args, cwd, env) {
  return spawnSync(cmd, args, { cwd, env: { ...process.env, ...(env || {}) }, encoding: 'utf8' });
}

function scaffold() {
  const root = mkdtempSync(join(tmpdir(), 't123-e2e-'));
  const dispatchId = 'scan-t123fixture';
  const files = {
    [TARGET]: TARGET_SRC,
    'orchestrator/test/foo.test.mjs': PAIRED_TEST,
    'config/executor-profiles.json': JSON.stringify({
      opencode: {
        cmd: ['node', join(root, 'fake-executor.mjs')],
        cwd: '${TITAN_ROOT}',
        timeoutMs: 60000,
        env: {}
      }
    }, null, 2),
    'fake-executor.mjs': FAKE_EXECUTOR,
    ['reviews/' + dispatchId + '/layer-b/delta.md']: [
      '### DELTA-001',
      '**File**: `' + TARGET + '`',
      '**Finding**: loop bound of sumTo needs a look',
      '**Action**: keep the correct behaviour',
      ''
    ].join('\n'),
    ['reviews/' + dispatchId + '/layer-b/architect-decision.md']: [
      'DELTA-001',
      'Decision: ACCEPT',
      ''
    ].join('\n')
  };
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
  sh('git', ['init', '-q'], root);
  sh('git', ['config', 'user.name', 'titan-fixture'], root);
  sh('git', ['config', 'user.email', 'fixture@titan.local'], root);
  sh('git', ['add', '-A'], root);
  sh('git', ['commit', '-q', '-m', 'fixture'], root);
  return { root, dispatchId };
}

function logCount(root) {
  const r = sh('git', ['rev-list', '--count', 'HEAD'], root);
  return parseInt(String(r.stdout || '').trim() || '0', 10);
}

function resultOf(root, dispatchId) {
  const p = join(root, 'reviews', dispatchId, 'layer-b', 'execute-result.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

function cleanup(root) {
  spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', root], { encoding: 'utf8' });
}

test('integration: bad edit (s+=i -> sum+=i) is intercepted, rolled back, never committed', () => {
  const { root, dispatchId } = scaffold();
  try {
    const before = logCount(root);
    const r = sh('node', [EXECUTOR, dispatchId, '--skip-baseline'], root, {
      D_TITAN_ROOT: root, FAKE_MODE: 'bad', FAKE_TARGET: join(root, TARGET)
    });
    const res = resultOf(root, dispatchId);
    assert.ok(res, 'execute-result.json must exist');
    assert.equal(res.verifyStatus, 'FAIL', 'expected FAIL, got: ' + res.verifyStatus + ' / ' + JSON.stringify(res.deltas) + '\n' + r.stdout);
    const d0 = res.deltas[0];
    assert.equal(d0.status, 'FAIL');
    assert.ok(String(d0.reason).includes('semantic-guard'), 'reason must mention semantic-guard: ' + d0.reason);
    assert.equal(logCount(root), before, 'no new commit allowed for a bad fix');
    const src = readFileSync(join(root, TARGET), 'utf8');
    assert.ok(!src.includes('sum += i'), 'bad edit must be rolled back, current: ' + src);
    assert.ok(String(r.stdout || '').includes('sum'), 'stdout must show the interception detail');
  } finally { cleanup(root); }
});

test('integration: legit edit (comment only, test still green) passes the guard and commits', () => {
  const { root, dispatchId } = scaffold();
  try {
    const before = logCount(root);
    const r = sh('node', [EXECUTOR, dispatchId, '--skip-baseline'], root, {
      D_TITAN_ROOT: root, FAKE_MODE: 'good', FAKE_TARGET: join(root, TARGET)
    });
    const res = resultOf(root, dispatchId);
    assert.ok(res, 'execute-result.json must exist');
    assert.equal(res.verifyStatus, 'PASS', 'expected PASS, got: ' + res.verifyStatus + ' / ' + JSON.stringify(res.deltas) + '\n' + r.stdout);
    assert.equal(res.deltas[0].semantic, 'PASS', 'semantic status must be PASS: ' + JSON.stringify(res.deltas[0]));
    assert.equal(logCount(root), before + 1, 'a new commit is expected');
    assert.ok(readFileSync(join(root, TARGET), 'utf8').includes('// verified fix'), 'change must be on disk');
  } finally { cleanup(root); }
});
