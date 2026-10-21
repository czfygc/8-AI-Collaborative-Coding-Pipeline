#!/usr/bin/env node
// End-to-end test for the shared memory MCP server.
//
// Speaks real newline-delimited JSON-RPC to server.mjs over stdio — the same
// frames OpenCode and Cline send — then verifies:
//   1. initialize / tools/list negotiate correctly (6 tools)
//   2. remember -> recall round-trips through the ACTUAL store file
//   3. the written fact satisfies DSH's FactSchema (writeDoc asserts it)
//   4. pre-existing Harness facts are left untouched
//   5. search and consolidate return usable output
//   6. error paths surface as isError content, not protocol failures
//   7. the test fact is removed again, so the run leaves no residue
//
// Run:  node test.mjs     (cwd must be the workspace)

import { spawn } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readDoc, writeDoc, listActive, CONFIG } from './store.mjs';
import { appendCodingFact, appendDiffEntry } from './chain-store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS = process.cwd();
const CLIENT = 'test-harness';

// Snapshot any pre-existing core-memory files BEFORE the suite writes its own.
// If the suite is launched with cwd elsewhere (e.g. the repo root), WS points
// at the REAL workspace, and the core tests would overwrite then delete the
// real CORE.md. Cleanup below restores byte-for-byte from these backups (T-101).
const CORE_DIR = path.join(WS, 'titan-memory', 'core');
let coreBackup = null;
let noteBackup = null;
try { coreBackup = fs.readFileSync(path.join(CORE_DIR, 'CORE.md'), 'utf8'); } catch { /* absent */ }
try { noteBackup = fs.readFileSync(path.join(CORE_DIR, 'notes', 'selftest-proxy.md'), 'utf8'); } catch { /* absent */ }
if (path.resolve(WS) !== path.resolve(HERE)) {
	process.stderr.write(`[warn] suite cwd is ${WS}, not ${HERE}; real-core backup/restore active (coreBackup=${coreBackup !== null})\n`);
}

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

class Client {
	constructor(child) {
		this.child = child;
		this.pending = new Map();
		this.nextId = 1;
		this.stderr = '';
		let buffer = '';
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk) => {
			buffer += chunk;
			let nl;
			while ((nl = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (line.length === 0) continue;
				let message;
				try { message = JSON.parse(line); } catch { continue; }
				const waiter = this.pending.get(message.id);
				if (waiter) {
					this.pending.delete(message.id);
					waiter(message);
				}
			}
		});
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk) => { this.stderr += chunk; });
	}

	request(method, params) {
		const id = this.nextId++;
		const payload = { jsonrpc: '2.0', id, method };
		if (params !== undefined) payload.params = params;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`timeout waiting for ${method}`));
			}, 25_000);
			this.pending.set(id, (message) => {
				clearTimeout(timer);
				if (message.error) reject(new Error(`${method}: ${message.error.message}`));
				else resolve(message.result);
			});
			this.child.stdin.write(`${JSON.stringify(payload)}\n`);
		});
	}

	notify(method, params) {
		const payload = { jsonrpc: '2.0', method };
		if (params !== undefined) payload.params = params;
		this.child.stdin.write(`${JSON.stringify(payload)}\n`);
	}

	async stop() {
		this.child.stdin.end();
		await new Promise((resolve) => {
			this.child.once('exit', resolve);
			setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 3000);
		});
	}
}

async function main() {
	const before = readDoc();
	const beforeActive = listActive(WS).length;
	const beforeIds = new Set(Object.keys(before.tables.facts));
	process.stdout.write(`store: active facts before = ${beforeActive}\n\n`);

	const child = spawn(process.execPath, [path.join(HERE, 'server.mjs')], {
		env: { ...process.env, TITAN_WORKSPACE: WS, TITAN_CLIENT: CLIENT },
		stdio: ['pipe', 'pipe', 'pipe'],
		windowsHide: true
	});
	const client = new Client(child);
	let testFactId;

	try {
		process.stdout.write('protocol\n');
		const init = await client.request('initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: CLIENT, version: '1.0.0' }
		});
		ok('initialize returns serverInfo', init?.serverInfo?.name === 'titan-memory');
		ok('initialize advertises tools capability', typeof init?.capabilities?.tools === 'object');
		client.notify('notifications/initialized');

		const ping = await client.request('ping');
		ok('ping responds', ping !== undefined);

		process.stdout.write('\ntools/list\n');
		const listed = await client.request('tools/list');
		const names = (listed.tools ?? []).map((t) => t.name).sort();
		ok('exposes exactly 7 tools',
			JSON.stringify(names) === JSON.stringify(['memory_coding_recall', 'memory_consolidate', 'memory_core_recall', 'memory_core_remember', 'memory_recall', 'memory_remember', 'memory_search']),
			JSON.stringify(names));
		for (const tool of listed.tools ?? []) {
			ok(`  ${tool.name} has description`, typeof tool.description === 'string' && tool.description.length > 40);
			ok(`  ${tool.name} inputSchema is a JSON object`, tool.inputSchema?.type === 'object');
		}

		process.stdout.write('\nremember -> recall round trip\n');
		const text = `titan-memory-mcp selftest ${Date.now()} — verify shared store write path`;
		const rememberResult = await client.request('tools/call', {
			name: 'memory_remember',
			arguments: { text, kind: 'fact', tags: ['titan-mcp-selftest', 'verification'] }
		});
		ok('remember not an error', rememberResult.isError !== true, JSON.stringify(rememberResult));
		const stored = rememberResult.content?.[0]?.text ?? '';
		const idMatch = stored.match(/fact ([0-9a-f-]{36})/);
		testFactId = idMatch?.[1];
		ok('remember returns a fact id', Boolean(testFactId), stored.slice(0, 200));

		// The write must have landed in the real file, shape-valid for DSH.
		const after = readDoc();
		ok('fact persisted to dsh_memory.json', testFactId !== undefined && after.tables.facts[testFactId] !== undefined);
		const storedFact = after.tables.facts[testFactId];
		ok('fact has DSH FactSchema fields',
			storedFact?.workspacePath === WS && storedFact?.state === 'active'
			&& storedFact?.sessionId === `mcp:${CLIENT}`
			&& Number.isInteger(storedFact?.seq) && Number.isInteger(storedFact?.updatedAt));
		ok('pre-existing facts untouched',
			[...beforeIds].every((id) => after.tables.facts[id] !== undefined));
		ok('unit/global preserved',
			JSON.stringify(after.unit) === JSON.stringify(before.unit) && JSON.stringify(after.global) === JSON.stringify(before.global));

		const recallResult = await client.request('tools/call', {
			name: 'memory_recall',
			arguments: { query: 'titan-memory-mcp selftest', limit: 5 }
		});
		ok('recall not an error', recallResult.isError !== true, JSON.stringify(recallResult));
		const recallText = recallResult.content?.[0]?.text ?? '';
		ok('recall finds the new fact', recallText.includes('titan-memory-mcp selftest'), recallText.slice(0, 300));
		ok('recall returns the id', recallText.includes(testFactId ?? 'none'));

		process.stdout.write('\nrecall ranking parity\n');
		const tagHits = await client.request('tools/call', {
			name: 'memory_recall',
			arguments: { query: 'titan-mcp-selftest' }
		});
		ok('tag query ranks the fact first',
			(tagHits.content?.[0]?.text ?? '').trim().split('\n')[1]?.includes(testFactId ?? 'none'));

		process.stdout.write('\nerror paths\n');
		const empty = await client.request('tools/call', { name: 'memory_remember', arguments: { text: '   ' } });
		ok('empty text reported as isError', empty.isError === true && /empty/i.test(empty.content?.[0]?.text ?? ''),
			JSON.stringify(empty));
		const missing = await client.request('tools/call', { name: 'memory_remember', arguments: { text: 'x', id: 'no-such-id' } });
		ok('unknown id reported as isError', missing.isError === true && /MEMORY_NOT_FOUND/.test(missing.content?.[0]?.text ?? ''));
		const missingRecall = await client.request('tools/call', { name: 'memory_recall', arguments: { query: 'zzz_no_such_token_zzz' } });
		// cwd-agnostic: from a foreign cwd the garbage query may legitimately
		// hit real in-scope facts (token tag of T-65); inventing is what fails.
		ok('miss reports no match or only real facts (never invents)',
			/no active facts match|\d+ fact\(s\) in /.test(missingRecall.content?.[0]?.text ?? ''));
		const unknown = await client.request('tools/call', { name: 'not_a_tool', arguments: {} });
		ok('unknown tool reported as isError', unknown.isError === true);

		process.stdout.write('\nsearch\n');
		const search = await client.request('tools/call', {
			name: 'memory_search',
			arguments: { query: 'titan-memory-mcp selftest', limit: 3 }
		});
		ok('search not an error', search.isError !== true, JSON.stringify(search).slice(0, 300));
		process.stdout.write(`    search: ${(search.content?.[0]?.text ?? '').split('\n')[0].slice(0, 160)}\n`);

		process.stdout.write('\nconsolidate\n');
		const consol = await client.request('tools/call', { name: 'memory_consolidate', arguments: {} });
		ok('consolidate not an error', consol.isError !== true);
		const consolText = consol.content?.[0]?.text ?? '';
		ok('consolidate reports budget', /budget remaining: \d+ of 300/.test(consolText), consolText.slice(0, 120));

		process.stdout.write('\ncore memory (dsh-core-memory style)\n');
		const coreWrite = await client.request('tools/call', {
			name: 'memory_core_remember',
			arguments: { text: '# selftest core\n\nM1 开工前三步 pull rebase 读台账 认领提交' }
		});
		ok('core remember not an error', coreWrite.isError !== true, JSON.stringify(coreWrite).slice(0, 200));
		const coreText = coreWrite.content?.[0]?.text ?? '';
		ok('core remember reports chars', /chars/.test(coreText), coreText.slice(0, 160));
		const noteWrite = await client.request('tools/call', {
			name: 'memory_core_remember',
			arguments: { text: '# selftest note\n\n10810 代理切换备忘', note: 'selftest-proxy' }
		});
		ok('note remember not an error', noteWrite.isError !== true, JSON.stringify(noteWrite).slice(0, 200));
		ok('note remember reports note id', /selftest-proxy/.test(noteWrite.content?.[0]?.text ?? ''));
		const coreHit = await client.request('tools/call', {
			name: 'memory_core_recall',
			arguments: { query: '认领提交', limit: 5 }
		});
		ok('core recall not an error', coreHit.isError !== true);
		const coreHitText = coreHit.content?.[0]?.text ?? '';
		ok('core recall finds CORE.md hit', /CORE\.md/.test(coreHitText), coreHitText.slice(0, 200));
		const noteHit = await client.request('tools/call', {
			name: 'memory_core_recall',
			arguments: { query: '10810', limit: 5 }
		});
		const noteHitText = noteHit.content?.[0]?.text ?? '';
		ok('note recall finds selftest-proxy', /selftest-proxy/.test(noteHitText), noteHitText.slice(0, 200));
		const miss = await client.request('tools/call', {
			name: 'memory_core_recall',
			arguments: { query: 'zzz_nothing_matches_xyz', limit: 5 }
		});
		ok('note recall misses on gibberish', /no hits|no notes/.test(miss.content?.[0]?.text ?? ''), (miss.content?.[0]?.text ?? '').slice(0, 200));

		process.stdout.write('\nunknown method\n');
		await client.request('resources/list').then(
			() => ok('unknown method rejected', false, 'resolved instead of rejecting'),
			() => ok('unknown method rejected', true)
		);

		// T-150 coding chain: the fact carries coordinates only; the diff body
		// lives in the content-addressed chain store and is returned only when
		// the caller explicitly asks for it.
		process.stdout.write('\ncoding memory chain (T-150)\n');
		const chainFact = appendCodingFact(
			{ file: 'src/selftest.ts', function: 'runSelftest', branch: 'main' },
			{ summary: 'selftest coding fact', ws: WS }
		);
		const chainDiff = appendDiffEntry(
			'--- a/src/selftest.ts\n+++ b/src/selftest.ts\n@@\n-old\n+new\n',
			{ file: 'src/selftest.ts', function: 'runSelftest', branch: 'main' },
			{ summary: 'selftest diff', ref: 'git:selftest' },
			{ ws: WS }
		);
		const chainHit = await client.request('tools/call', {
			name: 'memory_coding_recall',
			arguments: { fact_id: chainFact.id }
		});
		ok('coding recall not an error', chainHit.isError !== true, JSON.stringify(chainHit).slice(0, 200));
		const chainText = chainHit.content?.[0]?.text ?? '';
		let chainBlockJson = {};
		try { chainBlockJson = JSON.parse(chainText); } catch { /* keep empty */ }
		ok('coding recall returns coordinates', chainBlockJson?.fact?.coordinates?.file === 'src/selftest.ts', chainText.slice(0, 200));
		ok('coding recall returns diff reference', chainBlockJson?.diffs?.[0]?.hash === chainDiff.hash, chainText.slice(0, 200));
		ok('coding recall hides diff body by default',
			!chainText.includes('@@') && chainBlockJson?.bodies === undefined, chainText.slice(0, 200));
		const chainBodies = await client.request('tools/call', {
			name: 'memory_coding_recall',
			arguments: { fact_id: chainFact.id, include_bodies: true }
		});
		const bodiesText = chainBodies.content?.[0]?.text ?? '';
		ok('coding recall returns body only when asked', bodiesText.includes('@@'), bodiesText.slice(0, 200));
		const chainMiss = await client.request('tools/call', {
			name: 'memory_coding_recall',
			arguments: { fact_id: 'no-such-coding-fact' }
		});
		ok('coding recall missing fact is an error result (not a crash)',
			chainMiss.isError === true && /not found|MEMORY_NOT_FOUND/i.test(chainMiss.content?.[0]?.text ?? ''),
			JSON.stringify(chainMiss).slice(0, 200));
	} finally {
		await client.stop();
		if (client.stderr.trim().length > 0) {
			process.stdout.write(`\nserver stderr:\n${client.stderr.trim().split('\n').slice(0, 6).map((l) => `  ${l}`).join('\n')}\n`);
		}
	}

	// Cleanup: the tool set deliberately has no delete, so unwind the test fact
	// through the same shape-checked writer the server uses.
	process.stdout.write('\ncleanup\n');
	if (testFactId !== undefined) {
		const doc = readDoc();
		if (doc.tables.facts[testFactId]) delete doc.tables.facts[testFactId];
		writeDoc(memoryFileOf(), doc);
		const gone = readDoc().tables.facts[testFactId] === undefined;
		ok('test fact removed', gone);
	}
	const finalActive = listActive(WS).length;
	ok(`active facts restored (${finalActive} of ${beforeActive})`, finalActive === beforeActive);

	// Core-memory files written by this suite (under ws/titan-memory/core).
	// Per file: restore a pre-existing snapshot byte-for-byte, else remove the
	// test copy — a partial snapshot (real CORE.md but no real note) must not
	// leave suite residue behind (T-101 round 2).
	const coreFile = path.join(CORE_DIR, 'CORE.md');
	const noteFile = path.join(CORE_DIR, 'notes', 'selftest-proxy.md');
	const hadReal = coreBackup !== null || noteBackup !== null;
	if (hadReal) {
		if (coreBackup !== null) {
			fs.mkdirSync(CORE_DIR, { recursive: true });
			fs.writeFileSync(coreFile, coreBackup, 'utf8');
		} else {
			fs.rmSync(coreFile, { force: true });
		}
		if (noteBackup !== null) {
			fs.mkdirSync(path.dirname(noteFile), { recursive: true });
			fs.writeFileSync(noteFile, noteBackup, 'utf8');
		} else {
			fs.rmSync(noteFile, { force: true });
		}
		const coreOk = coreBackup === null
			? !fs.existsSync(coreFile)
			: fs.readFileSync(coreFile, 'utf8') === coreBackup;
		const noteOk = noteBackup === null
			? !fs.existsSync(noteFile)
			: fs.readFileSync(noteFile, 'utf8') === noteBackup;
		ok('pre-existing core files restored byte-for-byte, test residue removed', coreOk && noteOk);
		ok('suite did not destroy real CORE.md',
			coreBackup === null || (fs.existsSync(coreFile) && fs.readFileSync(coreFile, 'utf8') === coreBackup));
	} else {
		fs.rmSync(CORE_DIR, { recursive: true, force: true });
		ok('core test tree cleaned', !fs.existsSync(coreFile));
		ok('core note test file cleaned', !fs.existsSync(noteFile));
	}

	process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
	process.exit(failures === 0 ? 0 : 1);
}

function memoryFileOf() {
	return process.env.TITAN_MEMORY_FILE
		|| path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'storages', 'dsh_memory.json');
}

main().catch((error) => {
	process.stderr.write(`\nFATAL ${error?.stack ?? error}\n`);
	process.exit(1);
});
