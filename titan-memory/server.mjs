#!/usr/bin/env node
// Zero-dependency MCP stdio server for the shared TITAN long-term memory.
//
// Transport: newline-delimited JSON-RPC 2.0 over stdin/stdout (the MCP stdio
// transport). No SDK — @modelcontextprotocol/sdk is not installed on this box
// and M7 says install nothing we do not need. stdout carries ONLY protocol
// frames; every diagnostic goes to stderr.
//
// Tools (the subset that can be served without a live DSH session):
//   memory_remember / memory_recall / memory_search / memory_consolidate
// Harness keeps its own native eight-tool set; all three clients read and
// write the same ~/.dsh/storages/dsh_memory.json.

import process from 'node:process';
import { remember, recall, consolidate, MemoryError, workspacePath, memoryFile, factLine, iso } from './store.mjs';
import { searchSessions } from './search.mjs';
import {
	recallCore,
	recallNotes,
	rememberCore,
	rememberNote,
	renderHits,
	coreFilePath,
	notesDirPath
} from './core-store.mjs';

const SERVER_NAME = 'titan-memory';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_PROTOCOL = '2025-06-18';

const log = (...args) => process.stderr.write(`${args.join(' ')}\n`);

const TEXT_OUTPUT = { type: 'text' };

// --------------------------------------------------------------- tool defs

const TOOLS = [
	{
		name: 'memory_remember',
		description: 'Add or update one fact in this workspace\'s shared long-term memory (the same store Harness\'s memory_remember writes). text <= 2000 chars, <= 300 active facts per workspace. Omit id to add; pass a recalled id to update. Workspace is fixed by TITAN_WORKSPACE.',
		inputSchema: {
			type: 'object',
			properties: {
				text: { type: 'string', description: 'Information-dense fact text; must not be empty.' },
				kind: { type: 'string', enum: ['preference', 'fact', 'convention', 'decision'], description: 'Fact category (default: fact).' },
				tags: { type: 'array', items: { type: 'string' }, description: 'Free-form routing tags; exact tag hits rank first on recall.' },
				id: { type: 'string', description: 'Update the existing fact with this id instead of adding a new one.' }
			},
			required: ['text']
		}
	},
	{
		name: 'memory_recall',
		description: 'Deterministic keyword scan over this workspace\'s active shared facts: exact tag matches rank first, case-insensitive text substring next, recency breaks ties. Literal not semantic — query with words the fact actually contains. Omit query to list the newest facts. Returns the fact id, which memory_remember can take to update.',
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Words to match against fact text and tags.' },
				limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum facts to return (default 20).' }
			}
		}
	},
	{
		name: 'memory_search',
		description: 'Literal full-text scan over PAST session logs of this workspace (durable zstd JSONL under ~/.dsh/sessions), newest session first, strongest excerpt per session. Covers raw conversation that was never promoted to a fact. Slower than memory_recall (decompresses logs); prefer memory_recall for curated facts. Returns null when nothing matches — never invents content.',
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Full-text query, interpreted literally.' },
				limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum sessions to return (default 5).' }
			},
			required: ['query']
		}
	},
	{
		name: 'memory_consolidate',
		description: 'Read-only report: how many active facts remain against the 300 cap, plus deterministic near-duplicate merge candidates (Jaccard >= 0.55 over fact tokens). Use it before writing when the workspace is close to full. Nothing is changed.',
		inputSchema: { type: 'object', properties: {} }
	},
	{
		name: 'memory_core_recall',
		description: 'dsh-core-memory style local retrieval over plain markdown files (coexists with the DSH fact store): reads <ws>/titan-memory/core/CORE.md (core memory, <= 3000 chars, resident per round) and keyword-scores long-tail notes under <ws>/titan-memory/core/notes/*.md. Zero network; keyword not semantic — a paraphrase may miss.',
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Keywords to match against CORE.md and notes/ bodies.' },
				limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum notes to return (default 5).' }
			}
		}
	},
	{
		name: 'memory_core_remember',
		description: 'Write the core memory markdown file (<ws>/titan-memory/core/CORE.md, max 3000 chars) — the resident-per-round snapshot. Pass note=<id> to write a long-tail note under notes/ instead (max 8000 chars per note). Files are git-versionable.',
		inputSchema: {
			type: 'object',
			properties: {
				text: { type: 'string', description: 'Markdown content to write.' },
				note: { type: 'string', description: 'Optional note id (a-zA-Z0-9._-). When set, writes notes/<id>.md instead of CORE.md.' }
			},
			required: ['text']
		}
	}
];

// ------------------------------------------------------------ tool execute

async function callTool(name, args) {
	const ws = workspacePath();
	const file = memoryFile();

	if (name === 'memory_remember') {
		const fact = await remember(args ?? {}, { ws, file });
		return `stored ${fact.kind} fact ${fact.id}\n${factLine(fact)}`;
	}

	if (name === 'memory_recall') {
		const input = args ?? {};
		const facts = recall({ query: input.query, limit: input.limit }, { ws, file });
		if (facts.length === 0) {
			return input.query === undefined || input.query === null || String(input.query).trim() === ''
				? 'no active facts in this workspace yet'
				: `no active facts match ${JSON.stringify(String(input.query))} in this workspace`;
		}
		const header = `${facts.length} fact(s) in ${ws}:`;
		return `${header}\n${facts.map(factLine).join('\n')}`;
	}

	if (name === 'memory_search') {
		const input = args ?? {};
		const result = searchSessions({ query: input.query, limit: input.limit }, { ws });
		if (result.hits.length === 0) return result.note ?? 'no matches';
		const lines = result.hits.map((hit, index) => {
			const when = hit.createdAt === undefined ? '' : `, ${iso(hit.createdAt)}`;
			return `${index + 1}. session ${hit.sessionId}${when}: ${hit.snippet}`;
		});
		const footer = `scanned ${result.scanned} session(s)${result.truncated ? ' (stopped at scan budget)' : ''}`;
		return `${lines.join('\n')}\n\n${footer}`;
	}

	if (name === 'memory_consolidate') {
		return consolidate({ ws, file });
	}

	if (name === 'memory_core_recall') {
		const input = args ?? {};
		const query = input.query ?? '';
		const core = recallCore({ query, limit: input.limit });
		const notes = recallNotes({ query, limit: input.limit });
		const sections = [renderHits(core), '', renderHits(notes)];
		return `CORE.md + notes/ local keyword recall for ${JSON.stringify(String(query))}:\n\n${sections.join('\n')}`;
	}

	if (name === 'memory_core_remember') {
		const input = args ?? {};
		const text = String(input.text ?? '');
		if (text.trim().length === 0) {
			throw new MemoryError('MEMORY_INVALID_ARGS', 'memory_core_remember: text must not be empty');
		}
		if (input.note !== undefined && String(input.note).length > 0) {
			const note = rememberNote(String(input.note), text);
			return `stored long-tail note ${note.id} (${note.bytes} bytes) under ${notesDirPath()}`;
		}
		const core = rememberCore(text);
		return `stored core memory (${core.chars} chars, ${core.bytes} bytes) at ${coreFilePath()}`;
	}

	throw new MemoryError('MEMORY_INVALID_ARGS', `unknown tool ${JSON.stringify(name)}`);
}

function toolResult(text, isError = false) {
	return { content: [{ ...TEXT_OUTPUT, text }], isError };
}

function errorText(error) {
	const code = error?.code ? `${error.code}: ` : '';
	return `${code}${error?.message ?? String(error)}`;
}

// ------------------------------------------------------------ jsonrpc loop

function reply(id, result) {
	send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
	send({ jsonrpc: '2.0', id, error: { code, message } });
}

function send(payload) {
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function dispatch(message) {
	const { id, method, params } = message;
	const isRequest = id !== undefined && id !== null;

	if (!isRequest) {
		// Notifications (initialized, cancelled, ...) need no response.
		return;
	}

	switch (method) {
		case 'initialize': {
			const requested = params?.protocolVersion;
			reply(id, {
				protocolVersion: typeof requested === 'string' ? requested : SUPPORTED_PROTOCOL,
				capabilities: { tools: {} },
				serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
				instructions: 'Shared TITAN long-term memory. Workspace is fixed by TITAN_WORKSPACE; facts are shared with the DeepSeek Harness client, which owns the full eight-tool set (memory_edit / memory_forget / memory_profile / memory_import live there). Writes are literal and durable — never invent fact ids or contents.'
			});
			return;
		}
		case 'ping':
			reply(id, {});
			return;
		case 'tools/list':
			reply(id, { tools: TOOLS });
			return;
		case 'tools/call': {
			const name = params?.name;
			try {
				const text = await callTool(name, params?.arguments ?? {});
				reply(id, toolResult(text, false));
			} catch (error) {
				// Per spec, tool-level failures surface as isError content so the
				// model sees the reason instead of a bare protocol error.
				log(`tool ${name} failed: ${error?.stack ?? error}`);
				reply(id, toolResult(errorText(error), true));
			}
			return;
		}
		default:
			replyError(id, -32601, `method not found: ${String(method)}`);
	}
}

function main() {
	log(`${SERVER_NAME} ${SERVER_VERSION} listening on stdio (workspace=${workspacePath()}, client=${process.env.TITAN_CLIENT || 'unknown'}, store=${memoryFile()})`);

	let buffer = '';
	process.stdin.setEncoding('utf8');
	process.stdin.on('data', (chunk) => {
		buffer += chunk;
		let newline;
		while ((newline = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line.length === 0) continue;
			let message;
			try {
				message = JSON.parse(line);
			} catch (error) {
				log(`dropping malformed frame: ${error.message}`);
				continue;
			}
			dispatch(message).catch((error) => {
				log(`dispatch failed: ${error?.stack ?? error}`);
				if (message.id !== undefined && message.id !== null) replyError(message.id, -32603, errorText(error));
			});
		}
	});
	process.stdin.on('end', () => process.exit(0));
	process.stdin.on('close', () => process.exit(0));
	process.on('SIGINT', () => process.exit(0));
	process.on('SIGTERM', () => process.exit(0));
}

main();
