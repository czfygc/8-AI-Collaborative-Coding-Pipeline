// T-150 scene routing for the titan-memory coding prototype (zero-dep, ESM).
//
// Three scenes, each with different memory behaviour:
//   chat     — conversational; durable long-term facts only, no working state.
//   working  — the agent is doing something (search, read, plan); session facts
//              are short-lived, durable facts are written on promotion.
//   coding   — the agent is editing source code; two-layer memory:
//              * session facts hold COORDINATES only (file / function / branch)
//              * the code diffs those coordinates point at live in a separate
//                content-addressed chain store (chain-store.mjs), keyed by sha256,
//                so a fact never carries diff body inline.
//
// This module is a pure routing helper — it does not read or write any store.
// The prototype's persisted data lives under <ws>/titan-memory/chain-data/.

const SCENES = ['chat', 'working', 'coding'];

// Source-file extensions that mark a scene as "coding" regardless of the tool.
const CODE_EXT = new Set([
	'.mjs', '.cjs', '.js', '.jsx', '.ts', '.tsx', '.py', '.c', '.cpp', '.h', '.hpp',
	'.cc', '.go', '.rs', '.java', '.rb', '.php', '.swift', '.kt', '.scala', '.sh', '.bash'
]);

/** Normalise a scene string to one of the three known scenes (default: working). */
export function normalizeScene(input) {
	const value = String(input ?? '').trim().toLowerCase();
	return SCENES.includes(value) ? value : 'working';
}

/**
 * Infer the scene from a lightweight context object. Deterministic and
 * side-effect free — the caller decides what to pass in.
 *
 * Precedence: explicit `scene` beats `file` beats `tool`.
 *   coding  — editing a source file (extension match)
 *   chat    — a chat/ask-style tool
 *   working — anything else (search, read, plan, unknown tool)
 */
export function detectSceneFromContext(ctx = {}) {
	if (ctx.scene !== undefined && ctx.scene !== null && String(ctx.scene).trim() !== '') {
		return normalizeScene(ctx.scene);
	}
	if (typeof ctx.file === 'string' && ctx.file.trim() !== '') {
		const dot = ctx.file.lastIndexOf('.');
		const ext = dot >= 0 ? ctx.file.slice(dot).toLowerCase() : '';
		if (CODE_EXT.has(ext)) return 'coding';
	}
	const tool = String(ctx.tool ?? '').trim().toLowerCase();
	if (tool === '' || tool === 'chat' || tool === 'ask' || tool === 'reply') return 'chat';
	return 'working';
}

/** Per-scene memory policy. `durable` = facts survive the session; `twoLayer` =
 *  session facts and reusable experiences are kept apart (coding only). */
export function sceneConfig(scene) {
	switch (normalizeScene(scene)) {
		case 'chat':
			return { scene: 'chat', durable: true, twoLayer: false, ttlMs: null };
		case 'coding':
			return { scene: 'coding', durable: true, twoLayer: true, ttlMs: null };
		default:
			return { scene: 'working', durable: false, twoLayer: false, ttlMs: 3_600_000 };
	}
}

/** True when `ctx` looks like a coding context (used by the prototype's writer). */
export function isCodingContext(ctx) {
	return detectSceneFromContext(ctx) === 'coding';
}