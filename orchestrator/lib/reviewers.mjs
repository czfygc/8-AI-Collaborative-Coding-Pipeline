// lib/reviewers.mjs — T-61 P2 提取（机械搬移自 orchestrate.mjs；块体逐字节未动，仅加 export 前缀）
// 符号集（计划 C-2）：loadReviewersYaml/loadReviewersArray/loadEnabledReviewers + REVIEWERS 状态。
// 状态迁移（markers.mjs setDispatchMarkers 同款先例）：原入口顶层 `let REVIEWERS;` 迁本模块私有，
// 入口在原赋值点（CLI --mode 解析后，时序不变）调 setReviewers(loadEnabledReviewers(reviewMode))；
// 消费方经 getReviewers() 读取。入口 28 处代码引用词边界替换 REVIEWERS→getReviewers()（注释行不动）。
// env/config 加载器已在 P0 随常量层落 lib/constants.mjs（计划 P2 符号表微调，语义不变）。
import { existsSync, readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { REVIEWERS_YAML } from './constants.mjs';

let REVIEWERS;

export function setReviewers(v) { REVIEWERS = v; }

export function getReviewers() { return REVIEWERS; }

// ---------- YAML 加载 (js-yaml) ----------
export function loadReviewersYaml(path) {
  if (!existsSync(path)) {
    return {};
  }
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
  let doc;
  try {
    doc = yaml.load(text);
  } catch (e) {
    return {};
  }
  if (!doc) {
    return {};
  }
  return doc;
}

// Helper function to load reviewers array for a specific mode
export function loadReviewersArray(mode) {
  const raw = readFileSync(REVIEWERS_YAML, 'utf8').replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
  const doc = yaml.load(raw);
  if (!doc) {
    throw new Error('reviewers.yaml 解析失败');
  }
  
  const key = mode === 'scan' ? 'reviewers_scan' : 'reviewers_role';
  const reviewers = doc[key];
  if (!reviewers || !Array.isArray(reviewers) || reviewers.length === 0) {
    throw new Error(`reviewers.yaml 中 ${key} 为空或缺失`);
  }
  
  return reviewers;
}

export function loadEnabledReviewers(modeOverride) {
  // Use the provided mode, or fall back to environment variable, or default to 'role'
  const reviewMode = modeOverride || process.env.TITAN_REVIEW_MODE || 'role';
  const doc = loadReviewersYaml(REVIEWERS_YAML);
  let reviewers;
  if (reviewMode === 'scan') {
    reviewers = doc.reviewers_scan;
  } else {
    reviewers = doc.reviewers_role;
  }
  if (!reviewers || !Array.isArray(reviewers) || reviewers.length === 0) {
    const key = reviewMode === 'scan' ? 'reviewers_scan' : 'reviewers_role';
    console.error('[FATAL] ' + key + ' 为空或缺失');
    process.exit(1);
  }
  const enabled = reviewers.filter(r => {
    const v = r.enabled;
    return v === true || v === 'true' || v === 1 || v === '1';
  });
  if (enabled.length === 0) {
    const key = reviewMode === 'scan' ? 'reviewers_scan' : 'reviewers_role';
    console.error('[FATAL] ' + key + ' 中没有 enabled:true 的 reviewer');
    process.exit(1);
  }
  if (reviewMode === 'scan') {
    // MODE_B: 代码扫描模式 —— 返回扫描器配置（用于 FreeLLMAPI/Kilo 调用）
    return enabled.map(r => ({
      name: r.name,
      display_name: r.display_name || r.name,
      provider: r.provider || 'freellmapi',
      model_id: r.model_id || r.name,
      enabled: true,
      scan_focus: r.scan_focus || '',
      temperature: Number.isFinite(r.temperature) ? r.temperature : 0.1,
      max_tokens: Number.isFinite(r.max_tokens) ? r.max_tokens : 8192,
    }));
  }
  // MODE_A: 角色化模式（原有逻辑）
  return enabled.map(r => {
    const uploadWait = r.upload_wait_ms != null ? parseInt(r.upload_wait_ms, 10) : 3000;
    return {
      name: r.name,
      display_name: r.display_name || r.name,
      url_match: r.url_match ? new RegExp(r.url_match) : null,
      url_open: r.url_open || '',
      perspective: r.perspective || '',
      perspective_prompt: (r.perspective_prompt || '').trim(),
      prefix: r.prefix || r.name.charAt(0).toUpperCase(),
      enabled: true,
      skip_fresh_chat: r.skip_fresh_chat === true || r.skip_fresh_chat === 'true' || r.skip_fresh_chat === 1,
      editor_selector: r.editor_selector || '',
      upload_strategy: r.upload_strategy === null || r.upload_strategy === undefined ? null : (r.upload_strategy || 'direct'),
      file_input_selector: r.file_input_selector || '',
      upload_button_selector: r.upload_button_selector || null,
      upload_menu_item_text: r.upload_menu_item_text || null,
      upload_wait_ms: Number.isFinite(uploadWait) && uploadWait > 0 ? uploadWait : 3000,
      response_max_ms: Number.isFinite(Number(r.response_max_ms)) && Number(r.response_max_ms) > 0 ? Number(r.response_max_ms) : null,
      submit_selector: r.submit_selector || null,
    };
  });
}
