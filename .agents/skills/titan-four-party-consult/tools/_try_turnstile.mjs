// try-solve-turnstile.mjs — 尝试用真实鼠标事件点击 Cloudflare Turnstile 复选框
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const tab = list.find(t => t.type === 'page' && t.url.startsWith('https://chatgpt.com'));
if (!tab) { console.log('NO_CHATGPT_TAB'); process.exit(1); }
console.log('title:', tab.title);

const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
function send(method, params) {
  return new Promise((res) => {
    const myId = ++id;
    const h = (ev) => { const m = JSON.parse(ev.data); if (m.id === myId) { ws.removeEventListener('message', h); res(m); } };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: myId, method, params }));
    setTimeout(() => { ws.removeEventListener('message', h); res({ timeout: true }); }, 20000);
  });
}

// 1) 找可交互的挑战元素：iframe(challenges.cloudflare.com) 或 [id*=turnstile]
const locExpr = `(() => {
  const frames = [...document.querySelectorAll('iframe')];
  const cf = frames.filter(f => (f.src||'').includes('challenges.cloudflare.com'));
  const ts = document.querySelector('[id*="turnstile"], .cf-turnstile, #challenge-stage');
  const el = cf[0] || ts;
  if (!el) return { found: false, iframeCount: frames.length, titles: frames.map(f=>f.src).slice(0,5) };
  const r = el.getBoundingClientRect();
  const host = el.closest('div,fieldset')?.getBoundingClientRect();
  return { found: true, tag: el.tagName, rect: { x: r.x, y: r.y, w: r.width, h: r.height },
           host: host ? { x: host.x, y: host.y, w: host.width, h: host.height } : null };
})()`;
const loc = await send('Runtime.evaluate', { expression: locExpr, returnByValue: true });
const v = loc.result?.result?.value;
console.log('locate:', JSON.stringify(v));

let cx, cy;
if (v && v.found) {
  const box = (v.host && v.host.w > 20) ? v.host : v.rect;
  // Turnstile 复选框通常在 widget 左侧、垂直居中偏上
  cx = Math.round(box.x + Math.min(30, box.w / 4));
  cy = Math.round(box.y + box.h / 2);
} else {
  // 退路：整页中部常见复选框位置
  const dim = await send('Runtime.evaluate', { expression: '({w:innerWidth,h:innerHeight})', returnByValue: true });
  const d = dim.result?.result?.value || { w: 1200, h: 800 };
  cx = Math.round(d.w / 2 - 120); cy = Math.round(d.h / 2);
}
console.log('click at', cx, cy);

await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'none' });
await new Promise(r => setTimeout(r, 300));
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
await new Promise(r => setTimeout(r, 120));
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });

// 2) 轮询 90s 看是否跳过挑战并出现编辑器
const exp = '(() => ({ title: document.title, bodyLen: document.body?document.body.innerText.length:0, editor: !!document.querySelector("#prompt-textarea"), composer: !!document.querySelector(\'textarea,[contenteditable="true"]\'), url: location.href.slice(0,80) }))()';
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 3000));
  const r = await send('Runtime.evaluate', { expression: exp, returnByValue: true });
  const s = r.result?.result?.value;
  console.log(`poll ${i}:`, JSON.stringify(s));
  if (s && (s.editor || s.composer)) { console.log('SOLVED_EDITOR_READY'); ws.close(); process.exit(0); }
}
console.log('STILL_BLOCKED');
ws.close();
