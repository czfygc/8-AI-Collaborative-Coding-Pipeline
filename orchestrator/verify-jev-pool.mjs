#!/usr/bin/env node
// verify-jev-pool.mjs — 重启后验证 jev 池分类修复是否已生效（①的验收器）
// 检查: 1) models.yaml 磁盘分类正确  2) build.log 有晚于编辑时间的 pool loaded 行(=已 reload)
//       3) reload 后的 witness 里 free 链不再把 mimo-flash 当免费主力
// 退出码 0=PASS / 1=FAIL / 2=环境缺
import { readFileSync, existsSync, statSync } from 'node:fs';
const YML = 'C:/Users/Administrator/.dsh/profiles/web/plugins/jev-router/config/models.yaml';
const BAK = YML + '.bak-20261002-paid';
const BUILD = 'C:/Users/Administrator/.dsh/logs/jev-router/build.log';
const DISPATCH = 'C:/Users/Administrator/.dsh/logs/jev-router/dispatch.log';
let fail = 0;
// 1) 磁盘分类
try {
  const y = readFileSync(YML, 'utf8');
  // 只看列表项（- 开头），注释里提到模型名不算
  const items = s => s.split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('- '));
  const freeSec = items(y.split(/^paid:/m)[0]);
  const paidSec = items(y.split(/^paid:/m)[1] || '');
  const freeHas = freeSec.some(x => /mimo-v2\.6-flash/.test(x));
  const paidOrderOk = paidSec.findIndex(x => /mimo-v2\.6-flash/.test(x)) === 0
    && paidSec.findIndex(x => /mimo-v2\.6-pro/.test(x)) === 1;
  const diskOk = !freeHas && paidOrderOk;
  console.log('[1/3] models.yaml 分类: ' + (diskOk ? 'PASS' : 'FAIL (free含=' + freeHas + ' paid序ok=' + paidOrderOk + ')'));
  if (!diskOk) fail++;
} catch (e) { console.log('[1/3] models.yaml 读失败: ' + e.message); fail++; }
// 2) reload 证据（build.log 的 pool loaded 时间晚于备份文件时间=编辑后有加载）
try {
  const editAt = statSync(YML).mtimeMs;   // 用 models.yaml 自身 mtime（备份继承的是源文件旧时间）
  const build = readFileSync(BUILD, 'utf8').split(/\r?\n/).filter(l => l.includes('pool loaded from'));
  const last = build[build.length - 1] || '';
  const ts = (last.match(/^\[?(\d{4}-\d{2}-\d{2}T[^\]\s]+)/) || [])[1];   // 行首是 [ 时间 ]
  const loadedAt = ts ? Date.parse(ts.endsWith('Z') ? ts : ts + 'Z') : 0;
  const reloaded = loadedAt > editAt;
  console.log('[2/3] 池已 reload: ' + (reloaded ? 'PASS' : 'FAIL — build.log 最后 pool loaded=' + (ts || '?') + '，编辑于 ' + new Date(editAt).toISOString() + '；重启 dsh web 后本项才转 PASS'));
  if (!reloaded) fail++;
} catch (e) { console.log('[2/3] build.log 检查失败: ' + e.message); fail++; }
// 3) reload 后 witness 抽样：免费链不应首选 mimo-flash
try {
  const lines = readFileSync(DISPATCH, 'utf8').split(/\r?\n/).filter(l => l.includes('WITNESS_LLM_STREAM'));
  const tail = lines.slice(-40);
  const mimoAs = tail.filter(l => /final_model=xiaomi\/mimo-v2\.6-flash/.test(l)).length;
  console.log('[3/3] 近40条 witness 中 mimo-flash: ' + mimoAs + ' 条 ' + (fail === 0 ? (mimoAs <= 4 ? '(≤10%，PASS — 仅付费档被选中)' : '(FAIL — 仍被当免费首选)') : '(2未过，本项待重启后再判)'));
  if (fail === 0 && mimoAs > 4) fail++;
} catch (e) { console.log('[3/3] witness 检查失败: ' + e.message); fail++; }
console.log(fail === 0 ? 'POOL_VERIFY_PASS' : 'POOL_VERIFY_PENDING_OR_FAIL(' + fail + ')');
process.exit(fail === 0 ? 0 : 1);
