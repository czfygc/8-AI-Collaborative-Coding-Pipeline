// lib/contracts.mjs — T-61 P8 产出（计划 §4 R2 契约注册表骨架：只登记不实现）
// 定位：现有协议 + 扩展槽的注册点。纯数据、零副作用、不挂运行时校验——拆分期间 R2 红线
//   只准空壳登记，校验实现全部是拆后任务（P11/P12）。本模块不被运行时引用（仅注册）；
//   import 冒烟由 verify-gate LIB_MODULES 覆盖。
// 登记四条（与计划 §4 R2 行一一对应）：
//   1) execute-result：权威 schema = design-specs/execute-result.schema.json（只冻结字段名/枚举，
//      不复制 pattern——防 P-03 孪生实现漂移，校验以权威文件为准）；
//   2) delta.md：两档生成器各异（analyze=lib/analyze-core.mjs runAnalyze；scan=scan-flow.mjs
//      generateDeltaMd），DELTA 段由 titan-execute.mjs parseAcceptDeltas 消费；
//   3) architect-decision：lib/architect.mjs 生成，逐条 Decision 枚举措辞（大小写不敏感）；
//   4) 扩展槽 design-v1 / plan-v1 / deliver-v1：字段名冻结（P8 草案），消费者=拆后 P12 pipeline
//      （reviews/pipeline-<id>/stage-0N-<stage>/）；实现前如需变更走台账程序。
// 变更纪律：已冻结字段名后续只许追加、不许改名；新增契约追加新条目。

export const CONTRACT_REGISTRY_VERSION = 'v1-r2-p8';

// 1) execute-result（既有协议；权威源为 JSON Schema 文件，此处镜像字段名+枚举作冻结面）
export const EXECUTE_RESULT_CONTRACT = Object.freeze({
  id: 'execute-result',
  authoritativeSource: 'design-specs/execute-result.schema.json',
  note: '校验实现以 authoritativeSource 为准；本条目只冻结字段名/枚举，不复制 pattern（防孪生漂移）',
  required: ['dispatchId', 'deltas', 'executor', 'verifyStatus', 'gitDiff', 'exitCode', 'timestamp'],
  deltaItemRequired: ['deltaId', 'file', 'finding', 'action', 'status'],
  enums: {
    executor: ['opencode', 'cline', 'kilo', 'harness'],
    deltaStatus: ['PASS', 'FAIL', 'SKIPPED'],
    verifyStatus: ['PASS', 'FAIL'],
  },
});

// 2) delta.md（Layer B 两档；头格式字段名冻结）
export const DELTA_MD_CONTRACT = Object.freeze({
  id: 'delta-md',
  variants: {
    analyze: {
      generator: 'lib/analyze-core.mjs runAnalyze',
      headerFields: ['dispatchId', 'generated', 'artifactSha256', 'round', 'trigger', 'counts'],
      sectionHeading: '## DELTA 项',
      deltaHeading: 'DELTA-<3位数字> 三级标题',
      entryFields: ['Type', 'Name', 'Reviewers', 'Occurrences', 'Finding', 'Evidence', 'Same-fact verification', 'Requires Architect decision', 'Suggested action'],
      typeEnum: ['FACT_CONFLICT', 'ASSUMPTION_CONFLICT', 'HIGH_SEVERITY_UNCONFIRMED', 'BLIND_SPOT'],
    },
    scan: {
      generator: 'scan-flow.mjs generateDeltaMd',
      headerFields: ['标题行 Scan Delta — ISO 时间戳', '扫描目标（粗体字段行）'],
      deltaHeading: 'DELTA-<3位数字> 三级标题',
      entryFields: ['Type', 'Severity', '文件', '发现', '动作'],
    },
  },
  consumer: 'titan-execute.mjs parseAcceptDeltas（头部宽容解析；DELTA 段+Decision 枚举措辞）',
});

// 3) architect-decision（架构师裁决档；头字段 + 逐条决策枚举措辞）
export const ARCHITECT_DECISION_CONTRACT = Object.freeze({
  id: 'architect-decision',
  file: 'reviews/<dispatchId>/layer-b/architect-decision.md',
  generators: ['lib/architect.mjs runArchitect（CDP 捕获）', 'lib/architect.mjs runArchitectLocal（本地占位）'],
  headerFields: ['source', 'captured'],
  note: '短路/本地占位档头行含额外标注（如 LOCAL TEST MODE）；本文件另存内核测试与 CDP 两形态',
  deltaHeading: 'DELTA-<3位数字> 三级标题',
  decisionField: 'Decision',
  decisionEnum: ['accept', 'reject', 'defer'],
  caseInsensitive: true,
  consumer: 'titan-execute.mjs parseAcceptDeltas（兼容 ACCEPT 大写写法）',
});

// 4) 扩展槽（P8 字段名冻结草案；P12 pipeline 实现，运行时不校验）
const PIPELINE_STAGE_FIELDS = ['schemaVersion', 'pipelineId', 'stage', 'parentStageId', 'inputs', 'outputs', 'decisions', 'artifacts', 'timestamp'];
export const PIPELINE_STAGE_SCHEMAS = Object.freeze({
  'design-v1': Object.freeze({ stage: 'design', fields: PIPELINE_STAGE_FIELDS }),
  'plan-v1': Object.freeze({ stage: 'plan', fields: PIPELINE_STAGE_FIELDS }),
  'deliver-v1': Object.freeze({ stage: 'deliver', fields: PIPELINE_STAGE_FIELDS }),
});

// 5) verify 命令注册槽（T-164 落地，R4）：权威源 = orchestrator/config/verify-profiles.json
//    （纯数据；读侧 orchestrator/lib/verify-profiles.mjs 解析 + 执行）。UNKNOWN 传播语义：
//    profile/capability 缺失 → 显式 UNKNOWN，不静默当通过。消费方 titan-execute.mjs 的
//    language 槽（T-163）与 CLI orchestrator/verify-profile.mjs。
export const VERIFY_PROFILES_CONTRACT = Object.freeze({
  id: 'verify-profiles',
  authoritativeSource: 'orchestrator/config/verify-profiles.json',
  required: ['version', 'languages', 'profiles', 'capabilities', 'unknownPolicy'],
  languageKeys: ['js', 'py'],
  capabilityEnum: ['syntax', 'test'],
  profileEnum: ['node:mjs', 'python:pkg'],
  statusEnum: ['PASS', 'FAIL', 'UNKNOWN'],
  note: 'UNKNOWN ≠ FAIL：显式未知不阻断（由调用方决定），但绝不静默当通过；命令按 argv 逐个执行（不走 shell）',
  consumer: 'titan-execute.mjs verify() 第 4 步 + orchestrator/verify-profile.mjs CLI',
});

// 总注册表（id → 契约；消费方按 id 取用）
export const CONTRACTS = Object.freeze({
  'execute-result': EXECUTE_RESULT_CONTRACT,
  'delta-md': DELTA_MD_CONTRACT,
  'architect-decision': ARCHITECT_DECISION_CONTRACT,
  'design-v1': PIPELINE_STAGE_SCHEMAS['design-v1'],
  'plan-v1': PIPELINE_STAGE_SCHEMAS['plan-v1'],
  'deliver-v1': PIPELINE_STAGE_SCHEMAS['deliver-v1'],
  'verify-profiles': VERIFY_PROFILES_CONTRACT,
});
