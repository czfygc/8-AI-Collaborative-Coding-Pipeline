// Shared long-term-memory store for TITAN (OpenCode / Cline / Harness).
//
// Reads and writes the SAME file DSH's own dsh-native-memory plugin uses:
//   ~/.dsh/storages/dsh_memory.json
// so all three clients share one memory. The recall scoring below is a faithful
// port of dsh-native-memory's pure functions (MIT) so that Harness and the MCP
// clients return identical rankings for the same query.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------------------------------------------------------------- config

export const CONFIG = {
	maxFactsPerWorkspace: 300,
	maxFactChars: 2000,
	lockStaleMs: 10_000,
	lockTimeoutMs: 5_000,
	lockRetryMs: 15
};

export const KINDS = ['preference', 'fact', 'convention', 'decision'];

export function memoryFile() {
	return process.env.TITAN_MEMORY_FILE
		|| path.join(os.homedir(), '.dsh', 'storages', 'dsh_memory.json');
}

/** Canonical workspace-path form. The fact table joins on an EXACT string
 *  match, DSH writes the native spelling (`D:\TITAN_ARCHAEOLOGY`), while the
 *  MCP configs spell it `D:/TITAN_ARCHAEOLOGY`. Without normalising, a
 *  forward-slash TITAN_WORKSPACE silently returns zero active facts — this
 *  bug shipped in the first wiring and was caught by the Cline cross-check. */
export function normalizeWorkspacePath(input) {
	let value = String(input ?? '').trim();
	while (value.length > 1 && (value.endsWith('/') || value.endsWith('\\'))) value = value.slice(0, -1);
	if (process.platform === 'win32') value = value.split('/').join('\\');
	return value;
}

/** Workspace this client is bound to. Explicit env beats cwd: MCP servers can
 *  be launched with an arbitrary cwd, and the fact table is workspace-scoped. */
export function workspacePath() {
	return normalizeWorkspacePath(process.env.TITAN_WORKSPACE || process.cwd());
}

/** Provenance stamped on facts we write, so a reader can tell MCP writes from
 *  Harness writes. Set TITAN_CLIENT=opencode / cline in each client's config. */
function originSession() {
	return `mcp:${process.env.TITAN_CLIENT || 'unknown'}`;
}

// ------------------------------------------------- dsh-native-memory port
// Source: node_modules/dsh-native-memory/lib/index.mjs (MIT, highland0971)

export function tokenize(query) {
	const tokens = new Set();
	for (const word of query.toLowerCase().split(/\s+/)) {
		const runs = word.match(/[㐀-鿿]+|[^㐀-鿿]+/g) ?? [];
		for (const run of runs) {
			tokens.add(run);
			if (/^[㐀-鿿]+$/.test(run) && run.length >= 2) {
				for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2));
			}
		}
	}
	return [...tokens].filter((token) => token.length > 0);
}

export function factTokens(text) {
	const tokens = new Set();
	const runs = text.toLowerCase().match(/[㐀-鿿]+|[^㐀-鿿]+/g) ?? [];
	for (const run of runs) {
		if (/^[㐀-鿿]+$/.test(run)) {
			tokens.add(run);
			for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2));
		} else {
			for (const word of run.split(/[^a-z0-9]+/)) if (word.length > 0) tokens.add(word);
		}
	}
	return tokens;
}

/** Three tiers: exact tag +3, fuzzy tag +1, case-insensitive text substring +2,
 *  whole multi-word phrase +4. */
export function scoreFact(fact, tokens, fullQuery, phraseBoost) {
	const text = fact.text.toLowerCase();
	const tags = (fact.tags ?? []).map((tag) => tag.toLowerCase());
	let score = 0;
	for (const token of tokens) {
		if (tags.includes(token)) score += 3;
		else if (tags.some((tag) => tag.includes(token) || token.includes(tag))) score += 1;
		if (text.includes(token)) score += 2;
	}
	if (phraseBoost && fullQuery.length > 1 && text.includes(fullQuery)) score += 4;
	return score;
}

export function compareRecency(left, right) {
	return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id);
}

const CONSOLIDATION_SIMILARITY = 0.55;
const CONSOLIDATION_MAX_PAIRS = 5;

export function suggestConsolidations(facts) {
	const tokenSets = facts.map((fact) => ({ fact, tokens: factTokens(fact.text) }));
	const candidates = [];
	for (let i = 0; i < tokenSets.length; i += 1) {
		for (let j = i + 1; j < tokenSets.length; j += 1) {
			const left = tokenSets[i];
			const right = tokenSets[j];
			const intersection = [...left.tokens].filter((token) => right.tokens.has(token)).length;
			const union = new Set([...left.tokens, ...right.tokens]).size;
			if (union === 0) continue;
			const similarity = intersection / union;
			if (similarity < CONSOLIDATION_SIMILARITY) continue;
			candidates.push({
				a: left.fact,
				b: right.fact,
				similarity,
				suggestedText: `${left.fact.text} ${right.fact.text}`.slice(0, 600)
			});
		}
	}
	return candidates
		.sort((x, y) => y.similarity - x.similarity || x.a.id.localeCompare(y.a.id) || x.b.id.localeCompare(y.b.id))
		.slice(0, CONSOLIDATION_MAX_PAIRS);
}

export function truncate(text, max) {
	return [...text].length <= max ? text : `${[...text].slice(0, max).join('')}…`;
}

export function iso(millis) {
	return new Date(millis).toISOString();
}

export function factLine(fact) {
	const tags = (fact.tags ?? []).length > 0 ? ` (tags: ${fact.tags.join(', ')})` : '';
	return `- ${fact.id} [${fact.kind}] ${truncate(fact.text, 400)}${tags} — updated ${iso(fact.updatedAt)}`;
}

// ------------------------------------------------------------ file access

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class MemoryError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
		this.name = 'MemoryError';
	}
}

/** Serialise our own writers (OpenCode + Cline can hit the file at once).
 *  DSH does not take this lock — it writes on demand only (verified: the file
 *  sat untouched for 6h while dsh was running), so the window stays tiny. */
async function withLock(file, fn) {
	const lock = `${file}.titanlock`;
	const deadline = Date.now() + CONFIG.lockTimeoutMs;
	for (;;) {
		try {
			fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
			break;
		} catch (error) {
			if (error.code !== 'EEXIST') throw error;
			try {
				if (Date.now() - fs.statSync(lock).mtimeMs > CONFIG.lockStaleMs) {
					fs.rmSync(lock, { force: true });
					continue;
				}
			} catch { /* lock vanished; retry */ }
			if (Date.now() > deadline) {
				fs.rmSync(lock, { force: true });
				continue;
			}
			await sleep(CONFIG.lockRetryMs);
		}
	}
	try {
		return await fn();
	} finally {
		fs.rmSync(lock, { force: true });
	}
}

function normalise(doc) {
	if (doc === null || typeof doc !== 'object') throw new MemoryError('MEMORY_UNAVAILABLE', 'memory file is not a JSON object');
	doc.tables = doc.tables ?? {};
	doc.tables.facts = doc.tables.facts ?? {};
	doc.tables.profiles = doc.tables.profiles ?? {};
	return doc;
}

export function readDoc(file = memoryFile()) {
	const raw = fs.readFileSync(file, 'utf8');
	return normalise(JSON.parse(raw));
}

/** Atomic replace. Keeps a rolling .bak of the previous bytes so a bad write is
 *  always recoverable, and refuses to persist a doc whose facts fail the DSH
 *  FactSchema shape (a malformed row would make the Harness plugin refuse to
 *  open the domain at all). Exported so tests can clean up after themselves. */
export function writeDoc(file, doc) {
	assertShape(doc);
	const backup = `${file}.bak`;
	try { fs.copyFileSync(file, backup); } catch { /* first run */ }
	const tmp = `${file}.titan.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
	fs.renameSync(tmp, file);
}

function assertShape(doc) {
	for (const [id, fact] of Object.entries(doc.tables.facts)) {
		const problems = [];
		if (typeof fact?.id !== 'string' || fact.id.length === 0) problems.push('id');
		if (typeof fact?.workspacePath !== 'string' || fact.workspacePath.length === 0) problems.push('workspacePath');
		if (!KINDS.includes(fact?.kind)) problems.push(`kind(${fact?.kind})`);
		if (typeof fact?.text !== 'string' || fact.text.length === 0) problems.push('text');
		if (!Array.isArray(fact?.tags) || fact.tags.some((t) => typeof t !== 'string')) problems.push('tags');
		if (typeof fact?.sessionId !== 'string' || fact.sessionId.length === 0) problems.push('sessionId');
		if (!Number.isInteger(fact?.seq) || fact.seq < 0) problems.push('seq');
		if (!Number.isInteger(fact?.createdAt) || fact.createdAt < 0) problems.push('createdAt');
		if (!Number.isInteger(fact?.updatedAt) || fact.updatedAt < 0) problems.push('updatedAt');
		if (fact?.state !== 'active' && fact?.state !== 'archived') problems.push(`state(${fact?.state})`);
		if (problems.length > 0) {
			throw new MemoryError('MEMORY_UNAVAILABLE', `refusing to write: fact ${id} fails the DSH FactSchema (${problems.join(', ')})`);
		}
	}
}

// ------------------------------------------------------------- operations

const activeIn = (doc, ws) =>
	Object.values(doc.tables.facts).filter((fact) => fact.workspacePath === ws && fact.state === 'active');

export function listActive(ws, file = memoryFile()) {
	return activeIn(readDoc(file), ws).sort(compareRecency);
}

export async function remember(args, { ws = workspacePath(), file = memoryFile() } = {}) {
	const text = args.text;
	if (typeof text !== 'string' || text.trim().length === 0) {
		throw new MemoryError('MEMORY_INVALID_ARGS', 'memory_remember: fact text must not be empty');
	}
	const kind = args.kind ?? 'fact';
	if (!KINDS.includes(kind)) {
		throw new MemoryError('MEMORY_INVALID_ARGS', `memory_remember: kind must be one of ${KINDS.join('|')}`);
	}
	const tags = args.tags ?? [];
	if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) {
		throw new MemoryError('MEMORY_INVALID_ARGS', 'memory_remember: tags must be an array of strings');
	}
	if ([...text].length > CONFIG.maxFactChars) {
		throw new MemoryError('MEMORY_CAP_EXCEEDED', `fact text is ${[...text].length} characters, over the cap of ${CONFIG.maxFactChars}; split the fact or consolidate with memory_consolidate`);
	}

	return withLock(file, () => {
		const doc = readDoc(file);
		const now = Date.now();
		const active = activeIn(doc, ws);
		let fact;

		if (args.id !== undefined) {
			const existing = doc.tables.facts[args.id];
			if (existing === undefined || existing.workspacePath !== ws) {
				throw new MemoryError('MEMORY_NOT_FOUND', `memory_remember: no fact '${args.id}' in this workspace`);
			}
			fact = { ...existing, kind, text, tags, updatedAt: now, state: 'active' };
		} else {
			const occupied = active.filter((f) => f.id !== undefined).length;
			if (occupied >= CONFIG.maxFactsPerWorkspace) {
				throw new MemoryError('MEMORY_CAP_EXCEEDED', `workspace already holds ${CONFIG.maxFactsPerWorkspace} active facts (the cap); run memory_consolidate and drop stale ones first`);
			}
			const seq = doc.tables.facts && Object.values(doc.tables.facts)
				.reduce((max, f) => Math.max(max, Number.isInteger(f.seq) ? f.seq : 0), 0);
			fact = {
				id: crypto.randomUUID(),
				workspacePath: ws,
				kind,
				text,
				tags,
				sessionId: originSession(),
				seq: seq + 1,
				createdAt: now,
				updatedAt: now,
				state: 'active'
			};
		}

		doc.tables.facts[fact.id] = fact;
		writeDoc(file, doc);
		return fact;
	});
}

export function recall({ query, limit = 20 }, { ws = workspacePath(), file = memoryFile() } = {}) {
	const bounded = Math.max(1, Math.min(50, Math.trunc(limit) || 20));
	const active = activeIn(readDoc(file), ws);
	if (query === undefined || query === null || String(query).trim().length === 0) {
		return active.sort(compareRecency).slice(0, bounded);
	}
	const tokens = tokenize(String(query));
	if (tokens.length === 0) return active.sort(compareRecency).slice(0, bounded);
	const folded = String(query).trim().toLowerCase();
	const phraseBoost = /\s/.test(String(query).trim());
	return active
		.map((fact) => ({ fact, score: scoreFact(fact, tokens, folded, phraseBoost) }))
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score || compareRecency(left.fact, right.fact))
		.slice(0, bounded)
		.map((entry) => entry.fact);
}

export function consolidate({ ws = workspacePath(), file = memoryFile() } = {}) {
	const facts = listActive(ws, file);
	const budget = CONFIG.maxFactsPerWorkspace - facts.length;
	const header = `${facts.length} active facts; budget remaining: ${Math.max(0, budget)} of ${CONFIG.maxFactsPerWorkspace}`;
	const candidates = suggestConsolidations(facts);
	if (candidates.length === 0) return `${header}\nno consolidation candidates — the active facts look distinct`;
	const lines = candidates.map((candidate, index) =>
		`${index + 1}. ${candidate.a.id} + ${candidate.b.id} (${Math.round(candidate.similarity * 100)}%): ${truncate(candidate.suggestedText, 300)}`);
	return `${header}\n\nMerge candidates (near-duplicate text):\n${lines.join('\n')}\n\nApply with memory_remember (pass the kept fact's id to rewrite it) — there is no delete on this side; ask Harness to memory_forget the loser.`;
}
