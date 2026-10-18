// orchestrator/test/lock.test.mjs — T-56 W5a（S-09/S-10 + M-07）：单写者锁契约
// 契约：
//   wx 互斥 / releaseLock 只释放自己的锁 / M-07 死锁清理（死 PID 锁被 unlink、活锁不动）
//   / S-10 锁内重读比对（快照失配 → conflict 拒绝覆盖） / 正常写入 + 清理锁文件

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  sha256OfText, lockAlivePid, removeStaleLock,
  tryAcquireLock, releaseLock, withLockedJsonWrite,
} from '../lib/lock.mjs';

let dir;
test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'titan-lock-')) + '\\'; });
test.afterEach(() => { try { rmSync(join(dir), { recursive: true, force: true }); } catch {} });

// 生成一个"刚退出进程"的 PID（保证死，且几乎不可能瞬间被复用）
function deadPid() {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', 'process.exit(0)'], { encoding: 'utf8' });
  return child.pid;
}

const LIVE = process.pid;

test('wx 互斥：他人持锁时抢不到', () => {
  const lp = join(dir, 'a.lock');
  assert.equal(tryAcquireLock(lp, { pid: LIVE }), true);
  assert.equal(tryAcquireLock(lp, { pid: LIVE }), false);
  assert.equal(lockAlivePid(lp), String(LIVE));
});

test('releaseLock 只释放自己的锁', () => {
  const lp = join(dir, 'b.lock');
  tryAcquireLock(lp, { pid: LIVE });
  releaseLock(lp, { pid: LIVE + 1 }); // 别人的 pid 不动
  assert.equal(lockAlivePid(lp), String(LIVE));
  releaseLock(lp, { pid: LIVE });
  assert.equal(lockAlivePid(lp), null);
  assert.equal(existsSync(lp), false);
});

test('M-07 死锁清理：死 PID 锁被 unlink，活锁不动', () => {
  const dead = join(dir, 'dead.lock');
  writeFileSync(dead, String(deadPid()), 'utf8');
  assert.equal(removeStaleLock(dead), true);
  assert.equal(existsSync(dead), false);

  const live = join(dir, 'live.lock');
  tryAcquireLock(live, { pid: LIVE });
  assert.equal(removeStaleLock(live), false);
  assert.equal(existsSync(live), true);
  releaseLock(live);
});

test('S-10 锁内重读比对：快照失配 → conflict，磁盘内容不被覆盖', () => {
  const doc = join(dir, 'work-orders.json');
  const contentA = JSON.stringify({ orders: [{ id: 'A', status: 'ready' }] });
  writeFileSync(doc, contentA, 'utf8');
  const snapA = sha256OfText(contentA);
  // 模拟他端新写
  const contentB = JSON.stringify({ orders: [{ id: 'B', status: 'claimed' }] });
  writeFileSync(doc, contentB, 'utf8');
  const r = withLockedJsonWrite(doc, { produceDoc: () => ({ orders: [{ id: 'C', status: 'x' }] }), baseSnapshot: snapA });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'conflict');
  assert.equal(readFileSync(doc, 'utf8'), contentB, '冲突时不得覆盖磁盘内容');
  assert.equal(existsSync(doc + '.tmp'), false);
  assert.equal(existsSync(join(dir, 'work-orders.write.lock')), false);
});

test('正常写入：快照匹配 + 原子落盘 + 锁文件清理', () => {
  const doc = join(dir, 'work-orders.json');
  const contentA = JSON.stringify({ orders: [{ id: 'A' }] });
  writeFileSync(doc, contentA, 'utf8');
  const r = withLockedJsonWrite(doc, { produceDoc: () => ({ orders: [{ id: 'A' }, { id: 'B' }] }), baseSnapshot: sha256OfText(contentA) });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'written');
  assert.deepEqual(JSON.parse(readFileSync(doc, 'utf8')).orders.map(o => o.id), ['A', 'B']);
  assert.equal(existsSync(join(dir, 'work-orders.write.lock')), false);
  assert.equal(existsSync(doc + '.tmp'), false);
});