// T-141 AstrBot Phase 1 Persona：四层优先级 + [%None] 清除 + temp 注入
import { readFileSync } from 'node:fs';

export const NONE_PERSONA = '[%None]';
export const PERSONA_HEADER = '# Persona Instructions';

const SOURCE = Object.freeze({
  FORCE: 'force',
  SESSION: 'session',
  GLOBAL: 'global',
  SYSTEM: 'system',
  NONE: 'none',
});

function absent(value) {
  return value === undefined || value === null || value === '';
}

function normalizePersona(id, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('persona "' + id + '" must be an object');
  }
  const prompt = raw.system_prompt ?? raw.systemPrompt;
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new TypeError('persona "' + id + '" requires a non-empty system_prompt');
  }
  return {
    id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : id,
    system_prompt: prompt,
    tools: Array.isArray(raw.tools) ? raw.tools.map(String) : [],
  };
}

export function loadPersonas(filePath) {
  if (absent(filePath)) {
    return { defaultId: null, personas: {} };
  }
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { defaultId: null, personas: {} };
    throw err;
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new SyntaxError('invalid persona config ' + filePath + ': ' + err.message);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new TypeError('persona config must be a JSON object');
  }
  const table = doc.personas && typeof doc.personas === 'object' && !Array.isArray(doc.personas)
    ? doc.personas
    : doc;
  const personas = {};
  for (const [id, raw] of Object.entries(table)) {
    if (id === 'default' || id === 'defaultId') continue;
    personas[id] = normalizePersona(id, raw);
  }
  const defaultId = typeof doc.default === 'string'
    ? doc.default
    : (typeof doc.defaultId === 'string' ? doc.defaultId : null);
  return { defaultId, personas };
}

export function resolvePersona({
  sessionId = null,
  overrides = {},
  sessions = {},
  globalDefaultId = null,
  systemDefaultId = null,
  personas = {},
} = {}) {
  const layers = [];
  if (overrides && !absent(overrides.forcePersonaId)) {
    layers.push({ source: SOURCE.FORCE, id: overrides.forcePersonaId });
  }
  const record = sessionId !== null && sessions ? sessions[sessionId] : null;
  const stored = typeof record === 'string' ? record : record && record.personaId;
  const sessionPersonaId = overrides && !absent(overrides.sessionPersonaId)
    ? overrides.sessionPersonaId
    : (overrides && !absent(overrides.personaId) ? overrides.personaId : stored);
  if (!absent(sessionPersonaId)) {
    layers.push({ source: SOURCE.SESSION, id: sessionPersonaId });
  }
  if (!absent(globalDefaultId)) {
    layers.push({ source: SOURCE.GLOBAL, id: globalDefaultId });
  }
  if (!absent(systemDefaultId)) {
    layers.push({ source: SOURCE.SYSTEM, id: systemDefaultId });
  }
  if (layers.length === 0) {
    return {
      personaId: null,
      persona: null,
      source: SOURCE.NONE,
      cleared: false,
      reason: 'no_selection',
    };
  }
  const chosen = layers[0];
  if (chosen.id === NONE_PERSONA) {
    return {
      personaId: null,
      persona: null,
      source: chosen.source,
      cleared: true,
      reason: 'explicit_none',
    };
  }
  const persona = personas ? personas[chosen.id] : null;
  if (!persona) {
    return {
      personaId: chosen.id,
      persona: null,
      source: chosen.source,
      cleared: false,
      reason: 'not_found',
    };
  }
  return {
    personaId: chosen.id,
    persona,
    source: chosen.source,
    cleared: false,
    reason: 'resolved',
  };
}

export function composeSystemPrompt(basePrompt, persona, { header = PERSONA_HEADER } = {}) {
  if (typeof basePrompt !== 'string') {
    throw new TypeError('basePrompt must be a string');
  }
  if (!persona || typeof persona.system_prompt !== 'string' || persona.system_prompt.trim() === '') {
    return { text: basePrompt, temp: false, personaId: null, injected: false };
  }
  const section = header + '\n\n' + persona.system_prompt.trim();
  const lead = basePrompt.endsWith('\n') ? basePrompt + '\n' : basePrompt + '\n\n';
  const text = lead + section + '\n';
  return {
    text,
    temp: true,
    personaId: persona.id ?? null,
    injected: true,
  };
}

export function applyPersona(basePrompt, resolved) {
  if (!resolved || !resolved.persona) {
    return composeSystemPrompt(basePrompt, null);
  }
  return {
    ...composeSystemPrompt(basePrompt, resolved.persona),
    source: resolved.source,
  };
}
