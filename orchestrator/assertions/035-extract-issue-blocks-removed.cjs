// assertions/035-extract-issue-blocks-removed.cjs —— P3-02：删除已弃用的 extractIssueBlocks 死代码
const { readFileSync } = require('fs');
const { join } = require('path');
const src = readFileSync(join(__dirname, '..', 'orchestrate.mjs'), 'utf8');
const def = /function\s+extractIssueBlocks\s*\(/.test(src);
const call = /(?<!function\s)extractIssueBlocks\s*\(/.test(src.replace(/function\s+extractIssueBlocks\s*\(/g, ''));
if (def) { console.log('STILL_DEFINED function extractIssueBlocks 仍存在（DEPRECATED 死代码未删）'); process.exit(1); }
if (call) { console.log('STILL_CALLED 残留调用点'); process.exit(1); }
console.log('OK 死代码已移除且无残留调用');
process.exit(0);
