// lib/constants.mjs — T-61 P0 常量上提（机械搬移自 orchestrate.mjs 顶层常量区；块体逐字节未动，仅加 export 前缀）
// 依据：分阶段拆分计划.md §9 破环预案（"环即再拆或常量上提"）——P1 起 lib 模块引用共享常量，
// 常量留入口即成循环 import（lib→入口会连带执行 CLI 顶层副作用，import 冒烟闸必炸）。
// 搬移块：L45-91 env/config 加载器与 envFromFile/configFromFile（私有——仅 CDP_HOST/TITAN_ROOT/START_BAT
// 回退链消费；计划 P2 符号表微调，语义不变）、L122-129 常量区头+CDP_HOST+TITAN_ROOT、
// L200-245 超时/响应/锁/附件/快照/架构师常量+START_BAT+REVIEWERS_YAML。
// __dirname 语义 = orchestrator/（lib/ 下两次 dirname，与原入口取值一致）。
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const __dirname = dirname(dirname(fileURLToPath(import.meta.url)));

// Load environment variables from .env file if it exists
function loadEnvFile() {
  const envPath = join(__dirname, '.env');
  if (!existsSync(envPath)) {
    return {};
  }
  try {
    const content = readFileSync(envPath, 'utf8');
    const env = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const [key, ...valueParts] = trimmed.split('=');
      if (key === undefined) continue;
      const value = valueParts.join('=').trim();
      // Remove quotes if present
      let cleanedValue = value;
      if ((cleanedValue.startsWith('"') && cleanedValue.endsWith('"')) ||
          (cleanedValue.startsWith("'") && cleanedValue.endsWith("'"))) {
        cleanedValue = cleanedValue.slice(1, -1);
      }
      env[key.trim()] = cleanedValue;
    }
    return env;
  } catch (e) {
    // If we can't read the .env file, continue without it
    return {};
  }
}

// Load configuration from config.json if it exists
function loadConfigFile() {
  const configPath = join(__dirname, 'config.json');
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    const content = readFileSync(configPath, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    // If we can't read or parse config.json, continue without it
    return {};
  }
}

const envFromFile = loadEnvFile();
const configFromFile = loadConfigFile();

// ---------- 常量 ----------
export const CDP_HOST = process.env.D_CDP_HOST || configFromFile.D_CDP_HOST || envFromFile.D_CDP_HOST || '127.0.0.1:9222';
// P-19 复位：四级回退保留默认值。执行器修复轮（DELTA-011/022）曾把 D_TITAN_ROOT 改为
// 强制项，但全套工具链（autopilot/bat/头less 调用）都依赖零配置默认运行——强制=回归。
// 可移植性顺序：env > config.json > .env > 默认（默认是本部署的最后兜底，不是坏味道）。
export const TITAN_ROOT = process.env.D_TITAN_ROOT || configFromFile.D_TITAN_ROOT || envFromFile.D_TITAN_ROOT
  || resolve(fileURLToPath(new URL('../..', import.meta.url)));


// P2-14: 统一超时配置（per-reviewer + artifact 大小）
/**
 * 超时配置
 *
 * @constant {number} TIMEOUT_INLINE_BASE_MS - 180s inline 基础超时
 * @constant {number} TIMEOUT_UPLOAD_BASE_MS - 300s upload 基础超时
 * @constant {number} TIMEOUT_INLINE_MAX_MS - 360s inline 硬上限
 * @constant {number} TIMEOUT_UPLOAD_MAX_MS - 600s upload 硬上限
 * @constant {number} TIMEOUT_ARTIFACT_FACTOR - 每 50KB 增加 10%
 * @constant {number} TIMEOUT_ARTIFACT_UNIT_KB - 50KB 单位
 */
export const TIMEOUT_INLINE_BASE_MS = 180000;
// T-72（2026-10-21 用户指令「等待结果的时间太长，要提高效率」）：upload 基线 300s → 240s。
// 实测有回复的席均在 60~120s 内落地（deepseek 5/gemini 3/grok 5 findings），240s 仍留足余量；
// 真正拖时长的席位是"发不出去/没渲染"的席（如 qwen/chatgpt 上传失败），它们本来就没有产物。
// 超时仍有 T-62 全文兜底，不丢内容，只是提前标记。
export const TIMEOUT_UPLOAD_BASE_MS = 240000;
export const TIMEOUT_INLINE_MAX_MS = 360000;
export const TIMEOUT_UPLOAD_MAX_MS = 600000;
export const TIMEOUT_ARTIFACT_FACTOR = 1.1;
export const TIMEOUT_ARTIFACT_UNIT_KB = 50;
// T-04: 旧根 orchestrator-runs/ 已归档至 reviews/legacy/；probe/screenshot/run 输出改落 reviews/_probe-runs（根目录不再复活运行产物）
export const OUT_ROOT_PROBE = join(TITAN_ROOT, 'reviews', '_probe-runs');
export const ENSURE_LOG = join(TITAN_ROOT, 'orchestrator', 'logs', 'ensure-tabs.log');
export const DISPATCH_HISTORY_LOG = join(TITAN_ROOT, 'dispatch-history.log');
export const MAX_REPORT_CHARS = 200000;
// R-02: inline 通道安全上限。reviewers.yaml 声明"inline 适用于小报告（< 20K 字符）"，
// 超过此字符数的 artifact 自动切 upload 通道，避免长文全文贴入 AI 对话造成长上下文风控。
export const AUTO_UPLOAD_CHARS = 20000;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB
// DELTA-024（T-59 批2c）：散落运行参数收拢区。只收"运行阈值/多处复用/成组调参"的值；
// 单点流程私有字面量不搬（避免为收拢而收拢）。各使用点见常量名。
export const CDP_VERSION_PROBE_TIMEOUT_MS = 10000;   // tryFetchVersion 探测超时
export const CDP_ATTACH_RETRIES = 3;                 // ensureTabs attachToTarget 重试次数
export const CDP_ATTACH_RETRY_DELAY_MS = 1000;        // attach 重试退避
export const DRAG_STEP_DELAY_MS = 400;               // 拖拽上传 dragEnter→dragOver 间隔
export const ATTACH_CONFIRM_TIMEOUT_MS = 8000;        // 附件确认轮询上限
export const SNAPSHOT_TAIL_CHARS = 8000;             // snapshot bodyTail 截取长度
export const ARCHITECT_DELTA_MAX_CHARS = 60000;      // 架构师 delta 字符预算
export const ARCHITECT_CAPTURE_WINDOW_MS = 180000;   // 架构师响应采集窗
export const ARCHITECT_SUBMIT_SETTLE_MS = 1200;      // 注入→提交前稳态等待
export const RESPONSE_STABLE_DEFAULT_MS = 4000;      // waitForResponse 缺省稳定窗
export const RESPONSE_STABLE_UPLOAD_MS = 5000;       // upload 通道稳定窗
export const RESPONSE_POLL_MAX = 200;                // waitForResponse 缺省轮询上限
export const FILE_LOCK_POLL_MS = 10;                 // 文件锁轮询间隔（计数器/历史）
export const FILE_LOCK_TIMEOUT_MS = 500;             // 文件锁获取超时
export const FILE_LOCK_STALE_MS = 5000;              // 陈旧锁回收阈值（DELTA-023）
export const START_BAT = process.env.START_BAT || configFromFile.START_BAT || envFromFile.START_BAT || join(TITAN_ROOT, '启动 CDP 浏览器.bat');

export const REVIEWERS_YAML = join(__dirname, 'reviewers.yaml');
