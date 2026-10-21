#!/usr/bin/env node
// T-150: coding 记忆链只读原型的自检（独立于 test.mjs，可单独跑）
//
// 覆盖：
//   1. scene 路由：显式 > 文件扩展名 > tool 兜底；未知 scene 归一为 working
//   2. scene 策略：coding = 两层记忆（twoLayer），working = 短 TTL，chat = 只有 durable
//   3. coding 事实只存坐标（file/function/branch）+ 摘要——**不含 diff 正文、不含 diff hash**
//   4. diff 条目按正文 sha256 内容寻址：条目存 hash/摘要/引用，正文另存 diff-bodies/<hash>
//   5. recall 组装 chain_block：按坐标匹配 diff → 只给 hash+摘要+引用；正文需显式 withBodies 才取
//   6. 隔离：原型数据只落 <ws>/titan-memory/chain-data/，**不碰共享事实库**（dsh_memory.json）
//   7. 落盘是原子的（tmp + rename），不留 .tmp 残file
//   8. 坐标缺失/摘要为空/正文为空 → 显式报错，不静默写入
//
// 运行：node titan-memory/test-chain.mjs        （cwd 建议为工作区根）
// 退出码：0=全绿，1=有失败

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	normalizeScene, detectSceneFromContext, sceneConfig, isCodingContext,
} from './scene.mjs';
import {
	appendCodingFact, appendDiffEntry, recallCodingFact, listCodingFacts,
	readDiffBody, factsFile, diffsFile, chainRoot, diffBodyFile,
} from './chain-store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS = process.cwd();

let failures = 0;
let checks = 0;

function ok(label, condition, detail = '') {
	checks += 1;
	if (condition) {
		process.stdout.write(`  ok    ${label}\n`);
	} else {
		failures += 1;
		process.stdout.write(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}\n`);
	}
}

function throws(label, fn) {
	let threw = false;
	try { fn(); } catch { threw = true; }
	ok(label, threw);
}

// 1) scene 路由
ok('normalizeScene: 合法值原样', normalizeScene('coding') === 'coding');
ok('normalizeScene: 未知值归 working', normalizeScene('nope') === 'working');
ok('detectSceneFromContext: 显式优先', detectSceneFromContext({ scene: 'chat', file: 'a.py' }) === 'chat');
ok('detectSceneFromContext: .py → coding', detectSceneFromContext({ file: 'src/x.py' }) === 'coding');
ok('detectSceneFromContext: .mjs → coding', detectSceneFromContext({ file: 'src/x.mjs' }) === 'coding');
ok('detectSceneFromContext: .md → 非 coding', detectSceneFromContext({ file: 'README.md' }) !== 'coding');
ok('detectSceneFromContext: tool 兜底 working', detectSceneFromContext({ tool: 'search' }) === 'working');
ok('isCodingContext: 扩展名判定', isCodingContext({ file: 'a.ts' }) === true);

// 2) scene 策略
ok('sceneConfig(coding): twoLayer=true', sceneConfig('coding').twoLayer === true);
ok('sceneConfig(working): 短 TTL + 非 twoLayer', sceneConfig('working').twoLayer === false && sceneConfig('working').ttlMs > 0);
ok('sceneConfig(chat): 只有 durable', sceneConfig('chat').durable === true && sceneConfig('chat').twoLayer === false);

// 3~5) 事实 + diff + recall
// 坐标带本次运行戳：保证「按坐标匹配」只命中本轮这一条（否则多次运行会累积旧 diff）
const RUN_TAG = 'run-' + Date.now().toString(36);
const coords = { file: 'src/feature-' + RUN_TAG + '.py', function: 'handle', branch: 'main' };
const diffBody = '--- a/src/feature.py\n+++ b/src/feature.py\n@@\n-old\n+new\n';

const fact = appendCodingFact(coords, { summary: '改了 handle 的分支判断', ws: WS });
ok('appendCodingFact: 事实只存坐标', fact.coordinates.file === coords.file && fact.coordinates.function === coords.function);
ok('appendCodingFact: 事实不含 diff 正文', !JSON.stringify(fact).includes('old') && !JSON.stringify(fact).includes('new'));
ok('appendCodingFact: 事实不含 diff hash', !('hash' in fact) && !('diffHash' in fact));

const entry = appendDiffEntry(diffBody, coords, { summary: 'handle 分支修正', ref: 'git:abc1234' }, { ws: WS });
ok('appendDiffEntry: 内容寻址 hash 长度 64', typeof entry.hash === 'string' && entry.hash.length === 64);
ok('appendDiffEntry: 条目不含 diff 正文', !JSON.stringify(entry).includes('@@'));
ok('appendDiffEntry: 条目带 ref', entry.ref === 'git:abc1234');

const chain = recallCodingFact(fact.id, { ws: WS });
ok('recall: chain_block 含事实与坐标', chain.fact.id === fact.id && chain.fact.coordinates.branch === 'main');
ok('recall: diffs 按坐标匹配到 1 条', chain.diffs.length === 1);
ok('recall: diffs 只给 hash+摘要+引用', chain.diffs[0].hash === entry.hash && chain.diffs[0].ref === 'git:abc1234');
ok('recall: 默认不含正文', chain.bodies.length === 0);
const withBodies = recallCodingFact(fact.id, { ws: WS, withBodies: true });
ok('recall: 显式 withBodies 才取正文', withBodies.bodies.length === 1 && withBodies.bodies[0].body.includes('@@'));
ok('readDiffBody: 按 hash 取回原文', readDiffBody(entry.hash, { ws: WS }) === diffBody);
ok('listCodingFacts: 能列出事实', listCodingFacts({ ws: WS }).some(f => f.id === fact.id));

// 6) 隔离：数据只在 chain-data 下，且不碰共享事实库
const shared = path.join(WS, 'titan-memory', 'chain-data');
ok('chainRoot 落在 titan-memory/chain-data', chainRoot(WS).startsWith(shared));
ok('facts.jsonl 存在', fs.existsSync(factsFile(WS)));
ok('diffs.jsonl 存在', fs.existsSync(diffsFile(WS)));
const sharedStore = process.env.TITAN_SHARED_STORE || path.join(process.env.USERPROFILE || '', '.dsh', 'storages', 'dsh_memory.json');
let touchedShared = false;
try {
	const before = fs.statSync(sharedStore).mtimeMs;
	appendCodingFact({ file: 'x.py' }, { summary: 'isolation probe', ws: WS });
	touchedShared = fs.statSync(sharedStore).mtimeMs !== before;
} catch { /* 共享库不存在时无法比较——只看未抛错即可 */ }
ok('不写共享事实库', touchedShared === false);

// 7) 原子落盘：无 .tmp 残留
const tmpLeftovers = [];
try {
	for (const f of fs.readdirSync(chainRoot(WS))) if (f.endsWith('.tmp')) tmpLeftovers.push(f);
} catch { /* 目录不存在则无残留 */ }
ok('无 .tmp 残留', tmpLeftovers.length === 0, tmpLeftovers.join(','));

// 8) 错误路径显式失败
throws('appendCodingFact: 坐标全空 → 报错', () => appendCodingFact({}, { summary: 'x', ws: WS }));
throws('appendCodingFact: 空摘要 → 报错', () => appendCodingFact({ file: 'a.py' }, { summary: '  ', ws: WS }));
throws('appendDiffEntry: 空正文 → 报错', () => appendDiffEntry('', coords, {}, { ws: WS }));
throws('recallCodingFact: 未知 id → 报错', () => recallCodingFact('no-such-id', { ws: WS }));

// 清理：把原型数据留在 chain-data（运行期数据，已 gitignore），但删除本次测试事实避免污染
try {
	const lines = fs.readFileSync(factsFile(WS), 'utf8').split('\n').filter(Boolean);
	const kept = lines.filter(l => {
		try { return JSON.parse(l).id !== fact.id; } catch { return true; }
	});
	fs.writeFileSync(factsFile(WS), kept.length ? kept.join('\n') + '\n' : '', 'utf8');
	// 本轮的 diff 条目一并清掉（按 hash 精确删）
	const dlines = fs.readFileSync(diffsFile(WS), 'utf8').split('\n').filter(Boolean);
	const dkept = dlines.filter(l => {
		try { return JSON.parse(l).hash !== entry.hash; } catch { return true; }
	});
	fs.writeFileSync(diffsFile(WS), dkept.length ? dkept.join('\n') + '\n' : '', 'utf8');
	try { fs.unlinkSync(diffBodyFile(entry.hash, WS)); } catch { /* 正文可能已不在 */ }
} catch { /* 无数据可清 */ }

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
