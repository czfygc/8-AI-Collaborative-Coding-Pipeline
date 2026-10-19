// orchestrator/lib/semantic-guard.mjs — T-123：执行器语义护栏
//
// 背景（T-122 e2e run#1 实录）：executor 把 `s += i` 改成 `sum += i`——`sum` 未声明。
// 语法级 sanity（node --check）全绿：实测 V8 对 sloppy .js 与 ESM 都不在编译期报
// "assignment to undeclared"（只在执行期抛 ReferenceError，而 sloppy CJS 下连执行期
// 都不抛——静默创建全局、结果算错）。于是 verify（只查"改没改+范围"）+ sanity（只到
// 语法级）双双放行，坏修复被自动提交。对应 2026-10-14 记忆里的 wrong-fix 假 PASS 遗留缺口。
//
// 本模块两条支柱（保守优先：宁可无证据记 SKIP，不可漏；也不可误报阻塞正当修复）：
//   A) 静态——未声明标识符检查：只看 diff 新增行，且要求"该标识符在文件他处从未出现
//      + 文件内无声明 + 非全局白名单"才拦，专抓拼写漂移类（s → sum）。
//   B) 行为——配对回归测试：orchestrator/test/<base>.test.mjs 同名自动发现并运行。
//      基线（修复前）与修复后对照：只有"基线绿、修复后红"才算本次回归；
//      基线本就红 → 记 PREEXISTING-FAIL 不阻塞（避免既有红测试误伤）。
//
// 状态语义（供 execute-result.json 记账，杜绝"没验证却显示 PASS"）：
//   PASS   有语义证据且通过
//   SKIP   无可用语义证据（无配对测试）——不阻塞，但必须显式记账
//   FAIL   语义证据判定为回归 —— 拦截、回滚、不提交
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

// 常见全局标识符白名单：赋值给它们不算"未声明"（浏览器/Node 宿主提供）
const GLOBAL_ALLOWLIST = new Set([
  'process', 'console', 'globalThis', 'global', 'module', 'exports', 'require',
  '__dirname', '__filename', 'Buffer', 'setTimeout', 'setInterval', 'clearTimeout',
  'clearInterval', 'setImmediate', 'queueMicrotask', 'fetch', 'URL', 'URLSearchParams',
  'TextEncoder', 'TextDecoder', 'structuredClone', 'crypto', 'performance', 'atob',
  'btoa', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'Array', 'Object', 'JSON', 'Math',
  'Date', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'BigInt', 'Number',
  'String', 'Boolean', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'Intl', 'Reflect', 'Proxy', 'ArrayBuffer', 'Uint8Array', 'Int32Array', 'Float64Array',
  'DataView', 'WeakRef', 'FinalizationRegistry', 'Iterator', 'AsyncIterator', 'escape',
  'unescape', 'eval', 'arguments', 'undefined', 'NaN', 'Infinity', 'window', 'document',
  'self', 'navigator', 'location', 'history', 'alert', 'prompt', 'confirm',
  'localStorage', 'sessionStorage', 'XMLHttpRequest', 'FormData', 'Blob', 'File',
  'Event', 'CustomEvent', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver',
  'AbortController', 'AbortSignal', 'Headers', 'Request', 'Response', 'WebSocket',
  'Worker', 'DisposableStack', 'AsyncDisposableStack', 'SuppressedError'
]);

const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'class', 'return', 'typeof', 'new', 'delete',
  'void', 'await', 'yield', 'import', 'export', 'from', 'default', 'if', 'else',
  'for', 'while', 'do', 'switch', 'try', 'catch', 'throw', 'in', 'of', 'instanceof',
  'this', 'null', 'true', 'false', 'break', 'continue', 'case', 'extends', 'super'
]);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function occurrenceCount(text, id) {
  if (!text) return 0;
  const re = new RegExp('\\b' + escapeRe(id) + '\\b', 'g');
  return (text.match(re) || []).length;
}

// 文件内是否"有声明"（含解构声明 / import / 函数形参 / catch 形参）
function isDeclared(content, id) {
  const e = escapeRe(id);
  const pats = [
    new RegExp('\\b(?:const|let|var|function|class)\\s+' + e + '\\b'),
    new RegExp('\\b(?:const|let|var)\\s*[\\{\\[][^\\}\\]]*\\b' + e + '\\b'),
    new RegExp('\\bimport\\b[^\\n;]*\\b' + e + '\\b'),
    new RegExp('\\bexport\\b[^\\n;]*\\b' + e + '\\b'),
    new RegExp('\\bfunction\\b[^\\n]*\\([^)]*\\b' + e + '\\b'),
    new RegExp('\\([^)]*\\b' + e + '\\b[^)]*\\)\\s*(?:=>|\\{)'),
    new RegExp('\\bcatch\\s*\\(\\s*' + e + '\\b')
  ];
  return pats.some((p) => p.test(content));
}

// 新增行里的"赋值目标"标识符（排除属性赋值 obj.x / 可选链 a?.x / 声明关键字）
function collectAssignTargets(line) {
  const out = [];
  const re = /(^|[^\w$.])([A-Za-z_$][\w$]*)\s*(\+\+|--|\*\*=|[+\-*/%]=|=(?!=|>))/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const id = m[2];
    if (KEYWORDS.has(id)) continue;
    out.push({ id, text: m[0].trim() });
  }
  return out;
}

// diff 文本里的新增行（排除 +++ 文件头）
export function addedLines(diffText) {
  if (!diffText) return [];
  return String(diffText).split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));
}

/**
 * A) 静态检查：新增行中出现"文件内从未声明、文件他处也从未出现"的赋值目标。
 * @returns {{problems: string[], checked: number}}
 */
export function detectUndeclaredIdentifiers(absFile, diffText) {
  const problems = [];
  const lines = addedLines(diffText);
  if (!lines.length) return { problems, checked: 0 };
  let content = '';
  try { content = readFileSync(absFile, 'utf8'); } catch (e) {
    return { problems: ['semantic-static-error: 无法读取目标文件: ' + e.message], checked: 0 };
  }
  const addedText = lines.join('\n');
  const seen = new Set();
  let checked = 0;
  for (const line of lines) {
    for (const cand of collectAssignTargets(line)) {
      const id = cand.id;
      if (seen.has(id)) continue;
      if (GLOBAL_ALLOWLIST.has(id)) continue;
      if (isDeclared(content, id)) continue;
      // 文件他处也出现过 → 不是本次新引入（保守放过）
      if (occurrenceCount(content, id) > occurrenceCount(addedText, id)) continue;
      seen.add(id);
      checked++;
      problems.push('undeclared-identifier: `' + id + '` 在新增行被赋值，但文件中无声明、他处也无使用（疑似拼写漂移）: ' + line.trim().slice(0, 120));
    }
  }
  return { problems, checked };
}

/**
 * 配对回归测试发现：orchestrator/test/<base>.test.mjs（同名优先；base- 前缀唯一命中亦可）
 * @returns {string|null} 绝对路径
 */
export function discoverPairedTest(absFile, testDir) {
  if (!testDir || !existsSync(testDir)) return null;
  const base = basename(absFile).replace(/\.[^.]+$/, '');
  let files = [];
  try { files = readdirSync(testDir); } catch (e) { return null; }
  const tests = files.filter((f) => /\.(test|spec)\.(mjs|js|cjs)$/.test(f));
  const exact = tests.find((f) => f === base + '.test.mjs' || f === base + '.spec.mjs');
  if (exact) return join(testDir, exact);
  const pref = tests.filter((f) => f.startsWith(base + '-'));
  if (pref.length === 1) return join(testDir, pref[0]);
  return null;
}

/**
 * 跑一个测试文件（node --test）。cwd 固定为工作区根——测试夹具路径语义绑定根目录
 * （T-59 实证：cwd=orchestrator/ 会导致 w6/meta 用例抖动 FAIL，cwd=根 稳 PASS）。
 */
export function runTestFile(testFile, root, timeoutMs = 180000) {
  // 嵌套测试运行器隔离（T-123 自测实证）：外层 `node --test` 会设 NODE_TEST_CONTEXT=child-v8，
  // 子进程继承后内层 `node --test` 即使用例失败也 exit 0（实测红灯被读成绿灯）——必须剥离，
  // 否则护栏在测试环境里形同虚设。
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  const r = spawnSync('node', ['--test', testFile], {
    cwd: root, env, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe']
  });
  const out = String(r.stdout || '') + String(r.stderr || '');
  return {
    ok: r.status === 0,
    status: r.status === null ? null : r.status,
    timedOut: !!(r.error && (r.error.code === 'ETIMEDOUT' || r.error.code === 'ENOENT')),
    output: out.trim()
  };
}

/** 跑配对测试（无配对 → SKIP）。用作修复前基线。 */
export function runPairedTest(absFile, opts = {}) {
  const { root, testDir, timeoutMs } = opts;
  const testFile = discoverPairedTest(absFile, testDir);
  if (!testFile) {
    return { status: 'SKIP', ok: null, testFile: null, output: '', detail: 'no-paired-test: ' + basename(absFile) };
  }
  const r = runTestFile(testFile, root || process.cwd(), timeoutMs);
  return {
    status: r.ok ? 'PASS' : 'FAIL',
    ok: r.ok,
    testFile,
    output: r.output,
    detail: (r.ok ? 'PASS ' : 'FAIL ') + relative(root || process.cwd(), testFile)
  };
}

/**
 * 语义护栏主入口：静态 + 行为。
 * @param {string} absFile 目标文件绝对路径
 * @param {object} opts { root, testDir, diffText, baseline, timeoutMs }
 * @returns {{status:'PASS'|'FAIL'|'SKIP', problems:string[], checks:Array}}
 */
export function runSemanticGuard(absFile, opts = {}) {
  const { root, testDir, diffText, baseline, timeoutMs } = opts;
  const problems = [];
  const checks = [];

  // A) 静态：未声明标识符
  const stat = detectUndeclaredIdentifiers(absFile, diffText || '');
  checks.push({
    name: 'undeclared-identifier',
    status: stat.problems.length ? 'FAIL' : 'PASS',
    detail: stat.problems.length ? stat.problems.join(' ; ') : '无未声明赋值（检查 ' + stat.checked + ' 个候选）'
  });
  problems.push(...stat.problems);

  // B) 行为：配对回归测试（基线对照）
  const testFile = discoverPairedTest(absFile, testDir);
  if (!testFile) {
    checks.push({
      name: 'paired-regression-test',
      status: 'SKIP',
      detail: 'no-paired-test: ' + basename(absFile) + ' 无同名回归测试（本条无行为证据，静态检查仍生效）'
    });
  } else {
    const post = runTestFile(testFile, root || process.cwd(), timeoutMs);
    const baseOk = baseline && baseline.testFile === testFile ? baseline.ok : null;
    if (post.ok) {
      checks.push({
        name: 'paired-regression-test',
        status: 'PASS',
        detail: 'PASS ' + relative(root || process.cwd(), testFile)
      });
    } else if (baseOk === false) {
      // 修复前就红 → 非本次回归，不阻塞（但显式记账）
      checks.push({
        name: 'paired-regression-test',
        status: 'PREEXISTING-FAIL',
        detail: 'PREEXISTING-FAIL ' + relative(root || process.cwd(), testFile) + '（修复前基线即失败，非本次回归，不阻塞）'
      });
    } else {
      const tail = post.output.split('\n').slice(-12).join(' | ').slice(0, 600);
      const baseNote = baseOk === null ? '（基线未能取得，保守按回归处理）' : '';
      checks.push({
        name: 'paired-regression-test',
        status: 'FAIL',
        detail: 'FAIL ' + relative(root || process.cwd(), testFile) + baseNote
      });
      problems.push('semantic-regression: 配对测试 ' + relative(root || process.cwd(), testFile) + ' 修复后失败: ' + tail);
    }
  }

  // 整体口径：PASS 必须有"行为证据"（配对测试通过）；只有静态证据 → SKIP（不阻塞但显式记账，
  // 杜绝"没验证却显示 PASS"）。PREEXISTING-FAIL 同样不构成行为证据 → 计 SKIP。
  const hasBehavioralPass = checks.some((c) => c.name === 'paired-regression-test' && c.status === 'PASS');
  const status = problems.length ? 'FAIL' : (hasBehavioralPass ? 'PASS' : 'SKIP');
  return { status, problems, checks, testFile };
}
