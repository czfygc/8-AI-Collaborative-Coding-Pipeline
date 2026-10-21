// T-153: Run 事件账本回归 —— run_id / 事件链 / 只追加 / 脱敏 / 保留策略
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLedger, newRunId, scrubPayload, EVENT_TYPES } from '../lib/run-events.mjs';

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 't153-events-'));
}

test('newRunId 形如 run-YYYYMMDDTHHMMSS-xxxxxx 且互不相同', () => {
  const a = newRunId();
  const b = newRunId();
  assert.match(a, /^run-\d{8}T\d{6}-[0-9a-f]{6}$/);
  assert.notEqual(a, b);
  assert.match(newRunId('gate'), /^gate-/);
});

test('append：事件链 seq 从 1 递增，文件只追加不覆盖', () => {
  const root = tmpRoot();
  try {
    const l = createLedger({ root });
    l.append('run-x', EVENT_TYPES.RUN_START, { kind: 'test' });
    l.append('run-x', EVENT_TYPES.RUN_END, { ok: true });
    const events = l.read('run-x');
    assert.equal(events.length, 2);
    assert.equal(events[0].seq, 1);
    assert.equal(events[1].seq, 2);
    assert.equal(events[0].type, 'run.start');
    assert.equal(events[1].payload.ok, true);
    const file = l.runFile('run-x');
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('append：非法 run_id 被拒（防路径穿越）', () => {
  const root = tmpRoot();
  try {
    const l = createLedger({ root });
    assert.throws(() => l.append('../escape', 'x', {}), /非法 run_id/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('脱敏：疑似密钥字段打码，长文本截断', () => {
  const s = scrubPayload({ api_key: 'AKIA-super-secret', note: 'x'.repeat(900), nested: { password: 'p', keep: 'ok' } });
  assert.equal(s.api_key, '[redacted]');
  assert.ok(s.note.endsWith('...[truncated]'));
  assert.ok(s.note.length < 900);
  assert.equal(s.nested.password, '[redacted]');
  assert.equal(s.nested.keep, 'ok');
});

test('append：写入前自动脱敏 payload', () => {
  const root = tmpRoot();
  try {
    const l = createLedger({ root });
    l.append('run-y', 'task.start', { token: 'ghp_xxx', prompt: 'hello' });
    const e = l.read('run-y')[0];
    assert.equal(e.payload.token, '[redacted]');
    assert.equal(e.payload.prompt, 'hello');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('list：按 mtime 倒序返回最近 run', () => {
  const root = tmpRoot();
  try {
    const l = createLedger({ root });
    l.append('run-a', 'run.start', {});
    l.append('run-b', 'run.start', {});
    const list = l.list({ limit: 10 });
    assert.equal(list.length, 2);
    assert.ok(list[0].mtime >= list[1].mtime);
    assert.ok(list.every(r => r.events >= 1));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prune：只保留最近 keepRuns 个 run 文件', () => {
  const root = tmpRoot();
  try {
    const l = createLedger({ root, keepRuns: 2 });
    for (const id of ['r1', 'r2', 'r3', 'r4']) l.append(id, 'run.start', {});
    const dropped = l.prune();
    assert.equal(dropped.length, 2);
    const left = l.list({ limit: 100 });
    assert.equal(left.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('summary：按 type 统计事件数', () => {
  const root = tmpRoot();
  try {
    const l = createLedger({ root });
    l.append('run-s', 'run.start', {});
    l.append('run-s', 'gate.proposed', {});
    l.append('run-s', 'gate.proposed', {});
    const s = l.summary('run-s');
    assert.equal(s.total, 3);
    assert.equal(s.counts['gate.proposed'], 2);
    assert.equal(s.counts['run.start'], 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('read：坏行不炸整条链（标记为 ledger.corrupt）', () => {
  const root = tmpRoot();
  try {
    const l = createLedger({ root });
    l.ensure();
    mkdirSync(join(root, 'runs'), { recursive: true });
    writeFileSync(l.runFile('run-bad'), 'not-json\n{"seq":2,"type":"run.end"}\n', 'utf8');
    const events = l.read('run-bad');
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'ledger.corrupt');
    assert.equal(events[1].type, 'run.end');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
