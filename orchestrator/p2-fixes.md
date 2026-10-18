# P2 Fixes Summary（Batch A/B/C 全量回写）

> 修复来源：`orchestrator/汇总.md` 9 模型联合审计（P2 共 18 项）。
> Batch A：2026-09-28 首批回写；Batch B/C：2026-09-30 会话回写（补齐缺口）。
> 每项行号为修复落地位置（orchestrate.mjs 除注明外）。

---

## Batch A（分发层/基础设施，已记录）

### P2-01: CDP Connect Timeout + Probe/Attach Retry

**问题**：tryFetchVersion() 无超时；CDP.connect() 无超时/重试；attachToTarget 无重试

**修复**：
1. `tryFetchVersion()` 添加 10s 超时
2. `CDP.connect()` 添加 15s 超时
3. `ensureTabs()` 中的 attachToTarget 添加 3 次重试

**落地**：L351（attach 重试 ×3）

### P2-02: 登录检测精确化

**问题**：检测 `signin|log in| |注册|sign up` 过于宽泛，会误报"最近登录记录"等字样

**修复**：
1. 改为检测登录按钮/表单选择器（如 `input[type="email"]`, `button:contains("Sign")`）
2. 排除"登录记录"、"登录历史"等短语

**落地**：L369（表单元素计数判断，避免"登录记录"误报）

### P2-03: 注入/提交多选择器回退 + registered 长度校验

**问题**：
1. Quill execCommand 最多 500 行截断
2. registered 长度校验可能不准确（Quill delta 未注册）

**修复**：
1. 增加 prompt 长度限制（超过 1000 行时警告并截断）
2. 添加 Quill editor.getContents().ops.length 校验
3. 保护已有草稿：检测 input 框非空时询问是否继续

**落地**：L441（草稿保护）、L450（Quill ops 校验）

### P2-04: Upload 轮询 attachment-preview-wrapper + 失败回退 inline

**问题**：uploadByDragSim 只等待 3s 不轮询

**修复**：
1. attachment-preview-wrapper 轮询（最多 8s）
2. 超时后 throw 错误让 runTabUpload 返回 failed status

**落地**：L937（8s 轮询）

### P2-14: 超时统一（per-reviewer + artifact 大小）

**问题**：inline 300s / upload 420s / deepseek 600s 不一致

**修复**：
1. 定义基础超时：inline 180s, upload 300s
2. 按 artifact 大小因子调整：每 50KB +10%
3. 允许 reviewers.yaml 中 response_max_ms 覆盖
4. 设置硬上限：inline 360s, upload 600s

**落地**：L34、L1044（inline 路径）、L1251（upload 路径）

---

## Batch B（解析与 Layer A/B 分析链，2026-09-30 回写）

### P2-05: ISSUE/severity 提取正则脆弱

**问题**：K-1 一位数字丢失、DS-01 误匹配 S-01、verdict 行误当 ISSUE、自然语言 severity 无法提取。

**修复**：
1. 无 ISSUE-ID 时 fallback 以空行分割段落
2. idRe 支持一位数字 + 前缀边界
3. 自然语言 severity（高/中/低）映射

**落地**：L1455（空行 fallback）、L1581（一位数字 id + 自然语言 severity）

### P2-06: ASSUMPTION_CONFLICT / overallVerdict 启发式过敏感

**问题**：否定包跨行惰性删除会吞掉正文（`[\s\S]{0,12}?` 跨行误删），制造假 ASSUMPTION_CONFLICT。

**修复**：
1. 否定处理按行/按句，不跨行惰性删除
2. 结构化 verdict 可用时优先，启发式兜底收紧

**落地**：L1505（否定包按行处理）

### P2-07: HIGH_SEVERITY_UNCONFIRMED 语义偏离且双写

**问题**：HSU 与 backlog 混写、双写，语义偏离 skill 定义。

**修复**：
1. HSU 独立桶，不再混入 backlog
2. 互斥写入；阈值缺失显式报错

**落地**：L2523（highSeverityUnconfirmed 独立桶）

### P2-08: NONE 占位未分类，空响应状态丢失

**问题**：reviewer 空响应/失败在分析中与"沉默"不可区分。

**修复**：
1. 无 raw 文本 + 无 verdict → NONE 占位（isNone=true）
2. 以 dispatch-meta.reviewers 为准输出每个 reviewer 状态，参与分类计数

**落地**：L2427-2428（NONE 占位）、L2445-2448（per-reviewer 状态输出）

**验证**：回归输出 `gemini: ... isNone=false` / fixture `verdictLines=0 ... isNone=true` ✅

### P2-09: filter 规则过少/过宽/解析脆弱

**问题**：规则字段解析用 `id` 非 `ruleId`、规则少、正则过宽（真实发现被误过滤）。

**修复**：
1. 字段名统一为 `ruleId`
2. 扩展到 5 条规则：ABSOLUTE-PATH / RUNTIME-ID / OUT-OF-SCOPE / LINE-LENGTH / MISSING-COMMENT
3. 正则锚点收紧 + 上下文过滤 + 白名单

**落地**：reviewers.yaml L117-134（5 条 ruleId）

**验证**：yaml_check 测试 18/18 ✅；回归输出 `filters=...` 5 条全列出 ✅

### P2-15: 自审场景 Marker 自杀

**问题**：artifact 自身含 PROMPT_MARKER_END 时，之前的 findings 被整段丢弃。

**修复**：
1. 每次 dispatch 给 marker 追加 dispatchId 后缀，避免自审撞 marker
2. 边界 marker 取当前 dispatch 的带后缀版本；兼容旧 dispatch 无后缀版本

**落地**：L650（marker 后缀）、L1423（边界 marker 兼容）

**验证**：afterMarker_short 测试 9/9 ✅（marker 后缀拼接、splitFindings 双 marker 兼容、isPromptContaminated）

### P2-16: topicKey 对 Windows 路径分割错误【原汇总遗漏】

**问题**：按 `\` 切 `D:\TITAN\foo` 产生 `"d"` 键，scope 归并失效。

**修复**：Windows 绝对路径先取 basename（剥盘符目录），再按 `[:\-\/]` 切首段。

**落地**：L2529（P2-16 路径规范化；冻结前审计定位 L2528-2538）

### P2-17: Layer B skeleton 先写空数组【原汇总遗漏】

**问题**：analyze 中途失败时留下 empty conflicts/backlog，误判"未执行"。

**修复**：
1. skeleton 带 status 标记（STEP_A_PLACEHOLDER）
2. analyze 成功完成后覆盖为 COMPLETED

**落地**：L1687（skeleton status 标记）、L2703（成功后覆盖）

---

## Batch C（history/健壮性/架构师，2026-09-30 回写）

### P2-10: 日志/错误静默；dispatch-history 无 parentDispatchId

**问题**：诊断日志失败静默吞掉；history 无血缘字段。

**修复**：
1. 诊断日志失败应告警而非静默吞掉
2. dispatch-history 记录 parentDispatchId，便于追踪连运链

**落地**：L993（P2-10 日志告警）、L1712（parentDispatchId 记录）

### P2-11: SHA256 漂移检查恢复路径缺失/退出码不区分

**问题**：drift 中止不留痕、无重试提示，退出码与常规失败混淆。

**修复**：
1. 中止状态落 history（DISPATCH_ABORTED 行）
2. 明确重试提示
3. 退出码区分 drift（=2）与常规失败

**落地**：L2080（中止状态落 history + 退出码 2）

**验证**：history_retry 测试 10/10 ✅（DISPATCH_FAILED/ABORTED 行不拦截重跑；原子写 tmp+rename）

### P2-12: 并发/原子性/锁不足

**问题**：dispatchId 碰撞、raw 写入失败留下 canonical 空、非原子写。

**修复**：原子写（tmp+rename）+ 利用 mkdirSync 原子性模拟轻量文件锁。

**落地**：L1716（P2-12 原子写 + 文件锁）

**验证**：history_retry 10/10（原子写断言）✅

### P2-13: 架构师注入无二次校验；delta 无 token 预算；窗口跨条

**问题**：注入只确认元素存在、不确认内容落地；delta 超长溢出架构师上下文；600 字符窗口跨 DELTA 条目截断。

**修复**：
1. editorState 复检——读回编辑器内容确认 prompt 落地，未落地不提交
2. delta 按字符/token 预算截断并留痕
3. 窗口按下一个 DELTA id 边界裁切，而非固定 600 字符

**落地**：L2168（token 预算）、L2204（editorState 复检）、L2254（DELTA id 边界窗口）

**验证**：architect 输出 `editorState={"ok":true,"len":444,...}` ✅（复检生效）

### P2-18: --run 与 --review 去重哈希不一致【原汇总遗漏】

**问题**：同一 artifact 两模式产生不同 history 行，跨模式重放绕过去重。

**修复**：--run/--review 统一哈希（均用文本 binary hash）；history 行记录 mode 字段；ABORTED/FAILED 统一 dedup 不拦截重跑。

**落地**：L1715（mode 字段）、L1842（统一哈希 + 模式记录）

---

## 覆盖核对

| 批次 | 项 | 状态 |
|---|---|---|
| Batch A | P2-01/02/03/04/14 | ✅ 已记录（2026-09-28） |
| Batch B | P2-05/06/07/08/09/15/16/17 | ✅ 本回写补齐 |
| Batch C | P2-10/11/12/13/18 | ✅ 本回写补齐 |

合计 18/18，与 `汇总.md` P2 表一一对应。

**回归基线（2026-09-30 复跑，全吻合）**：
- `--analyze 66c0f00e` → conflicts=0 blind_spots=0 consensus=4 complementary=0 backlog=11 deltas=0；verdictLines gemini=6/deepseek=9；filters=5 全列出
- `--analyze _fixture_stest2` → conflicts=0 blind_spots=1 consensus=2 complementary=2 backlog=1 deltas=1
- 冻结哈希：orchestrate.mjs / reviewers.yaml 与 `_freeze/manifest.json` 一致（无漂移）
