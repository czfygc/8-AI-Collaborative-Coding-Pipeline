# TITAN 自动修复流水线合同 v1（草案，待 Director 签字）

- 状态：**已生效（2026-10-02 Director 签字）** —— v1.1 已吸收第二客户端评审（Cline，APPROVE_WITH_CHANGES，5/6 采纳）+ 第7轮实测修正（假红/假绿/错目标绿护栏、红线12/13）+ 第9轮 pin 审计（全位置显式 -m 具体模型 id，见 #11 与 adapters.json）；评审记录见 orchestrator/audit-evidence/contract-review-20261001.md
- 适用范围：§13.6 步骤 ④C / ⑤D / ⑥调参 / ⑦E 的唯一输入；与本合同冲突的旧散文一律以本合同为准
- 生效前置：门禁 gate-v1.1（verify-baseline #5 已收紧 ==0，硬度矩阵 UNEXPECTED=0）已打标
- 关联：orchestrator/adapters.json（草案）、orchestrator/audit-evidence/phase-b-probes-20261001.md、§12 十三缺口

---

## #1 工单 schema（work-orders.json 单条）

必填字段（缺一即视为非法工单，verify-delta 拒绝执行）：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string | WO-<YYYYMMDD>-<NNN>，唯一 |
| source_delta | string | 来源 DELTA-### 及所在 dispatchId |
| status | enum | 见 #2 状态机 |
| owner | string | 修复者客户端/模型（claude/fixer-cline/fixer-opencode） |
| verifier | string | 验证者；**必须 ≠ owner**（M4 硬约束，脚本校验） |
| base_commit | string | 认领时钉死的 40 位 commit；**禁止事后推断 HEAD~1** |
| target_files | string[] | 允许改动的文件白名单；超出即判越界 FAIL |
| anchor | object | {file, pattern, expectHit:boolean, resolvedLine:number|null}；pattern 现场搜索，命中才置 ready |
| instruction | string | 给修理工的最小修复指令（不得包含验收结论） |
| verify_cmd | string | 验证命令；优先只用 node 内置（node --check + 只读解析） |
| verify_cmd_deps | string[] | 依赖声明（如 ["node_modules","env"]）；第 0 步注入，缺失=环境错误 |
| expected_gate_drift | object | 预登记漂移集，默认空 {}；仅 ANALYZER_CHANGE 类工单可非空，**批准工单时 Director 一并签掉** |
| attempt_count | number | 从 0 起；命中三分支之二后清零（见 #10 debug） |
| created_at / approved_at / closed_at | iso8601 | 时间戳 |

锚点规则（G13）：导入时现场解析；未命中 → status=NEEDS_ENRICHMENT，**不进队列**；预期首批 48 条中可观比例进富化队列（写入本合同，试点不得以此为由中止）。

## #2 状态机

todo → claimed → ready → in_progress → verifying → done

硬约束（步3 评审 HIGH 冲突修正）：**工单进入 in_progress 前 owner 必填；进入 verifying 前 owner 与 verifier 必须都非空且互不相等**（导入期允许两者为 null=待派工；verify-delta 对“verifier==owner”直接 BAD_ORDER 拒跑，对“verifying 阶段 verifier 为空”同样拒绝）。
分支态：
- blocked（环境错误 / 人工介入）
- NEEDS_ENRICHMENT（锚点未命中或 instruction 不足；补全后回 ready）
- REJECTED_DEFINITION（delta 与代码不符；打回 Fusion 重写 delta）
- ROLLBACK_PENDING（FAIL×2 且诊断判“修复方案错”后的回滚窗口，未分类禁止自动回滚）
- REBASELINE（FAIL 命中已登记 expected_gate_drift → 重定基线流程，需预登记+已签字）
任何状态迁移必须落 work-orders.json 时间戳与 actor。

## #3 FAIL 二分类协议

- 分类时机：验证者提出，autopilot 执行分类，**Director 只在“批准工单”时一次性签字**（签字前置，不再逐次找人）。
- 两类：
  1. **预期漂移**：FAIL 命中该工单 approved 的 expected_gate_drift → autopilot 直接进 REBASELINE，附重定基线 diff。
  2. **非预期回归**：未命中登记集 → 回滚该修复，保留证据，attempt_count+1；**FAIL 未分类禁止自动回滚**（红线 7）。
- 禁止事后申报漂移集（自我偏袒）；申报只在工单批准前。
- 环境类失败（exit 2、index.lock、依赖缺失）**不计 FAIL**，进 blocked（红线 11）。

## #4 红→绿验收流程

0. **依赖注入**：新建临时树后先注入 verify_cmd_deps（复制/链接 node_modules 等）；注入失败 → 独立错误码 ENV_DEPS，**不许计为 FAIL**（G10）。
1. 双树并行挂载：父树（base_commit）+ 子树（修复后 commit）同时挂载，**不串行 add/remove**。
2. 树位置：**%TEMP%\titan-verify-<wo-id>**，禁入主仓（防污染 git status）。
3. **双命令语义（试点开工时钉死）**：
   - `verify_cmd` = 回归门禁：**两树都必须 PASS**；父树 FAIL = 基线本身破了 → 交 #3 分类。
   - `target_cmd` = 新断言（断言“修好之后的状态”）：**父树必须失败（红）、子树必须通过（绿）** —— 这才是红→绿证据。父树即绿 → TARGET_NOT_RED（断言写错/已被满足，不算修复）；子树仍红 → TARGET_NOT_GREEN（修复没生效）。
   - 两者缺一不可用于“新断言类”修复；纯回归修复可省 target_cmd（退化为两树同跑 verify_cmd）。
4. 越界检查：git diff --name-only 必须 ⊆ target_files。
5. 通过后写 evidence：命令、退出码、diff 摘要、树路径清理记录。
6. 全部 git 写操作带**锁重试退避（3 次 × 2s）**；index.lock 冲突归环境错误（G14/红线 11）。
7. **修理工必须在隔离分支上工作（步5 冒烟发现）**：修理工从 base_commit 拉出 fix/<wo-id> 分支（独立 worktree），verify-delta 的 --child 必须指向该分支头 —— 否则 base..child 会包含共享主干上他人提交，越界检查（BOUNDARY_VIOLATION）必然误报。边界只判“修复分支自身”的改动。
8. **门禁变更必须跑硬度矩阵（步3 评审 MEDIUM 冲突修正）**：任何对 verify-baseline*.mjs / 门禁白名单的改动，合并前必须先跑 `node orchestrator/verify-baseline-mutation.mjs --legacy <旧版> --report <路径>`，要求 UNEXPECTED=0，报告入库（A′ / gate-v1.1 流程常态化为合同条款）。

## #5 修理工 prompt 模板

'''
[工单 WO-xxxx | base_commit <sha>]
你在只允许改动 {target_files} 的约束下修复以下问题。
锚点：{file} 第 {resolvedLine} 行附近，匹配模式：{pattern}
指令：{instruction}
禁止事项：不得修改白名单外文件；不得改门禁/审计基线文件（汇总.md、FREEZE_RECORD、verify-baseline*.mjs）；不得 git push；不得改写历史。
完成动作：本地提交，提交信息严格为 [T-xx] type: 描述（type ∈ feat/fix/docs/chore/refactor/test）。
字段冒号统一用全角“标题：”“位置：”等（与 extractFinding 兼容）。
'''

## #6 验证者 prompt 模板

'''
[验证工单 WO-xxxx | 你是 verifier，owner={owner}]
先自检：若 owner 与你（本验证者）是同一客户端/模型，立即输出 BAD_ORDER 并退出，不得继续（M4）。
输出：
1) 红→绿结论：父树 verify 退出码 / 子树 verify 退出码（引原样输出片段）
2) 越界检查：改动文件清单 vs target_files
3) FAIL 二分类建议：预期漂移(需引用 expected_gate_drift 键) / 非预期回归 / 环境错误(给错误码)
4) 判定表：| 条目 | 判定 | 简要理由 |（**不要复制示例行内容，示例仅说明格式**）
只读：不得修改任何文件。
'''

## #7 B→池组成决策矩阵（已由步1 填格，此处为裁定版）

| 席位 | 裁定 | 依据 |
|---|---|---|
| 修理工 A | Cline 3.0.67（cline/openai-compatible → Freellmapi pin 模型） | 探针2 实测 PASS |
| 修理工 B / debugger | OpenCode（需 opencode-windows-x64 显式安装 + 禁 push + timeout 包装） | 探针1 实测带条件可用 |
| 守门人 gate3 | Cline 只读（auto-approve=true + 指令约束 + 事后指纹校验） | 探针5 实测 PASS + 指纹零变化 |
| 第 4 reviewer 席 | Freellmapi 内异模型（mistral/nemotron 系，pin 模型） | G15(a) |
| architect | ChatGPT 专席，不兼任 reviewer | G15 |
| 底线 | ≥1 修理工 + verify-delta 自动执行 + Director 复核即可运转；2+2 是吞吐优化 | G11 |
| 探针4（OpenCode 诊断） | **已实测可用（第3轮首跑 PASS）**：--format json 输出 NDJSON，结构化结论 {branch, evidence: file:line, reason}，分支命中 REJECTED_DEFINITION 且 evidence 指向真实行；只读（repo 干净）。FAIL×2 → 用该结论按三分支分流 | orchestrator/audit-evidence/autopilot/round3-probe4-parallel-20261001.md |

## #8 共享文件单写者表

| 文件 | 唯一写者 | 说明 |
|---|---|---|
| orchestrator/work-orders.json（工单队列，按 M5 归 orchestrator/ 不放根目录） | autopilot | 队列状态唯一写者 |
| ISSUE_REGISTRY.json | Director/人 | 只记批次级 T-xx；客户端只在认领时写自己的条目 |
| 门禁白名单（verify-baseline*.mjs 等） | feat 分支流程 | 任何改动必须走 A′ 式分支+硬度矩阵 |
| adapters.json | 合同流程（步3/步6） | 运行时不改 |
| reviews/** 产物 | dispatch 流程 | G12：timestamp churn 不入库 |

## #9 预算、归档与 golden bootstrap

- 预算：每日 dispatch 上限与 token 上限 —— **数值待步6 调参填入（本草案留空，null=未定）**；CDP 通道每日上限单列。
- 归档布局：evidence 统一进 orchestrator/audit-evidence/<主题>-<日期>.md，单文件 ≤ 200KB，超限拆分。
- golden bootstrap（G8）：新通道首个 dispatch → 人工过目输出 → 当场钉为该 dispatch 期望值（登记进 _session_memory.md §2 附录）→ 此后才可自动 PASS/FAIL。**未完成 bootstrap 的 dispatch，verify 输出只能是 UNVERIFIED，不许判 FAIL。**
- **运行产物大小上限（步3 评审现场实测追加）**：任何 CLI 运行输出落盘硬上限 50MB，超限即截断并告警；未截断前禁止无人值守跑 --json 长任务。实测教训：一次 cline --json 评审写出 7.86GB（accumulated 事件重复累积），当时 C 盘仅剩 244MB —— autopilot 必须带 size cap 与磁盘水位检查（<1GB 暂停调度）。

## #10 守门人检查项与放行规则（gate3）

- 位置：verify 之后、merge 之前；**只读，只出报告**，由 autopilot 按规则阻塞/放行（守门人改文件=四权分立破，红线 10）。
- 检查项：AGENTS M1–M8 + SHARED_GIT_WORKSPACE_GUIDE 规则 1–9（重点：规则四密钥不入库、规则五运行目录、规则六 index.lock、规则八行尾编码、规则九根目录）。
- 范围两档：diff 模式（本批次改动 → **阻塞**）为主；全仓模式（存量违规 → **只报不阻塞**）。
- **打标纪律（Director 2026-10-02 ⑦批复核指令1）**：任何 gate tag 必须**先复核判据、后打标**；先打后复核即使事后全过也属流程违规，台账记一笔。（gate-v2 追认：四判据复核全过。）
- **扩容期门禁不松（复核指令5 + 2026-10-02 紧急升级）**：每批必跑 verify-baseline **11/11**（gate-v3 新增 #11 `orchestrate.mjs` 语法项 —— d8aac99 事故证明 10/10≠语法绿）；跌破即**停批回合同**，不得带病续批。
- **“本批次”的定义（gate3 首跑改判后钉死）**：diff 模式只认**指定 commit 区间**（如 694d7d8..HEAD）内本方提交；git status 里他方未提交改动与工作区存量一律归“只报不阻塞”档，禁止计入 FAIL。首跑实测：守门人把他人 HARNESS 删除算进阻塞 → 改判 PASS（证据：orchestrator/audit-evidence/autopilot/gate3-20261001.md）。
- 放行条件：diff 模式 0 违规；出现违规 → 输出条目+证据，autopilot 阻塞并把工单推回对应状态。
- 运行方式：cline --auto-approve true + 只读指令约束 + 事后主树 git status 指纹比对（SHA256，探针5 已验证）。
- FAIL×2 的 debug 三分支（autopilot 解析守门人/诊断输出）：
  - 「delta 与代码不符/锚点错」→ REJECTED_DEFINITION 打回 Fusion
  - 「修复方案错、真因在别处」→ 回 fixer，改写 anchor/instruction，attempt_count 清零
  - 「无法定位」→ blocked 交人

## #11 路由表与降级规则

- 路由是**运行时决策**（channel:auto，每 dispatch 现算），不是模型属性；映射见 orchestrator/adapters.json。
- 顺序：api → cdp → unavailable。api 失败（超时/4xx/额度）降 cdp；cdp 失败置 unavailable（不阻塞整单）。
- 有效下限：≥2 家 reviewer 成功，否则重试或标 DEGRADED。
- **判定值字面量强制（步5 第2轮实测追加）**：判定值只能是大写 PASS / FAIL / CONDITIONAL；中文同义词（合格/不合格/不适用）会让 extractVerdictLines 解析成 0 行 → analyze 静默降级。审阅与验证 prompt 模板必须写死该约束（实测：不写→0 行，写→2 行）。
- 已验证 pin 模型清单见 adapters.json（mistral-code 可用；glm-5.3 不产表不可用；gemini-2.5-flash 429、deepseek-chat 503 → 降级 cdp；mistral-medium-3.5 与 nemotron-3.5-lightning 不在 /v1/models）。
- **4 席框架的两档判据（Director 2026-10-02 裁决1）**：
  - API 侧判据 = 3 席两两字面 Jaccard=0 + 语义共享簇低 → **API 3 席保留**（本批实测满足：Jaccard 全 0、共享簇 3 个/独有率 15%）；
  - CDP 侧判据 = T-06 已验证 + grok/chatgpt **best-effort 参与（缺席不阻塞）**；
  - 两者合并为“4 席框架”，**两档验证相互独立：不得用 API 3 席的数据推 CDP 席的结论**（grok 席不跑 CDP 补测，也不得被 API 结论背书）。
- **验证者席规则（裁决 3 采纳）**：某席连续 2 轮 0 独有发现 → 降级为“验证者席”（参与共识投票、不占发现者多样性配额）；连续 3 轮 0 独有 → 换模型（席位保留）。**硬约束：验证者席不计入 #11 的“≥2 家 reviewer 成功”独立性下限** —— 若 2 家里有 1 家是验证者席，实际独立发现者只有 1 家，判为不满足下限（须标 DEGRADED 并补第三家）。
- **deepseek 席 DEGRADED 状态（裁决2）**：进 ⑦ 首批标记 DEGRADED（codestral 顶班）；**门禁不因 DEGRADED 放宽**，计“在场但降级”而非缺席；Director 补不同组织 key 后立即复算替换（见 adapters.reviewers[deepseek]）。
- **输出格式合规门槛（Director 2026-10-02 前置条件3，4 家对照实测 2/4 不合规）**：单个 reviewer 输出必须同时满足 (a) ISSUE 块结构（ISSUE-ID 行 + 标题/位置/严重程度/建议 字段行）≥1 条，(b) 判定表 ≥2 行且判定值为大写 PASS/FAIL/CONDITIONAL；不满足即记 **FORMAT_NON_COMPLIANT**，该家当轮按 unavailable 处理（不计入 ≥2 家下限、不参与共识），并触发“换模型或加压 prompt”修复项；连续 2 轮不合规 → 该模型从 adapters.json 摘牌。
- 输出契约：判定表分隔符锁定 “或制表符（extractVerdictLines 两者都容，探针3 实测）；**禁止 model=auto 做 reviewer 路由**（实测落 codestral-latest，破坏独立性），必须 pin 模型 id。作用域说明（Director 2026-10-02 pin 审计，**取代**旧豁免）：**所有位置（reviewer / 修理工 / 守门人 / 诊断）一律显式传 -m 具体模型 id，禁止 auto、禁止依赖客户端配置缺省**；强档 pin 见 adapters.json model_policy（gemini-3.7-flash / deepseek-v4-pro / claude-sonnet-5）。独立性仍按“客户端×模型”两级判定（G11）：同一单内守门人模型必须不同于修理工模型。
- prompt 模板禁止放可照抄的判定表示例（探针3 实测回声缺陷）。
- CDP 每日上限：ChatGPT/Grok 默认 best-effort（缺席不阻塞），数值待步6。

---

## 红线累加（合同生效即全部适用）

1–6 见 §10.5；7. FAIL 未分类禁止自动回滚；8. 无红→绿证据的工单不进 verifying；9. 锚点定位失败禁止硬改（回 NEEDS_ENRICHMENT）；10. 守门人不得改文件（只读）；11. index.lock/依赖缺失等环境错误不计工单 FAIL。
12. **（2026-10-02 事件后新增）修理工/守门人 CLI 必须在完整克隆或只读副本内运行，禁止以共享主仓为 cwd。**
13. **（同上）修理工禁用 git checkout -- . / git restore . / git stash / git reset --hard / 跨仓 git；只允许在隔离树内 add+commit。autopilot 派工前后各记一次主仓指纹，指纹变化 → 立即中止本轮并上报，不自动恢复。**

### 假红与弱绿护栏（步5 实测追加）

- **假绿（第7轮演练发现）**：verify-delta 的 verify/target 命令必须注入 env D_TITAN_ROOT=<树路径>，否则 verify-baseline 会去读主仓产物 → 子树漂移看不见（演练首轮假 GREEN 的根因，已修复）。
- **假红（G10）**：verify/target 输出命中 Cannot find module 或 MODULE_NOT_FOUND → 判 ENV_DEPS（环境错误），不计 FAIL/BASELINE_BROKEN（verify-delta 已实现；044 首跑因临时树缺 node_modules 被误判 BASELINE_BROKEN 即此坑）。
- **弱绿**：target_cmd 只断言“非空”会让非法实现（如 selector 带反斜杠）也变绿。断言必须覆盖**实现有效性**（044 第2轮改为：非空 + 无反斜杠 + 形如合法 CSS 前缀）。弱绿导致的合入按红线 7 走回滚并计入回滚率。
- **第三类失败：错目标绿（wrong-target green，047 实测）**：target_cmd 是照 delta 写的，若 delta 本身错（汇总 P3-14 称 if(!report) 恒真，实际 report 由 let report='' 初始化、该守卫是唯一加载点），断言会把错误目标固化成“绿”。护栏：**claim 之后、派工之前必须做 delta 定义核对（读代码验证 delta 声称的事实）**；核对不过 → 直接 REJECTED_DEFINITION，不派修理工。047 若走此步可省 13 分钟与 2 次干预。
- 诊断 prompt 必须给**精确相对路径**（orchestrator/orchestrate.mjs），否则 opencode 回报 BLOCKED/file:not_found（047 首跑实测）。

### 试点统计口径（进 ⑥ 前置，Director 2026-10-02 指定）

1. **delta 定义核对是硬步骤**：claim 之后、派工之前完成，核对不过直接 REJECTED_DEFINITION（不派修理工）。
2. **诊断 prompt 必须带精确相对路径**（047 两次对照实测：无路径→BLOCKED/not_found，有路径→REJECTED_DEFINITION+真实 file:line）。
3. **四数按类型分桶统计，禁止混桶平均**：简单（改单条配置/正则/死代码）｜ 中等（跨函数逻辑）｜ 分析器级（改 runAnalyze 输出，会触发门禁漂移与 FAIL 二分类）。进 ⑥ 的门槛 = 3 单 + ≥1 单分析器级（P1-11），而非“凑满 3–5 单”；平均周期必须分桶报（当前简单桶 5min、中等桶 13–40min，混平均=19min 是误导）。
- 事件记录：orchestrator/audit-evidence/autopilot/incident-fixer-scope-20261002.md；试点进度：orchestrator/audit-evidence/autopilot/pilot-progress-20261002.md。

## 签字栏

- 单一主笔：deepseek-harness —— 已起草（本文件）
- 第二客户端评审：Cline 3.0.67 headless（2026-10-01）—— APPROVE_WITH_CHANGES，6 条发现 5 采纳 1 误报（详见评审记录）
- Director 签字：**已签（用户 2026-10-02 会话内确认：“合同 v1.1 我签字”）** —— 生效；批准后进入 ⑦ 扩容需再审批一次 ⑥ 输出

---

## ⑦ 首批质量清单（Director 2026-10-02 三段指令之③，修后验证期生效）

1. 全部工单 verify_cmd 统一附 `node --check <改动的.mjs>`（045 已示范，批量补齐）——语法类缺陷从事故驱动转标配。
2. 对照统计工具（字面 Jaccard/独有率/归簇）收编为带自测的单一脚本，禁手搓 regex（25%→15% 教训）。
3. 修理工绝对路径写入残留风险：三层软防线已就位，OS 级 ACL 列为已知未做项（诚实入账）。
4. 干预归因拆分进⑥：区分[我方机制留洞]与[模型不干活]，调参才不失真。
5. 审阅工作流复用 汇总.md 已验证经验：8 模型只查不改、命名归档；修复用 deepseek-v4.1-flash/glm-5.3；Gemini 2.5 Flash 审查；与网页 deepseek/gemini 结果合并去重。
6. 启动条件：jev 池分类修复经 verify-jev-pool.mjs PASS + 观察窗口（见 routing-fix-20261002.md）后，新会话开⑦。

