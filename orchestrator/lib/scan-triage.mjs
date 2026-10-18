// orchestrator/lib/scan-triage.mjs — T-56 W4：scan findings 入口分诊过滤（纯函数）
// 背景：auto-fix 执行器轮实测反复三类劣质 finding——占位符（prompt 示例的"详细描述"被
// 原样当标题回）、纯重构类（超长函数重构建议，执行器炸改）、建新文件类（越界建议）。
// 默认拦下，--allow-* 显式放行。契约见 orchestrator/test/scan-triage.test.mjs。

export const TRIAGE_RULES = [
  {
    id: 'placeholder',
    label: '占位符',
    test(f) {
      const title = String(f.title || '').trim();
      const desc = String(f.description || '').trim();
      if (!title) return false;
      if (/^(详细描述|详尽描述|详情描述|占位符|待补充|待填写|TODO|TBD|FIXME|placeholder)([:：\s].*)?$/i.test(title)) return true;
      if (/^(详细描述|详尽描述|TODO|TBD|placeholder)$/i.test(desc) && !/[A-Za-z0-9_\u4e00-\u9fa5]{6,}/.test(title)) return true;
      return false;
    },
  },
  {
    id: 'refactor',
    label: '纯重构',
    test(f) {
      const s = String(f.title || '') + ' ' + String(f.description || '');
      const type = String(f.type || '').toUpperCase();
      const sev = String(f.severity || '').toUpperCase();
      // BUG/SECURITY/CRITICAL 的重构诉求除外——那是修复手段，不是纯重构建议。
      if (type === 'BUG' || type === 'SECURITY' || sev === 'CRITICAL') return false;
      return /(重构|refactor|extract\s*(to\s*)?(function|method|module)|rename\b|拆(分|开)函数)/i.test(s);
    },
  },
  {
    id: 'new-file',
    label: '建新文件',
    test(f) {
      const s = String(f.title || '') + ' ' + String(f.description || '');
      return /(新建|新增|创建|抽取|迁移到)\s*.{0,6}(文件|模块|脚本|工具类|class)|(new|create|add)\s+(a\s+)?(separate\s+)?(file|module|script|utility)/i.test(s);
    },
  },
];

export function triageFindings(findings, allow = null) {
  const allowSet = new Set(allow && typeof allow === 'object' ? Object.keys(allow).filter((k) => allow[k]) : []);
  const kept = [];
  const dropped = [];
  for (const f of findings || []) {
    const hits = TRIAGE_RULES.filter((r) => r.test(f)).map((r) => r.id);
    const blocked = hits.filter((id) => !allowSet.has(id));
    if (blocked.length === 0) kept.push(f);
    else dropped.push({ finding: f, rules: blocked });
  }
  return { kept, dropped };
}