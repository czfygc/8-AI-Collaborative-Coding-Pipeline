// T-172: model-health 回归 —— 分档表校验 / 探针 / TTL 缓存 / 健康判定 / 分档派单建议
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadTiers, listModels, getModel, getTaskTier, probeModel, probeModels, evaluateHealth,
  recommend, renderHealthTable, renderRecommendation, readCache, cacheEntry, TIERS, DEFAULT_TTL_MS,
} from '../lib/model-health.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = fileURLToPath(new URL('../model-health.mjs', import.meta.url));
const CONFIG = fileURLToPath(new URL('../config/model-tiers.json', import.meta.url));

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 't172-health-'));
}

// 假 fetch：按模型 id 返回不同结局
function fakeFetch(behaviour) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const id = body.model;
    const b = behaviour(id) || {};
    if (b.throw) { const e = new Error('boom'); e.name = b.name || 'Error'; throw e; }
    const payload = b.tool_calls
      ? JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: 'ping' } }] } }] })
      : JSON.stringify({ choices: [{ message: { content: 'pong' } }] });
    return {
      status: b.status || 200,
      text: async () => b.body || payload,
    };
  };
}

test('分档表：结构完整、id 不重、tier 合法、每个任务档位有规则与验收', () => {
  const cfg = loadTiers(CONFIG);
  assert.ok(Array.isArray(cfg.models) && cfg.models.length > 0);
  const ids = new Set(cfg.models.map((m) => m.id));
  assert.equal(ids.size, cfg.models.length);
  for (const m of cfg.models) assert.ok(TIERS.includes(m.tier), '非法 tier: ' + m.id);
  for (const [name, t] of Object.entries(cfg.taskTiers)) {
    assert.ok(t.label, name + ' 缺 label');
    assert.ok(TIERS.includes(t.prefer), name + ' prefer 非法');
    assert.ok(Array.isArray(t.allowedModelTiers) && t.allowedModelTiers.length, name + ' 缺 allowedModelTiers');
    assert.ok(t.rule, name + ' 缺 rule');
    assert.ok(t.acceptance, name + ' 缺 acceptance');
  }
  // 三档任务都必须存在（规划口径）
  for (const t of ['mechanical', 'bounded_code', 'architecture', 'review', 'long_run']) {
    assert.ok(cfg.taskTiers[t], '缺任务档位: ' + t);
  }
});

test('分档表：低档任务优先 light、架构任务只允许 heavy、付费档默认不外露给免费推荐', () => {
  const cfg = loadTiers(CONFIG);
  assert.equal(cfg.taskTiers.mechanical.prefer, 'light');
  assert.equal(cfg.taskTiers.architecture.prefer, 'heavy');
  assert.deepEqual(cfg.taskTiers.architecture.allowedModelTiers, ['heavy']);
  const rec = recommend({ config: cfg, health: {}, taskTier: 'mechanical', allowPaid: false, requireTools: false });
  assert.ok(rec.candidates.every((c) => c.free !== false));
});

test('探针：200 + tool_calls → healthy 且 tools=true', async () => {
  const r = await probeModel({
    id: 'm1', baseUrl: 'http://127.0.0.1:3001/v1', env: { FREELLMAPI_API_KEY: 'k' },
    fetchImpl: fakeFetch(() => ({ tool_calls: true })),
  });
  assert.equal(r.state, 'healthy');
  assert.equal(r.ok, true);
  assert.equal(r.tools, true);
  assert.equal(r.reason, 'ok_with_tools');
  assert.ok(r.latency_ms >= 0);
});

test('探针：200 但没 tool_calls → healthy 但 tools=false（不能派需要工具的活）', async () => {
  const r = await probeModel({
    id: 'm2', baseUrl: 'http://127.0.0.1:3001/v1', env: { FREELLMAPI_API_KEY: 'k' },
    fetchImpl: fakeFetch(() => ({ tool_calls: false })),
  });
  assert.equal(r.state, 'healthy');
  assert.equal(r.tools, false);
  assert.equal(r.reason, 'ok_no_tool_calls');
});

test('探针：429 → down（额度耗尽）；非 200 一律显式 down', async () => {
  const r = await probeModel({
    id: 'm3', baseUrl: 'http://127.0.0.1:3001/v1', env: { FREELLMAPI_API_KEY: 'k' },
    fetchImpl: fakeFetch(() => ({ status: 429, body: 'free-models-per-day' })),
  });
  assert.equal(r.state, 'down');
  assert.equal(r.http_status, 429);
  assert.match(r.reason, /http_429/);
});

test('探针：缺 key → unknown（不当失败也不当通过）', async () => {
  const r = await probeModel({
    id: 'm4', baseUrl: 'http://127.0.0.1:3001/v1', env: {},
    fetchImpl: fakeFetch(() => ({ tool_calls: true })),
  });
  assert.equal(r.state, 'unknown');
  assert.match(r.reason, /missing_key/);
});

test('探针：超时 / 网络错误 → unknown（显式未知）', async () => {
  const r = await probeModel({
    id: 'm5', baseUrl: 'http://127.0.0.1:3001/v1', env: { FREELLMAPI_API_KEY: 'k' },
    fetchImpl: fakeFetch(() => ({ throw: true, name: 'AbortError' })),
  });
  assert.equal(r.state, 'unknown');
  assert.equal(r.reason, 'timeout');
});

test('健康判定：TTL 内 healthy / 超时 stale / down / 缺失 unknown', () => {
  const now = 1_700_000_000_000;
  assert.equal(evaluateHealth({ state: 'healthy', checked_at: now - 1000 }, { ttlMs: 60000, now }), 'healthy');
  assert.equal(evaluateHealth({ state: 'healthy', checked_at: now - 120000 }, { ttlMs: 60000, now }), 'stale');
  assert.equal(evaluateHealth({ state: 'down', checked_at: now }, { ttlMs: 60000, now }), 'down');
  assert.equal(evaluateHealth(null, { ttlMs: 60000, now }), 'unknown');
});

test('TTL 缓存：第二次跑不重复探（probed 为空、entries 复用）', async () => {
  const dir = tmpDir();
  try {
    const cachePath = join(dir, 'health.json');
    const cfg = loadTiers(CONFIG);
    let calls = 0;
    const fetchImpl = async (url, init) => {
      calls += 1;
      const body = JSON.parse(init.body);
      return { status: 200, text: async () => JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: 'ping' } }] } }] }) };
    };
    const first = await probeModels({ ids: ['a', 'b'], config: cfg, cachePath, fetchImpl, env: { FREELLMAPI_API_KEY: 'k' } });
    assert.equal(first.probed.length, 2);
    assert.equal(calls, 2);
    const second = await probeModels({ ids: ['a', 'b'], config: cfg, cachePath, fetchImpl, env: { FREELLMAPI_API_KEY: 'k' } });
    assert.equal(second.probed.length, 0);
    assert.equal(second.cached.length, 2);
    assert.equal(calls, 2, 'TTL 内不该再探');
    const cache = readCache(cachePath);
    assert.ok(cache['a']);
    assert.ok(cacheEntry(cache, 'a', DEFAULT_TTL_MS));
    assert.equal(cacheEntry(cache, 'a', 1, Date.now() + 10000), null, '超 TTL 应失效');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('派单建议：mechanical 优先 light 档，且同档内优先不限量平台', () => {
  const cfg = loadTiers(CONFIG);
  const health = {};
  for (const m of cfg.models) {
    health[m.id] = { id: m.id, state: 'healthy', tools: true, latency_ms: 100, checked_at: Date.now() };
  }
  const rec = recommend({ config: cfg, health, taskTier: 'mechanical', requireTools: false, limit: 50 });
  assert.ok(rec.candidates.length > 0);
  const firstLight = rec.candidates.find((c) => c.tier === 'light');
  assert.ok(firstLight, '应至少有一个 light 候选');
  // light 候选应排在 medium/heavy 之前
  const firstMediumIdx = rec.candidates.findIndex((c) => c.tier === 'medium');
  const lastLightIdx = rec.candidates.map((c) => c.tier).lastIndexOf('light');
  if (firstMediumIdx !== -1) assert.ok(lastLightIdx < firstMediumIdx, 'light 应整体排在 medium 前面');
  // 同为 light 时不限量平台优先
  const lightCandidates = rec.candidates.filter((c) => c.tier === 'light');
  const rpdSeq = lightCandidates.map((c) => (c.rpd === null ? 0 : c.rpd <= 200 ? 1 : 2));
  assert.deepEqual(rpdSeq, [...rpdSeq].sort((a, b) => a - b), 'light 内部应按额度从宽到严排');
});

test('派单建议：down 的模型被排除；探针说没有 tool_calls 的模型不进需要工具的活', () => {
  const cfg = loadTiers(CONFIG);
  const health = {};
  for (const m of cfg.models) {
    health[m.id] = { id: m.id, state: 'healthy', tools: true, latency_ms: 100, checked_at: Date.now() };
  }
  const target = cfg.models.find((m) => m.tier === 'medium');
  health[target.id] = { id: target.id, state: 'down', tools: false, latency_ms: 10, checked_at: Date.now() };
  const rec = recommend({ config: cfg, health, taskTier: 'bounded_code', requireTools: true, limit: 50 });
  assert.ok(!rec.candidates.some((c) => c.id === target.id), 'down 的模型不该进候选');

  const noTool = cfg.models.find((m) => m.tier === 'medium' && m.id !== target.id);
  health[noTool.id] = { id: noTool.id, state: 'healthy', tools: false, latency_ms: 10, checked_at: Date.now() };
  const rec2 = recommend({ config: cfg, health, taskTier: 'bounded_code', requireTools: true, limit: 50 });
  assert.ok(!rec2.candidates.some((c) => c.id === noTool.id), '探针没出 tool_calls 的模型不该进需要工具的活');
  const rec3 = recommend({ config: cfg, health, taskTier: 'long_run', requireTools: false, limit: 50 });
  assert.ok(rec3.candidates.some((c) => c.id === noTool.id), '不需要工具的活应仍可派它');
});

test('派单建议：architecture 只给 heavy；未知任务档位显式抛错', () => {
  const cfg = loadTiers(CONFIG);
  const health = {};
  for (const m of cfg.models) {
    health[m.id] = { id: m.id, state: 'healthy', tools: true, latency_ms: 100, checked_at: Date.now() };
  }
  const rec = recommend({ config: cfg, health, taskTier: 'architecture', limit: 50 });
  assert.ok(rec.candidates.length > 0);
  assert.ok(rec.candidates.every((c) => c.tier === 'heavy'));
  assert.throws(() => getTaskTier('nope', cfg), /未知任务档位/);
});

test('渲染：健康表与建议文本可读且含关键列', () => {
  const cfg = loadTiers(CONFIG);
  const entries = { 'x-model': { id: 'x-model', state: 'healthy', tools: true, latency_ms: 123, checked_at: Date.now() } };
  const table = renderHealthTable(entries, [{ id: 'x-model', tier: 'light', platform: 'kilo', rpd: null }]);
  assert.ok(table.includes('x-model'));
  assert.ok(table.includes('healthy'));
  assert.ok(table.includes('unlimited'));
  const rec = recommend({ config: cfg, health: entries, taskTier: 'mechanical', limit: 3 });
  const text = renderRecommendation(rec);
  assert.ok(text.includes('mechanical'));
});

test('CLI：--no-probe --json 可离线运行；未知任务档位退 2', () => {
  const out = spawnSync(process.execPath, [CLI, '--all', '--no-probe', '--json'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const j = JSON.parse(out.stdout);
  assert.ok(Array.isArray(j.health));
  const bad = spawnSync(process.execPath, [CLI, '--task', 'nope'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(bad.status, 2);
});
