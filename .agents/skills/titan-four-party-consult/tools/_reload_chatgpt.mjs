// reload + wait editor — 刷新挑战页并轮询直到编辑器出现或超时
const list0 = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const tab = list0.find(t => t.type === 'page' && t.url.startsWith('https://chatgpt.com'));
if (!tab) { console.log('NO_CHATGPT_TAB'); process.exit(1); }

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
await send('Page.enable', {});
await send('Page.reload', { ignoreCache: true });
console.log('reloaded, polling...');

const exp = '(() => ({ title: document.title, bodyLen: document.body?document.body.innerText.length:0, editor: !!document.querySelector("#prompt-textarea"), composerAny: !!document.querySelector(\'textarea,[contenteditable="true"]\'), login: !!document.querySelector("a[href*=login],[data-testid*=login]"), head: document.body?document.body.innerText.slice(0,120):"" }))()';
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 2000));
  const r = await send('Runtime.evaluate', { expression: exp, returnByValue: true });
  const v = r.result?.result?.value;
  if (!v) { console.log(`poll ${i}: eval-fail ${JSON.stringify(r).slice(0,120)}`); continue; }
  console.log(`poll ${i}: title="${v.title}" bodyLen=${v.bodyLen} editor=${v.editor} composer=${v.composerAny} login=${v.login} head=${JSON.stringify(v.head)}`);
  if (v.editor || v.composerAny) { console.log('EDITOR_READY'); ws.close(); process.exit(0); }
}
console.log('EDITOR_NOT_READY');
ws.close();
