// orchestrator/lib/already-resolved-proof.mjs — T-56 W6（P-12）：ALREADY_RESOLVED 强证明
// 背景：执行器口头宣称"已被前序 DELTA 修复"（ALREADY_RESOLVED）即可免改 PASS 的通道
// 被滥用成"不动文件拿 PASS"的后门（T-49 多轮实证空 diff+口头声明）。P-12 收紧：
// 声明必须附 PROOF 行，格式 `PROOF: <file>:<line>: <该行原文片段>`，服务端对当前文件
// 逐字校验（file 必须一致、行号存在、原文逐字命中且长度 >= 8），无有效 proof 视为需修。
// 契约见 orchestrator/test/already-resolved-proof.test.mjs。
import { readFileSync } from 'node:fs';

export function extractAlreadyResolvedProof(text) {
  const s = String(text || '');
  const arIdx = s.search(/\bALREADY_RESOLVED\b/i);
  if (arIdx < 0) return { declared: false, proof: null };
  const after = s.slice(arIdx);
  const m = after.match(/^\s*PROOF[:：]\s*(.+?)\s*$/im);
  if (!m) return { declared: true, proof: null };
  const loc = m[1].match(/^([A-Za-z0-9_./\\-]+):(\d+)\s*[:：]?\s*(.*)$/);
  if (!loc) return { declared: true, proof: { malformed: true, raw: m[1].trim() } };
  return {
    declared: true,
    proof: {
      file: String(loc[1] || '').replace(/\\/g, '/'),
      line: Number(loc[2]),
      original: String(loc[3] || '').trim(),
    },
  };
}

// proof.file 与目标文件一致性（相对路径后缀匹配，防幻觉路径）
export function proofFileMatches(targetFile, proofFile) {
  const t = String(targetFile || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const p = String(proofFile || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p) return false;
  if (p === t) return true;
  if (!t.includes('/') && !p.includes('/')) return p === t;
  return t.endsWith('/' + p) || p.endsWith('/' + t);
}

// 逐字校验：行号存在 + 该行原文逐字包含 quoted 片段（trim 后比对，片段 >= 8 字符）
export function proofLineMatches(fileAbs, targetFile, proof, lines) {
  if (!proof || proof.malformed || !Number.isInteger(proof.line) || proof.line < 1) return false;
  if (!proof.original || proof.original.length < 8) return false;
  if (!proofFileMatches(targetFile, proof.file)) return false;
  let fileLines = lines || null;
  if (!fileLines) {
    try { fileLines = readFileSync(fileAbs, 'utf8').replace(/\r/g, '').split('\n'); } catch { return false; }
  }
  if (proof.line > fileLines.length) return false;
  const lineContent = String(fileLines[proof.line - 1] || '').trim();
  return lineContent.length > 0 && lineContent.includes(proof.original);
}