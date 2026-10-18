// orchestrator/lib/check-file.mjs — T-56 W5b（S-11）：verify_cmd 按扩展名分派器
// 用法: node orchestrator/lib/check-file.mjs <file>
// 退出码: 0=校验通过  1=校验失败  2=依赖缺失（环境错误，不计 FAIL——verify-delta 已把
//        verify_cmd exit 2 归为 ENV:ENV_DEPS，与 T-12 合同一致）
// 分派:
//   .mjs/.js/.cjs -> node --check（语法）
//   .json         -> JSON.parse（无外部依赖，纯内置）
//   .yaml/.yml    -> js-yaml 解析；模块缺失（克隆树无 node_modules）按 ENV 处理 exit 2
//   .md/.txt 等   -> 不适用，exit 2（ENV:UNSUPPORTED，宁缺毋滥——假绿不如不验证）
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { extname, resolve } from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('[CHECK-FILE] 用法: node check-file.mjs <file>');
  process.exit(2);
}
const abs = resolve(target);
if (!existsSync(abs)) {
  console.error('[CHECK-FILE] [MISSING] ' + abs);
  process.exit(1);
}
const ext = extname(abs).toLowerCase();

try {
  if (['.mjs', '.js', '.cjs'].includes(ext)) {
    execFileSync(process.execPath, ['--check', abs], { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log('[CHECK-FILE] PASS syntax: ' + abs);
    process.exit(0);
  }
  if (ext === '.json') {
    JSON.parse(readFileSync(abs, 'utf8'));
    console.log('[CHECK-FILE] PASS json: ' + abs);
    process.exit(0);
  }
  if (ext === '.yaml' || ext === '.yml') {
    let yaml = null;
    try { yaml = await import('js-yaml'); } catch { /* 克隆树无 node_modules */ }
    if (!yaml) {
      console.error('[CHECK-FILE] [ENV] js-yaml 不可用（克隆树无 node_modules），按环境错误处理（exit 2）');
      process.exit(2);
    }
    const load = yaml.load || (yaml.default && yaml.default.load);
    if (typeof load !== 'function') {
      console.error('[CHECK-FILE] [ENV] js-yaml 无法调用 load()');
      process.exit(2);
    }
    load(readFileSync(abs, 'utf8'));
    console.log('[CHECK-FILE] PASS yaml: ' + abs);
    process.exit(0);
  }
  console.error('[CHECK-FILE] [ENV] 不支持校验的扩展名: ' + ext);
  process.exit(2);
} catch (e) {
  console.error('[CHECK-FILE] [FAIL] ' + ext + ' 校验失败: ' + (e.message || e));
  process.exit(1);
}