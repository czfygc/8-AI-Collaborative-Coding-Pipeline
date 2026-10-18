// orchestrator/test/check-file.test.mjs — T-56 W5b（S-11）：verify_cmd 分派器行为测试
// 契约：mjs→语法（好=0/坏=1含 SyntaxError）；json→JSON.parse（好=0/坏=1）；
// yaml→js-yaml（好=0/坏=1；工作区有 node_modules）；不支持扩展名→exit 2（ENV 不清算为 FAIL）；
// 文件缺失→exit 1。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const CHECK = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'check-file.mjs');
let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'check-file-')) + '\\'; });
after(() => { try { rmSync(join(dir), { recursive: true, force: true }); } catch {} });

function run(path) {
  return spawnSync(process.execPath, [CHECK, path], { encoding: 'utf8', timeout: 60000 });
}

test('mjs 语法：好文件 exit 0', () => {
  const p = join(dir, 'good.mjs');
  writeFileSync(p, 'export const x = 1;\n', 'utf8');
  const r = run(p);
  assert.equal(r.status, 0, (r.stderr || '') + (r.stdout || ''));
  assert.ok(/PASS syntax/.test(r.stdout || r.stderr), '应打印 PASS syntax');
});

test('mjs 语法：坏文件 exit 1 且含 SyntaxError', () => {
  const p = join(dir, 'bad.mjs');
  writeFileSync(p, 'export const = ;\n', 'utf8');
  const r = run(p);
  assert.equal(r.status, 1);
  assert.ok(/SyntaxError/.test((r.stderr || '') + (r.stdout || '')), '应含 SyntaxError 信息');
});

test('json：好文件 exit 0 / 坏文件 exit 1', () => {
  const good = join(dir, 'good.json');
  writeFileSync(good, '{"a": 1}', 'utf8');
  assert.equal(run(good).status, 0);
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{""}', 'utf8');
  assert.equal(run(bad).status, 1);
});

test('yaml：好文件 exit 0 / 坏文件 exit 1（工作区含 js-yaml）', () => {
  const good = join(dir, 'good.yaml');
  writeFileSync(good, 'a: 1\nb:\n  - x\n', 'utf8');
  const g = run(good);
  assert.equal(g.status, 0, (g.stderr || '') + (g.stdout || ''));
  const bad = join(dir, 'bad.yaml');
  writeFileSync(bad, 'a: [1,\n', 'utf8');
  assert.equal(run(bad).status, 1);
});

test('不支持扩展名：exit 2（ENV，不判校验失败）', () => {
  const p = join(dir, 'note.md');
  writeFileSync(p, 'hello', 'utf8');
  const r = run(p);
  assert.equal(r.status, 2);
  assert.ok(/不支持校验的扩展名|不支持/.test((r.stderr || '') + (r.stdout || '')));
});

test('文件缺失：exit 1 且标识 MISSING', () => {
  const r = run(join(dir, 'nope.mjs'));
  assert.equal(r.status, 1);
  assert.ok(/MISSING/.test((r.stderr || '') + (r.stdout || '')));
});