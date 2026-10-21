// T-171: task-card 纪律回归 —— 证据分级 / 阶段语义 / 一次修正后停止 / OUT_OF_SCOPE / YAML 任务卡往返
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  normalizeEvidenceLevel, normalizeStage, normalizeStageResults, normalizeTaskCard, normalizeFixRounds,
  evaluateEntry, renderTaskCardYaml, parseTaskCardYaml, summarizeEntry,
  EVIDENCE_LEVELS, STAGES, STAGE_RESULTS, TASK_CARD_FIELDS, MAX_FIX_ROUNDS,
} from '../lib/task-card.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = fileURLToPath(new URL('../task-card.mjs', import.meta.url));

test('证据分级枚举合法；非法值显式抛错（不当默认通过）', () => {
  assert.deepEqual([...EVIDENCE_LEVELS], ['firsthand', 'local_report', 'unverified']);
  assert.equal(normalizeEvidenceLevel('firsthand'), 'firsthand');
  assert.equal(normalizeEvidenceLevel('FirstHand'), 'firsthand');
  assert.equal(normalizeEvidenceLevel(undefined), 'unverified');
  assert.equal(normalizeEvidenceLevel(null), 'unverified');
  assert.throws(() => normalizeEvidenceLevel('cloud'), /非法 evidence_level/);
});

test('阶段枚举与阶段结果枚举固定；未知阶段/未知结果显式抛错', () => {
  assert.deepEqual([...STAGES], ['code', 'artifact', 'release']);
  assert.deepEqual([...STAGE_RESULTS], ['PASS', 'FAIL', 'UNKNOWN']);
  assert.equal(normalizeStage('artifact'), 'artifact');
  assert.throws(() => normalizeStage('publish'), /非法 stage/);
  const r = normalizeStageResults({ code: 'pass', artifact: null, release: 'unknown' });
  assert.deepEqual(r, { code: 'PASS', artifact: null, release: 'UNKNOWN' });
  assert.throws(() => normalizeStageResults({ design: 'PASS' }), /未知阶段/);
  assert.throws(() => normalizeStageResults({ code: 'DONE' }), /非法 stage_results/);
});

test('任务卡字段白名单：未知字段抛错；四字段缺省为空数组', () => {
  assert.deepEqual([...TASK_CARD_FIELDS], ['scope', 'acceptance', 'out_of_scope', 'evidence_required']);
  const c = normalizeTaskCard({ scope: ['a'], out_of_scope: ['b'] });
  assert.deepEqual(c.acceptance, []);
  assert.deepEqual(c.evidence_required, []);
  assert.throws(() => normalizeTaskCard({ forbidden: ['x'] }), /未知字段/);
  assert.throws(() => normalizeTaskCard({ scope: 'not-a-list' }), /必须是数组/);
});

test('fix_rounds 必须是非负整数', () => {
  assert.equal(normalizeFixRounds(undefined), 0);
  assert.equal(normalizeFixRounds('2'), 2);
  assert.throws(() => normalizeFixRounds(-1), /非法 fix_rounds/);
  assert.throws(() => normalizeFixRounds(1.5), /非法 fix_rounds/);
});

test('阶段语义：代码不过却产物 PASS → 报 issue（代码通过 ≠ 产物通过）', () => {
  const ev = evaluateEntry({ status: 'done', stage_results: { code: 'FAIL', artifact: 'PASS' } });
  assert.equal(ev.ok, false);
  assert.ok(ev.issues.some((i) => /阶段语义矛盾/.test(i)));
});

test('阶段语义：发布 PASS 但产物段不是 PASS → 报 issue', () => {
  const ev = evaluateEntry({ status: 'done', stage_results: { code: 'PASS', artifact: null, release: 'PASS' } });
  assert.equal(ev.ok, false);
  assert.ok(ev.issues.some((i) => /发布段 PASS/.test(i)));
});

test('done 状态要求代码段 PASS，且不得有 FAIL 段', () => {
  const bad = evaluateEntry({ status: 'done', stage_results: { code: null } });
  assert.ok(bad.issues.some((i) => /done 但代码段不是 PASS/.test(i)));
  const good = evaluateEntry({ status: 'done', stage_results: { code: 'PASS' } });
  assert.equal(good.ok, true);
  assert.ok(good.warnings.some((w) => /task_card/.test(w)));
  const noAcceptance = evaluateEntry({
    status: 'done', stage_results: { code: 'PASS' }, task_card: { scope: ['a'] },
  });
  assert.ok(noAcceptance.warnings.some((w) => /acceptance/.test(w)));
});

test('证据分级：交叉验证 PASS 但 evidence_level 非 firsthand → 报 issue（亲验与自报不可混）', () => {
  const ev = evaluateEntry({
    status: 'verifying',
    evidence_level: 'local_report',
    cross_validation: { status: 'PASS', verifier: 'kilo' },
  });
  assert.equal(ev.ok, false);
  assert.ok(ev.issues.some((i) => /firsthand/.test(i)));
});

test('证据分级：未验证也算合法（只是不能冒充亲验）', () => {
  const ev = evaluateEntry({ status: 'todo', evidence_level: 'unverified' });
  assert.equal(ev.ok, true);
  assert.equal(ev.evidence_level, 'unverified');
});

test('一次修正后停止：fix_rounds>1 且未移交他人 → 报 issue；已移交（verifier≠owner）→ 通过', () => {
  const stuck = evaluateEntry({ status: 'in_progress', owner: 'opencode', fix_rounds: 2 });
  assert.equal(stuck.ok, false);
  assert.ok(stuck.issues.some((i) => /移交他人/.test(i)));
  const escalated = evaluateEntry({
    status: 'in_progress', owner: 'opencode', fix_rounds: 2,
    cross_validation: { status: 'pending', verifier: 'Kilo headless' },
  });
  assert.equal(escalated.ok, true);
  assert.equal(MAX_FIX_ROUNDS, 1);
});

test('交叉验证 FAIL 直接报 issue（证据位置为空也要报）', () => {
  const ev = evaluateEntry({ status: 'verifying', cross_validation: { status: 'FAIL' } });
  assert.ok(ev.issues.some((i) => /交叉验证 FAIL/.test(i)));
});

test('YAML 任务卡往返：渲染 → 解析 → 字段一致（含中文/引号/冒号）', () => {
  const entry = {
    id: 'T-999',
    title: '样例任务',
    owner: 'cline',
    status: 'in_progress',
    evidence_level: 'firsthand',
    stage: 'artifact',
    fix_rounds: 1,
    stage_results: { code: 'PASS', artifact: 'UNKNOWN', release: null },
    task_card: {
      scope: ['范围 A', '范围 B'],
      acceptance: ['验收 1：node --test 通过'],
      out_of_scope: ['禁止：改 ISSUE_REGISTRY.json'],
      evidence_required: ['证据：原始输出贴 archive/'],
    },
  };
  const yaml = renderTaskCardYaml(entry);
  assert.ok(yaml.includes('scope:'));
  assert.ok(yaml.includes('evidence_level: "firsthand"'));
  const back = parseTaskCardYaml(yaml);
  assert.equal(back.id, 'T-999');
  assert.equal(back.evidence_level, 'firsthand');
  assert.equal(back.stage, 'artifact');
  assert.equal(back.fix_rounds, '1');
  assert.deepEqual(back.scope, entry.task_card.scope);
  assert.deepEqual(back.acceptance, entry.task_card.acceptance);
  assert.deepEqual(back.out_of_scope, entry.task_card.out_of_scope);
  assert.deepEqual(back.evidence_required, entry.task_card.evidence_required);
});

test('YAML 解析：空列表 [] 与注释行不炸', () => {
  const parsed = parseTaskCardYaml('# comment\nscope: []\nacceptance:\n  - "x"\n');
  assert.deepEqual(parsed.scope, []);
  assert.deepEqual(parsed.acceptance, ['x']);
});

test('CLI：列全部条目可运行；单条目输出 YAML + RESULT', () => {
  const all = spawnSync(process.execPath, [CLI, '--all'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.ok(all.status === 0 || all.status === 1, '退出码应为 0（无 issues）或 1（有 issues）: ' + all.stderr);
  assert.ok(/共 \d+ 条/.test(all.stdout));

  const one = spawnSync(process.execPath, [CLI, 'T-171'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(one.status, 0, one.stderr);
  assert.ok(/RESULT: OK/.test(one.stdout));
  assert.ok(/scope:/.test(one.stdout));

  const missing = spawnSync(process.execPath, [CLI, 'T-000'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(missing.status, 3);
});

test('历史条目缺分级只报 warning，不报 issue（缺省不当失败，待补分级）', () => {
  const legacy = evaluateEntry({ status: 'done', cross_validation: { status: 'PASS', verifier: 'kilo' } });
  assert.equal(legacy.ok, true);
  assert.ok(legacy.warnings.some((w) => /未分级/.test(w)));
  assert.ok(legacy.warnings.some((w) => /stage_results/.test(w)));
});

test('edit-issue 集成：新字段可写入台账并被 CLI 读出（临时台账）', () => {
  const dir = mkdtempSync(join(tmpdir(), 't171-card-'));
  try {
    const reg = join(dir, 'ISSUE_REGISTRY.json');
    writeFileSync(reg, JSON.stringify({ schema_version: '1.0', issues: {} }, null, 2), 'utf8');
    const cardFile = join(dir, 'card.json');
    writeFileSync(cardFile, JSON.stringify({
      scope: ['只写临时台账'],
      acceptance: ['CLI 能读出 evidence_level'],
      out_of_scope: ['不许碰真实台账'],
      evidence_required: ['贴 CLI 原始输出'],
    }), 'utf8');

    const res = spawnSync(process.execPath, [
      fileURLToPath(new URL('../edit-issue.mjs', import.meta.url)),
      '--id', 'T-901', '--title', '临时条目', '--type', 'test', '--status', 'in_progress',
      '--owner', 'opencode', '--registry', reg, '--evidence-level', 'local_report',
      '--stage', 'code', '--stage-results', JSON.stringify({ code: 'PASS' }),
      '--task-card', cardFile, '--fix-rounds', '0', '--by', 'opencode', '--reason', 'T-171 回归',
    ], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);

    const saved = JSON.parse(readFileSync(reg, 'utf8'));
    const e = saved.issues['T-901'];
    assert.equal(e.evidence_level, 'local_report');
    assert.equal(e.stage, 'code');
    assert.deepEqual(e.stage_results, { code: 'PASS', artifact: null, release: null });
    assert.deepEqual(e.task_card.scope, ['只写临时台账']);
    assert.equal(e.fix_rounds, 0);

    const cli = spawnSync(process.execPath, [CLI, 'T-901', '--registry', reg], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.ok(/只写临时台账/.test(cli.stdout));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('edit-issue 集成：非法 evidence_level 被拦（退出码 2，不落盘）', () => {
  const dir = mkdtempSync(join(tmpdir(), 't171-card-bad-'));
  try {
    const reg = join(dir, 'ISSUE_REGISTRY.json');
    writeFileSync(reg, JSON.stringify({ schema_version: '1.0', issues: {} }, null, 2), 'utf8');
    const res = spawnSync(process.execPath, [
      fileURLToPath(new URL('../edit-issue.mjs', import.meta.url)),
      '--id', 'T-902', '--title', '非法条目', '--type', 'test', '--status', 'todo',
      '--owner', 'opencode', '--registry', reg, '--evidence-level', 'cloud',
    ], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(res.status, 2);
    assert.ok(/校验失败/.test(res.stderr + res.stdout));
    const saved = JSON.parse(readFileSync(reg, 'utf8'));
    assert.equal(saved.issues['T-902'], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summarizeEntry 输出可读摘要', () => {
  const s = summarizeEntry({ id: 'T-1', status: 'todo', owner: 'cline' });
  assert.ok(/T-1/.test(s));
  assert.ok(/evidence=unverified/.test(s));
});
