#!/usr/bin/env node
// safe-write.mjs — M9 字节通道写盘工具
// 用法: node orchestrator/safe-write.mjs --target <path> --b64 <base64-file> [--expect-sha256 <hex>] [--check]
// 流程: base64 文件 -> Buffer 解码 -> 字节直写 -> 回读 SHA256 比对 -> 可选 node --check
// 全程不经过 shell 字符串层，专治 M9 反斜杠/引号/模板串转义事故。
// 退出码: 0=成功, 1=失败, 2=用法错误

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { extname, resolve } from 'node:path';
import { gate, classifyTarget, isHighRisk } from './lib/write-gate.mjs';

const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : null;
}

const target = flagValue('--target');
const b64File = flagValue('--b64');
const expectSha = flagValue('--expect-sha256');
const doCheck = argv.includes('--check');
const confirmId = flagValue('--confirm');

if (!target || !b64File) {
  console.error('用法: node safe-write.mjs --target <path> --b64 <base64-file> [--expect-sha256 <hex>] [--check]');
  process.exit(2);
}
if (!existsSync(b64File)) {
  console.error('[SAFE-WRITE] base64 文件不存在: ' + b64File);
  process.exit(1);
}

const b64 = readFileSync(b64File, 'utf8').replace(/\s+/g, '');
const buf = Buffer.from(b64, 'base64');
if (buf.length === 0) {
  console.error('[SAFE-WRITE] base64 解码为空，拒绝写入');
  process.exit(1);
}
const sha = createHash('sha256').update(buf).digest('hex');

// T-153：目标属高风险类（宪法/台账/发布树/密钥）时，写入必须走「提案→确认→落盘」闸。
// 普通文件维持原行为（直接字节写 + 回读校验）。
const cls = classifyTarget(target, { repoRoot: process.cwd() });
if (isHighRisk(cls.category)) {
  if (cls.category === 'secrets') {
    console.error('[SAFE-WRITE] 密钥类目标不走本通道（' + cls.rule + '）：请用 write 工具写 titan_secrets.env（gitignored）');
    process.exit(1);
  }
  if (!confirmId) {
    console.error('[SAFE-WRITE] 高风险目标需先提案并确认（' + cls.rule + '）：');
    console.error('[SAFE-WRITE]   1) node orchestrator/run-gate.mjs propose --target ' + target + ' --content-file <明文文件>');
    console.error('[SAFE-WRITE]   2) node orchestrator/run-gate.mjs confirm --proposal <id> --by <确认人>');
    console.error('[SAFE-WRITE]   3) node orchestrator/run-gate.mjs apply --proposal <id>');
    console.error('[SAFE-WRITE]   （或直接带 --confirm <id> 一步落盘）');
    process.exit(1);
  }
  const proposal = gate.load(confirmId);
  if (!proposal) { console.error('[SAFE-WRITE] 提案不存在: ' + confirmId); process.exit(1); }
  if (proposal.status !== 'confirmed') { console.error('[SAFE-WRITE] 提案未确认: ' + proposal.status); process.exit(1); }
  if (proposal.kind !== 'write') { console.error('[SAFE-WRITE] 提案不是写入类型: ' + proposal.kind); process.exit(1); }
  const targetAbs = resolve(target);
  const hit = proposal.targets.find(t => resolve(t.path) === targetAbs);
  if (!hit) { console.error('[SAFE-WRITE] 提案未覆盖该目标: ' + target); process.exit(1); }
  if (hit.post_sha256 && hit.post_sha256 !== sha) {
    console.error('[SAFE-WRITE] 待写字节与提案内容不一致（期望 ' + hit.post_sha256 + '，实际 ' + sha + '），拒绝落盘');
    process.exit(1);
  }
  try {
    gate.applyProposal(confirmId);
  } catch (e) {
    console.error('[SAFE-WRITE] 闸门拒绝落盘: ' + e.message);
    process.exit(1);
  }
  console.log('[SAFE-WRITE] [GATE] proposal=' + confirmId + ' category=' + cls.category);
} else {
  writeFileSync(target, buf);
}

const readBack = readFileSync(target);
const shaBack = createHash('sha256').update(readBack).digest('hex');

console.log('[SAFE-WRITE] target: ' + target);
console.log('[SAFE-WRITE] bytes: ' + buf.length);
console.log('[SAFE-WRITE] sha256: ' + shaBack);
console.log('[SAFE-WRITE] readback MATCH: ' + (sha === shaBack));

if (expectSha && expectSha.toLowerCase() !== shaBack) {
  console.error('[SAFE-WRITE] EXPECT MISMATCH (expected ' + expectSha.toLowerCase() + ')');
  process.exit(1);
}
if (sha !== shaBack) {
  console.error('[SAFE-WRITE] READBACK MISMATCH');
  process.exit(1);
}

if (doCheck && ['.mjs', '.js', '.cjs'].includes(extname(target).toLowerCase())) {
  // 回读一致不等于语义正确（例如重复声明），故可选跑语法检查
  const r = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error('[SAFE-WRITE] node --check FAIL:\n' + (r.stderr || '').trim());
    process.exit(1);
  }
  console.log('[SAFE-WRITE] node --check: PASS');
}

console.log('[SAFE-WRITE] OK');
process.exit(0);
