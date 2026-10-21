#!/usr/bin/env node
// pre-commit-check.mjs —— 提交前/CI 校验：ISSUE_REGISTRY.json 必须可解析且条目结构完整
// 用法：node orchestrator/pre-commit-check.mjs [registry-path]
// 退出码：0=通过，1=失败
import { readFileSync } from 'node:fs';
const registry = process.argv[2] ?? 'ISSUE_REGISTRY.json';
let raw;
try { raw = readFileSync(registry, 'utf8'); } catch (e) {
  console.error('[PRE-COMMIT] 读取失败: ' + registry + ' -> ' + e.message); process.exit(1);
}
let root;
try { root = JSON.parse(raw); } catch (e) {
  console.error('[PRE-COMMIT] JSON 不可解析: ' + registry + ' -> ' + e.message);
  process.exit(1);
}
if (!root || !root.issues || typeof root.issues !== 'object' || Array.isArray(root.issues)) {
  console.error('[PRE-COMMIT] 缺少 issues 对象'); process.exit(1);
}
const issues = root.issues;
const required = ['id','title','type','status','owner','description','files','evidence','cross_validation'];
const validTypes = new Set(['feat','fix','docs','chore','refactor','test','research']);
const validStatuses = new Set(['todo','claimed','in_progress','verifying','done','blocked']);
let failed = 0;
let warned = 0;
for (const [id, entry] of Object.entries(issues)) {
  if (!entry || typeof entry !== 'object') { console.error('[PRE-COMMIT] 条目不是对象: ' + id); failed++; continue; }
  let missing = [];
  for (const k of required) {
    if (!(k in entry)) missing.push(k);
  }
  if (missing.length) { console.warn('[PRE-COMMIT] warn: 条目 ' + id + ' 缺少字段: ' + missing.join(', ')); warned++; }
  if (entry.type && !validTypes.has(entry.type)) { console.warn('[PRE-COMMIT] warn: 条目 ' + id + ' type 非法: ' + entry.type); warned++; }
  if (entry.status && !validStatuses.has(entry.status)) { console.warn('[PRE-COMMIT] warn: 条目 ' + id + ' status 非法: ' + entry.status); warned++; }
  if (entry.id && entry.id !== id) { console.warn('[PRE-COMMIT] warn: 条目 ' + id + ' id 与键不一致: id=' + entry.id); warned++; }
  if (!Array.isArray(entry.files)) { console.warn('[PRE-COMMIT] warn: 条目 ' + id + ' files 不是数组'); warned++; }
}
if (failed > 0) {
  console.error('[PRE-COMMIT] 校验失败，共 ' + failed + ' 处严重问题，提交被拦截'); process.exit(1);
}
if (warned > 0) {
  console.warn('[PRE-COMMIT] 注意：共 ' + warned + ' 处历史条目结构不完整（不阻断提交，建议逐条用 edit-issue.mjs 补全）');
}
console.log('[PRE-COMMIT] ISSUE_REGISTRY.json 校验通过，条目数: ' + Object.keys(issues).length + ' (警告 ' + warned + ')');
