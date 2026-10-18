// orchestrator/test/cdp-client.test.mjs — T-56 W2.1：CDP.connect() 行为契约测试
// 背景（回归债 DELTA-027 + DELTA-034）：
//   旧实现 = attemptConnect 自递归（每次调用 new Promise 再调 this.connect()，永不返回，
//   且 reject 分支死代码）+ this.wsUrl.replace(/^ws:/,'wss:') 强制升级（CDP debug 端口
//   只提供 ws://，全被改坏）。结果：网页通道全断 + 栈溢出（RangeError）。
// 契约（修复后必须全部满足）：
//   ① URL 原样保留 ws://  ② onerror→reject 且非 RangeError
//   ③ onopen→resolve      ④ 重试上限（maxAttempts 次后 reject，实例数=上限）
//   （附加）⑤ 尝试级超时 option 可配

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CDP } from '../cdp-client.mjs';

class FakeWebSocket {
  static instances = [];
  static behavior = 'open'; // open | error | never
  static reset() { FakeWebSocket.instances = []; FakeWebSocket.behavior = 'open'; }
  constructor(url) {
    FakeWebSocket.instances.push(this);
    this.url = url;
    this.readyState = 0;
    this.closed = false;
    queueMicrotask(() => {
      if (FakeWebSocket.behavior === 'error') this.onerror && this.onerror({ message: 'boom' });
      else if (FakeWebSocket.behavior === 'open') { this.readyState = 1; this.onopen && this.onopen(); }
      // 'never'：不触发任何事件，用于超时测试
    });
  }
  close() { this.closed = true; this.readyState = 3; }
  send() {}
}

test('① URL 保持 ws://（不强制 wss）', async () => {
  FakeWebSocket.reset();
  const cdp = new CDP('ws://127.0.0.1:9222/devtools/page/abc', FakeWebSocket);
  await cdp.connect();
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(FakeWebSocket.instances[0].url, 'ws://127.0.0.1:9222/devtools/page/abc');
});

test('② onerror → reject，且不是 RangeError（无自递归）', async () => {
  FakeWebSocket.reset();
  FakeWebSocket.behavior = 'error';
  const cdp = new CDP('ws://127.0.0.1:9222/x', FakeWebSocket);
  await assert.rejects(
    () => cdp.connect({ maxAttempts: 1 }),
    (e) => {
      assert.ok(!(e instanceof RangeError), '错误不应是 RangeError: ' + e.name);
      return /WS error/.test(e.message);
    }
  );
});

test('③ onopen → resolve', async () => {
  FakeWebSocket.reset();
  const cdp = new CDP('ws://127.0.0.1:9222/x', FakeWebSocket);
  await cdp.connect({ maxAttempts: 1 });
  assert.equal(cdp.ws.readyState, 1);
});

test('④ 重试上限：失败 maxAttempts 次后 reject，实例数=上限', async () => {
  FakeWebSocket.reset();
  FakeWebSocket.behavior = 'error';
  const cdp = new CDP('ws://127.0.0.1:9222/x', FakeWebSocket);
  await assert.rejects(
    () => cdp.connect({ maxAttempts: 3, baseDelayMs: 1 }),
    (e) => /after 3 attempt/.test(e.message)
  );
  assert.equal(FakeWebSocket.instances.length, 3);
});

test('⑤ 尝试级超时：连接无响应 -> timeout reject（超时清理定时器）', async () => {
  FakeWebSocket.reset();
  FakeWebSocket.behavior = 'never';
  const cdp = new CDP('ws://127.0.0.1:9222/x', FakeWebSocket);
  await assert.rejects(
    () => cdp.connect({ maxAttempts: 1, attemptTimeoutMs: 50 }),
    (e) => /timeout 50ms/.test(e.message)
  );
});

test('⑥ waitForEvent：匹配会话的事件到达即解析（T-58 chooser 拦截用）', async () => {
  FakeWebSocket.reset();
  const cdp = new CDP('ws://127.0.0.1:9222/x', FakeWebSocket);
  await cdp.connect({ maxAttempts: 1 });
  const ws = FakeWebSocket.instances[0];
  let received = null;
  const p = cdp.waitForEvent('Page.fileChooserOpened', 2000, 'S1').then((params) => { received = params; });
  ws.onmessage({ data: JSON.stringify({ method: 'Page.fileChooserOpened', sessionId: 'S1', params: { backendNodeId: 42 } }) });
  await p;
  assert.equal(received.backendNodeId, 42);
});

test('⑦ waitForEvent：sessionId 不匹配不触发 + 超时 reject 且无残留 handler', async () => {
  FakeWebSocket.reset();
  const cdp = new CDP('ws://127.0.0.1:9222/x', FakeWebSocket);
  await cdp.connect({ maxAttempts: 1 });
  const ws = FakeWebSocket.instances[0];
  let caught = null;
  const p = cdp.waitForEvent('Page.fileChooserOpened', 80, 'S1').then(() => 'ok', (e) => { caught = e; return 'timeout'; });
  ws.onmessage({ data: JSON.stringify({ method: 'Page.fileChooserOpened', sessionId: 'OTHER', params: { backendNodeId: 1 } }) });
  const r = await p;
  assert.equal(r, 'timeout');
  assert.ok(/timeout waiting event/.test(caught.message));
  assert.equal(cdp.eventHandlers.get('Page.fileChooserOpened'), undefined);
});