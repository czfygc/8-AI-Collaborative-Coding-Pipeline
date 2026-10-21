// orchestrator/titan-codegen.mjs —— Telegram codegen 薄执行器
// 用法: node titan-codegen.mjs <prompt>
// 链路：OpenCode headless 生成新代码 -> Kilo 独立验收（不 commit） -> 输出 [CODEGEN] verdict/files/summary
// 安全：只新建、只落 codegen/ 白名单子目录、单文件 <= 50KiB、不修改现有文件、不 commit、无 shell 元字符、无密钥字样。

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gate } from './lib/write-gate.mjs';

const TITAN_ROOT = resolve(process.env.TITAN_ROOT || 'D:\\TITAN_ARCHAEOLOGY');
const WHITELIST_DIR = join(TITAN_ROOT, 'codegen');
const MAX_FILE_BYTES = 50 * 1024;
const PROMPT_MAX_LEN = 1500;
const SHELL_META = /[&|;<>$()`\\]/;
const SECRET_PAT = /sk-|AIza|ghp_|sk-pro-|AKIA/i;

function die(msg) {
  console.log('[CODEGEN] FAIL: ' + msg);
  process.exit(1);
}

// T-153：--commit <proposal_id> --by <确认人> —— 用户回「提交」后的确认+落盘动作
// 提案由本次生成流程登记（kind=commit），确认后才真正 git commit。
const argvAll = process.argv.slice(2);
const commitIdx = argvAll.indexOf('--commit');
if (commitIdx !== -1) {
  const pid = argvAll[commitIdx + 1];
  const byIdx = argvAll.indexOf('--by');
  const by = byIdx !== -1 ? argvAll[byIdx + 1] : null;
  if (!pid || !by) die('用法: node titan-codegen.mjs --commit <proposal_id> --by <确认人>');
  try {
    const p = gate.load(pid);
    if (!p) die('提案不存在: ' + pid);
    if (p.status === 'proposed') gate.confirmProposal(pid, { by });
    gate.applyProposal(pid, { by });
    console.log('[CODEGEN] committed proposal=' + pid + ' by=' + by);
    process.exit(0);
  } catch (e) {
    die('提交失败: ' + (e && e.message ? e.message : String(e)));
  }
}

const rawPrompt = process.argv.slice(2).join(' ') || '';
if (!rawPrompt) die('缺少 prompt');
if (rawPrompt.length > PROMPT_MAX_LEN) die('prompt 过长（>' + PROMPT_MAX_LEN + ' 字符）');
if (SHELL_META.test(rawPrompt)) die('prompt 含 shell/git 元字符，已拦截');
if (SECRET_PAT.test(rawPrompt)) die('prompt 含疑似密钥字样，已拦截');
if (/\bgit\s+push\b/i.test(rawPrompt)) die('禁止 git push');

const profilesPath = join(TITAN_ROOT, 'config', 'executor-profiles.json');
let profiles;
try { profiles = JSON.parse(readFileSync(profilesPath, 'utf8')); } catch (e) { die('执行器配置读取失败: ' + e.message); }
const oc = profiles.opencode;
if (!oc || !oc.cmd || !oc.cmd[0]) die('opencode profile 缺失');
const ocExe = oc.cmd[0];
const ocArgs = oc.cmd.slice(1);
const ocModelFlag = oc.modelFlag;
const ocDefaultModel = oc.defaultModel;

if (!existsSync(ocExe)) die('OpenCode 二进制不存在: ' + ocExe);
if (!existsSync(WHITELIST_DIR)) mkdirSync(WHITELIST_DIR, { recursive: true });

const genPrompt = `你是代码生成执行器。在工作区 ${TITAN_ROOT} 内，根据用户需求从零生成新代码文件。

用户需求：${rawPrompt}

硬约束（违反即整单作废）：
1) 只新建文件，绝对禁止修改或删除任何现有文件。
2) 新文件只能放在根目录下的 codegen/ 子目录内（写入相对路径 codegen/xxx），禁止落在仓根散文件，禁止写 reviews/、tmp/、archive/、orchestrator/、node_modules/。
3) 单个源码文件不得超过 50 KiB。
4) 生成完毕后，在 stdout 最后一行输出：FILES: codegen/a.js, codegen/b.js（逗号分隔相对路径，可多个）。
5) 不执行 git commit，不执行任何 shell 命令，不修改现有文件。`;

const genEnv = { ...process.env, ...Object.fromEntries(Object.entries(oc.env || {}).map(([k, v]) => [k, v.replace('${FREELLMAPI_API_KEY}', process.env.FREELLMAPI_API_KEY || '').replace('${TITAN_ROOT}', TITAN_ROOT)])) };
const genArgs = [...ocArgs, genPrompt];
if (ocModelFlag && ocDefaultModel) genArgs.push(ocModelFlag, ocDefaultModel);

const gen = spawnSync(ocExe, genArgs, {
  cwd: TITAN_ROOT, env: genEnv, encoding: 'utf8', timeout: 600000, maxBuffer: 10 * 1024 * 1024,
});
if (gen.error) die('OpenCode 启动失败: ' + gen.error.message);

const statusRaw = (spawnSync('git', ['status', '--porcelain'], { cwd: TITAN_ROOT, encoding: 'utf8' }).stdout || '');
const lines = statusRaw.split('\n').filter(Boolean);
const newFiles = [];
const modifiedFiles = [];
for (const l of lines) {
  const code = l.slice(0, 2).trim();
  const p = l.slice(3).trim().replace(/\\/g, '/');
  if (p.startsWith('reviews/') || p.startsWith('tmp/') || p.startsWith('archive/')) continue;
  if (code === '??') {
    if (p.startsWith('codegen/')) newFiles.push(p);
    else modifiedFiles.push(p);
  } else {
    modifiedFiles.push(p);
  }
}
if (modifiedFiles.length) {
  for (const p of modifiedFiles) {
    if (!p.startsWith('codegen/')) {
      try { unlinkSync(join(TITAN_ROOT, p)); } catch {}
    } else {
      try { spawnSync('git', ['restore', '--staged', '--worktree', '--', p], { cwd: TITAN_ROOT }); } catch {}
    }
  }
  die('生成违规：触碰非 codegen/ 路径或现有文件：' + modifiedFiles.join(', ') + '，已回滚');
}
if (newFiles.length === 0) die('OpenCode 未产出任何新文件');

for (const p of newFiles) {
  const full = join(TITAN_ROOT, p);
  if (!existsSync(full)) continue;
  const size = statSync(full).size;
  if (size > MAX_FILE_BYTES) {
    try { unlinkSync(full); } catch {}
    die('文件超 50KiB 已拦截：' + p + ' (' + size + ' 字节)');
  }
}

const kilo = resolveKilo(profiles);
if (!kilo) die('Kilo 二进制不可用，无法独立验收');

const fileContents = [];
for (const p of newFiles) {
  try { fileContents.push('=== ' + p + ' ===\n' + readFileSync(join(TITAN_ROOT, p), 'utf8')); } catch {}
}
const reviewPrompt = `请独立审查下面由 OpenCode headless 生成的新代码文件（作者 != 验证者）。只判定合规与否，不修改文件。

合规规则：
- 仅新建文件，未修改任何现有文件。
- 所有文件在 codegen/ 子目录内。
- 单文件 <= 50 KiB。
- 文件内容无 shell/git 元字符、无密钥字样、无 git push。

文件列表：${newFiles.join(', ')}

文件内容：
${fileContents.join('\n\n')}

请在回复最后一行输出：VERDICT: PASS 或 VERDICT: FAIL：<简短理由>`;

const kiloEnv = { ...process.env, FREELLMAPI_API_KEY: process.env.FREELLMAPI_API_KEY || '' };
const kiloArgs = [...kilo.cmd.slice(1), reviewPrompt, '--model', kilo.defaultModel || 'yysd/codestral'];
const kiloRes = spawnSync(kilo, kiloArgs, {
  cwd: TITAN_ROOT, env: kiloEnv, encoding: 'utf8', timeout: 600000, maxBuffer: 10 * 1024 * 1024,
});
if (kiloRes.error) die('Kilo 启动失败: ' + kiloRes.error.message);
const kiloOut = kiloRes.stdout || '';
const pass = /VERDICT:\s*PASS/i.test(kiloOut);
const fReason = kiloOut.match(/VERDICT:\s*FAIL\s*:\s*(.+)/i);
const failReason = fReason ? fReason[1] : (pass ? '' : 'Kilo 未输出明确 VERDICT');

if (!pass) {
  for (const p of newFiles) { try { unlinkSync(join(TITAN_ROOT, p)); } catch {} }
  die('Kilo 验收未通过：' + failReason);
}

const preview = fileContents.map(c => c.slice(0, 400)).join('\n---\n');
// T-153：生成物不直接提交——先登记「提交提案」，等用户回「提交」再确认落盘（复用通用写闸）
let proposalId = '';
try {
  const proposal = gate.createProposal({
    kind: 'commit',
    actor: 'opencode',
    reason: 'codegen 生成物（Kilo 验收 PASS）',
    note: 'codegen',
    message: '[CODEGEN] feat: ' + rawPrompt.slice(0, 80).replace(/\s+/g, ' '),
    targets: newFiles.map(p => ({ path: join(TITAN_ROOT, p) })),
  });
  const sum = gate.summarize(proposal);
  proposalId = proposal.id;
  console.log('[CODEGEN] proposal=' + proposal.id + ' files=' + sum.files.length + ' confirm=pending');
} catch (e) {
  console.log('[CODEGEN] proposal=FAILED ' + (e && e.message ? e.message : String(e)));
}
console.log('[CODEGEN] verdict=PASS files=' + newFiles.join(', '));
if (proposalId) console.log('[CODEGEN] proposal_id=' + proposalId);
console.log('[CODEGEN] summary=' + preview.replace(/\s+/g, ' ').slice(0, 2000));
process.exit(0);

function resolveKilo(profiles) {
  const kp = profiles.kilo;
  if (!kp || !kp.cmd || !kp.cmd[0]) return null;
  const exe = kp.cmd[0];
  if (existsSync(exe)) return exe;
  const m = exe.match(/^(.*)kilocode\.kilo-code-[^\\/]+[\\/]bin[\\/]kilo\.exe$/);
  if (!m) return null;
  let best = null, bestV = [-1, -1, -1];
  try {
    for (const d of readdirSync(m[1])) {
      const vm = d.match(/^kilocode\.kilo-code-(\d+)\.(\d+)\.(\d+)/);
      if (!vm) continue;
      const e = join(m[1], d, 'bin', 'kilo.exe');
      if (!existsSync(e)) continue;
      const v = [+vm[1], +vm[2], +vm[3]];
      if (v[0] > bestV[0] || (v[0] === bestV[0] && v[1] > bestV[1]) || (v[0] === bestV[0] && v[1] === bestV[1] && v[2] > bestV[2])) { bestV = v; best = e; }
    }
  } catch {}
  return best;
}
