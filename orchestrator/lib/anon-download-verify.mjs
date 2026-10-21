// orchestrator/lib/anon-download-verify.mjs — T-175 产物闸门 ③/4：匿名可下载性验收
//
// 借鉴 EP07 资料包的 scripts/verify_anonymous_download.ps1（思路照抄，Node 化）：
//   ① 公开页面匿名可访问（HTTP 200）；
//   ② 直接下载链接匿名 HEAD 正常（200 或 302 跳 CDN）；
//   ③ **完整匿名下载**（不带任何认证/cookie）后核对字节数 + SHA-256；
//   ④ 源码私有仓对匿名访问必须是 404（防止"分发仓公开 = 源码也公开"）。
//
// 结局口径：PASS / FAIL / **UNKNOWN**——网络不可达、超时、没给期望哈希 → 显式未知，不当通过。
// 只读 + 只下载到内存/临时目录（不落地覆盖产物）。

import { createHash } from 'node:crypto';

export const ANON_STATUSES = Object.freeze(['PASS', 'FAIL', 'UNKNOWN']);

function nowIso() { return new Date().toISOString(); }

// 单个 HEAD/GET 检查：返回 {status, detail, http_status}
async function httpProbe(url, { method = 'GET', fetchImpl = null, timeoutMs = 20000, headers = null } = {}) {
  const doFetch = fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, { method, redirect: 'follow', signal: controller.signal, headers: headers || {} });
    return { ok: true, http_status: res.status, res };
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
    return { ok: false, http_status: null, error: aborted ? 'timeout' : String((e && e.message) || e).slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyAnonDownload({
  page = null, release = null, download = null, privateRepo = null,
  expected = {}, fetchImpl = null, timeoutMs = 20000, maxBytes = 512 * 1024 * 1024,
} = {}) {
  const checks = [];
  const add = (name, status, detail, extra = {}) => { checks.push({ name, status, detail, ts: nowIso(), ...extra }); };

  // ① 公开页面
  if (page) {
    const r = await httpProbe(page, { method: 'GET', fetchImpl, timeoutMs });
    if (!r.ok) add('public_page', 'UNKNOWN', '请求失败（' + r.error + '）——显式未知，不当通过', { url: page });
    else if (r.http_status === 200) add('public_page', 'PASS', '匿名访问 HTTP 200', { url: page, http_status: 200 });
    else add('public_page', 'FAIL', '匿名访问返回 HTTP ' + r.http_status + '（应为 200）', { url: page, http_status: r.http_status });
  }

  // ② 发布页（可选）
  if (release) {
    const r = await httpProbe(release, { method: 'GET', fetchImpl, timeoutMs });
    if (!r.ok) add('release_page', 'UNKNOWN', '请求失败（' + r.error + '）', { url: release });
    else if (r.http_status === 200) add('release_page', 'PASS', '匿名访问 HTTP 200', { url: release, http_status: 200 });
    else add('release_page', 'FAIL', '匿名访问返回 HTTP ' + r.http_status + '（应为 200）', { url: release, http_status: r.http_status });
  }

  // ③ 下载链接 HEAD（200 或 302 都算通）
  if (download) {
    const r = await httpProbe(download, { method: 'HEAD', fetchImpl, timeoutMs });
    if (!r.ok) add('download_head', 'UNKNOWN', 'HEAD 请求失败（' + r.error + '）', { url: download });
    else if (r.http_status === 200 || r.http_status === 302) {
      add('download_head', 'PASS', 'HEAD 返回 ' + r.http_status + '（302 = 跳 CDN，正常）', { url: download, http_status: r.http_status });
    } else {
      add('download_head', 'FAIL', 'HEAD 返回 ' + r.http_status, { url: download, http_status: r.http_status });
    }
  }

  // ④ 完整匿名下载 + 校验和
  if (download) {
    const expSha = expected.sha256 ? String(expected.sha256).toLowerCase() : null;
    const expBytes = Number.isInteger(expected.bytes) ? expected.bytes : null;
    if (!expSha && expBytes === null) {
      add('download_bytes', 'UNKNOWN', '没给期望 SHA256 / 字节数 → 无法核对（显式未知）', { url: download });
    } else {
      const r = await httpProbe(download, { method: 'GET', fetchImpl, timeoutMs });
      if (!r.ok) {
        add('download_bytes', 'UNKNOWN', '匿名下载失败（' + r.error + '）', { url: download });
      } else if (r.http_status !== 200) {
        add('download_bytes', 'FAIL', '匿名下载返回 HTTP ' + r.http_status, { url: download, http_status: r.http_status });
      } else {
        let buf;
        try {
          buf = Buffer.from(await r.res.arrayBuffer());
        } catch (e) {
          add('download_bytes', 'UNKNOWN', '读取响应体失败: ' + String(e.message || e).slice(0, 120), { url: download });
          buf = null;
        }
        if (buf) {
          if (buf.length > maxBytes) {
            add('download_bytes', 'UNKNOWN', '产物超过上限 ' + maxBytes + ' B，拒绝下载核对', { url: download, bytes: buf.length });
          } else {
            const sha = createHash('sha256').update(buf).digest('hex');
            const bytesOk = expBytes === null || buf.length === expBytes;
            const shaOk = expSha === null || sha === expSha;
            if (bytesOk && shaOk) {
              add('download_bytes', 'PASS', '匿名下载 ' + buf.length + ' B，SHA-256 与期望一致', { url: download, bytes: buf.length, sha256: sha });
            } else {
              const detail = [];
              if (!bytesOk) detail.push('字节数 期望 ' + expBytes + ' 实际 ' + buf.length);
              if (!shaOk) detail.push('SHA-256 期望 ' + expSha + ' 实际 ' + sha);
              add('download_bytes', 'FAIL', detail.join('；'), { url: download, bytes: buf.length, sha256: sha });
            }
          }
        }
      }
    }
  }

  // ⑤ 源码私有仓必须对匿名 404
  if (privateRepo) {
    const r = await httpProbe(privateRepo, { method: 'GET', fetchImpl, timeoutMs });
    if (!r.ok) add('private_source', 'UNKNOWN', '请求失败（' + r.error + '）', { url: privateRepo });
    else if (r.http_status === 404) add('private_source', 'PASS', '匿名访问私有源码仓返回 404（源码未公开）', { url: privateRepo, http_status: 404 });
    else add('private_source', 'FAIL', '私有源码仓匿名返回 HTTP ' + r.http_status + '（应为 404）', { url: privateRepo, http_status: r.http_status });
  }

  const hasFail = checks.some((c) => c.status === 'FAIL');
  const hasUnknown = checks.some((c) => c.status === 'UNKNOWN');
  let status = 'PASS';
  if (hasFail) status = 'FAIL';
  else if (hasUnknown) status = 'UNKNOWN';
  else if (!checks.length) status = 'UNKNOWN';

  return { status, checks, checked_at: nowIso() };
}

export function renderAnonReport(result) {
  const lines = [];
  lines.push('[ANON-DOWNLOAD] status=' + result.status + ' checks=' + result.checks.length);
  for (const c of result.checks) {
    lines.push('  ' + c.status.padEnd(8) + c.name.padEnd(16) + c.detail + (c.http_status ? '（HTTP ' + c.http_status + '）' : ''));
  }
  return lines.join('\n');
}

export default { ANON_STATUSES, verifyAnonDownload, renderAnonReport };
