// lib/upload-verify.mjs — 附件通道唯一事实源（T-58）：确认表达式 + 确认轮询 + chooser 拦截投递。
// 背景：DOM.setFileInputFiles 可能静默假成功（返回 {} 但 input.files=0、无上传请求、无芯片——
// qwen 实证：会话里模型亲口说"没收到附件"；XHR 监听零请求=change 从未触发）。
// 判定：正文出现文件名的前 12 字符（芯片对长名可能省略号截断，全名 includes 会假阴性——MiMo 处方③）；
// 可选席位专属选择器（gemini 的 .attachment-preview-wrapper）做 OR。

export function buildAttachmentConfirmExpr(absPath, extraSelector) {
  const name = String(absPath || '').split(/[\\/]/).pop();
  // T-58 实证：qwen 芯片渲染为 "orchestrate .mjs 205.0 KB"（扩展名前插空格）——含点的
  // 前缀（'orchestrate.'）indexOf 假阴性 → 误报 UPLOAD_FAILED（文件其实已挂上、只差没发出）
  // 而拖拽诋毁。改：取主名（去扩展）前 8 字符，不碰点号。
  const stem = name.lastIndexOf('.') > 0 ? name.slice(0, name.lastIndexOf('.')) : name;
  const needle = stem.slice(0, 8);
  return '(() => {'
    + ' try {'
    + (extraSelector ? ' if (document.querySelector(' + JSON.stringify(extraSelector) + ')) return true;' : '')
    + '  const t = document.body && document.body.innerText;'
    + '  return !!(t && String(t).indexOf(' + JSON.stringify(needle) + ') >= 0);'
    + ' } catch (e) { return false; }'
    + ' })()';
}

// 确认轮询（直传后 / 拖拽后共用；到点仍未见即 false，调用方降级或报错——禁止假成功）
export async function waitAttachmentConfirmed(cdp, sessionId, expr, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
    if (r.result && r.result.value === true) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(res => setTimeout(res, 800));
  }
}

// chooser 拦截投递（menu_then_upload 席的唯一实测有效通道，qwen）：
// 点上传按钮 → 点菜单项（触发 input.click()）→ Page.setInterceptFileChooserDialog 拦截
// （不弹原生对话框、不打扰桌面）→ Page.fileChooserOpened 拿 backendNodeId →
// DOM.setFileInputFiles({backendNodeId})（= Playwright chooser.setFiles 同款机制，
// 已实证芯片出现）。返回 { ok, method }；抛错/未确认时关闭拦截并由调用方降级。
export async function uploadViaChooserIntercept(cdp, sessionId, reviewer, artifactAbsPath) {
  await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId);
  try {
    const btnExpr = '(() => { const b = document.querySelector(' + JSON.stringify(reviewer.upload_button_selector) + '); if (b) { b.click(); return true; } return false; })()';
    await cdp.send('Runtime.evaluate', { expression: btnExpr, returnByValue: true }, sessionId);
    await new Promise(r => setTimeout(r, 1000));
    const menuExpr = '(() => { '
      + 'const M = ' + JSON.stringify(reviewer.upload_menu_item_text) + '; '
      + 'const items = [...document.querySelectorAll(\'[role="menuitem"],[role="option"],li,button,[class*="dropdown-menu-item"],[class*="menu"] [class*="item"]\')]; '
      + 'const cands = items.filter(el => (el.innerText || "").indexOf(M) >= 0).sort((a, b) => (a.innerText || "").length - (b.innerText || "").length); '
      + 'const t = cands[0]; '
      + 'if (t) { t.click(); return true; } return false; '
      + '})()';
    // 竞态修正（T-58 实测第二次打脸）：必须先注册 waitForEvent 再点击——点击在 eval 内同步
    // 触发 fileChooserOpened，后注册会丢事件（Playwright 亦然：Promise.all([waitForEvent, click])）。
    const evPromise = cdp.waitForEvent('Page.fileChooserOpened', 8000, sessionId);
    await cdp.send('Runtime.evaluate', { expression: menuExpr, returnByValue: true }, sessionId);
    const ev = await evPromise;
    if (!ev) throw new Error('no fileChooserOpened event');
    await cdp.send('DOM.setFileInputFiles', { files: [artifactAbsPath], backendNodeId: ev.backendNodeId }, sessionId);
    await new Promise(r => setTimeout(r, reviewer.upload_wait_ms || 3000));
    await cdp.send('Page.setInterceptFileChooserDialog', { enabled: false }, sessionId);
    const ok = await waitAttachmentConfirmed(cdp, sessionId, buildAttachmentConfirmExpr(artifactAbsPath), 6000);
    return { ok, method: 'chooser-intercept' };
  } catch (e) {
    try { await cdp.send('Page.setInterceptFileChooserDialog', { enabled: false }, sessionId); } catch (_) { /* 忽略 */ }
    throw e;
  }
}