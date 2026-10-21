// T-145: 工具输出沙箱（原型）—— 大输出先落盘，只把摘要+证据路径送回模型上下文
// 借鉴 context-mode 的 Sandbox 机制，独立实现、不改全局 hooks、不引入外部依赖。
// 约定：
//   storeArtifact  原始输出字节直写 archive/sandbox/artifacts/（可配置 dir）
//   digestContent  生成有预算上限的结构化摘要（默认 4096 B）
//   searchArtifact 需要细节时按行检索，不必回灌全文
//   recordRun/stats 逐条记账，量测节省比例
// 本模块不读环境变量、不联网。
import { mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DIR = resolve(HERE, '..', '..', 'archive', 'sandbox');
export const DEFAULT_BUDGET = 4096;

const ERROR_RE = /(^|[^a-z])(error|fatal|exception|traceback|panic|failed|failure)([^a-z]|$)/i;
const WARN_RE = /(^|[^a-z])(warn|warning|deprecated)([^a-z]|$)/i;
const URL_RE = /(https?|wss?):\/\/[^\s"'<>]+/gi;
const PATH_RE = /(^|[\s"'(])([A-Za-z]:[\\/][^\s"')]+|\/[\w.-]+\/[\w./-]+)/g;

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function slugify(label) {
  const s = String(label || 'output').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '');
  return (s || 'output').slice(0, 48);
}

export function byteLength(text) {
  return Buffer.byteLength(String(text || ''), 'utf8');
}

function countLines(text) {
  if (text === '') return 0;
  const parts = String(text).split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

// 重复行归一：抹掉数字/长十六进制/多余空白，便于把"同一类日志"折叠计数
export function normalizeLine(line) {
  return String(line)
    .replace(/[a-f0-9]{16,}/gi, '@')
    .replace(/[0-9]+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

export function storeArtifact({ content, label = 'output', source = 'unknown', dir = DEFAULT_DIR }) {
  const text = String(content == null ? '' : content);
  const buf = Buffer.from(text, 'utf8');
  const hash = createHash('sha256').update(buf).digest('hex');
  const artifactsDir = join(dir, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });
  const stem = slugify(label) + '-' + hash.slice(0, 10);
  let file = join(artifactsDir, stem + '.txt');
  let n = 1;
  while (existsSync(file)) {
    file = join(artifactsDir, stem + '-' + n + '.txt');
    n += 1;
  }
  writeFileSync(file, buf);
  const meta = {
    label: String(label || 'output'),
    source: String(source || 'unknown'),
    artifact: file,
    bytes: buf.length,
    lines: countLines(text),
    sha256: hash,
  };
  return meta;
}

function pushSection(parts, section, state, budget) {
  const used = state.bytes;
  const add = byteLength(section);
  if (used + add > budget) return false;
  parts.push(section);
  state.bytes = used + add;
  return true;
}

// 生成有预算上限的摘要；优先保证 header / signals / 首尾片段，重复模式按剩余预算补齐
export function digestContent(content, opts = {}) {
  const text = String(content == null ? '' : content);
  const budget = Math.max(512, Number(opts.maxBytes) || DEFAULT_BUDGET);
  const label = opts.label || 'output';
  const source = opts.source || 'unknown';
  const lines = text === '' ? [] : text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  let errors = 0;
  let warns = 0;
  const errorSamples = [];
  const repeat = new Map();
  const urls = new Set();
  const paths = new Set();
  for (const line of lines) {
    if (ERROR_RE.test(line)) {
      errors += 1;
      if (errorSamples.length < 3) errorSamples.push(line.trim().slice(0, 200));
    }
    if (WARN_RE.test(line)) warns += 1;
    const key = normalizeLine(line);
    if (key) repeat.set(key, (repeat.get(key) || 0) + 1);
    const u = line.match(URL_RE);
    if (u) for (const x of u) if (urls.size < 50) urls.add(x);
    const p = line.match(PATH_RE);
    if (p) for (const m of p) { const v = m.trim(); if (v) paths.add(v); }
  }
  const top = [...repeat.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 8);
  const hash = sha256(text);
  const stats = {
    label,
    source,
    bytes: byteLength(text),
    lines: lines.length,
    sha256: hash,
    errors,
    warns,
    urls: urls.size,
    paths: paths.size,
    topRepeat: top.map(([t, n]) => ({ text: t, count: n })),
    budget,
  };

  const parts = [];
  const state = { bytes: 0 };
  const header = [
    '[SANDBOX DIGEST] label=' + label + ' source=' + source,
    'bytes=' + stats.bytes + ' lines=' + stats.lines + ' sha256=' + hash.slice(0, 12) + ' budget=' + budget,
    'signals: error=' + errors + ' warn=' + warns + ' urls=' + urls.size + ' paths=' + paths.size,
  ].join('\n');
  pushSection(parts, header, state, budget);

  if (lines.length > 0) {
    const head = Math.min(3, lines.length);
    const headLines = lines.slice(0, head).map((l, i) => (i + 1) + '| ' + l.slice(0, 240));
    pushSection(parts, 'head:\n' + headLines.join('\n'), state, budget);
    const tailCount = Math.min(5, lines.length);
    const start = Math.max(head, lines.length - tailCount);
    const tailLines = lines.slice(start).map((l, i) => (start + i + 1) + '| ' + l.slice(0, 240));
    if (tailLines.length > 0) pushSection(parts, 'tail:\n' + tailLines.join('\n'), state, budget);
  }
  if (errorSamples.length > 0) {
    pushSection(parts, 'error-samples:\n' + errorSamples.map((l) => '- ' + l).join('\n'), state, budget);
  }
  if (top.length > 0) {
    const rep = top.map(([t, n]) => n + 'x ' + t).join('\n');
    pushSection(parts, 'top-repeats:\n' + rep, state, budget);
  }
  if (urls.size > 0) {
    pushSection(parts, 'urls:\n' + [...urls].slice(0, 5).join('\n'), state, budget);
  }
  let out = parts.join('\n');
  if (stats.bytes > byteLength(out)) {
    out += '\n[truncated: full output at artifact, use search]';
  }
  return { text: out, bytes: byteLength(out), stats };
}

export function measure(originalBytes, digestBytes) {
  const saved = Math.max(0, originalBytes - digestBytes);
  const savingPct = originalBytes > 0 ? Math.round((saved / originalBytes) * 10000) / 100 : 0;
  return { originalBytes, digestBytes, savedBytes: saved, savingPct };
}

export function recordRun(dir, record) {
  const ledger = join(dir, 'ledger.jsonl');
  mkdirSync(dirname(ledger), { recursive: true });
  appendFileSync(ledger, JSON.stringify(record) + '\n', 'utf8');
  return ledger;
}

// 一站式：落盘 -> 摘要 -> 记账
export function sandboxOutput({ content, label = 'output', source = 'unknown', dir = DEFAULT_DIR, maxBytes, record = true }) {
  const text = String(content == null ? '' : content);
  const meta = storeArtifact({ content: text, label, source, dir });
  const digest = digestContent(text, { label, source, maxBytes });
  const m = measure(meta.bytes, digest.bytes);
  const entry = {
    ts: new Date().toISOString(),
    label: meta.label,
    source: meta.source,
    artifact: meta.artifact,
    sha256: meta.sha256,
    bytes: meta.bytes,
    lines: meta.lines,
    digestBytes: digest.bytes,
    savedBytes: m.savedBytes,
    savingPct: m.savingPct,
  };
  if (record) recordRun(dir, entry);
  return { meta, digest, measured: m, entry };
}

export function searchArtifact(file, needle, opts = {}) {
  const abs = resolve(file);
  if (!existsSync(abs)) throw new Error('artifact not found: ' + abs);
  const raw = readFileSync(abs, 'utf8');
  const lines = raw.split(/\r?\n/);
  const max = Math.max(1, Number(opts.max) || 20);
  const context = Math.max(0, Number(opts.context) || 0);
  const useRegex = Boolean(opts.regex);
  let re = null;
  if (useRegex) re = new RegExp(needle, 'i');
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    const matched = useRegex ? re.test(lines[i]) : lines[i].toLowerCase().includes(String(needle).toLowerCase());
    if (matched) hits.push(i);
  }
  const picked = new Set();
  for (const i of hits.slice(0, max)) {
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j += 1) picked.add(j);
  }
  const rows = [...picked].sort((a, b) => a - b).slice(0, max * (context * 2 + 1));
  const text = rows.map((i) => (i + 1) + '| ' + lines[i]).join('\n');
  return {
    artifact: abs,
    totalLines: lines.length,
    matches: hits.length,
    shown: Math.min(max, hits.length),
    truncated: hits.length > rows.length,
    text,
  };
}

export function readLedger(dir = DEFAULT_DIR) {
  const ledger = join(dir, 'ledger.jsonl');
  if (!existsSync(ledger)) return { ledger, records: [] };
  const records = [];
  for (const line of readFileSync(ledger, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* 半行/损坏行跳过，不阻断统计 */ }
  }
  return { ledger, records };
}

export function summarizeLedger(records) {
  const total = records.reduce((acc, r) => {
    acc.runs += 1;
    acc.bytes += Number(r.bytes) || 0;
    acc.digestBytes += Number(r.digestBytes) || 0;
    acc.savedBytes += Number(r.savedBytes) || 0;
    return acc;
  }, { runs: 0, bytes: 0, digestBytes: 0, savedBytes: 0 });
  total.savingPct = total.bytes > 0 ? Math.round((total.savedBytes / total.bytes) * 10000) / 100 : 0;
  return total;
}

export function statsText(dir = DEFAULT_DIR) {
  const { ledger, records } = readLedger(dir);
  const s = summarizeLedger(records);
  const lines = [
    '[SANDBOX STATS] ledger=' + ledger,
    'runs=' + s.runs + ' original=' + s.bytes + 'B digest=' + s.digestBytes + 'B saved=' + s.savedBytes + 'B (' + s.savingPct + '%)',
  ];
  for (const r of records.slice(-10)) {
    lines.push('- ' + (r.ts || '?') + ' ' + (r.label || '?') + ' ' + (r.bytes || 0) + 'B -> ' + (r.digestBytes || 0) + 'B (' + (r.savingPct || 0) + '%)');
  }
  return lines.join('\n');
}

export function artifactSize(file) {
  const st = statSync(file);
  return { file: basename(file), bytes: st.size };
}
