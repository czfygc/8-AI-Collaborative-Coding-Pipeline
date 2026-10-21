# Multi-AI Collaboration Pipeline — 贡献者与 AI 代理协作规则（公开版）

> **English summary**: One ledger for all work; file-ownership partitioning so parallel agents never collide; the author never verifies their own change (a second agent must); evidence is graded (first-hand / self-reported / unverified) and never inflated; delivery is gated in three independent stages (code → artifact → release) — passing one never implies the next; any task card states its scope, acceptance criteria, out-of-scope items and required evidence. Secrets never enter URLs, command lines or files. Keep secrets in environment variables.
>
> 本文件是**公开版**：只写"任何人都能照做"的规则，不含本机路径、内部账号与运维细节。
> 本机内部宪法与发布同步账本留在各自私有仓，不随本仓库分发。

**工作区**：`<workspace>`（你的克隆目录） ｜ **分支**：`main` ｜ **台账**：`ISSUE_REGISTRY.json`（本仓不发布，见下文"不随本仓分发的内容"）

---

## 1. 单一台账（Single ledger）

- 所有任务进 `ISSUE_REGISTRY.json`；**认领 = 提交**（先到先得）。
- 状态机：`todo → claimed → in_progress → verifying → done`（或 `blocked`）。
- 开工前三步（强制顺序）：
  1. 同步他人提交（`git pull --rebase`）；
  2. **读台账**：确认目标为 `todo`、目标文件无人 `in_progress`；撞单就换任务，**不许硬上**；
  3. **认领**：改台账（`status=claimed` + 填 `owner`）并**提交**。
- 台账写入走 `orchestrator/edit-issue.mjs`（自动处理 JSON 转义/逗号/括号/时间戳，并内置**高风险写确认闸**），**不要手工编辑 JSON**。

## 2. 文件所有权分区（并行不打架）

- 每单在台账 `files` 里写明**自己独占哪些路径**；两单的路径集**不得重叠**。
- 共享文件（台账 / `AGENTS.md` / `orchestrator/verify-gate.mjs` / `orchestrator/test/SUITES.md` / CI）**只归协调者**。
- 委派只交**文件**，不做 git 写操作；由协调者统一集成、过闸、提交。

## 3. 作者 ≠ 验证者（Author ≠ verifier）

- **修的人不许自己验收**。重要改动必须由**第二个代理/客户端**复核：回归命令 + 原始输出作为证据，并回填台账 `verifier` 与证据位置。
- 分歧以**验证输出**为准，不靠辩论。
- 复核者可以是被协调者后台调用的另一客户端；**驱动可以是自己，判定必须出自对方**。

## 4. 证据分级（Evidence grading）

台账 `evidence_level` 三档，**亲验与自报不可混**：

| 值 | 含义 |
|---|---|
| `firsthand` | 独立客户端/云端实跑亲验（可作为交叉验证结论） |
| `local_report` | 本地执行端自报（作者自己跑的结果，未被第二方复核） |
| `unverified` | 未验证（默认） |

- `cross_validation = PASS` **只能**配 `evidence_level = firsthand`。
- 结论必须贴**原始输出**，不许用推理代替证据。

## 5. 一次修正后停止（One fix, then hand off）

- 作者自己改到**第 2 轮**还没过 → **必须移交他人**（`fix_rounds > 1` 时台账校验会要求 `verifier ≠ owner`）。
- 交接不是甩锅：交接时把"已试过什么、失败在哪一步、怀疑什么"写进台账。

## 6. OUT_OF_SCOPE（禁止事项）

- 任务卡必须写明**禁止事项**；命中禁止事项**立即停手回报**，不许"顺手改了"。
- 越界修改的典型代价：把内部台账、实例记忆或机器路径带进公开产物。

## 7. 阶段语义（代码 / 产物 / 发布 三段独立）

> **代码通过 ≠ 产物通过 ≠ 发布完成。**

| 阶段 | 判什么 | 工具 |
|---|---|---|
| `code` | 代码 → 审查 → 修复 → 验证 → 收口 | `node orchestrator/verify-gate.mjs` |
| `artifact` | 产物清单一致 + 第三方许可证署名 | `node orchestrator/artifact-gate.mjs verify-manifest` / `license` |
| `release` | 匿名可下载 + 校验和 + 公开可见 | `node orchestrator/artifact-gate.mjs anon-download` |

- 后段 PASS 而前段 FAIL = **矛盾**（判 FAIL）；前段**未判**（UNKNOWN）时后段 PASS 只能算 UNKNOWN。
- `UNKNOWN`（显式未知）**不等于通过**——这是本项目的硬规矩：不存在的数据就是 UNKNOWN，绝不填 0 或默认值凑数。

## 8. 任务卡（YAML 四段式）

任务卡四段，缺一不可（台账 `task_card` 字段）：

```yaml
scope:            # 做什么（逐条编号、可验证）
  - "..."
acceptance:       # 做完怎么算过（逐条给命令）
  - "node --test ... 全绿"
out_of_scope:     # 明确不许碰的（命中即停手回报）
  - "不许改台账既有字段语义"
evidence_required:  # 交什么证据（贴原始输出，不许复述推理）
  - "原始输出落 archive/evidence/<T-xx>/"
```

渲染与检查：`node orchestrator/task-card.mjs <T-xx>`（退出码 0=无问题 / 1=有问题）。

## 9. 任务分档与模型分档（省配额、强弱搭配）

- **任务档**：`mechanical`（机械/批处理）/ `bounded_code`（边界清晰的实现）/ `architecture`（架构与协议）/ `review`（只读挑错）/ `long_run`（长任务）。
- **模型档**：`light` / `medium` / `heavy`。
- 铁律：①**可验证性优先于能力**——低档模型只干"错了一定会被机器立刻抓住"的活（测试/正则/计数/schema 可判定）；②低档不许单独改行为；③**额度按稀缺度消耗**——优先派额度不受限的通道，把账号级日限额的通道省给强档；④**降档不反向**。
- 健康视图与推荐序：`node orchestrator/model-health.mjs --task mechanical`（探针 + TTL 缓存；UNKNOWN 不当可用也不当不可用）。

## 10. 体量纪律（单文件 50 KiB 拆分线）

- 适用：可执行源码；不适用：文档、数据、`node_modules/`、构建产物、一次性草稿。
- 拆分线 **51200 字节**：超线即触发拆分义务（立即冻结"只减不增"，并登记拆分计划）。
- 机械执行：`orchestrator/verify-gate.mjs` 的体量闸（`SIZE_LEDGER`）——任一超线文件增长、或出现未登记的新超线文件 → 闸门 FAIL。

## 11. 安全与密钥

- 密钥**永不进 URL、不进命令行、不进仓库文件**；用环境变量或已被 `.gitignore` 排除的密钥文件（如 `titan_secrets.env`）。
- **永远不要**用 `git add -f` 强行加入敏感文件。
- 安装底线：①尽量工作区内安装，不动全局环境；②只从官方源下载并核对校验和，**禁止** `iex (iwr …)` / `curl | bash`；③装完写记录并提交。
- 禁手：`git reset --hard`、`git clean -fd`、`git checkout -- .` 默认禁用（会抹掉他人未提交的工作）；永不重写历史；审计/基线文件只读不改。

## 12. 验证与收口

```powershell
node orchestrator/verify-gate.mjs        # 语法+导入+CLI+测试+自检+体量（提交前必跑，全绿才允许提交）
node orchestrator/skill-quality.mjs --strict
node orchestrator/task-card.mjs <T-xx>   # 任务卡纪律检查
node orchestrator/artifact-gate.mjs --help
```

- 提交信息格式：`[T-xx] 类型: 描述`（类型取 feat/fix/docs/chore/refactor/test）。
- 小步提交，一个提交只做一件事；只暂存自己的文件。
- **不许结束时无故不结账**——收尾必须完成：验证 + 台账 + 提交 + 结论落盘。

## 13. 不随本仓分发的内容（禁推清单）

以下属于**私有工作区资产**，任何情况下不进入公开产物：

- 内部台账与审计基线（`ISSUE_REGISTRY.json` 类、工作单、审计证据目录、汇总/计划类文档）；
- 实例记忆（`titan-memory/core/CORE.md` 与 `titan-memory/notes/`）；
- 内部 SOP 技能与发布同步账本；
- 运行期数据与本地产物（`reviews/`、`archive/`、`tmp/`、`design-specs/`、`*.log`、浏览器 profile、代理与节点配置、私有子仓）。

分发前用闸门自检：`node orchestrator/artifact-gate.mjs license --root .`（第三方署名）与 `verify-manifest`（清单一致）。

## 14. 许可

本项目以 **Apache License 2.0** 发布（见 `LICENSE`）；第三方组件署名见 `NOTICE`。
