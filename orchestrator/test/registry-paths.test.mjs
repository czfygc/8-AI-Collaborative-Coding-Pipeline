// orchestrator/test/registry-paths.test.mjs — T-56 W7：registry-paths suite
// 契约：
//   delta-to-registry 默认输出 = canonical orchestrator/work-orders.json（S-07），
//   且启动即打印绝对路径（--dry-run 不写文件）；
//   autopilot --workorders 显式路径可驱动（读者/写者与 canonical 对齐）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ORCH = join(dirname(fileURLToPath(import.meta.url)), '..');
const CANONICAL_REL = 'work-orders.json';

test('S-07：dry-run 打印 canonical 绝对路径 = orchestrator/work-orders.json', () => {
  const r = spawnSync(process.execPath, [join(ORCH, 'delta-to-registry.mjs'), '--dry-run'], {
    cwd: ORCH, encoding: 'utf8', timeout: 120000,
  });
  assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
  const expected = resolve(join(ORCH, CANONICAL_REL)).replace(/\\/g, '\\\\');
  assert.ok(new RegExp('\\[OUT\\] ' + expected).test(r.stdout), '应打印 canonical 绝对路径\n' + r.stdout);
});

test('autopilot --workorders 显式路径 + --dry-run：读取成功且不写状态', () => {
  const dir = mkdtempSync(join(tmpdir(), 'registry-paths-'));
  const woPath = join(dir, 'work-orders.json');
  writeFileSync(woPath, JSON.stringify({
    schema_version: '1.0', contract: 'test', source: 'test fixture',
    base_commit: '0'.repeat(40), generated_at: new Date().toISOString(),
    stats: { total: 0, ready: 0, needs_enrichment: 0 }, orders: [],
  }), 'utf8');
  const r = spawnSync(process.execPath, [join(ORCH, 'autopilot.mjs'), '--dry-run', '--workorders', woPath], {
    cwd: ORCH, encoding: 'utf8', timeout: 120000,
  });
  assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
  assert.ok(/可处理工单: 0/.test(r.stdout), '应读到 0 工单\n' + r.stdout);
  const after = JSON.parse(require_tmp_read(woPath));
  assert.equal(after.stats.total, 0, 'dry-run 不得改写状态');
  rmSync(dir, { recursive: true, force: true });
});

function require_tmp_read(p) {
  return spawnSync(process.execPath, ['-e', 'console.log(require("node:fs").readFileSync(process.argv[1],"utf8"))', p], { encoding: 'utf8' }).stdout;
}