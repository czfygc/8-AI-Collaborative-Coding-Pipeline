// review-flow.mjs - 审查流程核心逻辑
// 从 orchestrate.mjs 提取
//
// T-82（2026-10-16，T-73 对1 孪生收敛）：本模块原三份同名独立实现
// （loadReviewersYaml/loadEnabledReviewers/parseArchitectYaml，含 REVIEWERS_YAML 本地常量）
// 已废除，降为转出口——加载/解析唯一事实源 = lib/reviewers.mjs（T-61 P2）+ lib/architect.mjs（T-61 P7）。
// 收敛依据：orchestrator/audit-evidence/t73-twin-convergence-eval-20261016.md 对1（M4 PASS）。
// 调用方核证（2026-10-16 全仓 rg）：三导出零外部消费方——orchestrate.mjs 自 T-61 起直接
// import lib 版；loadReviewersYamlFull 为内部死码一并移除；lib 版 loadEnabledReviewers 的
// 缺失/空/零启用 FATAL exit(1) 语义与原实现一致（"缺失即退出"未放宽）。
// 契约注记：loadReviewersYaml 转口后为 lib 版契约（返回完整 doc、缺失/解析失败返回 {}，
// 不再返回 reviewers_role 数组、不再 process.exit）——零调用方，无行为风险。
export { loadReviewersYaml, loadEnabledReviewers } from './lib/reviewers.mjs';
export { parseArchitectYaml } from './lib/architect.mjs';
