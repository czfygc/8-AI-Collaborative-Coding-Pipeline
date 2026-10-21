// T-153: 写闸接入点回归 —— edit-issue（台账）走提案落盘 / safe-write 高风险拒写 / run-gate CLI
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const EDIT_ISSUE = fileURLToPath(new URL('../edit-issue.mjs', import.meta.url));
const SAFE_WRITE = fileURLToPath(new URL('../safe-write.mjs', import.meta.url));
const RUN_GATE = fileURLToPath(new URL('../run-gate.mjs', import.meta.url));

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 't153-int-'));
  const events = join(root, 'events');
  mkdirSync(events, { recursive: true });
  return { root, events, env: { ...process.env, TITAN_RUN_EVENTS_DIR: events } };
}

function run(cmd, args, env, cwd) {
  return spawnSync(process.execPath, [cmd, ...args], { cwd: cwd || REPO_ROOT, encoding: 'utf8', env });
}

test('edit-issue：台账写入走提案闸（attested 确认，提案留痕）', () => {
  const { root, events, env } = sandbox();
  try {
    const reg = join(root, 'ISSUE_REGISTRY.json');
    writeFileSync(reg, JSON.stringify({ issues: {} }, null, 2) + '\n', 'utf8');
    const r = run(EDIT_ISSUE, [
      '--id', 'T-900', '--title', '闸门测试', '--type', 'feat', '--status', 'claimed',
      '--owner', 'opencode', '--description', '写闸接入点测试', '--registry', reg, '--by', 'opencode',
    ], env);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\[GATE\] proposal=/);
    assert.match(r.stdout, /category=ledger/);
    const parsed = JSON.parse(readFileSync(reg, 'utf8'));
    assert.ok(parsed.issues['T-900'], '条目未落盘');
    const proposals = existsSync(join(events, 'proposals')) ? readdirSync(join(events, 'proposals')) : [];
    assert.ok(proposals.length >= 1, '提案未留痕');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('edit-issue：--defer 只提案不落盘，apply 后才写', () => {
  const { root, events, env } = sandbox();
  try {
    const reg = join(root, 'ISSUE_REGISTRY.json');
    writeFileSync(reg, JSON.stringify({ issues: {} }, null, 2) + '\n', 'utf8');
    const r1 = run(EDIT_ISSUE, [
      '--id', 'T-901', '--title', '延迟落盘', '--type', 'fix', '--status', 'claimed',
      '--owner', 'opencode', '--description', 'defer 测试', '--registry', reg, '--by', 'opencode', '--defer',
    ], env);
    assert.equal(r1.status, 0, r1.stdout + r1.stderr);
    assert.match(r1.stdout, /提案已登记，未落盘/);
    const pid = (r1.stdout.match(/proposal=(prop-[A-Za-z0-9._-]+)/) || [])[1];
    assert.ok(pid, '未打印 proposal id');
    assert.equal(JSON.parse(readFileSync(reg, 'utf8')).issues['T-901'], undefined, 'defer 模式不应落盘');

    const c = run(RUN_GATE, ['confirm', '--proposal', pid, '--by', 'kilo'], env);
    assert.equal(c.status, 0, c.stdout + c.stderr);
    const a = run(RUN_GATE, ['apply', '--proposal', pid], env);
    assert.equal(a.status, 0, a.stdout + a.stderr);
    assert.ok(JSON.parse(readFileSync(reg, 'utf8')).issues['T-901'], 'apply 后未落盘');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('safe-write：普通文件直通；高风险目标无确认则拒写', () => {
  const { root, events, env } = sandbox();
  try {
    const plain = join(root, 'notes.md');
    const b64 = join(root, 'plain.b64');
    writeFileSync(b64, Buffer.from('hello\n').toString('base64'), 'utf8');
    const ok = run(SAFE_WRITE, ['--target', plain, '--b64', b64], env);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.equal(readFileSync(plain, 'utf8'), 'hello\n');

    const risky = join(root, 'AGENTS.md');
    const r = run(SAFE_WRITE, ['--target', risky, '--b64', b64], env);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /高风险目标需先提案并确认/);
    assert.equal(existsSync(risky), false, '高风险目标不应被写入');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('safe-write：带 --confirm 的已确认提案可落盘', () => {
  const { root, events, env } = sandbox();
  try {
    const risky = join(root, 'AGENTS.md');
    const content = 'new constitution\n';
    const cfile = join(root, 'content.txt');
    writeFileSync(cfile, content, 'utf8');
    const b64 = join(root, 'content.b64');
    writeFileSync(b64, Buffer.from(content).toString('base64'), 'utf8');
    const p = run(RUN_GATE, ['propose', '--target', risky, '--content-file', cfile, '--by', 'opencode'], env);
    assert.equal(p.status, 0, p.stdout + p.stderr);
    const pid = (p.stdout.match(/PROPOSAL_ID: (\S+)/) || [])[1];
    assert.ok(pid, '未拿到 proposal id');
    run(RUN_GATE, ['confirm', '--proposal', pid, '--by', 'kilo'], env);
    const w = run(SAFE_WRITE, ['--target', risky, '--b64', b64, '--confirm', pid], env);
    assert.equal(w.status, 0, w.stdout + w.stderr);
    assert.equal(readFileSync(risky, 'utf8'), content);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('run-gate CLI：未确认直接 apply 被拒；reject 可标记放弃', () => {
  const { root, events, env } = sandbox();
  try {
    const target = join(root, 'ISSUE_REGISTRY.json');
    const cfile = join(root, 'c.txt');
    writeFileSync(target, '{}\n', 'utf8');
    writeFileSync(cfile, '{"x":1}\n', 'utf8');
    const p = run(RUN_GATE, ['propose', '--target', target, '--content-file', cfile, '--by', 'opencode'], env);
    assert.equal(p.status, 0, p.stdout + p.stderr);
    const pid = (p.stdout.match(/PROPOSAL_ID: (\S+)/) || [])[1];
    const a = run(RUN_GATE, ['apply', '--proposal', pid], env);
    assert.equal(a.status, 1);
    assert.match(a.stdout + a.stderr, /未确认/);
    assert.equal(readFileSync(target, 'utf8'), '{}\n');
    const rj = run(RUN_GATE, ['reject', '--proposal', pid, '--by', 'kilo', '--reason', '不改了'], env);
    assert.equal(rj.status, 0, rj.stdout + rj.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
