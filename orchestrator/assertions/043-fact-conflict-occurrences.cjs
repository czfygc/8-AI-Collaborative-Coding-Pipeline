// assertions/043-fact-conflict-occurrences.cjs
// 目标状态（P3-10）：FACT_CONFLICT 条目必须带 occurrences，且回链表达式必须引用真实存在的作用域变量。
// 第2轮加固（弱绿教训）：只查“字段存在”会放过 conflict.key 这类未定义引用（运行时必崩）。
// 用法：node orchestrator/assertions/043-fact-conflict-occurrences.cjs   退出 0=目标达成，1=未达成
const { readFileSync } = require('fs');
const { join } = require('path');

const root = join(__dirname, '..');
const src = readFileSync(join(root, 'orchestrate.mjs'), 'utf8').split(/\r?\n/);
const i = src.findIndex(l => l.includes("type: 'FACT_CONFLICT'"));
if (i < 0) { console.log('NO_FACT_CONFLICT_BLOCK'); process.exit(1); }
const lines = src.slice(i, i + 25);
const j = lines.findIndex(l => /occurrences\s*:/.test(l));
if (j < 0) { console.log('MISSING_OCCURRENCES (FACT_CONFLICT 未回链 issue)'); process.exit(1); }

const expr = lines.slice(j, j + 4).join(' ');
// 1) 不能引用该作用域不存在的变量：此处在 for (const key of ...) 循环内，只有 key / group / conflicts / verdictSet 等
if (/\bconflict\s*\./.test(expr)) { console.log('INVALID_REF conflict.* 不在该作用域（会 ReferenceError）'); process.exit(1); }
// 2) issue 对象没有 .key 字段（canonical issue = canonicalIssueId/factualProposition/evidenceScope/occurrences）
if (/issue\s*\.\s*key\b/.test(expr)) { console.log('INVALID_REF issue.key 字段不存在'); process.exit(1); }
// 3) 必须用真实存在的归一化函数建立匹配
if (!/factPropKey\s*\(/.test(expr) && !/normalizeNameKey\s*\(/.test(expr)) {
  console.log('NO_NORMALIZER 未调用 factPropKey/normalizeNameKey 做匹配'); process.exit(1);
}
// 4) 不允许写死空数组字面量
if (/occurrences\s*:\s*\[\s*\]/.test(expr)) { console.log('EMPTY_LITERAL'); process.exit(1); }

console.log('OK occurrences@' + (i + 1 + j) + ' :: ' + expr.trim().replace(/\s+/g, ' ').slice(0, 120));
process.exit(0);
