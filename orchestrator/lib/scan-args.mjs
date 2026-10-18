// orchestrator/lib/scan-args.mjs — T-56 W2.3：scan 模式 localOnly 强制逻辑（纯函数）
// 背景（C-03）：原 inline 的 const localOnly 被重赋值 → 多文件且未带 --local-only 时
// TypeError 炸断 scan 模式；且旧警告文案自相矛盾。此处收敛为唯一事实源。
// 契约见 orchestrator/test/scan-args.test.mjs：
//   (scanIsMulti=false, localOnly=false) -> false（网页席保留）
//   (true, false)  -> true（强制，附自洽警告文案）
//   (*, true)      -> true
export function forceLocalOnly(scanIsMulti, localOnly) {
  if (scanIsMulti && !localOnly) {
    console.warn('[SCAN] WARNING: Multi-file scan detected. Web seats only receive the first file as attachment,');
    console.warn('[SCAN]       N-1 files would be missed -> forcing local-only so all files go to local agentic seats.');
    console.warn('[SCAN]       To involve web seats with multiple files, run single-file scans per file instead.');
    return true;
  }
  return Boolean(localOnly);
}