// orchestrator/test/autopilot-ferry.test.mjs — T-56 W5d（S-06）：autopilot fixer 摆渡步骤序
// 契约（dry-run 下断言输出步骤序，不写状态）：
//   默认（off）：直跑 verify-delta 语义（dry-run: 'verify-delta: skipped'）
//   --run-fixers + 无 child_ref：fail-closed → result=NEEDS_FIX + 手跑命令 fixer-pool.mjs --run --wo <id>
//   --run-fixers + 有 child_ref：步骤含 child_ref 在册，直跑 verify

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ORCH = join(dirname(fileURLToPath(import.meta.url)), '..');
const AUTOPILOT = join(ORCH, 'autopilot.mjs');

function makeFixture(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-ferry-'));
  const woPath = join(dir, 'work-orders.json');
  writeFileSync(woPath, JSON.stringify({
    schema_version: '1.0',
    contract: 'orchestrator/autopilot-contract-v1.md#1',
    source: 'test fixture',
    base_commit: '0'.repeat(40),
    generated_at: new Date().toISOString(),
    stats: { total: 1, ready: 1, needs_enrichment: 0 },
    orders: [{
      id: 'WO-TEST-001',
      status: 'ready',
      owner: 'fixer-cline',
      verifier: 'verifier-harness',
      base_commit: '0'.repeat(40),
      target_files: ['orchestrator/example.mjs'],
      verify_cmd: 'node --check orchestrator/example.mjs',
      verify_cmd_deps: [],
      instruction: 'fixture',
      ...over,
    }],
  }, null, 2), 'utf8');
  return { dir, woPath };
}

function run(argv) {
  return spawnSync(process.execPath, [AUTOPILOT, '--dry-run', '--limit', '1', ...argv], { encoding: 'utf8', timeout: 120000 });
}

test('S-06 默认 off：dry-run 步骤为 claim → verify-delta skipped', () => {
  const { dir, woPath } = makeFixture();
  const r = run(['--workorders', woPath]);
  assert.equal(r.status, 0, r.stdout + (r.stderr || ''));
  assert.ok(/claim owner=fixer-cline/.test(r.stdout), '步骤应含 claim');
  assert.ok(/verify-delta: skipped \(dry-run\)/.test(r.stdout), '默认应直跑 verify-delta 语义');
  assert.ok(!/NEEDS_FIX/.test(r.stdout), '默认 off 不应出现 NEEDS_FIX');
  rmSync(dir, { recursive: true, force: true });
});

test('S-06 --run-fixers + 无 child_ref：fail-closed NEEDS_FIX + 打印手跑命令', () => {
  const { dir, woPath } = makeFixture();
  const r = run(['--workorders', woPath, '--run-fixers']);
  assert.equal(r.status, 0, r.stdout + (r.stderr || ''));
  assert.ok(/NEEDS_FIX/.test(r.stdout), '无 child_ref 应 fail-closed 标 NEEDS_FIX');
  assert.ok(/node orchestrator\/fixer-pool\.mjs --run --wo WO-TEST-001/.test(r.stdout), '应打印手跑命令:\n' + r.stdout);
  assert.ok(!/verify-delta: skipped/.test(r.stdout), 'fail-closed 后不应再进 verify-delta 步骤');
  rmSync(dir, { recursive: true, force: true });
});

test('S-06 --run-fixers + 有 child_ref：在册直跑 verify', () => {
  const { dir, woPath } = makeFixture({ child_ref: 'fix/WO-TEST-001' });
  const r = run(['--workorders', woPath, '--run-fixers']);
  assert.equal(r.status, 0, r.stdout + (r.stderr || ''));
  assert.ok(/child_ref=fix\/WO-TEST-001 已在册/.test(r.stdout), '应报告 child_ref 在册');
  assert.ok(/verify-delta: skipped \(dry-run\)/.test(r.stdout), '有 child_ref 应进入 verify 步骤（dry 显示 skipped）');
  assert.ok(!/NEEDS_FIX/.test(r.stdout));
  rmSync(dir, { recursive: true, force: true });
});