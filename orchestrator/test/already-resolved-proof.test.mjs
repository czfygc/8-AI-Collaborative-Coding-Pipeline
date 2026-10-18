// orchestrator/test/already-resolved-proof.test.mjs — T-56 W6（P-12）：强证明真/假 fixture
// 契约：PROOF 行解析（file:line:原文）；mall 形态拒；逐字校验 file 一致性/行号/原文包含。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractAlreadyResolvedProof, proofFileMatches, proofLineMatches } from '../lib/already-resolved-proof.mjs';

test('声明 + PROOF 行 → 解析出 file/line/原文', () => {
  const s = '已修复。\nALREADY_RESOLVED\nPROOF: src/app.mjs:37: const limit = MAX_TIMEOUT_MS * 2;';
  const r = extractAlreadyResolvedProof(s);
  assert.equal(r.declared, true);
  assert.equal(r.proof.file, 'src/app.mjs');
  assert.equal(r.proof.line, 37);
  assert.ok(r.proof.original.startsWith('const limit'));
});

test('声明但无 PROOF 行 → declared=true, proof=null（视为需修）', () => {
  const r = extractAlreadyResolvedProof('这个已被同轮修复。\nALREADY_RESOLVED\n');
  assert.equal(r.declared, true);
  assert.equal(r.proof, null);
});

test('PROOF 形态残缺 → malformed', () => {
  const r = extractAlreadyResolvedProof('ALREADY_RESOLVED\nPROOF: 没写行号和原文');
  assert.equal(r.proof.malformed, true);
});

test('未声明 → declared=false', () => {
  assert.equal(extractAlreadyResolvedProof('正常修复，无声明').declared, false);
});

test('逐字校验：真 fixture（file 一致 + 行号命中 + 原文逐字包含）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-proof-'));
  const abs = join(dir, 'target.mjs');
  writeFileSync(abs, 'export const a = 1;\nexport const b = 2;\nconst limit = MAX_TIMEOUT_MS * 2; // 关键行\n', 'utf8');
  const p = { file: 'target.mjs', line: 3, original: 'const limit = MAX_TIMEOUT_MS * 2' };
  assert.equal(proofLineMatches(abs, 'target.mjs', p), true);
  rmSync(dir, { recursive: true, force: true });
});

test('逐字校验：行号越界 → false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-proof-'));
  const abs = join(dir, 'target.mjs');
  writeFileSync(abs, 'line one\n', 'utf8');
  assert.equal(proofLineMatches(abs, 'target.mjs', { file: 'target.mjs', line: 9, original: 'line one' }), false);
  rmSync(dir, { recursive: true, force: true });
});

test('逐字校验：原文与行内容不符 → false；过短原文 → false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-proof-'));
  const abs = join(dir, 'target.mjs');
  writeFileSync(abs, 'const realCode = 42;\n', 'utf8');
  assert.equal(proofLineMatches(abs, 'target.mjs', { file: 'target.mjs', line: 1, original: 'const fakeCode = 99' }), false);
  assert.equal(proofLineMatches(abs, 'target.mjs', { file: 'target.mjs', line: 1, original: 'real' }), false);
  rmSync(dir, { recursive: true, force: true });
});

test('逐字校验：proof.file 与目标不一致 → false（防幻觉路径）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-proof-'));
  const abs = join(dir, 'target.mjs');
  writeFileSync(abs, 'const realCode = 42;\n', 'utf8');
  assert.equal(proofLineMatches(abs, 'target.mjs', { file: 'D:/elsewhere/hax.mjs', line: 1, original: 'const realCode = 42' }), false);
  assert.equal(proofFileMatches('src/target.mjs', './src/target.mjs'), true);
  assert.equal(proofFileMatches('target.mjs', 'target.mjs'), true);
  assert.equal(proofFileMatches('src/target.mjs', 'other.mjs'), false);
  rmSync(dir, { recursive: true, force: true });
});