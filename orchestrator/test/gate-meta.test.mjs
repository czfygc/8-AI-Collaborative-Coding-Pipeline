// orchestrator/test/gate-meta.test.mjs — T-56 W1 meta 测试：证明 verify-gate 护栏有效
// 方法：把 orchestrator/ 目录复制到沙箱（.tmp-gate-meta/sb-*），逐次注入四类
// "语法合法但运行时炸"的炸弹，断言 gate 变红；干净沙箱断言 gate 全绿。
// 四类炸弹与 gate 捕获段位：
//   B1 ESM require（C-02 类）        -> CLI 冒烟闸（加载期 ReferenceError: require is not defined）
//   B2 TDZ/未声明标识符（C-03 类）   -> 自检闸（self-check 加载即 ReferenceError）
//   B3 无限递归（C-01 类）           -> CLI 冒烟闸（RangeError: Maximum call stack size exceeded）
//   B4 注入模板引用泄漏（S-01 类）   -> 注入模板泄漏静态闸（Node 永不炸、浏览器才炸，唯静态可抓）
// 沙箱必须位于工作区树内（node_modules/js-yaml 向上解析）；test/、audit-evidence/、
// .tmp-gate-meta/ 不复制（防测试闸在沙箱内自我递归、防证据互串）。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cpSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ORCH_DIR = join(TEST_DIR, '..');
const WORKSPACE = join(TEST_DIR, '..', '..');
// 沙箱在 orchestrator/ 之外（Node cpSync 拒绝"复制到自身子树"），但仍在工作区树内
// （orchestrate.mjs import js-yaml 须向上解析到工作区 node_modules）。
const SB_ROOT = join(WORKSPACE, 'tmp', 'gate-meta');

const SKIP = /audit-evidence|[\\/]test[\\/]|\.tmp-gate-meta/;

function makeSandbox(name) {
  const dst = join(SB_ROOT, 'sb-' + name);
  rmSync(dst, { recursive: true, force: true });
  cpSync(ORCH_DIR, dst, { recursive: true, filter: (src) => !SKIP.test(src) });
  // 沙箱内 autopilot --dry-run 必须零工单：防 dry-run 从沙箱 spawn verify-delta 去真的 git 仓库动 worktree。
  const woPath = join(dst, 'work-orders.json');
  const wo = JSON.parse(readFileSync(woPath, 'utf8'));
  const empty = { ...wo, orders: [] };
  if (empty.stats) empty.stats = { ...empty.stats, total: 0, ready: 0 };
  writeFileSync(woPath, JSON.stringify(empty, null, 2));
  return dst;
}

function injectBomb(srcFile, bomb, beforeShebangLine) {
  const path = join(srcFile);
  let src = readFileSync(path, 'utf8');
  const bare = src.replace(/^#![^\n]*\n/, '');
  const hasShebang = bare.length !== src.length;
  const insertAt = hasShebang
    ? src.indexOf('\n', src.indexOf('#!')) + 1
    : (beforeShebangLine ? 0 : 0);
  src = src.slice(0, insertAt) + bomb + '\n' + src.slice(insertAt);
  writeFileSync(path, src);
}

function runGate(dir) {
  return spawnSync(process.execPath, [join(dir, 'verify-gate.mjs')], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, D_TITAN_ROOT: WORKSPACE },
  });
}

const BOMBS = [
  {
    name: 'B1-esm-require',
    file: 'fixer-pool.mjs',
    bomb: "const __bomb1 = require('node:fs');",
    caughtBy: 'CLI 冒烟闸',
  },
  {
    name: 'B2-tdz-undefined-identifier',
    file: 'orchestrate.mjs',
    bomb: "console.log('bomb2', __bombTDZ);",
    caughtBy: '自检闸',
  },
  {
    name: 'B3-infinite-recursion',
    file: 'delta-to-registry.mjs',
    bomb: 'function __bomb3(){ return __bomb3(); } __bomb3();',
    caughtBy: 'CLI 冒烟闸',
  },
  {
    name: 'B4-template-reference-leak',
    file: 'orchestrate.mjs',
    bomb: "const __bomb4 = `doc-ok-${''} reviewer.url_open ? 1 : 0`;",
    caughtBy: '注入模板泄漏静态闸',
  },
];

before(() => {
  rmSync(SB_ROOT, { recursive: true, force: true });
});

after(() => {
  rmSync(SB_ROOT, { recursive: true, force: true });
});

test('control: 干净沙箱 gate 全绿', () => {
  const sb = makeSandbox('control');
  const r = runGate(sb);
  assert.equal(r.status, 0, '干净沙箱 gate 应 exit 0\n' + (r.stdout || '') + (r.stderr || ''));
});

for (const b of BOMBS) {
  test(b.name + ' 注入 -> gate 变红（' + b.caughtBy + '）', () => {
    const sb = makeSandbox(b.name);
    injectBomb(join(sb, b.file), b.bomb);
    const r = runGate(sb);
    assert.notEqual(r.status, 0, '炸弹 ' + b.name + ' 应使 gate 非 0 退出\n' + (r.stdout || '') + (r.stderr || ''));
  });
}