// orchestrator/lib/lock.mjs — T-56 W5（S-09/S-10 + M-07）：单写者文件锁工具
// 三处 work-orders.json 写者（delta-to-registry / autopilot / fixer-pool）统一走本模块。
// 能力：
//   - wx（O_EXCL）原子抢锁 + 死锁清理：锁文件在但 PID 已死 → unlink 后重抢（M-07 陈旧池锁）
//   - 锁内重读比对（S-10）：写者持快照哈希进锁，锁内重新读盘比对，不一致 → conflict 拒绝写
//     （防"两个客户端各改一版、后写覆盖先写"的静默丢单）
//   - tmp+rename 原子落盘
// 契约见 orchestrator/test/lock.test.mjs。
import { writeFileSync, readFileSync, renameSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

export function sha256OfText(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

// 活锁 PID（进程还在 → 返回 pid 字符串；死掉/文件损坏 → null）
export function lockAlivePid(lockPath) {
  if (!existsSync(lockPath)) return null;
  try {
    const pid = Number(String(readFileSync(lockPath, 'utf8')).trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try { process.kill(pid, 0); return String(pid); } catch { return null; }
  } catch { return null; }
}

// M-07 死锁清理：PID 已死（或缺年龄检查）→ unlink；活锁绝不碰。
export function removeStaleLock(lockPath, { staleMs = 900000 } = {}) {
  if (!existsSync(lockPath)) return false;
  if (lockAlivePid(lockPath)) return false;
  try { unlinkSync(lockPath); return true; } catch { return false; }
}

export function tryAcquireLock(lockPath, { pid = process.pid } = {}) {
  try {
    writeFileSync(lockPath, String(pid), { flag: 'wx' });
    return true;
  } catch { return false; }
}

export function releaseLock(lockPath, { pid = process.pid } = {}) {
  try {
    if (!existsSync(lockPath)) return;
    if (String(readFileSync(lockPath, 'utf8')).trim() === String(pid)) unlinkSync(lockPath);
  } catch {}
}

// 锁内 JSON 写入。produceDoc 在锁内被调用；baseSnapshot 提供时先做重读比对。
// 返回 { ok, status: 'written'|'conflict'|'lock-failed', detail? }
export function withLockedJsonWrite(docPath, { produceDoc, baseSnapshot = null, lockPath = null, retries = 3, waitMs = 1000, lockPid = process.pid } = {}) {
  const lp = lockPath || (docPath.replace(/\.json$/i, '') + '.write.lock');
  for (let i = 0; i < retries; i++) {
    removeStaleLock(lp);
    if (!tryAcquireLock(lp, { pid: lockPid })) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
      continue;
    }
    try {
      if (baseSnapshot !== null) {
        const cur = existsSync(docPath) ? readFileSync(docPath, 'utf8') : '';
        if (sha256OfText(cur) !== baseSnapshot) {
          return { ok: false, status: 'conflict', detail: '锁内重读比对不一致：磁盘内容已变（他端新写），拒绝覆盖，请重读后重试' };
        }
      }
      const doc = produceDoc();
      const tmp = docPath + '.tmp';
      writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
      renameSync(tmp, docPath);
      return { ok: true, status: 'written' };
    } finally {
      releaseLock(lp, { pid: lockPid });
    }
  }
  const live = lockAlivePid(lp);
  return { ok: false, status: 'lock-failed', detail: live ? ('锁被活进程持有（PID ' + live + '）') : '抢锁失败' };
}