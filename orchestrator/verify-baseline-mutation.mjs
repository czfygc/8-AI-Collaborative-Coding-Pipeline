// verify-baseline-mutation.mjs
// 门禁硬度矩阵：对 verify-baseline.mjs 的 6 条断言逐条注入变异，验证"该 FAIL 的真的 FAIL"。
// 红线落地（§12.1-1）：门禁变更必须跑变异 —— 本文件把这条散文变成可执行。
//
// 用法:
//   node verify-baseline-mutation.mjs                       # 跑全部变异例
//   node verify-baseline-mutation.mjs --legacy <old.mjs>    # 对旧版脚本跑"上行"对照（如 >=0 时代）
//   node verify-baseline-mutation.mjs --report <path.md>    # 额外写 markdown 报告
//
// 只读主树：所有变异都在 %TEMP% 的副本目录内进行（复用负向测试的"副本目录"打法），
// 主仓 reviews/ 与 orchestrate 产物零字节变化。退出码: 0=矩阵符合预期, 1=有例不符合预期, 2=环境错误。
//
// 输出语义：
//   CAUGHT     = 变异被门禁抓到（期望 FAIL 且指对断言编号）
//   VISIBLE    = 变异被抓到但断言编号不符（抓错了位置）
//   INVISIBLE  = 变异未被抓住（该漂移当前不可见 —— 硬度矩阵的如实暴露，不是脚本 bug）
//   ENV-ERROR  = 退出码 2（缺文件/缺 dispatch，属环境错误，按红线 11 不计 FAIL）

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TITAN_ROOT = process.env.D_TITAN_ROOT || join(__dirname, '..');
const DISPATCH = '66c0f00e';
const BASE_SRC = join(TITAN_ROOT, 'reviews', DISPATCH);
const SCRIPT = join(__dirname, 'verify-baseline.mjs');

const argv = process.argv.slice(2);
function flag(name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; }
const legacyScript = flag('--legacy');
const reportPath = flag('--report');

// ---------- 变异工具 ----------
const VERDICT_RE = /^\s*(?:\||\t)?\s*(.+?)\s*(?:\||\t)\s*(PASS|FAIL|CONDITIONAL)\s*(?:\||\t)\s*(.+?)\s*(?:\||\t)?\s*$/i;
const SEPARATOR_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/i;

function editJson(root, rel, fn) {
  const p = join(root, 'reviews', DISPATCH, rel);
  const j = JSON.parse(readFileSync(p, 'utf8'));
  fn(j);
  writeFileSync(p, JSON.stringify(j, null, 2));
}

function dropOneVerdictLine(root, reviewer) {
  const p = join(root, 'reviews', DISPATCH, 'layer-a', 'raw', reviewer + '.md');
  const lines = readFileSync(p, 'utf8').replace(/\r/g, '').split('\n');
  let removed = false;
  const out = lines.filter(l => {
    if (!removed && VERDICT_RE.test(l) && !SEPARATOR_RE.test(l)) { removed = true; return false; }
    return true;
  });
  if (!removed) throw new Error('未找到可删除的 verdict 行: ' + reviewer);
  writeFileSync(p, out.join('\n'));
}

// ---------- 变异例定义 ----------
// expectExit: 期望退出码 0/1/2；expectFailId: 期望 FAIL 的断言编号（null = 期望 0 退出）
// direction: down(下行/值变坏) / up(上行/值变好或缺失) / blind(盲区注入) / env(环境)
const CASES = [
  { id: 'M1', assert: '#1', direction: 'down', desc: 'raw/gemini.md 删 1 行 verdict（6→5）',
    mutate: r => dropOneVerdictLine(r, 'gemini'), expectExit: 1, expectFailId: 1 },
  { id: 'M2', assert: '#2', direction: 'down', desc: 'raw/deepseek.md 删 1 行 verdict（9→8）',
    mutate: r => dropOneVerdictLine(r, 'deepseek'), expectExit: 1, expectFailId: 2 },
  { id: 'M3', assert: '#3', direction: 'down', desc: 'status.counts.consensus 4→3',
    mutate: r => editJson(r, 'layer-b/status.json', j => { j.counts.consensus = 3; }), expectExit: 1, expectFailId: 3 },
  { id: 'M4', assert: '#10', direction: 'up', desc: 'status.counts.consensus 4→5（gate-v2 前上行不可见，现被 #10 收紧抓住）',
    mutate: r => editJson(r, 'layer-b/status.json', j => { j.counts.consensus = 5; }), expectExit: 1, expectFailId: 10 },
  { id: 'M5', assert: '#4', direction: 'down', desc: 'conflicts.json 注入 1 条 ASSUMPTION_CONFLICT',
    mutate: r => editJson(r, 'layer-b/conflicts.json', j => { j.push({ type: 'ASSUMPTION_CONFLICT', topic: 'mutation-probe', detail: '注入的假冲突' }); }), expectExit: 1, expectFailId: 4 },
  { id: 'M6', assert: '#9', direction: 'blind', desc: 'conflicts.json 只注入 FACT_CONFLICT（#4 只数 ASSUMPTION 子型，gate-v2 起由 #9 counts 一致性兜住）',
    mutate: r => editJson(r, 'layer-b/conflicts.json', j => { j.push({ type: 'FACT_CONFLICT', topic: 'mutation-probe', detail: '注入的事实冲突' }); }), expectExit: 1, expectFailId: 9 },
  { id: 'M7', assert: '#5', direction: 'down', desc: 'blind-spots.json 注入 1 条盲点（0→1；新 ==0 应抓到）',
    mutate: r => editJson(r, 'layer-b/blind-spots.json', j => { j.push({ id: 'MUT-001', severity: 'HIGH', detail: '注入的盲点' }); }), expectExit: 1, expectFailId: 5 },
  { id: 'M8', assert: '#5', direction: 'up', desc: '同 M7 变异跑 --legacy 旧版对照（现为 gate-v1.1 ==0，同样应抓到；>=0 时代的增益见 v1.1 报告）',
    mutate: r => editJson(r, 'layer-b/blind-spots.json', j => { j.push({ id: 'MUT-001', severity: 'HIGH', detail: '注入的盲点' }); }), expectExit: 1, expectFailId: 5, legacyOnly: true },
  { id: 'M9', assert: '#6', direction: 'down', desc: 'backlog.complementary 注入 1 条（0→1）',
    mutate: r => editJson(r, 'layer-b/backlog.json', j => { j.complementary = (j.complementary || []).concat([{ id: 'MUT-002', detail: '注入的互补项' }]); }), expectExit: 1, expectFailId: 6 },
  { id: 'M10', assert: '#8', direction: 'up', desc: 'backlog 整个 complementary 键被删（gate-v2 前读作 0 不可见，现被 #8 抓住）',
    mutate: r => editJson(r, 'layer-b/backlog.json', j => { delete j.complementary; }), expectExit: 1, expectFailId: 8 },
  { id: 'M15', assert: '#9', direction: 'down', desc: 'status.counts.conflicts 改成 3（实际 0：状态与产物漂移）',
    mutate: r => editJson(r, 'layer-b/status.json', j => { j.counts.conflicts = 3; }), expectExit: 1, expectFailId: 9 },
  { id: 'M13', assert: '#7', direction: 'down', desc: 'blind-spots 播 1 条无 occurrences 的盲点（#7 需 #5 先重定基线才单独生效，当前 firstFail=#5）',
    mutate: r => editJson(r, 'layer-b/blind-spots.json', j => { j.push({ id: 'MUT-003', severity: 'HIGH', proposition: '注入无 occurrences 的盲点' }); }), expectExit: 1, expectFailId: 5 },
  { id: 'M11', assert: 'env', direction: 'env', desc: '整个 dispatch 目录缺失（应 exit 2，按红线 11 不计 FAIL）',
    mutate: r => rmSync(join(r, 'reviews', DISPATCH), { recursive: true, force: true }), expectExit: 2, expectFailId: null },
  { id: 'M12', assert: 'env', direction: 'env', desc: '缺 layer-b/delta.md（应 exit 2 环境错误）',
    mutate: r => rmSync(join(r, 'reviews', DISPATCH, 'layer-b', 'delta.md'), { force: true }), expectExit: 2, expectFailId: null },
];

// ---------- 执行 ----------
function run(scriptPath, caseRoot) {
  try {
    const out = execFileSync(process.execPath, [scriptPath, DISPATCH], {
      env: { ...process.env, D_TITAN_ROOT: caseRoot },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : -1, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

function failIdOf(out) {
  const m = out.match(/\[(\d+)\/\d+\][^\n]*❌/);
  return m ? Number(m[1]) : null;
}

if (!existsSync(BASE_SRC)) {
  console.error('[MISSING] 基线 dispatch 不存在: ' + BASE_SRC);
  process.exit(2);
}

const results = [];
for (const c of CASES) {
  if (c.legacyOnly && !legacyScript) {
    results.push({ c, status: 'SKIPPED', exit: '-', failId: '-' });
    console.log('[' + c.id + '] ' + c.assert + ' ' + c.direction + ' | ' + c.desc);
    console.log('      -> SKIPPED（未提供 --legacy <旧版脚本>）');
    continue;
  }
  const scriptPath = c.legacyOnly ? legacyScript : SCRIPT;
  const caseRoot = mkdtempSync(join(tmpdir(), 'titan-mutation-' + c.id + '-'));
  try {
    mkdirSync(join(caseRoot, 'reviews'), { recursive: true });
    cpSync(BASE_SRC, join(caseRoot, 'reviews', DISPATCH), { recursive: true });
    c.mutate(caseRoot);
    const { code, out } = run(scriptPath, caseRoot);
    const fid = failIdOf(out);
    let status;
    if (code === 2) status = 'ENV-ERROR';
    else if (code === c.expectExit && fid === c.expectFailId) status = (code === 0 ? 'INVISIBLE' : 'CAUGHT');
    else if (code === c.expectExit && fid !== c.expectFailId) status = 'VISIBLE';
    else status = 'UNEXPECTED';
    results.push({ c, status, exit: code, failId: fid === null ? '-' : fid });
    console.log('[' + c.id + '] ' + c.assert + ' ' + c.direction + ' | ' + c.desc);
    console.log('      -> exit=' + code + ' failId=' + (fid === null ? '-' : fid) + '  ' + status +
      (status === 'UNEXPECTED' ? '（期望 exit=' + c.expectExit + ' failId=' + (c.expectFailId === null ? '-' : c.expectFailId) + '）' : ''));
  } finally {
    rmSync(caseRoot, { recursive: true, force: true });
  }
}

// ---------- 汇总 ----------
const unexpected = results.filter(r => r.status === 'UNEXPECTED').length;
const caught = results.filter(r => r.status === 'CAUGHT').length;
const invisible = results.filter(r => r.status === 'INVISIBLE').length;
const envErr = results.filter(r => r.status === 'ENV-ERROR').length;
const skipped = results.filter(r => r.status === 'SKIPPED').length;
console.log('');
console.log('=== 硬度矩阵汇总 ===');
console.log('变异例 ' + results.length + '：CAUGHT=' + caught + ' / INVISIBLE(已知盲区)=' + invisible +
  ' / ENV-ERROR=' + envErr + ' / SKIPPED=' + skipped + ' / UNEXPECTED=' + unexpected);
const rows = results.map(r =>
  '| ' + r.c.id + ' | ' + r.c.assert + ' | ' + r.c.direction + ' | ' + r.c.desc + ' | ' + r.status +
  ' | exit=' + r.exit + ' failId=' + r.failId + ' |');
const md = [
  '# verify-baseline 硬度矩阵报告（A-prime / gate-v1.1）',
  '',
  '- 生成: ' + new Date().toISOString(),
  '- 被测: orchestrator/verify-baseline.mjs（#5 已收紧 >=0 -> ==0）',
  '- 变异基线: dispatch ' + DISPATCH + '，全部变异在 %TEMP% 副本目录内进行，主树零变化',
  legacyScript ? '- 对照旧版: ' + legacyScript : '- 对照旧版: 未提供（M8 SKIPPED）',
  '',
  '| 例 | 断言 | 方向 | 变异 | 结果 | 证据 |',
  '|---|---|---|---|---|---|',
  ...rows,
  '',
  '## 结论',
  '',
  '- CAUGHT=' + caught + '：变异被门禁抓到且指对断言编号（下行硬度有效）。',
  '- INVISIBLE=' + invisible + '：如实暴露的当前不可见漂移（M4 consensus 上行、M6 只数 ASSUMPTION 子型、M10 complementary 键缺失），属已知盲区，待第 6 步调参裁定是否加断言。',
  '- ENV-ERROR=' + envErr + '：缺文件/缺 dispatch 按红线 11 计环境错误，不计 FAIL。',
  '- UNEXPECTED=' + unexpected + '：必须为 0。',
  '',
].join('\n');
console.log('');
if (reportPath) { writeFileSync(reportPath, md); console.log('报告已写入: ' + reportPath); }
process.exit(unexpected > 0 ? 1 : 0);
