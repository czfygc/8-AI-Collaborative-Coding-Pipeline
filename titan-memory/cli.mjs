#!/usr/bin/env node
// CLI fallback for the shared TITAN memory store — for any client that can
// only reach a shell. Same store, same semantics as server.mjs.
//
//   node cli.mjs recall  '{"query":"10810","limit":5}'
//   node cli.mjs remember '{"text":"...","kind":"decision","tags":["x"]}'
//   node cli.mjs search  '{"query":"proxy"}'
//   node cli.mjs consolidate
//
// JSON args on argv, human-readable text on stdout; exit code 1 on error.

import process from 'node:process';
import { remember, recall, consolidate, MemoryError, workspacePath, memoryFile, factLine } from './store.mjs';
import { searchSessions } from './search.mjs';

function parseArgs(raw) {
	if (raw === undefined || raw === null || String(raw).trim() === '') return {};
	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new MemoryError('MEMORY_INVALID_ARGS', `argument must be JSON: ${error.message}`);
	}
}

async function main() {
	const [, , command, raw] = process.argv;
	const args = parseArgs(raw);
	const ws = workspacePath();
	const file = memoryFile();

	let out;
	switch (command) {
		case 'remember': {
			const fact = await remember(args, { ws, file });
			out = `stored ${fact.kind} fact ${fact.id}\n${factLine(fact)}`;
			break;
		}
		case 'recall': {
			const facts = recall({ query: args.query, limit: args.limit }, { ws, file });
			if (facts.length === 0) {
				out = args.query === undefined ? 'no active facts in this workspace yet'
					: `no active facts match ${JSON.stringify(String(args.query))} in this workspace`;
			} else {
				out = `${facts.length} fact(s) in ${ws}:\n${facts.map(factLine).join('\n')}`;
			}
			break;
		}
		case 'search': {
			const result = searchSessions({ query: args.query, limit: args.limit }, { ws });
			out = result.hits.length === 0
				? (result.note ?? 'no matches')
				: `${result.hits.map((hit, i) => `${i + 1}. session ${hit.sessionId}: ${hit.snippet}`).join('\n')}\n\nscanned ${result.scanned} session(s)`;
			break;
		}
		case 'consolidate':
			out = consolidate({ ws, file });
			break;
		default:
			process.stderr.write('usage: cli.mjs <remember|recall|search|consolidate> [json-args]\n');
			process.exit(2);
	}
	process.stdout.write(`${out}\n`);
}

main().catch((error) => {
	process.stderr.write(`${error?.code ? `${error.code}: ` : ''}${error?.message ?? String(error)}\n`);
	process.exit(1);
});
