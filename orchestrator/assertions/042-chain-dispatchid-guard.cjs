// assertions/042-chain-dispatchid-guard.cjs —— P3-09：连运钩子必须检查 dispatchId 非空
const { readFileSync } = require('fs');
const { join } = require('path');
const src = readFileSync(join(__dirname, '..', 'orchestrate.mjs'), 'utf8');
const i = src.indexOf('if (chainAnalyze)');
if (i < 0) { console.log('NO_CHAIN_BLOCK'); process.exit(1); }
const block = src.slice(i, i + 400);
if (/if\s*\(\s*!dispatchId\s*\)/.test(block) || /dispatchId\s*&&/.test(block)) {
  console.log('OK guard found: ' + block.split('\n').find(l => l.includes('dispatchId')).trim().slice(0, 90));
  process.exit(0);
}
console.log('MISSING_GUARD chainAnalyze 分支未检查 dispatchId 非空');
process.exit(1);
