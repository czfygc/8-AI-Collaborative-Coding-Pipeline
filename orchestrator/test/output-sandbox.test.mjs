// T-145: 工具输出沙箱原型回归 —— 落盘/摘要预算/检索/记账/CLI
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  storeArtifact, digestContent, sandboxOutput, searchArtifact,
  readLedger, summarizeLedger, measure, slugify, DEFAULT_BUDGET,
} from '../lib/output-sandbox.mjs';

const CLI = fileURLToPath(new URL('../sandbox.mjs', import.meta.url));

function tmp() {
  return mkdtempSync(join(tmpdir(), 't145-sandbox-'));
}

function bigLog(n = 5000) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    if (i % 500 === 0) rows.push('2026-10-21T00:00:00Z ERROR request ' + i + ' failed: connection timed out after 30000ms');
    else if (i % 97 === 0) rows.push('2026-10-21T00:00:01Z WARN retry attempt ' + (i % 5) + ' for job ' + i);
    else rows.push('2026-10-21T00:00:02Z INFO worker ' + (i % 8) + ' processed item ' + i + ' ok');
  }
  return rows.join('\n') + '\n';
}

test('storeArtifact：字节落盘且 sha256 可回读核对', () => {
  const dir = tmp();
  try {
    const content = 'alpha\nbeta\ngamma\n';
    const meta = storeArtifact({ content, label: 'Unit Test/A', source: 'test', dir });
    assert.equal(meta.bytes, Buffer.byteLength(content, 'utf8'));
    assert.equal(meta.lines, 3);
    assert.equal(readFileSync(meta.artifact, 'utf8'), content);
    assert.equal(meta.sha256.length, 64);
    assert.ok(meta.artifact.includes('unit-test-a-'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('storeArtifact：同内容重复落盘不覆盖旧文件', () => {
  const dir = tmp();
  try {
    const a = storeArtifact({ content: 'same', label: 'dup', dir });
    const b = storeArtifact({ content: 'same', label: 'dup', dir });
    assert.notEqual(a.artifact, b.artifact);
    assert.equal(readFileSync(b.artifact, 'utf8'), 'same');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('digestContent：大日志被压到预算内且保留关键信号', () => {
  const content = bigLog();
  const d = digestContent(content, { label: 'big', source: 'test' });
  assert.ok(Buffer.byteLength(content, 'utf8') > 200 * 1024, '样本应足够大');
  assert.ok(d.bytes <= DEFAULT_BUDGET, '摘要应不超过预算: ' + d.bytes);
  assert.ok(d.stats.errors >= 10, '应统计到错误行: ' + d.stats.errors);
  assert.ok(d.stats.warns >= 10, '应统计到告警行: ' + d.stats.warns);
  assert.equal(d.stats.lines, 5000);
  assert.match(d.text, /signals: error=/);
  assert.match(d.text, /top-repeats:/);
  assert.ok(d.stats.sha256.length === 64);
});

test('digestContent：预算约束生效并可检测截断标记', () => {
  const content = ('line with lots of text ' + 'x'.repeat(180) + '\n').repeat(800);
  const d = digestContent(content, { label: 'trunc', maxBytes: 600 });
  assert.ok(d.bytes <= 600 + 80, '含截断标记也不应明显超预算: ' + d.bytes);
  assert.match(d.text, /truncated: full output at artifact/);
});

test('digestContent：空输出不抛错', () => {
  const d = digestContent('', { label: 'empty' });
  assert.equal(d.stats.bytes, 0);
  assert.equal(d.stats.lines, 0);
  assert.match(d.text, /\[SANDBOX DIGEST\]/);
});

test('measure：节省比例计算口径', () => {
  const m = measure(1000, 100);
  assert.equal(m.savedBytes, 900);
  assert.equal(m.savingPct, 90);
  assert.equal(measure(0, 0).savingPct, 0);
});

test('searchArtifact：按需检索原始输出并带行号', () => {
  const dir = tmp();
  try {
    const content = ['one', 'two target here', 'three', 'four target again', 'five'].join('\n');
    const meta = storeArtifact({ content, label: 's', dir });
    const r = searchArtifact(meta.artifact, 'target', { max: 5, context: 1 });
    assert.equal(r.matches, 2);
    assert.equal(r.shown, 2);
    assert.match(r.text, /2\| two target here/);
    assert.match(r.text, /4\| four target again/);
    assert.match(r.text, /1\| one/);
    assert.match(r.text, /5\| five/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('searchArtifact：max 截断时 truncated 标记为真', () => {
  const dir = tmp();
  try {
    const content = Array.from({ length: 50 }, (_, i) => 'hit ' + i).join('\n');
    const meta = storeArtifact({ content, label: 'm', dir });
    const r = searchArtifact(meta.artifact, 'hit', { max: 3 });
    assert.equal(r.matches, 50);
    assert.equal(r.shown, 3);
    assert.equal(r.truncated, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sandboxOutput + ledger：逐条记账并可聚合节省', () => {
  const dir = tmp();
  try {
    const r1 = sandboxOutput({ content: bigLog(1000), label: 'a', source: 't', dir });
    const r2 = sandboxOutput({ content: 'small\n', label: 'b', source: 't', dir });
    const { records } = readLedger(dir);
    assert.equal(records.length, 2);
    const s = summarizeLedger(records);
    assert.equal(s.runs, 2);
    assert.equal(s.bytes, r1.measured.originalBytes + r2.measured.originalBytes);
    assert.ok(s.savingPct > 80);
    assert.ok(r1.measured.savingPct > 90);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('slugify：路径与特殊字符安全化', () => {
  assert.equal(slugify('Unit Test/A'), 'unit-test-a');
  assert.equal(slugify(''), 'output');
  assert.equal(slugify('...'), 'output');
});

test('CLI file：摘要进 stdout、原始内容进 artifact', () => {
  const dir = tmp();
  try {
    const src = join(dir, 'input.log');
    writeFileSync(src, bigLog(2000), 'utf8');
    const r = spawnSync(process.execPath, [CLI, 'file', src, '--label', 'cli', '--dir', join(dir, 'sandbox')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\[SANDBOX DIGEST\] label=cli/);
    assert.match(r.stdout, /\[SANDBOX\] artifact=/);
    assert.match(r.stdout, /saved=\d+B/);
    assert.ok(Buffer.byteLength(r.stdout, 'utf8') < 8192, 'CLI 输出应只含摘要');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
