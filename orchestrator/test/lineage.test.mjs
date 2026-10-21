// T-165: 产物血缘回归 —— stage/project 校验 / 仓名派生 / 读取端容错与筛选
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateStage, validateProject, deriveProjectFromRepo, readLineage, listLineage, STAGE_ENUM } from '../lib/lineage.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = fileURLToPath(new URL('../lineage.mjs', import.meta.url));

function tmpReviews() {
  const root = mkdtempSync(join(tmpdir(), 't165-lineage-'));
  const reviews = join(root, 'reviews');
  mkdirSync(reviews, { recursive: true });
  return { root, reviews };
}

function writeMeta(reviews, dispatchId, meta) {
  const dir = join(reviews, dispatchId, 'layer-a');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'dispatch-meta.json'), JSON.stringify(meta, null, 2), 'utf8');
}

test('stage 枚举校验：合法值过、非法拒、空值当 null', () => {
  for (const s of STAGE_ENUM) {
    const r = validateStage(s);
    assert.equal(r.ok, true, s);
    assert.equal(r.value, s);
  }
  const bad = validateStage('bogus');
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /--stage 非法/);
  assert.equal(validateStage(null).value, null);
  assert.equal(validateStage('').value, null);
  assert.equal(validateStage('SCAN').value, 'scan');
});

test('project 字符集校验：字母数字点下划线连字符过；其它拒', () => {
  assert.equal(validateProject('V8').ok, true);
  assert.equal(validateProject('my-repo_1.0').ok, true);
  assert.equal(validateProject('bad project').ok, false);
  assert.equal(validateProject('bad/../x').ok, false);
  assert.equal(validateProject('x'.repeat(65)).ok, false);
  assert.equal(validateProject(null).value, null);
});

test('project 由仓名派生（--repo D:\\V8 → V8）', () => {
  assert.equal(deriveProjectFromRepo('D:\\V8'), 'V8');
  assert.equal(deriveProjectFromRepo('D:\\V8\\'), 'V8');
  assert.equal(deriveProjectFromRepo('D:\\my repo\\X'), 'X');
  assert.equal(deriveProjectFromRepo(null), null);
});

test('读取端：老产物无血缘字段 → 跳过不报错；新产物可读可筛', () => {
  const { root, reviews } = tmpReviews();
  try {
    writeMeta(reviews, 'd-001', { dispatchId: 'd-001', stage: 'scan', project: 'V8', parentDispatchId: null, timestamp: '2026-10-21T10:00:00Z' });
    writeMeta(reviews, 'd-002', { dispatchId: 'd-002', stage: 'fix', project: 'V8', timestamp: '2026-10-21T11:00:00Z' });
    writeMeta(reviews, 'd-legacy', { dispatchId: 'd-legacy', reviewers: [] }); // 老产物：没有 stage/project
    writeMeta(reviews, 'd-003', { dispatchId: 'd-003', stage: 'plan', project: 'OTHER', timestamp: '2026-10-21T12:00:00Z' });

    const one = readLineage('d-001', { reviewsRoot: reviews });
    assert.equal(one.stage, 'scan');
    assert.equal(one.project, 'V8');
    assert.equal(readLineage('d-legacy', { reviewsRoot: reviews }).stage, null);
    assert.equal(readLineage('nope', { reviewsRoot: reviews }), null);

    const all = listLineage({ reviewsRoot: reviews });
    assert.equal(all.length, 4, '老产物也列出（字段为 null），但不会被 stage/project 过滤命中');
    assert.equal(all.find(x => x.dispatchId === 'd-legacy').stage, null);
    const byStage = listLineage({ stage: 'scan', reviewsRoot: reviews });
    assert.equal(byStage.length, 1);
    assert.equal(byStage[0].dispatchId, 'd-001');
    const byProject = listLineage({ project: 'V8', reviewsRoot: reviews });
    assert.equal(byProject.length, 2);
    const both = listLineage({ stage: 'fix', project: 'V8', reviewsRoot: reviews });
    assert.equal(both.length, 1);
    assert.equal(both[0].dispatchId, 'd-002');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI：--dispatch 查单条；--stage/--project 过滤；非法 stage 退 1', () => {
  const { root, reviews } = tmpReviews();
  try {
    writeMeta(reviews, 'd-001', { dispatchId: 'd-001', stage: 'scan', project: 'V8', timestamp: '2026-10-21T10:00:00Z' });
    const env = { ...process.env };
    // CLI 的 reviews 根固定为仓内 reviews/，这里用 --dispatch 验证读取路径与容错
    const miss = spawnSync(process.execPath, [CLI, '--dispatch', 'no-such-dispatch'], { encoding: 'utf8', timeout: 60000 });
    assert.equal(miss.status, 1);
    assert.match(miss.stdout + miss.stderr, /无该 dispatch/);
    const bad = spawnSync(process.execPath, [CLI, '--stage', 'bogus'], { encoding: 'utf8', timeout: 60000 });
    assert.equal(bad.status, 1);
    const ok = spawnSync(process.execPath, [CLI, '--stage', 'scan', '--json'], { encoding: 'utf8', timeout: 60000 });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.doesNotThrow(() => JSON.parse(ok.stdout));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
