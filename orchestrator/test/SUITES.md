# T-56 W7 测试套件清单（orchestrator/test/）

> 收敛标准（计划 W7）：七大 suite 全部有单测文件；verify-gate 五段（syntax/import/CLI/test/self-check）
> 全绿才算过闸；meta-test 四炸弹（ESM require / TDZ / 无限递归 / 注入模板引用泄漏）每闸必跑。
> 运行方式：`node --test orchestrator/test/`（verify-gate ④ 测试闸自动执行，0 用例视绿）。

| Suite | 测试文件 | 覆盖（回归债） |
|---|---|---|
| cdp-client | cdp-client.test.mjs | connect() URL 保持 ws / onerror 非 RangeError / onopen / 重试上限 / 尝试级超时（C-01, DELTA-027/034） |
| orchestrate-helpers | send-check-expr.test.mjs, scan-args.test.mjs | sendCheckExpr 无裸标识符 + vm 行为等价（S-01）；forceLocalOnly 三组合（C-03） |
| scan-filter | scan-triage.test.mjs | 占位符/纯重构/建新文件默认拦 + --allow-* 放行（W4 分诊） |
| markers | markers.test.mjs | 后缀机制 / 无后缀兼容 / contaminated 三态 / splitEndMarkers（M-17） |
| titan-sanity | file-sanity.test.mjs | 协议标记入文件 / 体积减半 / node--check / JSON / import 冒烟（P-01/P-19 护栏） |
| autopilot-statemachine | autopilot-ferry.test.mjs, lock.test.mjs, cleanup-batch.test.mjs, titan-execute-w6.test.mjs | fixer 摆渡 NEEDS_FIX 步骤序（S-06）；单写者锁 wx/死锁清理/锁内重读比对（S-09/S-10/M-07）；PID 三重校验（S-12）；超时退避链 + BLOCKED 记账 + PROOF 强证明（P-11/P-12） |
| registry-paths | registry-paths.test.mjs, check-file.test.mjs, decision-api.test.mjs, already-resolved-proof.test.mjs | canonical work-orders 路径（S-07）；verify_cmd 扩展名分派（S-11）；decision-api 启动（C-02）；PROOF 逐字校验 fixture |
| output-sandbox | output-sandbox.test.mjs | T-145 工具输出沙箱：落盘字节+sha256 回读、摘要预算上限、错误/告警信号、按需检索、ledger 节省聚合、CLI 只回摘要 |
| skills-frontmatter | skills-frontmatter.test.mjs | T-146 技能元数据：目录名=frontmatter name、description 长度、五个工程技能在位、MIT 来源标注、工作流索引与 M1-M7 分工；T-155 起全量强制 frontmatter + version/requires/tests/provenance 四字段 |
| skill-quality | skill-quality.test.mjs | T-155 技能质量门：校验器规则（缺 frontmatter/坏 semver/name 不符/空 requires/shell 元字符/测试文件不存在/provenance 缺 ref/description 越界）、夹具目录计数、仓内 19 技能全绿回归、CLI 退出码 |
| run-events | run-events.test.mjs | T-153 Run 事件账本：run_id 形态、事件链 seq 递增、只追加、非法 run_id 拒写、payload 脱敏（密钥打码+长文本截断）、list 倒序、prune 保留策略、坏行不炸链 |
| test-runner | run-tests.test.mjs | T-161 共享测试运行器：框架探测（vitest/jest/npm-test/pytest/node:test/探测不到）、命令构造（含 last_failed 变体）、输出解析（node spec+TAP / vitest / jest / pytest）、退化安全（解析不到不谎报通过）、target 白名单拒危险串、实跑红/绿两态、CLI --json 与人读摘要、输出长度上限（省 token） |
| verify-profiles | verify-profiles.test.mjs | T-164 R4 verify 命令注册槽：配置结构、语言→profile 映射、扩展名推断、UNKNOWN 传播（缺 profile/缺能力/未知语言三种）、node/python syntax 实跑 PASS/FAIL、python 档不写 __pycache__（不污染被检仓）、CLI 退码 0/1/3 与用法错 2、pytest 禁 cache 环境、无 shell 元字符 |
| repo-scope | repo-scope.test.mjs | T-167 R7 目标仓范围：仓库根判定（不存在/非目录/无标记拒；.git 与 AGENTS.md 过）、越界判据 DELTA-012（根内真/根外假/.. 穿越假）、目录目标展开（取源文件/跳噪声目录/上限截断）、单文件原样返回、标记清单含 AGENTS.md（D:\V8 靠它通过） |
| lineage | lineage.test.mjs | T-165 R5 产物血缘：stage 枚举校验（合法/非法/空→null/大小写）、project 字符集校验、仓名派生（D:\V8→V8）、读取端容错（老产物无字段跳过不报错）、stage/project 组合筛选、CLI 单查与过滤 |
| intent | intent.test.mjs | T-166 R6 意图落盘：代码枚举与 design-specs/intent.schema.json 一致（防漂移）、机器人三档模式→intent 映射、非法 intent 抛错、字段名与 schema 一致、长文本截断 + 疑似密钥打码、落盘文件名带 epoch ms、内容回读、列表倒序、坏文件不炸 |
| pipeline-stage | pipeline-stage.test.mjs | T-162 R1 生命周期编排：阶段目录名与顺序（stage-01-design…stage-04-deliver）、产物字段沿用 R2 冻结名 + 追加 evidenceLevel/notes、非法 evidenceLevel 拒、四阶段各落产物（implement 只出执行单不改业务文件）、--pipeline 串链四阶段 + evidence.json、缺需求退 2 / 无 pipeline 退 1、CLI --design 跑通 |
| skill-manifest | skill-manifest.test.mjs | T-151 技能 manifest：provenance 拆解（original/adapted/vendored/非法）、条目生成（name/slug/version/source/sha256/treeSha256/entrypoints）、readOnly 默认 true + write:true 才 false、manifest 生成（只含带 SKILL.md 的目录、按名排序）、差异比对（新增/变更/移除/未变）、apply 落盘 + CAS 期望哈希不符显式冲突、并发写冲突显式失败且不覆盖他端内容、verify 一致性校验、仓内 20 技能与磁盘一致、CLI status/build/apply/verify |
| write-gate | write-gate.test.mjs, write-gate-integration.test.mjs | T-153 高风险写闸：目标分类（宪法/台账/密钥/发布树/普通）、提案不落盘、未确认拒写、显式+attested 两种确认、TOCTOU 拒写、密钥只记账；接入点 edit-issue（attested/--defer）、safe-write（高风险拒写/--confirm 放行）、run-gate CLI（apply 前置确认、reject） |
| diagrams | diagrams.test.mjs | T-147 图表文档：三张图在位、自包含离线（无脚本/图片/远程字体）、aria-labelledby 可解析、title 为 svg 首子元素、索引齐全 |
| persona | persona.test.mjs | T-141 Persona：四层优先级（force > session > global > system）、[%None] 清除不穿透、未知 ID fail-closed、system 段末尾注入 + temp 标记 |
| task-card | task-card.test.mjs | T-171 任务卡纪律：证据分级枚举（firsthand/local_report/unverified，非法值显式抛错）、阶段枚举与阶段结果（code/artifact/release × PASS/FAIL/UNKNOWN）、任务卡字段白名单（未知字段/非数组显式抛错）、fix_rounds 非负整数、阶段语义矛盾（产物 PASS 但代码非 PASS / 发布 PASS 但产物非 PASS）、done 要求代码段 PASS、交叉验证 PASS 必配 firsthand（亲验与自报不可混）、一次修正后停止（fix_rounds>1 未移交他人报 issue，已移交放行）、历史条目缺分级只报 warning、YAML 任务卡渲染→解析往返（含中文/引号/冒号）、CLI 单条/--all/不存在退码 0/1/3、edit-issue 集成（新字段落盘 + 非法值退 2 不落盘） |
| model-health | model-health.test.mjs | T-172 模型健康注册表 + 分档派单：分档表结构校验（id 不重 / tier 合法 / 任务档位有 rule+acceptance）、探针四态（200+tool_calls → healthy / 200 无 tool_calls → tools=false / 429 → down / 缺 key 与超时 → unknown）、TTL 缓存（二次不重探、超 TTL 失效）、健康判定（healthy/stale/down/unknown）、派单建议（mechanical 优先 light 且同档内不限量平台优先 / down 与无 tool_calls 被排除 / architecture 只给 heavy）、渲染与 CLI（--no-probe --json 离线、未知档位退 2） |
| supervisor | supervisor.test.mjs | T-173 常驻子进程监督器：job 规范校验（id/command/restart/max_restarts/env 白名单拒密钥）、清单 upsert/list/remove、子进程 env 只传白名单、守护循环重启策略（never 不重启 / on-failure 仅失败重启 / always 重启）、真实子进程拉起与心跳状态、移出清单即杀、计划任务 install/uninstall 成对可用（Windows）、状态原子写盘、CLI add/list 往返 |
| artifact-gate | artifact-gate.test.mjs | T-175 产物级闸门四件套：①artifact-manifest（文件+大小+SHA256、字典序、指纹稳定、默认排除 node_modules/.git、missing/mismatched/extra 三类问题）②license-notice-check（NOTICE 解析 "<pkg>@<ver> <LIC>"、无依赖免 NOTICE、有依赖未署名 FAIL、禁用许可证 AGPL FAIL、许可证标识缺失 UNKNOWN、python requirements.txt 档、gui/installer 本期未实现 UNKNOWN）③anon-download-verify（页面/发布页/HEAD 302/完整下载+哈希字节/私有仓 404；哈希不符 FAIL、网络异常与缺期望值 UNKNOWN）④stage-gate（三段独立 PASS；前段 FAIL 而后段 PASS = 矛盾 FAIL；前段未判 + 后段 PASS = UNKNOWN；任一 FAIL → FAIL；未判 → UNKNOWN）、CLI 往返与退出码 0/1/2/3 |

特别项：
- gate-meta.test.mjs（四炸弹沙箱护栏证明，每次过闸必跑；沙箱 tmp/gate-meta 自建自清理）
- 端到端三件（不需常驻设施即可跑）：w3-web-smoke（需 CDP 9222，手动）、verify-gate CLI 冒烟段（自动）、landmine 沙箱（titan-execute-w6，自动）

统计口径：`node --test orchestrator/test/` 的「tests N / pass N / fail 0」；任何 fix commit 必须携带 ≥1 新测试（回归账本 R1）。