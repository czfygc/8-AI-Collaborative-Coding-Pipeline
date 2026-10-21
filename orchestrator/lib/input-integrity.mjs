// lib/input-integrity.mjs — T-154 不可信输入完整性闸门
// 确定性检测（零依赖、零模型）：隐藏文本 / 不可见字符 / 指令形状行 / 隐藏链接。
//
// 设计原则：
//   1. 只报警不阻断（findings 由调用方决定处置），不自动执行、不自动丢弃内容；
//   2. 宁可少报不误杀——正常中文/英文/代码文本必须零命中；
//   3. findings 不回显可疑原文全文（避免把注入内容再写进下游上下文），
//      只给类别 + 偏移 + 命中码点（不可见字符例外，需要给人看是哪个字符）。
//
// 用法：
//   import { scanInput, scanInputDetailed } from './input-integrity.mjs';
//   const r = scanInput(text);            // { ok, findings: [...], counts }
//   if (!r.ok) console.warn(JSON.stringify(r.findings));

// ---------- 不可见 / 可疑码点 ----------
// 零宽空格/连字/非断行空格/单词连接符/BOM + 双向文本覆盖（RTL/LTR override）
const INVISIBLE_CODEPOINTS = new Map([
  [0x200b, 'ZWSP 零宽空格'],
  [0x200c, 'ZWNJ 零宽非连接符'],
  [0x200d, 'ZWJ 零宽连接符'],
  [0x2060, 'WORD JOINER 单词连接符'],
  [0xfeff, 'BOM 字节序标记'],
  [0x202a, 'LRE 左嵌入'],
  [0x202b, 'RLE 右嵌入'],
  [0x202c, 'PDF 弹出方向格式'],
  [0x202d, 'LRO 左覆盖'],
  [0x202e, 'RLO 右覆盖'],
  [0x2066, 'LRI 左隔离'],
  [0x2067, 'RLI 右隔离'],
  [0x2068, 'FSI 首强隔离'],
  [0x2069, 'PDI 弹出方向隔离']
]);

// 疑似隐藏文本的 HTML 标签（display:none / visibility:hidden / 零尺寸 / 注释包裹）
const HIDDEN_TAG_RE = /<\s*(div|span|p|section|style|script|b|i|u)\b[^>]*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0|height\s*:\s*0|position\s*:\s*absolute[^>]*left\s*:\s*-\d)/i;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

// 指令形状行：提示注入的常见祈使句式（英文 + 中文）
const INJECTION_PATTERNS = [
  { id: 'ignore-previous', re: /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?|context)/i },
  { id: 'disregard-above', re: /disregard\s+(?:all\s+)?(?:the\s+)?(?:above|previous|prior|earlier|foregoing)/i },
  { id: 'forget-everything', re: /forget\s+(?:everything|all)\b/i },
  { id: 'new-instructions', re: /(?:new|updated|revised)\s+(?:system\s+)?instructions?\s*[:：]/i },
  { id: 'you-are-now', re: /you\s+are\s+now\s+(?:a|an|the)\b/i },
  { id: 'system-role', re: /(?:^|\n)\s*(?:system|assistant|developer)\s*[:：]/i },
  { id: 'role-play', re: /(?:act|pretend|behave)\s+as\s+(?:if\s+)?(?:you\s+are\s+)?(?:a|an|the)?\s*(?:unrestricted|unfiltered|jailbroken|developer)/i },
  { id: 'reveal-prompt', re: /(?:reveal|show|print|repeat|output)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions?)/i },
  { id: 'zh-ignore', re: /(?:忽略|无视|忘记|不要理会)(?:以上|之前|上面|前面)(?:的)?(?:所有)?(?:指令|提示|规则|要求)/ },
  { id: 'zh-new-role', re: /(?:你现在是|从现在起你(?:是|扮演)|进入)(?:一个)?(?:不受限|无限制|开发者模式)/ },
  { id: 'zh-reveal', re: /(?:输出|打印|复述|重复)(?:你的)?(?:系统)?(?:提示词|提示语|初始指令)/ }
];

// 隐藏链接：锚文本与 href 指向不同域（钓鱼/误导常见形态）
const ANCHOR_RE = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const TAG_STRIP_RE = /<[^>]+>/g;

function isPrivateHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost')) return true;
  if (/^127\./.test(h) || h === '::1' || h === '0.0.0.0') return true;
  if (/^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h.startsWith('[') || h.includes(']')) return true;
  return false;
}

function hostOf(url) {
  try {
    const u = new URL(String(url).trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return u.protocol.replace(':', '') + ':';
    return u.hostname.toLowerCase();
  } catch {
    return null; // 相对链接 / 非 URL
  }
}

/**
 * 扫描一段文本，返回 findings。
 * @param {string} text
 * @param {{ includePositions?: boolean }} [opts]
 * @returns {{ ok: boolean, findings: Array<object>, counts: Record<string, number>, chars: number }}
 */
export function scanInputDetailed(text, opts = {}) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  const findings = [];
  const counts = Object.create(null);
  const add = (kind, detail, extra = {}) => {
    counts[kind] = (counts[kind] || 0) + 1;
    findings.push({ kind, detail, ...extra });
  };

  if (!s) {
    return { ok: true, findings, counts, chars: 0 };
  }

  // 1) 不可见 / 方向控制码点
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i);
    const label = INVISIBLE_CODEPOINTS.get(cp);
    if (label) {
      add('invisible-char', label, { offset: i, codepoint: 'U+' + cp.toString(16).toUpperCase().padStart(4, '0') });
    }
  }

  // 2) HTML 注释包裹的文本
  if (HTML_COMMENT_RE.test(s)) {
    HTML_COMMENT_RE.lastIndex = 0;
    const m = s.match(HTML_COMMENT_RE);
    if (m && m.length) {
      add('html-comment', 'HTML 注释内可能藏有对模型的隐藏指令', { count: m.length });
    }
  }
  HTML_COMMENT_RE.lastIndex = 0;

  // 3) 隐藏样式标签
  if (HIDDEN_TAG_RE.test(s)) {
    add('hidden-element', '标签带 display:none / visibility:hidden / 零尺寸样式');
  }

  // 4) 指令形状行
  for (const p of INJECTION_PATTERNS) {
    const m = s.match(p.re);
    if (m) {
      add('injection-shape', '疑似提示注入指令句式: ' + p.id, { pattern: p.id });
    }
  }

  // 5) 隐藏链接：锚文本可见域与 href 域不一致
  ANCHOR_RE.lastIndex = 0;
  let am;
  while ((am = ANCHOR_RE.exec(s)) !== null) {
    const href = am[1];
    const label = String(am[2] || '').replace(TAG_STRIP_RE, '').trim();
    const hrefHost = hostOf(href);
    if (!hrefHost) continue;
    const labelHosts = label.match(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi);
    if (!labelHosts || labelHosts.length === 0) continue;
    const labelHost = labelHosts[0].toLowerCase();
    if (hrefHost !== labelHost && !isPrivateHost(hrefHost) && !isPrivateHost(labelHost)) {
      add('mismatched-link', '锚文本显示域与 href 指向域不一致', { shown: labelHost, target: hrefHost });
    }
  }
  ANCHOR_RE.lastIndex = 0;

  return { ok: findings.length === 0, findings, counts, chars: s.length };
}

/**
 * 精简版：只回 ok 与计数（用于高频路径，避免把 findings 灌进日志/上下文）。
 * @param {string} text
 */
export function scanInput(text) {
  const r = scanInputDetailed(text);
  return { ok: r.ok, counts: r.counts, findings: r.findings };
}

/**
 * 生成人类可读的一行摘要（不回显可疑原文）。
 * @param {{ findings: Array<object> }} result
 */
export function summarizeFindings(result) {
  if (!result || !result.findings || !result.findings.length) return 'input-integrity: clean';
  const parts = Object.entries(result.counts || {}).map(([k, v]) => `${k}x${v}`);
  return 'input-integrity: ' + parts.join(', ');
}

export default { scanInput, scanInputDetailed, summarizeFindings };
