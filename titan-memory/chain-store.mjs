// T-150 coding diff-chain store (zero-dep, ESM, JSONL append-only).
//
// Two-layer coding memory, persisted under <ws>/titan-memory/chain-data/ — a
// private tree that never touches the shared fact store (dsh_memory.json).
//
//   facts.jsonl      — one line per CODING FACT. Holds COORDINATES ONLY
//                      (file / function / branch) plus a short summary. No diff
//                      body, no diff hash — by design.
//   diffs.jsonl      — one line per DIFF ENTRY, keyed by sha256 of the diff body.
//                      Carries the hash, a short summary and a diff reference;
//                      the body itself is NOT inlined here.
//   diff-bodies/<h>  — the raw diff text, content-addressed by its sha256.
//
// A fact links to its diffs through COORDINATES: recallCodingFact(id) returns a
// chain_block whose `diffs` array is assembled by matching diff entries against
// the fact's coordinates. To fetch the actual diff text you ask for the body by
// hash — the fact never carries it.
//
// All writes are atomic (tmp file + rename) so a crash mid-write cannot leave a
// half-line in the JSONL.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeWorkspacePath, workspacePath } from './store.mjs';
import { isCodingContext } from './scene.mjs';

export const CONFIG = {
	maxFactChars: 2000,
	maxDiffChars: 2_000_000,        // a diff body is code, not a novel
	chainDirName: 'chain-data',
	bodyDirName: 'diff-bodies'
};

// ----------------------------------------------------------------- paths

export function chainRoot(ws = workspacePath()) {
	const root = normalizeWorkspacePath(ws);
	return path.join(root, 'titan-memory', CONFIG.chainDirName);
}

export function factsFile(ws = workspacePath()) {
	return path.join(chainRoot(ws), 'facts.jsonl');
}

export function diffsFile(ws = workspacePath()) {
	return path.join(chainRoot(ws), 'diffs.jsonl');
}

export function diffBodyFile(hash, ws = workspacePath()) {
	return path.join(chainRoot(ws), CONFIG.bodyDirName, String(hash));
}

// ----------------------------------------------------------------- helpers

/** Normalise a coordinates object to {file, function, branch} with string values. */
export function normalizeCoordinates(input) {
	const src = input && typeof input === 'object' ? input : {};
	const out = {};
	for (const key of ['file', 'function', 'branch']) {
		const value = src[key];
		out[key] = value === undefined || value === null ? '' : String(value).trim();
	}
	return out;
}

/** Two coordinate sets match when every non-empty field of `a` equals `b`'s. */
export function coordinatesMatch(a, b) {
	const aC = normalizeCoordinates(a);
	const bC = normalizeCoordinates(b);
	for (const key of ['file', 'function', 'branch']) {
		if (aC[key].length > 0 && aC[key] !== bC[key]) return false;
	}
	return true;
}

function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true });
}

/** Atomically append one JSON line to a JSONL file (read + new line, tmp, rename). */
function appendJsonl(file, object) {
	ensureDir(path.dirname(file));
	let existing = '';
	try { existing = fs.readFileSync(file, 'utf8'); } catch { /* absent — fine */ }
	const tail = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
	const next = `${existing}${tail}${JSON.stringify(object)}\n`;
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, next, 'utf8');
	fs.renameSync(tmp, file);
}

function readJsonl(file) {
	try {
		const raw = fs.readFileSync(file, 'utf8');
		const lines = raw.split('\n');
		const out = [];
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			try { out.push(JSON.parse(trimmed)); } catch { /* skip corrupt line */ }
		}
		return out;
	} catch {
		return [];
	}
}

function sha256Of(text) {
	return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// ----------------------------------------------------------------- facts

/**
 * Append a CODING FACT. The fact stores ONLY coordinates + summary — no diff
 * body, no diff hash. Returns the fact object as persisted.
 */
export function appendCodingFact(coordinates, meta = {}) {
	const coords = normalizeCoordinates(coordinates);
	if (coords.file === '' && coords.function === '' && coords.branch === '') {
		throw new Error('appendCodingFact: at least one of file/function/branch is required');
	}
	const summary = String(meta.summary ?? '').trim();
	if (summary.length === 0) throw new Error('appendCodingFact: summary must not be empty');
	if ([...summary].length > CONFIG.maxFactChars) {
		throw new Error(`appendCodingFact: summary is ${[...summary].length} chars, over the cap of ${CONFIG.maxFactChars}`);
	}
	const record = {
		type: 'fact',
		id: crypto.randomUUID(),
		coordinates: coords,
		summary,
		createdAt: meta.createdAt ?? Date.now(),
		updatedAt: meta.updatedAt ?? Date.now()
	};
	appendJsonl(factsFile(meta.ws), record);
	return record;
}

// ----------------------------------------------------------------- diffs

/**
 * Append a DIFF ENTRY. The entry is keyed by sha256 of the diff body: it stores
 * the hash, a short summary, a diff reference and the COORDINATES it applies to
 * (so recall can assemble the chain by coordinate match) — the body itself is
 * NOT inlined. The raw body is written separately to diff-bodies/<hash> so it
 * can be fetched by hash without ever appearing in a fact.
 *
 * Returns the entry as persisted. Pass `ws` to target a specific workspace's
 * chain tree (defaults to this client's workspace).
 */
export function appendDiffEntry(diffBody, coordinates, meta = {}, { ws = workspacePath() } = {}) {
	const body = String(diffBody ?? '');
	if (body.length === 0) throw new Error('appendDiffEntry: diff body must not be empty');
	if ([...body].length > CONFIG.maxDiffChars) {
		throw new Error(`appendDiffEntry: diff body is ${[...body].length} chars, over the cap of ${CONFIG.maxDiffChars}`);
	}
	const hash = sha256Of(body);
	const summary = String(meta.summary ?? '').trim();
	const entry = {
		type: 'diff',
		hash,
		coordinates: normalizeCoordinates(coordinates),
		summary: summary.length > 0 ? summary : `diff ${hash.slice(0, 12)}`,
		ref: meta.ref === undefined || meta.ref === null ? `diff-bodies/${hash}` : String(meta.ref),
		createdAt: meta.createdAt ?? Date.now()
	};
	appendJsonl(diffsFile(ws), entry);
	// Raw body lives content-addressed — append-only, keyed by hash.
	const bodyFile = diffBodyFile(hash, ws);
	ensureDir(path.dirname(bodyFile));
	const tmp = `${bodyFile}.tmp`;
	fs.writeFileSync(tmp, body, 'utf8');
	fs.renameSync(tmp, bodyFile);
	return entry;
}

/** Read the raw diff body for a hash (returns '' when absent). */
export function readDiffBody(hash, { ws = workspacePath() } = {}) {
	try {
		return fs.readFileSync(diffBodyFile(hash, ws), 'utf8');
	} catch {
		return '';
	}
}

// ----------------------------------------------------------------- recall

/**
 * Recall a CODING FACT by id and assemble its chain_block:
 *   { fact, diffs: [{hash, summary, ref}], bodies: [] }
 *
 * `diffs` is built by matching diff entries against the fact's coordinates —
 * the body is NEVER inlined into the fact. `bodies` is an empty array by
 * default; pass {withBodies: true} to also pull the raw text (a separate,
 * explicit fetch — the prototype never inlines it).
 */
export function recallCodingFact(factId, { ws = workspacePath(), withBodies = false } = {}) {
	const facts = readJsonl(factsFile(ws));
	const fact = facts.find((entry) => entry.id === factId);
	if (!fact) {
		throw new Error(`recallCodingFact: no coding fact with id ${JSON.stringify(factId)} in ${chainRoot(ws)}`);
	}
	const diffs = readJsonl(diffsFile(ws))
		.filter((entry) => entry.type === 'diff' && coordinatesMatch(entry.coordinates, fact.coordinates))
		.map((entry) => ({ hash: entry.hash, summary: entry.summary, ref: entry.ref }));
	const bodies = withBodies
		? diffs.map((entry) => ({ hash: entry.hash, body: readDiffBody(entry.hash, { ws }) }))
		: [];
	return { fact, diffs, bodies };
}

/** List all coding facts for a workspace (newest first). */
export function listCodingFacts({ ws = workspacePath() } = {}) {
	return readJsonl(factsFile(ws)).slice().sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}