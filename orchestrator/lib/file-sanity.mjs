// orchestrator/lib/file-sanity.mjs — T-56 W7：执行器改动后 sanity 护栏（自 titan-execute 提取）
// T-49 实战教训：执行器曾把 3665 行文件删成一行 "ALREADY_RESOLVED"，verify 只查 scope/范围
// 照样 PASS——毁灭性删改必须当场拦截（不能等事后 gate）。护栏：
//   1) 协议标记入文件（<5 行的壳 + ALREADY_RESOLVED）
//   2) 体积护栏（行数减半以上）
//   3) JS/MJS/CJS node --check
//   4) JSON JSON.parse
//   5) TS tsc --noEmit
//   6) YAML js-yaml 解析
//   7) 纯库模块 import 冒烟（P-19 第二击：__dirname TDZ 等加载期炸弹）
//   8) mojibake（T-59 用户指令：U+FFFD 替换符 = 编码被破坏）
//   9) full-file-rewrite（T-59 用户指令：改动行占比 >80% 且行数变化 <20% = 整文件重写/EOL 翻转）
// 契约见 orchestrator/test/file-sanity.test.mjs（titan-sanity suite）。
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const LIB_SAFE = ['scan-flow.mjs', 'cdp-client.mjs', 'review-flow.mjs'];

export function checkFileSanity(absFile, pre, opts = {}) {
  const problems = [];
  try {
    const content = readFileSync(absFile, 'utf8');
    const lines = content.split('\n').length;
    // 1) 整文件被替换/混入协议标记 = 执行器把 stdout 协议写进了文件
    if (/^\s*ALREADY_RESOLVED\s*$/i.test(content.trim()) || (lines <= 5 && /ALREADY_RESOLVED/i.test(content))) {
      problems.push('marker-as-file-content');
    }
    // 2) 体积护栏：删掉一半以上（任何正当修复都不该把大文件删成壳）
    if (pre && pre.lines > 100 && lines < pre.lines * 0.5) {
      problems.push('shrink ' + pre.lines + '->' + lines + ' lines (>50% deleted)');
    }
    // 3) 语法护栏：JS/MJS/CJS 必过 node --check
    if (/\.(mjs|cjs|js)$/i.test(absFile)) {
      const chk = spawnSync('node', ['--check', absFile], { encoding: 'utf8', timeout: 120000 });
      if (chk.status !== 0) problems.push('node--check FAIL: ' + String(chk.stderr || '').trim().slice(0, 200));
    }
    // 4) 语法护栏：JSON 必过 JSON.parse
    else if (/\.json$/i.test(absFile)) {
      try {
        JSON.parse(content);
      } catch (e) {
        problems.push('JSON.parse FAIL: ' + String(e.message).trim().slice(0, 200));
      }
    }
    // 5) 语法护栏：TypeScript 必过 tsc --noEmit
    else if (/\.ts$/i.test(absFile)) {
      const chk = spawnSync('tsc', ['--noEmit', absFile], { encoding: 'utf8', timeout: 120000 });
      if (chk.status !== 0) problems.push('tsc--noEmit FAIL: ' + String(chk.stderr || '').trim().slice(0, 200));
    }
    // 6) 语法护栏：YAML 必过 js-yaml 解析（工作区含依赖；缺失按 ENV 由调用方决定）
    else if (/\.(yaml|yml)$/i.test(absFile)) {
      try {
        const script = 'import { readFileSync } from "node:fs"; import("js-yaml").then(function(m){var y=m.load||(m.default&&m.default.load);y(readFileSync(process.argv[1],"utf8"));process.exit(0)}).catch(function(e){console.error(e.message);process.exit(1)})';
        const chk = spawnSync('node', ['--input-type=module', '-e', script, absFile], { encoding: 'utf8', timeout: 120000 });
        if (chk.status !== 0) problems.push('YAML validation FAIL: ' + String(chk.stderr || chk.stdout || '').trim().slice(0, 200));
      } catch (e) {
        problems.push('YAML validation setup FAIL: ' + String(e.message).trim().slice(0, 200));
      }
    }
    // 7) 导入烟雾护栏（P-19 第二击，R2 实测）：执行器曾在 ESM 里写 __dirname——node --check
    //    语法全绿但 import 即炸。纯库模块（无顶层副作用）必须在提交前实跑一次 import。
    const base = absFile.replace(/\\/g, '/').split('/').pop();
    if ((opts.libSafe || LIB_SAFE).includes(base)) {
      const smoke = spawnSync('node', ['--input-type=module', '-e',
        `import(${JSON.stringify('file:///' + absFile.replace(/\\/g, '/'))}).then(function(){process.exit(0)}).catch(function(e){console.error('IMPORT_ERR: '+e.message);process.exit(1)})`],
        { encoding: 'utf8', timeout: 30000 });
      if (smoke.status !== 0) problems.push('import-smoke FAIL: ' + String(smoke.stderr || smoke.stdout || '').trim().slice(0, 200));
    }
    // 8) mojibake 护栏（T-59 用户指令，堵 cline Set-Content 编码破坏）：含 U+FFFD = 编码被打坏
    if (content.includes(String.fromCharCode(0xFFFD))) {
      problems.push('mojibake: 文件含 U+FFFD 替换符（编码被破坏）');
    }
    // 9) full-file-rewrite 护栏（T-59 用户指令，堵整文件重写/EOL 翻转）：改动行占比
    //    = (+/- 行数) / max(前,后 行数) > 80%，且行数变化 < 20% → 拦（小修不碰 80% 行；
    //    4280 行文件被整文件重写必中）。纯增删（行数变化 >= 20%）交由体积护栏管。
    const diffText = String(opts.diffText || '');
    if (pre && pre.lines > 0 && diffText) {
      const touched = diffText.split('\n').filter((l) =>
        (l.startsWith('+') && !l.startsWith('+++')) || (l.startsWith('-') && !l.startsWith('---'))
      ).length;
      const denom = Math.max(pre.lines, lines);
      const lineDelta = Math.abs(lines - pre.lines) / pre.lines;
      if (denom > 0 && touched / denom > 0.8 && lineDelta < 0.2) {
        problems.push('full-file-rewrite: 改动行占比 ' + Math.round((touched * 100) / denom) + '% (>80%) 且行数变化 <20%');
      }
    }
  } catch (e) { problems.push('sanity-error: ' + e.message); }
  return { problems };
}