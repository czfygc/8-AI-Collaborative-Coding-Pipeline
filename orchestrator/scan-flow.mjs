// scan-flow.mjs - Step 4 扫描流程：多席并行扫描 -> 去重/排序 -> delta.md
// 席位（T-40 起全量）：opencode / cline / kilo（本地 CLI）+ harness（dsh headless 真跑）
//                      + 网页 4 席 gemini/deepseek/grok/chatgpt（CDP，由 orchestrate 经 webSeatRunner 注入）
// 超时可配：TITAN_SCAN_TIMEOUT_MS（默认 300000ms）；路径可配：TITAN_OPENCODE_BIN / TITAN_CLINE_BIN / TITAN_KILO_BIN
// --auto-fix 执行链（scan delta -> architect-decision(ACCEPT) -> titan-execute）实现在 orchestrate.mjs 的 scan 块。

import { readFileSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { basename, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { triageFindings } from './lib/scan-triage.mjs';

// P-19 复位：执行器修复轮（R2 DELTA-014）在 ESM 里用了 __dirname → import 即炸。
// scan-flow 是纯库模块、由 CLI 入口调用且入口已做四级 TITAN_ROOT 解析——此处保留
// 简单 env 回退即可（TITAN_ROOT 漂移属设计注记，不值得为它破运行时）。
const TITAN_ROOT = process.env.D_TITAN_ROOT || 'D:\\TITAN_ARCHAEOLOGY';
const CLI_TIMEOUT_MS = Number(process.env.TITAN_SCAN_TIMEOUT_MS) > 0 ? Number(process.env.TITAN_SCAN_TIMEOUT_MS) : 300000;
const PROMPT_CAP = 24000;

function priorityRank(sev) { return { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 }[sev] || 0; }

// T-49 R2：多文件完整逻辑链扫描 prompt（本地 agentic 席自读全部文件，关注跨文件契约）。
// 多文件模式一律走文件路径列表（合并体积必然超帽）；单文件超帽仍走单路径模式。
function buildMultiFileScanPrompt(absPaths) {
  const list = absPaths.map((p) => '- ' + p).join('\n');
  return `请对以下 ${absPaths.length} 个文件组成的完整逻辑链做安全/正确性/性能/最佳实践/风格扫描。
重点关注跨文件问题：调用关系与接口契约不一致、共享状态/常量漂移、重复实现、一边改了另一边没改的镜像不同步。
文件清单：
${list}
第一步必须用你的文件读取工具完整读取上述所有文件（可分段读完全文），读取完成后再输出扫描结果。
只读取这些文件，禁止修改任何文件，只输出一个 JSON 数组（无其他文字、无 markdown 围栏）：
[{"file":"<上述文件之一的文件名>","line":1,"type":"BUG|SECURITY|PERFORMANCE|BEST_PRACTICE|STYLE","severity":"CRITICAL|HIGH|MEDIUM|LOW","title":"简短标题","description":"详细描述","suggestion":"修复建议"}]`;
}

function buildScanPrompt(content, absPath) {
  // 大文件通道（T-48）：超过 PROMPT_CAP 时不截断——argv 模式有 Win32 32767 字符硬上限，
  // 直接升帽会 spawn EINVAL；截断则本地席只看到文件头部（164K 字符的 A-orchestrate.mjs
  // 按 24K 帽只覆盖前 572 行/15%）。故改走文件路径模式：本地 4 席全是 agentic CLI
  // （opencode/cline/kilo/harness 均带文件读取工具），由其自读全文后再扫描。
  if (content.length > PROMPT_CAP && absPath) {
    return `请对文件 ${absPath} 做安全/正确性/性能/最佳实践/风格扫描。
该文件过大（${content.length} 字符），已走文件路径模式：第一步必须用你的文件读取工具完整读取该文件（可分段读完全文），读取完成后再输出扫描结果。
只读取这一个文件，禁止修改任何文件，只输出一个 JSON 数组（无其他文字、无 markdown 围栏）：
[{"file":"${basename(absPath)}","line":1,"type":"BUG|SECURITY|PERFORMANCE|BEST_PRACTICE|STYLE","severity":"CRITICAL|HIGH|MEDIUM|LOW","title":"简短标题","description":"详细描述","suggestion":"修复建议"}]`;
  }
  const body = content.length > PROMPT_CAP ? content.slice(0, PROMPT_CAP) + '\n...[文件过大，已截断]' : content;
  return `请对以下代码做安全/正确性/性能/最佳实践扫描。禁止读取或修改任何文件，只输出一个 JSON 数组（无其他文字）：
[{"file":"相对路径","line":1,"type":"BUG|SECURITY|PERFORMANCE|BEST_PRACTICE|STYLE","severity":"CRITICAL|HIGH|MEDIUM|LOW","title":"简短标题","description":"详细描述","suggestion":"修复建议"}]
代码：
\`\`\`
${body}
\`\`\``;
}

function extractReplyText(stdout) {
  // 兼容三家事件流：opencode=type:"text" 的 part.text；
  // cline=run_result.text（完整）或 agent_event/content_start 片段；其余（kilo/harness）走裸文本回退。
  const opencodeParts = [];
  const clineFrags = [];
  let clineResult = null;
  for (const line of String(stdout).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const ev = JSON.parse(t);
      const p = ev && ev.part;
      if (ev.type === 'text' && p && typeof p.text === 'string') {
        opencodeParts.push(p.text);
      } else if (ev.type === 'run_result' && typeof ev.text === 'string') {
        clineResult = ev.text;
      } else if (ev.type === 'agent_event' && ev.event && ev.event.type === 'content_start'
          && ev.event.contentType === 'text' && typeof ev.event.text === 'string') {
        clineFrags.push(ev.event.text);
      }
    } catch {}
  }
  return clineResult || opencodeParts.join('') || clineFrags.join('');
}

export function parseFindingsJson(text) {
  if (!text) return [];
  const s = String(text);
  // T-48：模型常把正则转义原样写进 JSON 字符串（如 "Bearer\s+\S+"——\s 不是合法 JSON
  // 转义序列），严格 JSON.parse 拒收导致 findings=0（chatgpt 大文件扫描实测复现）。
  // 修复通道：解析失败时把"非合法转义的单反斜杠"升级为 \\ 再解析一次；合法 JSON 不受影响。
  const tryParse = (src) => {
    try { return JSON.parse(src); } catch {}
    try { return JSON.parse(src.replace(/\\(?![\\"/bfnrtu])/g, '\\\\')); } catch {}
    return null;
  };
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start >= 0 && end > start) {
    const arr = tryParse(s.slice(start, end + 1));
    if (Array.isArray(arr)) return arr.filter(f => f && typeof f === 'object' && f.file && f.severity);
  }
  // 快路径失败（chatgpt 快照流式抓取会在首个数组后拼接重复片段）：
  // 从首个 '[' 起做带字符串感知的平衡括号扫描，取第一个能解析出 findings 的数组。
  for (let i = start; i >= 0 && i < s.length; i = s.indexOf('[', i + 1)) {
    let depth = 0, inStr = false, esc = false, endIdx = -1;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '[') depth++;
      else if (ch === ']') { depth--; if (depth === 0) { endIdx = j; break; } }
    }
    if (endIdx > i) {
      const arr = tryParse(s.slice(i, endIdx + 1));
      if (Array.isArray(arr)) {
        const ok = arr.filter(f => f && typeof f === 'object' && f.file && f.severity);
        if (ok.length) return ok;
      }
    }
  }
  // Fallback: parse Chinese plain-text format (ISSUE-ID, 标题, 位置, 严重程度, 建议)
  function parseChineseFindings(text) {
    const lines = text.split('\n');
    const findings = [];
    let current = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^ISSUE-ID[:：]/i.test(trimmed)) {
        if (current) findings.push(current);
        // extract issueId
        const parts = trimmed.split(/[:：]/);
        const issueId = parts.slice(1).join(':').trim(); // in case there are extra colons in value
        current = { issueId, title: '', location: '', severity: '', suggestion: '' };
        continue;
      }
      if (current) {
        if (/^标题[:：]/i.test(trimmed)) {
          current.title = trimmed.replace(/^[^:：]+[:：]/, '').trim();
        } else if (/^位置[:：]/i.test(trimmed)) {
          current.location = trimmed.replace(/^[^:：]+[:：]/, '').trim();
        } else if (/^严重程度[:：]/i.test(trimmed)) {
          current.severity = trimmed.replace(/^[^:：]+[:：]/, '').trim();
        } else if (/^建议[:：]/i.test(trimmed)) {
          current.suggestion = trimmed.replace(/^[^:：]+[:：]/, '').trim();
        }
        // ignore other lines
      }
    }
    if (current) findings.push(current);
    // map to expected format
    return findings.map(f => {
      // file: use location if not empty, else 'unknown'
      const file = f.location || 'unknown';
      // line: default 1
      const line = 1;
      // type: default BUG
      const type = 'BUG';
      // severity: keep as is, ensure uppercase
      const severity = f.severity.toUpperCase();
      // title: from 标题
      const title = f.title;
      // description: we can set to title (or combine)
      const description = f.title; // or maybe f.suggestion? We'll use title.
      // suggestion: from 建议
      const suggestion = f.suggestion;
      return { file, line, type, severity, title, description, suggestion };
    });
  }
  const chinese = parseChineseFindings(s);
  if (chinese.length) return chinese;
  return [];
}

function seatFindings(stdout) {
  const reply = extractReplyText(stdout);
  const fromReply = parseFindingsJson(reply);
  return fromReply.length ? fromReply : parseFindingsJson(stdout);
}

function deduplicateFindings(findings) {
  const map = new Map();
  for (const f of findings) {
    const key = `${f.file}:${f.line}:${f.type}:${createHash('md5').update(String(f.description || '').slice(0, 200)).digest('hex').slice(0, 8)}`;
    if (!map.has(key) || priorityRank(f.severity) > priorityRank(map.get(key).severity)) map.set(key, f);
  }
  return Array.from(map.values());
}

function generateDeltaMd(fileName, findings) {
  let md = `# Scan Delta — ${new Date().toISOString()}\n\n`;
  md += `**扫描目标**: ${fileName}\n\n`;
  findings.forEach((f, i) => {
    md += `### DELTA-${String(i + 1).padStart(3, '0')}\n`;
    md += `Type: ${f.type}\n`;
    md += `Severity: ${f.severity}\n`;
    md += `**文件**: \`${f.file}\` (line ${f.line})\n`;
    md += `**发现**: ${f.description}\n`;
    md += `**动作**: ${f.suggestion || ''}\n\n`;
  });
  return md;
}

function resolveCommand(name) {
  const table = {
    opencode: [process.env.TITAN_OPENCODE_BIN, 'D:\\TITAN_ARCHAEOLOGY\\test-projects\\landmine-001\\node_modules\\opencode-windows-x64\\bin\\opencode.exe', 'opencode'],
    cline: [process.env.TITAN_CLINE_BIN, 'D:\\TITAN_ARCHAEOLOGY\\cline-local\\node_modules\\@cline\\cli-windows-x64\\bin\\cline.exe', 'cline'],
    kilo: [process.env.TITAN_KILO_BIN, 'C:\\Users\\Administrator\\.vscode\\extensions\\kilocode.kilo-code-7.8.3\\bin\\kilo.exe', 'kilo'],
  };
  for (const c of (table[name] || [name])) {
    if (!c) continue;
    if (!/[\\/]/.test(c)) return c;
    if (existsSync(c)) return c;
  }
  return name;
}

function runCliSeat(source, cmd, args, env) {
  return new Promise((resolve) => {
    let child;
    try {
      // stdin 必须 'ignore'（NULL）：opencode/cline 检测到 stdin 是打开的管道会阻塞读入，
      // prompt 已在 argv——stdin 留 pipe 会导致两席全程零输出直至超时（T-40 实测复现）。
      child = spawn(cmd, args, { cwd: TITAN_ROOT, env: env || process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ source, findings: [], error: 'spawn: ' + String((e && e.message) || e) });
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ source, findings: seatFindings(stdout), error: err || null });
    };
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) {
        try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      } else {
        try { child.kill('SIGKILL'); } catch {}
      }
      finish('timeout ' + CLI_TIMEOUT_MS + 'ms');
    }, CLI_TIMEOUT_MS);
    child.stdout.on('data', (d) => { if (stdout.length < 8 * 1024 * 1024) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 256 * 1024) stderr += d; });
    child.on('error', (e) => finish('spawn: ' + String((e && e.message) || e)));
    child.on('close', (code) => finish(code === 0 ? null : ('exit ' + code + (stderr ? ' :: ' + stderr.slice(0, 200) : ''))));
  });
}

// harness 席：dsh headless（stdin 传 prompt，--json 事件流取最后一个 final 的 text 解析）
function parseHarnessFinal(stdout) {
  let lastText = null;
  for (const line of String(stdout).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const ev = JSON.parse(t);
      if (ev && ev.type === 'final' && typeof ev.text === 'string') lastText = ev.text;
    } catch {}
  }
  return lastText == null ? null : parseFindingsJson(lastText);
}

function runHarnessSeat(prompt) {
  // T-49 R2-B2 实测：用户手动启动 Harness（Nemotron 550B）期间，扫描侧并发 spawn 第二个
  // dsh headless 出现整进程静默猝死（无栈零输出）。TITAN_SKIP_HARNESS=1 可临时跳过该席。
  if (process.env.TITAN_SKIP_HARNESS === '1') {
    return Promise.resolve({ source: 'harness', findings: [], error: 'skipped (TITAN_SKIP_HARNESS=1，避免与用户手动 Harness 会话冲突)' });
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', 'npx @deepseek-ai/dsh@0.1.6-alpha.2 --profile headless --json'],
        { cwd: TITAN_ROOT, env: process.env, windowsHide: true });
    } catch (e) {
      return resolve({ source: 'harness', findings: [], error: 'spawn: ' + String((e && e.message) || e) });
    }
    let stdout = '';
    let done = false;
    const finish = (err, findings) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ source: 'harness', findings: findings || [], error: err || null });
    };
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) {
        try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      } else {
        try { child.kill('SIGKILL'); } catch {}
      }
      finish('timeout ' + CLI_TIMEOUT_MS + 'ms');
    }, CLI_TIMEOUT_MS);
    child.stdout.on('data', (d) => { if (stdout.length < 8 * 1024 * 1024) stdout += d; });
    child.stderr.on('data', () => {});
    child.on('error', (e) => finish('spawn: ' + String((e && e.message) || e)));
    child.on('close', (code) => {
      if (code !== 0) return finish('exit ' + code);
      const findings = parseHarnessFinal(stdout);
      if (findings === null) return finish('no-final-event in dsh stream');
      finish(null, findings);
    });
    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (e) {
      finish('stdin: ' + String((e && e.message) || e));
    }
  });
}

// 网页 4 席扫描 prompt：完整文件走附件上传，prompt 只留简短描述 + JSON 输出契约（T-40）。
// 注意：不写"无问题输出 []"之类话术（用户实测该句诱导 grok/chatgpt 直接回空数组）。
export function buildWebScanPrompt(fileName) {
  return [
    '【TITAN 扫描请求】完整源文件已作为附件发送（' + fileName + '，未截断）。',
    '请扫描它的 安全/正确性/性能/最佳实践/风格 问题。',
    '只输出一个 JSON 数组，不要任何其他文字、不要 markdown 代码块围栏：',
    '[{"file":"' + fileName + '","line":1,"type":"BUG","severity":"HIGH","title":"简短标题","description":"详细描述","suggestion":"修复建议"}]',
    'type ∈ BUG|SECURITY|PERFORMANCE|BEST_PRACTICE|STYLE；severity ∈ CRITICAL|HIGH|MEDIUM|LOW。',
  ].join('\n');
}

async function dispatch8WayParallel(content, absPath, webSeatRunner, webSeatArgs = [], opts = {}) {
  // T-49 R2：分席模型锁定（两批不同模型=8 个视角）。env TITAN_SEAT_MODELS JSON 形如
  // {"opencode":"deepseek-v4-flash","cline":"glm-5.3","kilo":"codestral"}，
  // opencode 档自动加 freellmapi/ 前缀、kilo 档加 yysd/ 前缀。
  // T-55：缺省回落由 auto 改为家族去重 pin（DeepSeek/Zhipu/Mistral，harness 席走 dsh
  // agent-default-model=Nemotron），满足"交叉验证不能用同一家的模型"；auto 路由不确定。
  // kilo 原 pin minimax-m2.7 弃用：FreeLLMAPI 上游间歇 empty_completion/429，kilo 内置
  // 回退路由（xkiro/llm7）全死 → M4 headless exit=1；codestral（yysd 目录 id，上游
  // served=codestral-latest）全程 200。
  // T-57：opencode 席 deepseek-v4-pro → deepseek-v4-flash——pro 上游两把 custom key 实测
  // 429(quota)/402(Insufficient Balance，key 被 bench 24h)，flash 全程 200；保 DeepSeek
  // 家族槽不破 M4（补 pro key 归 T-54 key 池线）。
  const seatModels = (typeof process.env.TITAN_SEAT_MODELS === 'string' && process.env.TITAN_SEAT_MODELS.trim())
    ? JSON.parse(process.env.TITAN_SEAT_MODELS) : {};
  const ocModel = seatModels.opencode ? 'freellmapi/' + seatModels.opencode : 'freellmapi/deepseek-v4-flash';
  const clModel = seatModels.cline || 'glm-5.3';
  const klModel = seatModels.kilo ? 'yysd/' + seatModels.kilo : 'yysd/codestral';
  const prompt = Array.isArray(absPath)
    ? buildMultiFileScanPrompt(absPath)
    : buildScanPrompt(content, absPath);
  // 大文件=文件路径模式时 cline 必须 auto-approve=true：headless 下 --auto-approve false
  // 会把文件 Read 全部拦下，cline 读不到正文只能空手回（T-48 Stage-2 实测 cline=0）。
  // 扫描 prompt 已显式"只读这一个文件，禁止修改任何文件"，读取放开是安全的。
  const filePathMode = Array.isArray(absPath) || (content.length > PROMPT_CAP && !!absPath);
  const clineEnv = {
    ...process.env,
    OPENAI_API_KEY: process.env.FREELLMAPI_API_KEY || '',
    OPENAI_BASE_URL: 'http://127.0.0.1:3001/v1',
  };
  const webSeats = ['gemini', 'deepseek', 'qwen', 'chatgpt'];
  let webPromise;
  if (opts.localOnly) {
    // R2 local-only：多文件逻辑链只有本地 agentic 席能做（网页席单附件无法交叉引用）
    webPromise = Promise.resolve([]);
  } else if (typeof webSeatRunner === 'function') {
    webPromise = Promise.resolve()
      .then(() => webSeatRunner(...webSeatArgs))
      .then((list) => (Array.isArray(list) ? list : []).map((item) => ({
        source: item && item.source ? item.source : 'web-unknown',
        findings: item && item.error ? [] : parseFindingsJson((item && item.replyText) || ''),
        error: (item && item.error) || null,
      })))
      .catch((e) => webSeats.map((s) => ({ source: s, findings: [], error: 'webSeatRunner: ' + String((e && e.message) || e) })));
  } else {
    webPromise = Promise.resolve(webSeats.map((s) => ({ source: s, findings: [], error: 'no webSeatRunner (CDP 未接入)' })));
  }
  const [opencode, cline, kilo, harness, web] = await Promise.all([
    runCliSeat('opencode', resolveCommand('opencode'), ['run', '--pure', '--format', 'json', '-m', ocModel, prompt]),
    runCliSeat('cline', resolveCommand('cline'), ['--json', '--auto-approve', filePathMode ? 'true' : 'false', '-P', 'openai', '-m', clModel, '-c', TITAN_ROOT, prompt], clineEnv),
    runCliSeat('kilo', resolveCommand('kilo'), ['run', ...(filePathMode ? ['--auto'] : []), '--model', klModel, prompt]),
    runHarnessSeat(prompt),
    webPromise,
  ]);
  return [opencode, cline, kilo, harness, ...web];
}

export async function runScanMode(filePath, { maxIssues = 50, autoFix = false, webSeatRunner = null, localOnly = false, allow = null } = {}) {
  // T-49 R2：filePath 支持逗号分隔多文件（完整逻辑链扫描）。多文件一律文件路径模式。
  const isMulti = Array.isArray(filePath) || String(filePath).includes(',');
  const files = isMulti
    ? (Array.isArray(filePath) ? filePath : String(filePath).split(',')).map((p) => p.trim()).filter(Boolean)
    : [filePath];
  const contents = files.map((p) => readFileSync(p, 'utf8'));
  const totalChars = contents.reduce((a, c) => a + c.length, 0);
  const relPaths = files.map((p) => p.startsWith(TITAN_ROOT) ? p.slice(TITAN_ROOT.length).replace(/^[\\/]+/, '').replace(/\\/g, '/') : basename(p));
  const head = isMulti ? relPaths.join(' + ') : relPaths[0];
  console.log('[SCAN] 8-way parallel scan: ' + head + ' (' + totalChars + ' chars' + (isMulti ? ', ' + files.length + ' files' : '') + ') autoFix=' + autoFix + (localOnly ? ' localOnly=true' : ''));
  const scanArg = isMulti ? files : files[0];
  const content0 = isMulti ? contents.join('\n') : contents[0];
  // 本地席：小文件内联全文；超帽（T-48）改文件路径模式让席位自读全文；多文件（R2）永远路径模式。
  // 网页 4 席走附件通道：完整文件 + 简短描述 prompt（永远全文，无截断；localOnly 时跳过）。
  const seats = await dispatch8WayParallel(content0, scanArg, webSeatRunner, [files[0], buildWebScanPrompt(basename(files[0]))], { localOnly });
  for (const s of seats) {
    console.log('[SCAN] seat ' + s.source + ': findings=' + (s.findings || []).length + (s.error ? ' | error=' + s.error : ''));
  }
  const all = seats.flatMap((s) => (s.findings || []).map((f) => ({ ...f, source: s.source })));
  // T-56 W4：分诊过滤——占位符/纯重构/建新文件三类默认拦（--allow-* 显式放行），
  // 在去重排序之后、截断之前生效（被拦项不占用 maxIssues 配额）。
  const deduped = deduplicateFindings(all).sort((a, b) => priorityRank(b.severity) - priorityRank(a.severity));
  const { kept, dropped } = triageFindings(deduped, allow);
  if (dropped.length > 0) {
    const byRule = {};
    for (const d of dropped) for (const r of d.rules) byRule[r] = (byRule[r] || 0) + 1;
    console.log('[SCAN] triage dropped ' + dropped.length + ' findings (' + Object.entries(byRule).map(([k, v]) => k + '=' + v).join(', ') + ')');
  }
  let findings = kept.slice(0, maxIssues);
  // file 归一：prompt 只给代码，模型常回报 basename——titan-execute 的
  // diff 范围/提交都靠 delta.file 指到真实路径。多文件模式下归一到清单内精确匹配或
  // 唯一 basename 匹配；单文件维持旧行为；解析不了的原样保留（auto-fix 会安全地范围校验失败）。
  const normSet = new Map(); // basename -> relPath（唯一时）
  for (const rp of relPaths) {
    const b = basename(rp);
    normSet.set(b, normSet.has(b) ? null : rp); // 重名 basename 置空=歧义不归一
  }
  findings = findings.map((f) => {
    const raw = String(f.file || '').replace(/\\/g, '/');
    if (!raw) return f;
    if (relPaths.includes(raw)) return f; // 已是清单内相对路径
    if (existsSync(join(TITAN_ROOT, raw))) return { ...f, file: raw };
    if (!isMulti) {
      const inTargetDir = join(dirname(files[0]), raw);
      if (existsSync(inTargetDir) && String(files[0]).startsWith(TITAN_ROOT)) {
        return { ...f, file: inTargetDir.slice(TITAN_ROOT.length).replace(/^[\\/]+/, '').replace(/\\/g, '/') };
      }
      if (basename(raw) === basename(files[0])) return { ...f, file: relPaths[0] };
      return f;
    }
    // 多文件：basename 唯一命中清单才归一
    const byBase = normSet.get(raw.split('/').pop());
    return byBase ? { ...f, file: byBase } : f;
  });
  if (autoFix) console.log('[SCAN] auto-fix 执行链由 orchestrate.mjs 扫描块在 delta 落盘后触发');
  return { findings, deltaMd: generateDeltaMd(head, findings), executeResult: null };
}
