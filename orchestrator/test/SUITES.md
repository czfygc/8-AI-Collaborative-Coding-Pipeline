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

特别项：
- gate-meta.test.mjs（四炸弹沙箱护栏证明，每次过闸必跑；沙箱 tmp/gate-meta 自建自清理）
- 端到端三件（不需常驻设施即可跑）：w3-web-smoke（需 CDP 9222，手动）、verify-gate CLI 冒烟段（自动）、landmine 沙箱（titan-execute-w6，自动）

统计口径：`node --test orchestrator/test/` 的「tests N / pass N / fail 0」；任何 fix commit 必须携带 ≥1 新测试（回归账本 R1）。