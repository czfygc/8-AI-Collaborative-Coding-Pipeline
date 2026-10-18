// T-69：waitForResponse 时序（D-1）——URL 变化重置稳定时钟；超时后宽限重捕
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForResponse } from '../lib/session-nav.mjs';

const text250 = 'ISSUE-ID: G-01 ' + 'x'.repeat(240);

function fakeCdp(queue) {
  let calls = 0;
  return {
    cdp: { send: async () => { calls++; return { result: { value: queue.shift() } }; } },
    getCalls: () => calls,
  };
}

test('waitForResponse：URL 跳变期看似稳定的文本不得提前完成（稳定时钟随 URL 变化重置）', async () => {
  const snap = {
    url: 'about:blank',
    lastTextLen: text250.length,
    generating: false,
    bodyTail: text250,
  };
  const { cdp, getCalls } = fakeCdp([snap, { ...snap, url: 'https://chat.deepseek.com/c/1' }, { ...snap, url: 'https://chat.deepseek.com/c/1' }]);
  const r = await waitForResponse(cdp, 's1', { maxMs: 500, stableMs: 40, pollMax: 10, graceMs: 300 });
  assert.equal(r.lastTextLen, text250.length);
  // URL 跳变重置稳定时钟后，需再稳定 stableMs 才能完成：第 2 次轮询恰在跳变期，不得完成；第 3 次完成
  assert.equal(getCalls(), 3);
});

test('waitForResponse：超时后宽限期内仍可重捕真实回复', async () => {
  const { cdp, getCalls } = fakeCdp([
    { url: 'about:blank', lastTextLen: 0, generating: true },
    { url: 'https://chat.deepseek.com/c/1', lastTextLen: text250.length, generating: false, bodyTail: text250 },
    { url: 'https://chat.deepseek.com/c/1', lastTextLen: text250.length, generating: false, bodyTail: text250 },
  ]);
  const r = await waitForResponse(cdp, 's2', { maxMs: 50, stableMs: 1, pollMax: 5, graceMs: 3000 });
  assert.equal(r.lastTextLen, text250.length);
  assert.equal(getCalls(), 3);
});

test('waitForResponse：宽限期结束仍无回复则抛 timeout', async () => {
  const { cdp } = fakeCdp([]);
  cdp.send = async () => { return { result: { value: { url: 'about:blank', lastTextLen: 0, generating: true } } }; };
  await assert.rejects(
    waitForResponse(cdp, 's3', { maxMs: 50, stableMs: 90000, pollMax: 5, graceMs: 400 }),
    /waitForResponse timeout/
  );
});
