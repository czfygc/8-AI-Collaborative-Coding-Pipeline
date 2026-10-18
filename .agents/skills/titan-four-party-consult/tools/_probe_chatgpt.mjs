// probe-chatgpt.mjs — 探测 ChatGPT tab 当前状态：挑战页? 登录? 编辑器?
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const tab = list.find(t => t.type === 'page' && t.url.startsWith('https://chatgpt.com'));
if (!tab) { console.log('NO_CHATGPT_TAB'); process.exit(1); }
console.log('title:', tab.title);
console.log('url  :', tab.url);

const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
function send(method, params) {
  return new Promise((res) => {
    const myId = ++id;
    const h = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === myId) { ws.removeEventListener('message', h); res(m); }
    };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: myId, method, params }));
    setTimeout(() => { ws.removeEventListener('message', h); res({ timeout: true }); }, 15000);
  });
}
const exp = '(() => ({ ready: document.readyState, bodyLen: document.body?document.body.innerText.length:0, challenge: document.title.includes("Just a moment"), editor: !!document.querySelector("#prompt-textarea"), loginBtn: !!document.querySelector("[data-testid=\'login-button\'], a[href*=login]"), head: document.body ? document.body.innerText.slice(0,200) : "" }))()';
const r = await send('Runtime.evaluate', { expression: exp, returnByValue: true });
console.log(JSON.stringify(r.result?.result?.value ?? r, null, 2));
ws.close();
