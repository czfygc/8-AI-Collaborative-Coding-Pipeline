// T-162: 生命周期阶段编排回归 —— 产物 schema（沿用 R2 冻结字段）/ 四模式 / 串链 / 失败即停
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  STAGE_ORDER, STAGE_DIRS, STAGE_SCHEMA_VERSION, EVIDENCE_LEVELS,
  createPipeline, writeStageArtifact, listPipelineStages,
} from '../lib/pipeline-stage.mjs';
import { runPipelineMode } from '../lib/pipeline-runner.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ORCH = fileURLToPath(new URL('../orchestrate.mjs', import.meta.url));
const CONTRACTS = await import('../lib/contracts.mjs');

function sandbox() {
  // 约定：reviewsRoot 永远是 <repoRoot>/reviews（runner 按此拼路径找 pipeline）
  const tmp = mkdtempSync(join(tmpdir(), 't162-pipeline-'));
  const reviews = join(tmp, 'reviews');
  mkdirSync(reviews, { recursive: true });
  return { tmp, reviews, repoRoot: tmp };
}

test('阶段目录名与顺序按计划 §8 P12 约定（stage-01-design … stage-04-deliver）', () => {
  assert.deepEqual([...STAGE_ORDER], ['design', 'plan', 'implement', 'deliver']);
  assert.equal(STAGE_DIRS.design, 'stage-01-design');
  assert.equal(STAGE_DIRS.plan, 'stage-02-plan');
  assert.equal(STAGE_DIRS.implement, 'stage-03-implement');
  assert.equal(STAGE_DIRS.deliver, 'stage-04-deliver');
});

test('阶段产物字段名沿用 R2 冻结的 PIPELINE_STAGE_FIELDS（只追加 evidenceLevel/notes）', () => {
  const { tmp, reviews } = sandbox();
  try {
    const p = createPipeline({ reviewsRoot: reviews });
    const { artifact } = writeStageArtifact(p, 'design', { inputs: { a: 1 } });
    for (const f of CONTRACTS.PIPELINE_STAGE_SCHEMAS['design-v1'].fields) {
      assert.ok(f in artifact, '缺冻结字段 ' + f);
    }
    assert.equal(artifact.schemaVersion, STAGE_SCHEMA_VERSION);
    assert.equal(artifact.evidenceLevel, 'real');
    assert.ok(EVIDENCE_LEVELS.includes(artifact.evidenceLevel));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('非法 evidenceLevel 被拒（不静默）', () => {
  const { tmp, reviews } = sandbox();
  try {
    const p = createPipeline({ reviewsRoot: reviews });
    assert.throws(() => writeStageArtifact(p, 'design', { evidenceLevel: 'awesome' }), /evidenceLevel/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('四阶段各自落产物；implement 阶段不改业务文件（只出执行单）', async () => {
  const { tmp, reviews, repoRoot } = sandbox();
  try {
    const p = createPipeline({ reviewsRoot: reviews });
    for (const mode of ['design', 'plan', 'implement', 'deliver']) {
      const code = await runPipelineMode({
        mode,
        args: [],
        getFlagValue: (n) => (n === '--pipeline-id' ? p.id : (n === '--design' ? '需求一句话' : null)),
        repoRoot,
        project: 'demo',
      });
      assert.equal(code, 0, mode + ' 未跑通');
    }
    const stages = listPipelineStages(p);
    assert.equal(stages.length, 4);
    assert.deepEqual(stages.map(s => s.stage), ['design', 'plan', 'implement', 'deliver']);
    const impl = stages.find(s => s.stage === 'implement');
    assert.equal(impl.evidenceLevel, 'pending', 'implement 未实做必须是 pending');
    assert.ok(existsSync(join(p.dir, STAGE_DIRS.implement, 'executor-command.txt')));
    const del = stages.find(s => s.stage === 'deliver');
    assert.ok(existsSync(join(p.dir, STAGE_DIRS.deliver, 'artifact-index.json')));
    assert.ok(del.outputs.index);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('--pipeline 串链：四阶段一次跑完并落 evidence.json', async () => {
  const { tmp, reviews, repoRoot } = sandbox();
  try {
    const code = await runPipelineMode({
      mode: 'pipeline', args: [], getFlagValue: (n) => (n === '--pipeline' ? '端到端需求' : null),
      repoRoot, project: 'demo',
    });
    assert.equal(code, 0);
    const dirs = readdirSync(reviews).filter(d => d.startsWith('pipeline-'));
    assert.equal(dirs.length, 1);
    const ev = JSON.parse(readFileSync(join(reviews, dirs[0], 'evidence.json'), 'utf8'));
    assert.equal(ev.ok, true);
    assert.equal(ev.stages.length, 4);
    assert.equal(ev.failedStage, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('缺需求 → 退 2（用法错误）；无 pipeline 可续跑 → 退 1', async () => {
  const { tmp, repoRoot } = sandbox();
  try {
    const c1 = await runPipelineMode({ mode: 'design', args: [], getFlagValue: () => null, repoRoot });
    assert.equal(c1, 2);
    const c2 = await runPipelineMode({ mode: 'plan', args: [], getFlagValue: () => null, repoRoot });
    assert.equal(c2, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI：--design 跑通（产物落 reviews/pipeline-*/stage-01-design/stage.json）', () => {
  const r = spawnSync(process.execPath, [ORCH, '--design', '冒烟需求'], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /\[PIPELINE\] stage design 完成/);
  assert.match(r.stdout, /pipelineId=pipeline-/);
});
