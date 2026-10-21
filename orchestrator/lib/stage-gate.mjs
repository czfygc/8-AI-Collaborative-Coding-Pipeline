// orchestrator/lib/stage-gate.mjs — T-175 产物闸门 ④/4：代码 / 产物 / 发布 三段独立 PASS
//
// 核心语义（EP07 复盘 §2.4 的结论：我们缺的就是这一层）：
//   **代码通过 ≠ 产物通过 ≠ 发布完成**。三段各判各的，谁也替不了谁。
//
// 判定规则：
//   1. 每段独立给结论：PASS / FAIL / UNKNOWN（null = 未判）；
//   2. 后段 PASS 而前段没 PASS = **矛盾**（直接 FAIL，不许用后段盖前段）；
//   3. 总体：任一段 FAIL → FAIL；否则任一段 UNKNOWN/未判 → UNKNOWN；三段都 PASS → PASS；
//   4. UNKNOWN 不当通过（本仓铁律第 7 条：不存在的数据就是 UNKNOWN）。
//
// 今天（2026-10-21）本仓的真实状态：代码段 PASS、产物段 UNKNOWN（还没有"可分发产物"这个概念落地）、
// 发布段 UNKNOWN（无公开分发物）→ 总体 UNKNOWN，如实呈现，不粉饰。

export const GATE_STAGES = Object.freeze(['code', 'artifact', 'release']);
export const GATE_STATUSES = Object.freeze(['PASS', 'FAIL', 'UNKNOWN']);

export const STAGE_LABELS = Object.freeze({
  code: '代码段（代码 → 审查 → 修复 → 验证 → 收口）',
  artifact: '产物段（清单一致 + 许可证署名 + 产物自检）',
  release: '发布段（匿名可下载 + 校验和 + 公开可见）',
});

function norm(status) {
  if (status === null || status === undefined || status === '') return null;
  const s = String(status).trim().toUpperCase();
  if (s === 'PASS' || s === 'FAIL' || s === 'UNKNOWN') return s;
  return null;
}

// 三段判定
export function evaluateStages({ code = null, artifact = null, release = null, notes = {} } = {}) {
  const stages = {
    code: norm(code),
    artifact: norm(artifact),
    release: norm(release),
  };
  const issues = [];
  const warnings = [];

  // 阶段顺序语义：
  //   前段明确 FAIL + 后段 PASS = 矛盾（不许用后段盖前段）→ FAIL；
  //   前段未判/UNKNOWN + 后段 PASS = 不是矛盾，但整体不能算 PASS（缺前段背书）→ 走 UNKNOWN。
  if (stages.artifact === 'PASS' && stages.code === 'FAIL') {
    issues.push({ stage: 'artifact', type: 'stage_order', detail: '产物段 PASS 但代码段 FAIL（代码没过不能说产物对了）' });
  } else if (stages.artifact === 'PASS' && stages.code !== 'PASS') {
    warnings.push({ stage: 'artifact', type: 'stage_unbacked', detail: '产物段 PASS 但代码段未判/UNKNOWN（整体只能算 UNKNOWN）' });
  }
  if (stages.release === 'PASS' && stages.artifact === 'FAIL') {
    issues.push({ stage: 'release', type: 'stage_order', detail: '发布段 PASS 但产物段 FAIL（产物没过不能说发布完了）' });
  } else if (stages.release === 'PASS' && stages.artifact !== 'PASS') {
    warnings.push({ stage: 'release', type: 'stage_unbacked', detail: '发布段 PASS 但产物段未判/UNKNOWN（整体只能算 UNKNOWN）' });
  }

  const fail = GATE_STAGES.filter((s) => stages[s] === 'FAIL');
  const unknown = GATE_STAGES.filter((s) => stages[s] === null || stages[s] === 'UNKNOWN');

  let status;
  if (issues.length || fail.length) status = 'FAIL';
  else if (unknown.length) status = 'UNKNOWN';
  else status = 'PASS';

  return {
    status,
    stages,
    issues,
    warnings,
    notes,
    labels: STAGE_LABELS,
    summary: GATE_STAGES.map((s) => s + '=' + (stages[s] || 'UNKNOWN')).join(' / '),
  };
}

// 把各闸门的原始结论合成一次总判
// inputs: { code: {status,...}, manifest: {...}, license: {...}, anonDownload: {...} }
export function runStageGate({
  code = null, manifest = null, license = null, anonDownload = null, codeTests = null,
} = {}) {
  const notes = {};
  const issues = [];

  // 代码段：优先取"测试结论"，其次取调用方给的结论
  let codeStatus = null;
  if (codeTests && typeof codeTests === 'object' && codeTests.status) {
    codeStatus = norm(codeTests.status);
    notes.code = codeTests.detail || '';
  } else if (code && typeof code === 'object' && code.status) {
    codeStatus = norm(code.status);
    notes.code = code.detail || '';
  } else {
    codeStatus = norm(code);
  }

  // 产物段 = 清单一致 + 许可证署名 + （可选）产物自检
  const manifestStatus = manifest ? norm(manifest.status) : null;
  const licenseStatus = license ? norm(license.status) : null;
  const artifactParts = [manifestStatus, licenseStatus].filter((x) => x !== null);
  let artifactStatus = null;
  if (!artifactParts.length) artifactStatus = null;
  else if (artifactParts.some((x) => x === 'FAIL')) artifactStatus = 'FAIL';
  else if (artifactParts.some((x) => x === 'UNKNOWN')) artifactStatus = 'UNKNOWN';
  else artifactStatus = 'PASS';
  notes.artifact = 'manifest=' + (manifestStatus || '未判') + ' license=' + (licenseStatus || '未判');
  if (manifest && manifest.issues && manifest.issues.length) {
    for (const i of manifest.issues.slice(0, 10)) issues.push({ stage: 'artifact', type: 'manifest', detail: (i.path ? i.path + '：' : '') + i.detail });
  }
  if (license && license.issues && license.issues.length) {
    for (const i of license.issues.slice(0, 10)) issues.push({ stage: 'artifact', type: 'license', detail: i.detail });
  }

  // 发布段 = 匿名可下载验收
  const anonStatus = anonDownload ? norm(anonDownload.status) : null;
  notes.release = 'anon_download=' + (anonStatus || '未判');
  if (anonDownload && anonDownload.checks) {
    for (const c of anonDownload.checks.filter((x) => x.status !== 'PASS')) {
      issues.push({ stage: 'release', type: 'anon_download', detail: c.name + '：' + c.detail });
    }
  }

  const res = evaluateStages({ code: codeStatus, artifact: artifactStatus, release: anonStatus, notes });
  res.issues = res.issues.concat(issues);
  if (issues.length && res.status === 'PASS') res.status = 'FAIL';
  return res;}

export function renderStageGate(result) {
  const lines = [];
  lines.push('[STAGE-GATE] status=' + result.status + '  ' + result.summary);
  for (const s of GATE_STAGES) {
    const st = result.stages[s] || 'UNKNOWN';
    lines.push('  ' + st.padEnd(8) + s.padEnd(9) + (STAGE_LABELS[s] || '') + (result.notes && result.notes[s] ? '  ← ' + result.notes[s] : ''));
  }
  for (const i of result.issues || []) lines.push('  ISSUE [' + i.stage + '/' + i.type + '] ' + i.detail);
  if (result.status === 'UNKNOWN') {
    lines.push('  UNKNOWN = 显式未知（不是"通过"）：' + GATE_STAGES.filter((s) => !result.stages[s] || result.stages[s] === 'UNKNOWN').join(', ') + ' 段还没判');
  }
  return lines.join('\n');
}

export default { GATE_STAGES, GATE_STATUSES, STAGE_LABELS, evaluateStages, runStageGate, renderStageGate };
