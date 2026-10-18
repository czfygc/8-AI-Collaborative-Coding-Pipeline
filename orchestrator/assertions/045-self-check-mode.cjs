// assertions/045-self-check-mode.cjs —— P3-12：--self-check 必须“存在且真能跑”（静态标记 + 功能运行）
// 事故教训（d8aac99/弱绿类）：只查静态标记会让“缺分发点的半成品”也变绿 → 必须实际执行并要求 exit 0。
const { readFileSync } = require('fs');
const { join } = require('path');
const { spawnSync } = require('child_process');

const src = readFileSync(join(__dirname, '..', 'orchestrate.mjs'), 'utf8');
const hasFlag = /args\.includes\('--self-check'\)/.test(src);
const hasMode = /mode\s*=\s*'selfcheck'/.test(src);
const hasRun  = /runSelfCheck\s*\(/.test(src);
const hasDispatch = /if\s*\(mode\s*===\s*'selfcheck'\)/.test(src); // 分发点：main() 里必须短路调用
const hasOut  = /\[SELFCHECK\]/.test(src);
const missing = [!hasFlag && 'flag', !hasMode && 'mode', !hasRun && 'runSelfCheck', !hasDispatch && 'dispatch(mode短路)', !hasOut && '[SELFCHECK]日志'].filter(Boolean);
if (missing.length) { console.log('MISSING: ' + missing.join(', ') + '（--self-check 未实现或缺分发点）'); process.exit(1); }

// 功能运行：20s 超时防挂（045 半成品实测会挂进 CDP 连接）
const r = spawnSync(process.execPath, [join(__dirname, '..', 'orchestrate.mjs'), '--self-check'], {
  encoding: 'utf8', timeout: 20000, cwd: join(__dirname, '..', '..'),
  env: { ...process.env, D_TITAN_ROOT: join(__dirname, '..', '..') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (r.error && r.error.code === 'ETIMEDOUT') { console.log('RUNTIME_HANG: --self-check 20s 未退出（缺短路，挂进后续流程）'); process.exit(1); }
const out = String(r.stdout || '');
const passLines = (out.match(/\[SELFCHECK\] PASS/g) || []).length;
const failLines = (out.match(/\[SELFCHECK\] FAIL/g) || []).length;
if (r.status !== 0) { console.log('RUNTIME_FAIL: exit=' + r.status + ' failLines=' + failLines + ' out=' + out.split('\n').slice(0, 3).join(' | ')); process.exit(1); }
if (passLines < 3) { console.log('RUNTIME_THIN: PASS 行仅 ' + passLines + '（<3，自检项不足）'); process.exit(1); }
console.log('OK 静态标记齐全 + 运行 exit0 + PASS 行=' + passLines + ' FAIL 行=' + failLines);
process.exit(0);
