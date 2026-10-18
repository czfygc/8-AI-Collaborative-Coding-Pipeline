// orchestrator/lib/verdict-parse.mjs — T-56 W8（首批拆分，根治 M-14、灭 M-05/M-06 双源）
// 从 orchestrate.mjs 提取的两个唯一事实源：
//   - readRawResponse(mdPath)：raw md 的 "## Response" 之后段落（async；调用点必须全部 await）
//     M-14 根因：async 化后只改了一处调用点（orchestrate 2859 有 await / 3631 无），
//     analyze 拿 Promise 当 text → 全 NONE 占位（verdictLines=0 isNone=true）。
//   - extractVerdictLines(text)：reviewer 结构化判定表（| 或 \t 分隔，PASS/FAIL/CONDITIONAL）
// 回归基准（冻结，2026-09-29）：node orchestrate.mjs --analyze 66c0f00e →
//   verdictLines gemini=6 / deepseek=9；conflicts=0 blind_spots=0 consensus=4 complementary=0 backlog=11。
// 契约见 orchestrator/test/verdict-parse.test.mjs。
import { promises as fsPromises } from 'node:fs';

export async function readRawResponse(mdPath) {
  const content = await fsPromises.readFile(mdPath, 'utf8');
  const m = content.match(/## Response\s*\n([\s\S]*)$/);
  return m ? m[1].trim() : content;
}

export function extractVerdictLines(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  // P4: 首列前分隔符可选 —— 真实输出 "模块边界是否清晰\tPASS\t理由" 首列前无 | 也无 \t。
  // 列间分隔符必须是结构化的 | 或 \t（不接受纯空格），避免散文 "if test PASS then" 误匹配。
  const re = /^\s*(?:\||\t)?\s*(.+?)\s*(?:\||\t)\s*(PASS|FAIL|CONDITIONAL)\s*(?:\||\t)\s*(.+?)\s*(?:\||\t)?\s*$/i;
  const out = [];
  for (const line of lines) {
    if (/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line)) continue;
    const m = line.match(re);
    if (m) {
      const name = m[1].trim();
      if (/^(名称|条目|name|item)\s*$/i.test(name)) continue;
      out.push({ name, verdict: m[2].toUpperCase(), reason: m[3].trim() });
    }
  }
  return out;
}