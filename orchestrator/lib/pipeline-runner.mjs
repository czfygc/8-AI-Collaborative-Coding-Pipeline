// orchestrator/lib/pipeline-runner.mjs — T-162 生命周期模式执行器（R1 实装）
//
// 四个阶段 + 串链的口径（**框架真、内容源按可用性降级**）：
//   design    需求 → stage-01-design/{requirement.md, design-brief.md, stage.json}
//   plan      stage-01 → stage-02-plan/{plan.md, work-order.json, stage.json}
//   implement stage-02 → stage-03-implement/{executor-command.txt, stage.json}（**不改业务文件**）
//   deliver   stage-03/02 → stage-04-deliver/{delivery.md, artifact-index.json, stage.json}
//   pipeline  四阶段串链：任一阶段失败即停并落 evidence.json
//
// 诚实口径：每份 stage.json 带 evidenceLevel
//   real             = 由真实链路产出（本框架里暂无；多席位会诊接入后升级）
//   local-placeholder= 本地确定性产出（模板/推导），不是模型设计
//   pending          = 需执行器/人工补做（本阶段只产出执行单）
// 不谎报完成：串链成功只代表"框架跑通"，evidence.json 里逐阶段记 evidenceLevel。
//
// 红线：
//   1. 本模块**不修改任何业务文件**——implement 阶段只写执行单（真正改码走 titan-execute）。
//   2. 阶段之间靠文件契约交接（stage.json 的 outputs/artifacts 指名下一阶段读什么）。
//   3. 失败即停：--pipeline 遇失败阶段不继续，并把失败原因写进 evidence.json。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  STAGE_ORDER, STAGE_DIRS, createPipeline, stageDir, writeStageArtifact, readStageArtifact,
  listPipelineStages, writePipelineEvidence, latestPipeline,
} from './pipeline-stage.mjs';

function nowIso() {
  return new Date().toISOString();
}

function slug(text, max = 40) {
  return String(text || '').replace(/\s+/g, '-').slice(0, max).replace(/[^\w.-]/g, '') || 'req';
}

// ---------- design ----------
function runDesign(pipeline, { requirement, project }) {
  const dir = stageDir(pipeline, 'design');
  const reqFile = join(dir, 'requirement.md');
  writeFileSync(reqFile, '# 需求原文\n\n' + requirement + '\n', 'utf8');
  const brief = [
    '# 设计简报（本地确定性模板，非模型产出）',
    '',
    '## 1. 目标',
    requirement,
    '',
    '## 2. 约束',
    '- 不得触碰高风险文件（AGENTS.md / 台账 / 发布树 / 密钥）——须走 T-153 写闸',
    '- 改 orchestrator/ 代码必跑 node orchestrator/verify-gate.mjs 全绿',
    '- 单文件源码 ≤ 50 KiB（体量纪律）',
    '',
    '## 3. 交付物',
    '- 阶段产物：stage-01-design/stage.json（schema ' + 'v1' + '）',
    '- 下一步：--plan 续跑本 pipeline',
    '',
    '## 4. 证据等级',
    'local-placeholder：尚未跑多席位会诊（design 的真实方案产出属 T-168 待做）',
  ].join('\n');
  const briefFile = join(dir, 'design-brief.md');
  writeFileSync(briefFile, brief, 'utf8');
  const res = writeStageArtifact(pipeline, 'design', {
    parentStageId: null,
    inputs: { requirement, project },
    outputs: { brief: 'design-brief.md', requirement: 'requirement.md' },
    decisions: [],
    artifacts: [reqFile, briefFile],
    evidenceLevel: 'local-placeholder',
    notes: '本地确定性模板产出；多席位方案属 T-168',
  });
  return { ok: true, stage: 'design', artifact: res.artifact, dir };
}

// ---------- plan ----------
function runPlan(pipeline, { project }) {
  const design = readStageArtifact(pipeline, 'design');
  const dir = stageDir(pipeline, 'plan');
  const requirement = (design && design.inputs && design.inputs.requirement) || '';
  const steps = buildSteps(requirement);
  const planFile = join(dir, 'plan.md');
  writeFileSync(planFile, [
    '# 实施计划（由 stage-01 推导，本地确定性）',
    '',
    '| # | 步骤 | 落点 |',
    '|---|---|---|',
    ...steps.map((s, i) => '| ' + (i + 1) + ' | ' + s.what + ' | ' + s.where + ' |'),
    '',
    '> 步骤为模板推导，未经评审；执行前需人工确认（evidenceLevel=local-placeholder）。',
  ].join('\n') + '\n', 'utf8');
  const workOrder = {
    generatedAt: nowIso(),
    project,
    sourceStage: 'design',
    sourceArtifact: design ? 'stage-01-design/stage.json' : null,
    steps,
    executor: 'titan-execute',
    note: '本执行单不直接改文件；改码走 titan-execute <dispatchId>（verify 前置）',
  };
  const woFile = join(dir, 'work-order.json');
  writeFileSync(woFile, JSON.stringify(workOrder, null, 2) + '\n', 'utf8');
  const res = writeStageArtifact(pipeline, 'plan', {
    parentStageId: design ? design.timestamp : null,
    inputs: { project, designArtifact: design ? 'stage-01-design/stage.json' : null, requirement },
    outputs: { plan: 'plan.md', workOrder: 'work-order.json', stepCount: steps.length },
    decisions: [],
    artifacts: [planFile, woFile],
    evidenceLevel: design ? 'local-placeholder' : 'pending',
    notes: design ? '由 stage-01 模板推导' : '缺 stage-01 产物（未跑 design）→ pending',
  });
  return { ok: true, stage: 'plan', artifact: res.artifact, dir };
}

function buildSteps(requirement) {
  const base = [
    { what: '定位改动落点并确认无并发占用（M1 认领）', where: 'ISSUE_REGISTRY.json' },
    { what: '实现改动（一条一 commit）', where: '按落点' },
    { what: '补回归测试（orchestrator/test/ + SUITES.md 登记）', where: 'orchestrator/test/' },
    { what: '过闸：node orchestrator/verify-gate.mjs 全绿', where: 'verify-gate' },
    { what: 'M2 交叉验证（非作者客户端）+ 证据入库', where: 'archive/evidence/' },
    { what: '台账收口（status=done + verifier/evidence）', where: 'ISSUE_REGISTRY.json' },
  ];
  if (requirement) base.unshift({ what: '澄清需求边界与验收标准：' + requirement.slice(0, 60), where: '台账 description' });
  return base;
}

// ---------- implement ----------
function runImplement(pipeline, { project }) {
  const plan = readStageArtifact(pipeline, 'plan');
  const dir = stageDir(pipeline, 'implement');
  const cmdFile = join(dir, 'executor-command.txt');
  const planRef = plan ? 'stage-02-plan/work-order.json' : null;
  writeFileSync(cmdFile, [
    '# 执行单（本阶段不改业务文件）',
    '',
    '# 1) 先做 scan：定位问题文件',
    'node orchestrator/orchestrate.mjs --scan <file> --repo <abs>',
    '',
    '# 2) 再走执行链（verify 前置通过才 commit）',
    'node orchestrator/titan-execute.mjs <dispatchId> --executor opencode',
    '',
    '# 3) 收口',
    'node orchestrator/edit-issue.mjs --id <T-xxx> --status done ...',
    '',
    '来源计划: ' + (planRef || '(缺 stage-02 产物 → 先跑 --plan)'),
    '项目: ' + (project || '-'),
  ].join('\n') + '\n', 'utf8');
  const res = writeStageArtifact(pipeline, 'implement', {
    parentStageId: plan ? plan.timestamp : null,
    inputs: { project, planArtifact: planRef },
    outputs: { executorCommand: 'executor-command.txt' },
    decisions: [],
    artifacts: [cmdFile],
    evidenceLevel: 'pending',
    notes: plan ? '已产出执行单；真正改码需跑 titan-execute（本阶段不改业务文件）' : '缺 stage-02 产物 → pending',
  });
  return { ok: true, stage: 'implement', artifact: res.artifact, dir };
}

// ---------- deliver ----------
function runDeliver(pipeline, { project }) {
  const dir = stageDir(pipeline, 'deliver');
  const stages = listPipelineStages(pipeline);
  const index = stages.map(s => ({
    stage: s.stage,
    evidenceLevel: s.evidenceLevel,
    artifact: 'stage-0' + (STAGE_ORDER.indexOf(s.stage) + 1) + '-' + s.stage + '/stage.json',
    outputs: s.outputs,
  }));
  const idxFile = join(dir, 'artifact-index.json');
  writeFileSync(idxFile, JSON.stringify({ pipelineId: pipeline.id, project, stages: index, generatedAt: nowIso() }, null, 2) + '\n', 'utf8');
  const deliveryFile = join(dir, 'delivery.md');
  writeFileSync(deliveryFile, [
    '# 交付摘要',
    '',
    '- pipeline: ' + pipeline.id,
    '- 项目: ' + (project || '-'),
    '- 阶段数: ' + stages.length + '/' + STAGE_ORDER.length,
    '- 证据等级: ' + (stages.map(s => s.stage + '=' + s.evidenceLevel).join('、') || '(无)'),
    '',
    '> 本摘要是框架产出索引；**不表示改动已被执行器落地**（implement 阶段 evidenceLevel=pending 即未执行）。',
  ].join('\n') + '\n', 'utf8');
  const res = writeStageArtifact(pipeline, 'deliver', {
    parentStageId: stages.length ? stages[stages.length - 1].timestamp : null,
    inputs: { project, stageCount: stages.length },
    outputs: { delivery: 'delivery.md', index: 'artifact-index.json' },
    decisions: [],
    artifacts: [deliveryFile, idxFile],
    evidenceLevel: stages.length === STAGE_ORDER.length ? 'local-placeholder' : 'pending',
    notes: '索引式交付摘要；不表示业务改动已落地',
  });
  return { ok: true, stage: 'deliver', artifact: res.artifact, dir };
}

const STAGE_FN = { design: runDesign, plan: runPlan, implement: runImplement, deliver: runDeliver };

// ---------- 入口 ----------
export async function runPipelineMode({ mode, args, getFlagValue, repoRoot, project = null, stage = null }) {
  const requirement = (getFlagValue('--' + mode) || '').trim();
  const pipelineId = getFlagValue('--pipeline-id');
  let pipeline;
  if (mode === 'design' || mode === 'pipeline') {
    if (!requirement) {
      console.error('ERROR: --' + mode + ' 需要需求描述');
      return 2;
    }
    pipeline = createPipeline({ pipelineId: pipelineId || undefined, reviewsRoot: join(repoRoot, 'reviews') });
  } else {
    const found = pipelineId
      ? { id: pipelineId, dir: join(repoRoot, 'reviews', pipelineId), reviewsRoot: join(repoRoot, 'reviews') }
      : latestPipeline({ reviewsRoot: join(repoRoot, 'reviews') });
    if (!found) {
      console.error('[PIPELINE] 找不到可续跑的 pipeline（先跑 --design <需求>，或用 --pipeline-id 指定）');
      return 1;
    }
    pipeline = found;
    if (!existsSync(pipeline.dir)) {
      console.error('[PIPELINE] pipeline 不存在: ' + pipeline.id);
      return 1;
    }
  }

  const stagesToRun = mode === 'pipeline' ? STAGE_ORDER : [mode];
  const done = [];
  for (const st of stagesToRun) {
    const fn = STAGE_FN[st];
    let r;
    try {
      r = fn(pipeline, { requirement: mode === 'pipeline' ? requirement : requirement, project, stage });
    } catch (e) {
      const reason = 'stage ' + st + ' 执行异常: ' + (e && e.message ? e.message : String(e));
      console.error('[PIPELINE] ' + reason);
      writePipelineEvidence(pipeline, { ok: false, failedStage: st, reason, stages: done });
      return 1;
    }
    done.push({ stage: st, evidenceLevel: r.artifact.evidenceLevel, artifact: r.artifact.timestamp });
    console.log('[PIPELINE] stage ' + st + ' 完成（evidenceLevel=' + r.artifact.evidenceLevel + '）→ ' + r.dir);
  }

  if (mode === 'pipeline') {
    const evidenceFile = writePipelineEvidence(pipeline, { ok: true, failedStage: null, reason: '', stages: done });
    console.log('[PIPELINE] 四阶段串链完成 → ' + pipeline.dir);
    console.log('[PIPELINE] 证据: ' + evidenceFile);
  }
  console.log('[PIPELINE] pipelineId=' + pipeline.id);
  return 0;
}

export default { runPipelineMode };
