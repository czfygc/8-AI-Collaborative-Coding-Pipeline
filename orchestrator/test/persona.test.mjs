import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadPersonas,
  resolvePersona,
  composeSystemPrompt,
  applyPersona,
  NONE_PERSONA,
  PERSONA_HEADER,
} from '../lib/persona.mjs';
import { buildPersonaSystemPrompt } from '../lib/prompts.mjs';

const PERSONAS = {
  base: { id: 'base', name: 'Base', system_prompt: 'You are TITAN.', tools: [] },
  review: { id: 'review', name: 'Review', system_prompt: 'Be strict.', tools: ['read'] },
  coder: { id: 'coder', name: 'Coder', system_prompt: 'Write code.', tools: [] },
};

function tmp() {
  return mkdtempSync(join(tmpdir(), 't141-persona-'));
}

test('loadPersonas reads structured and flat configs, and tolerates a missing file', () => {
  const dir = tmp();
  try {
    const structured = join(dir, 'structured.json');
    writeFileSync(structured, JSON.stringify({
      default: 'base',
      personas: {
        base: { name: 'Base', system_prompt: 'You are TITAN.' },
        review: { system_prompt: 'Be strict.', tools: ['read', 7] },
      },
    }));
    const loaded = loadPersonas(structured);
    assert.equal(loaded.defaultId, 'base');
    assert.equal(loaded.personas.base.name, 'Base');
    assert.equal(loaded.personas.review.name, 'review');
    assert.deepEqual(loaded.personas.review.tools, ['read', '7']);

    const flat = join(dir, 'flat.json');
    writeFileSync(flat, JSON.stringify({ solo: { system_prompt: 'Solo.' } }));
    const flatLoaded = loadPersonas(flat);
    assert.equal(flatLoaded.defaultId, null);
    assert.equal(flatLoaded.personas.solo.system_prompt, 'Solo.');

    assert.deepEqual(loadPersonas(join(dir, 'absent.json')), { defaultId: null, personas: {} });
    assert.deepEqual(loadPersonas(null), { defaultId: null, personas: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPersonas rejects malformed configs', () => {
  const dir = tmp();
  try {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{');
    assert.throws(() => loadPersonas(bad), /invalid persona config/);

    const empty = join(dir, 'empty.json');
    writeFileSync(empty, JSON.stringify({ personas: { broken: {} } }));
    assert.throws(() => loadPersonas(empty), /non-empty system_prompt/);

    const array = join(dir, 'array.json');
    writeFileSync(array, '[]');
    assert.throws(() => loadPersonas(array), /must be a JSON object/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolvePersona follows force > session > global > system', () => {
  const force = resolvePersona({
    sessionId: 's1',
    overrides: { forcePersonaId: 'coder' },
    sessions: { s1: { personaId: 'review' } },
    globalDefaultId: 'base',
    systemDefaultId: 'base',
    personas: PERSONAS,
  });
  assert.equal(force.personaId, 'coder');
  assert.equal(force.source, 'force');

  const session = resolvePersona({
    sessionId: 's1',
    sessions: { s1: { personaId: 'review' } },
    globalDefaultId: 'base',
    systemDefaultId: 'base',
    personas: PERSONAS,
  });
  assert.equal(session.personaId, 'review');
  assert.equal(session.source, 'session');

  const global = resolvePersona({
    sessionId: 's1',
    sessions: {},
    globalDefaultId: 'base',
    systemDefaultId: 'review',
    personas: PERSONAS,
  });
  assert.equal(global.personaId, 'base');
  assert.equal(global.source, 'global');

  const system = resolvePersona({
    sessionId: 's1',
    sessions: {},
    globalDefaultId: null,
    systemDefaultId: 'review',
    personas: PERSONAS,
  });
  assert.equal(system.personaId, 'review');
  assert.equal(system.source, 'system');

  const none = resolvePersona({ personas: PERSONAS });
  assert.equal(none.personaId, null);
  assert.equal(none.source, 'none');
  assert.equal(none.reason, 'no_selection');
});

test('a session-level override wins over the stored conversation persona', () => {
  const result = resolvePersona({
    sessionId: 's1',
    overrides: { personaId: 'coder' },
    sessions: { s1: { personaId: 'review' } },
    globalDefaultId: 'base',
    personas: PERSONAS,
  });
  assert.equal(result.personaId, 'coder');
  assert.equal(result.source, 'session');
});

test('[%None] clears the selection and never falls through', () => {
  const force = resolvePersona({
    overrides: { forcePersonaId: NONE_PERSONA },
    globalDefaultId: 'base',
    systemDefaultId: 'base',
    personas: PERSONAS,
  });
  assert.equal(force.cleared, true);
  assert.equal(force.persona, null);
  assert.equal(force.source, 'force');

  const session = resolvePersona({
    sessionId: 's1',
    sessions: { s1: { personaId: NONE_PERSONA } },
    globalDefaultId: 'base',
    systemDefaultId: 'base',
    personas: PERSONAS,
  });
  assert.equal(session.cleared, true);
  assert.equal(session.persona, null);
  assert.equal(session.source, 'session');

  const global = resolvePersona({
    globalDefaultId: NONE_PERSONA,
    systemDefaultId: 'base',
    personas: PERSONAS,
  });
  assert.equal(global.cleared, true);
  assert.equal(global.persona, null);
  assert.equal(global.source, 'global');
});

test('an unknown selected persona fails closed instead of falling back', () => {
  const result = resolvePersona({
    overrides: { forcePersonaId: 'ghost' },
    sessions: { s1: { personaId: 'review' } },
    globalDefaultId: 'base',
    personas: PERSONAS,
  });
  assert.equal(result.personaId, 'ghost');
  assert.equal(result.persona, null);
  assert.equal(result.source, 'force');
  assert.equal(result.reason, 'not_found');
});

test('composeSystemPrompt appends persona last and marks the result temp', () => {
  const base = 'Safety first.\nBe accurate.';
  const out = composeSystemPrompt(base, PERSONAS.review);
  assert.ok(out.text.startsWith(base));
  assert.ok(out.text.includes(PERSONA_HEADER));
  assert.ok(out.text.trimEnd().endsWith('Be strict.'));
  assert.ok(out.text.indexOf('Safety first.') < out.text.indexOf(PERSONA_HEADER));
  assert.equal(out.temp, true);
  assert.equal(out.injected, true);
  assert.equal(out.personaId, 'review');

  const unchanged = composeSystemPrompt(base, null);
  assert.equal(unchanged.text, base);
  assert.equal(unchanged.temp, false);
  assert.equal(unchanged.injected, false);

  const blank = composeSystemPrompt(base, { id: 'blank', system_prompt: '   ' });
  assert.equal(blank.text, base);
  assert.equal(blank.temp, false);

  assert.throws(() => composeSystemPrompt(null, PERSONAS.base), /basePrompt/);
});

test('applyPersona preserves the resolved source and prompts.mjs exposes the wrapper', () => {
  const base = 'Base system prompt.';
  const applied = applyPersona(base, { persona: PERSONAS.coder, source: 'global' });
  assert.equal(applied.temp, true);
  assert.equal(applied.source, 'global');
  assert.ok(applied.text.includes('Write code.'));

  const cleared = applyPersona(base, { persona: null, source: 'session' });
  assert.equal(cleared.text, base);
  assert.equal(cleared.temp, false);

  const viaPrompts = buildPersonaSystemPrompt(base, PERSONAS.base);
  assert.equal(viaPrompts.temp, true);
  assert.ok(viaPrompts.text.includes(PERSONA_HEADER));
  assert.ok(viaPrompts.text.includes('You are TITAN.'));
});
