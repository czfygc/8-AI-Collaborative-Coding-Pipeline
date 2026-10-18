// orchestrator/test/decision-api.test.mjs — T-56 W2.2：--decision-api 服务器启动冒烟
// 背景（C-02）：orchestrate.mjs:3377 getExpectedBearerToken 内 `require('node:child_process')`
// —— ESM 内 require 未定义，语法闸/导入闸全绿（函数体懒执行），但只要 --decision-api 一跑
// 就 ReferenceError 崩溃，服务永远起不来（门禁 5 次假绿的第 3 类炸弹）。修复：execSync 提为
// 顶层 import。
// 契约：spawn --decision-api 随机端口 → 3s 内 127.0.0.1:<port> TCP 可连（listening），
//       且 stderr/stdout 无 "require is not defined"；结束 kill。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';

const ORCH = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ORCH, 'orchestrate.mjs');

function portOpen(port, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tryOnce = () => {
      const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true); });
      sock.on('error', () => {
        sock.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(tryOnce, 100);
      });
    };
    tryOnce();
  });
}

test('--decision-api 启动：端口监听成功且无 require-in-ESM 崩溃', async () => {
  const port = 3100 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, [ENTRY, '--decision-api', '--decision-port', String(port)], {
    cwd: ORCH,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    const listening = await portOpen(port, 5000);
    assert.ok(listening, '端口应在启动后尽快监听，实际输出:\n' + out);
    assert.ok(!/require is not defined/.test(out), '输出不得含 ESM require 崩溃:\n' + out);
    assert.ok(/listening http:\/\/127\.0\.0\.1/.test(out), '应打印 listening 行:\n' + out);
  } finally {
    child.kill();
  }
});