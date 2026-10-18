// orchestrator/lib/send-check-expr.mjs — T-56 W2.4：发送确认表达式构建（纯函数）
// 背景（S-01）：旧实现把 reviewer.url_open 裸引用拼进浏览器执行表达式
// （orchestrate.mjs:2037 模板内 `( reviewer.url_open ? ... )`），浏览器内 ReferenceError:
// reviewer is not defined → 发送确认/send-rescue 连坐失效；Node 侧永不报错（语法闸盲区），
// 只能靠静态扫描闸 + 本模块单测守。
// 修复：Node 侧预计算 hasUrlOpen 布尔，initialUrlNorm 经 JSON.stringify 注入，
// 产物不含任何 Node 作用域标识符。行为契约见 orchestrator/test/send-check-expr.test.mjs。
const ASSISTANT_SELECTOR = "model-response, .markdown, [data-message-author-role=\"assistant\"], article, .message-bubble";

export function buildSendCheckExpr(initialUrlNorm, hasUrlOpen) {
  const jsonNorm = JSON.stringify(String(initialUrlNorm || ''));
  const urlOpenClause = '(' + jsonNorm + ' === "" ? false : curUrl !== ' + jsonNorm + ')';
  const assistClause = 'document.querySelector(\'' + ASSISTANT_SELECTOR + '\')';
  const sentClause = '!!(cleanResidual.length === 0 && (' + (hasUrlOpen
    ? urlOpenClause + ' || ' + assistClause
    : assistClause) + '))';
  // 注意：['\\s\\u200b'] 在模板字面量中双反斜杠 -> 产物单反斜杠（浏览器正则 \s、\u200b）。
  return `(() => {
  const el = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
    .filter(e => e.offsetParent !== null)
    .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
  const residual = el ? (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? (el.value || '') : (el.innerText || '')) : '';
  const cleanResidual = residual.replace(/[\\s\\u200b]/g, '').replace(/<br\\s*\\/?>/g, '');
  const curUrl = location.href.split('?')[0].replace(/\\/+$/, '');
  return {
    url: location.href,
    residualLen: cleanResidual.length,
    sent: ${sentClause},
  };
})()`;
}