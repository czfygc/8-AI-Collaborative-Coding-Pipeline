# TITAN_ARCHAEOLOGY 多客户端协作规则（必加载，自包含）

> 本文件 `AGENTS.md` 被四客户端（deepseek Harness、OpenCode、Cline、Kilo Code）**每会话自动加载**。
> **自包含声明：遵守本文件全文即合规。** `SHARED_GIT_WORKSPACE_GUIDE.md` 是原理与示例参考层，`ISSUE_REGISTRY.json` 是任务台账——两者被本文件"挂载"（见 M0），而不是"不读就违规"的前置条件。
> 修订本文件 = 修宪，必须提交。

**工作区**：`D:\TITAN_ARCHAEOLOGY` ｜ **分支**：`main` ｜ **仓库**：四客户端共用同一个 `.git`

## M0 挂载机制（后两层如何被强制，不成孤立文件）

- **规范层（共享指南）**：OpenCode 经 `opencode.json` 全量自动加载；Cline/harness 以**本文件内联的完整程序（M1–M7）**为准，指南仅作"为什么+示例"的参考。——本文件自包含之后，不读指南也不影响合规。
- **状态层（台账）**：运行时状态文件不做静态全量加载（会无限膨胀）；挂载方式是**行为强制**：M1 规定任何改动开工前必须读台账并认领。未认领动工、撞单改同一文件，以提交历史为证，事后可审计。
- **兜底**：M4 开工自检 + 台账提交历史。跳过者会被发现。

## M1 开工与动工

**开工前三步（强制顺序）**：
1. `git pull --rebase`，先同步他人提交。
2. **读台账** `ISSUE_REGISTRY.json`：确认目标任务为 `todo`、目标文件无人 `in_progress`。撞单则换任务，**不许硬上**。
   - **读共享记忆**：调 `titan_memory_recall` 搜本任务关键词，确认没有已知的踩坑结论被重新推演。若召回为空且确信是新问题，开工后把结论用 `titan_memory_remember` 落盘。
3. **认领**：改台账（`status=claimed` + 填 `owner`）并**提交**。认领 = 提交，先到先得。

状态机：`todo → claimed → in_progress → verifying → done`（或 `blocked`）。开工后尽快把 `claimed` 推成 `in_progress` 并提交。

**动工纪律**：
- 同一文件同一时刻只允许一个 owner 处于 `in_progress`。
- 提交信息格式：`[T-xx] 类型: 描述`（类型取 feat/fix/docs/chore/refactor/test）。
- 只暂存自己的文件：`git add <路径>`；`git add -A` 仅在 `git status` 逐项确认后可用。
- 小步提交，一个提交只做一件事。

**阶段闸门**：
- 成批改动走分支 `stage/<阶段名>`；合回 `main` 的条件：闸门验证通过**且**验证证据已提交入库。
- **`main` 永远保持可运行。**
- 无依赖、可独立验证的小改动可直接在 `main` 小步提交（仍需 M1/M2/M4）。

## M2 验证与协作

**交叉验证**：
- **修的人不许自己验收。**
- 重要改动必须由第二个客户端验证：回归命令 + 输出作为证据提交，并在台账填 `verifier` 与证据位置。
- 分歧以验证输出为准，不靠辩论。
- **（2026-10-11 用户授权）作者客户端可自行后台调用另一客户端完成交叉验证，无需请示用户**：默认 verifier=Kilo（headless 调用方法与红线见技能 `titan-headless-clients`，验证输出落盘为证据）。verifier 仍必须是非作者客户端——**驱动可以是自己，判定必须出自对方**。

**根目录纪律**：
- 根目录只放四客户端共同检索/遵守的单个文件；判定口诀："只属于某个子项目吗？"→进子目录；"四客户端跨项目都要读吗？"→可留根。
- 新文件立即执行：提交前 `git status` 发现根目录散文件先归位；存量遗留走验收后一次性迁移。
- **一次性临时文件（`tmp/`、`_probe_*`、`_shot_*` 等）会话结束前必须清理**；能证明"做过且通过"的证据保留并归档，一次性探索脚本 `git rm` 删除。

## M3 中断与会话纪律

- 暂停前必须提交 WIP，或把台账改回 `todo`/`blocked`。**禁止半成品悬空。**
- **不许会话中途没结果的中断**——任务做到一半不许丢下不管。
- **不许结束时无故不结账**——收尾必须完成验证 + 台账 + 提交 + 知识库落盘。
- **会话过长需换新会话时**：先把本会话要点与坑点更新到共享记忆（`titan_memory_remember`），做好跨会话记忆，再提示换新会话。

## M4 开发与写盘

**开工自检（每次逐项过）**：
1. 台账读了吗？认领提交了吗？我是唯一 owner 吗？
2. `git status` 看过吗？在 `main` 还是正确的 `stage/` 分支？`pull --rebase` 了吗？
3. 目标文件有人正在改吗？
4. 我的改动谁来验证？证据交到哪里？
5. 根目录有我新增的散文件吗？有则先归位。
6. 待写内容含反斜杠吗？有则走反斜杠安全通道。
7. 改过 `orchestrator/` 下代码吗？改完必跑 `node orchestrator/verify-gate.mjs`（语法+导入+自检三连），全绿才允许提交。
8. 本次改动触碰的文件里有超 50 KiB 的源码吗？有则核对冻结台账（体量纪律）——只减不增，且拆分计划在案。

**反斜杠安全写盘（自检第 6 项的执行细则）**：
- 内容一旦经过 JS 模板字符串拼接，`\d`、`\U` 这类序列在解析期就被当成转义处理。**禁令**：待写 payload 含 `\` 时，禁止把 payload 拼进模板字符串 / `new_text` 字符串层，禁止"重写成 backslash-free payload"式自我阉割——那是丢数据，不是修 bug。
- **通道**：走字节通道——base64 中转（写时解码）或 `[IO.File]::WriteAllBytes` / `WriteAllText` 直写，不走字符串解析层。
- **校验**：落盘后必须 SHA256 对比预期哈希，确认字节级一致。
- **工具**：`orchestrator/safe-write.mjs`（`--target <path> --b64 <base64文件> [--expect-sha256 <hex>] [--check]`）已内置；自检第 7 项的验证闸门 = `orchestrator/verify-gate.mjs`。

**轻量通道（免台账）**：
- **判定**（同时满足全部）：单文件改动、改动 < 50 行、文件不在门禁白名单（verify-baseline*.mjs / _session_memory.md §2 / AGENTS.md）、不碰 orchestrate.mjs 核心函数（runAnalyze / runArchitect / main / runReview）、不碰 ISSUE_REGISTRY.json / work-orders.json / limits.json。
- **commit 格式**：轻量通道 `[fix] 描述`（无 T-xx 前缀）；完整通道 `[T-xx] fix: 描述`。
- **回滚**：任何 commit 都能 `git revert`，轻量通道不降低回滚能力。

**体量纪律（单文件 50 KiB 拆分线，宪法级）**：
- **适用**：可执行源码文件（`.mjs` / `.js` / `.cjs` / `.ts` / `.py` 等）。**不适用**：markdown/文档/数据文件、`node_modules/`、`vendor/`、构建产物、一次性草稿。
- **拆分线 51200 字节（50 KiB）**：任何源码文件超线即触发**拆分义务**——立即冻结"只减不增"，并在台账登记拆分计划，目标拆回 50 KiB 以下。
- **机械执行**：`orchestrator/verify-gate.mjs` ⑦ 体量纪律闸以 `SIZE_LEDGER` 维护"超线文件 → 冻结上限字节"。任一超线文件增长、或出现未登记的**新**超线文件 → 闸门 FAIL，不许提交。当前覆盖 `orchestrator/`（顶层 + `lib/`）。
- **存量豁免账本**（2026-10-13 清点）：仅 `orchestrator/orchestrate.mjs`（210539 B；T-59 批次上限 216000 B，等价"只减不增"）。`cfnext/worker.js`（352KB，子项目构建物疑云）标注"另案评估"。
- **变更程序**：台账值**只降不升**（合法净减后修订）；确需上调上限属修宪级，须用户拍板。

## M5 安全与密钥

**禁手清单**：
- `git reset --hard`、`git clean -fd`、`git checkout -- .` 默认禁用（会抹掉别人未提交的工作）；永不重写历史；审计/基线文件（各类 `汇总.md`、`FREEZE_RECORD`）只读不改。

**安装底线**：
- ①尽量工作区内安装，不动全局环境；②只从官方源下载并核对校验和，**禁止** `iex (iwr …)` / `curl | bash`；③装完写记录并提交。

**密钥与敏感信息**：
- 密钥**永不进 URL、不进命令行**，用环境变量或已忽略的密钥文件（如 `titan_secrets.env`）。
- 敏感文件（`**/titan_secrets.env`）已被 `.gitignore` 强制排除，**永远不要**用 `git add -f` 强行加入。
- 提交前 `git status` 审查：暂存内容里有没有密钥、缓存、浏览器数据、`node_modules`？有则先加 `.gitignore` 再提交。

## M6 用户交互

- **通俗易懂**：用户不懂代码，技术描述要用大白话，避免术语堆砌。
- **决策给选项**：需要用户拍板时，给出 2-3 个选项，每个选项附**理由**和**推荐项**（标明推荐）。
- **矛盾主动提示**：用户的要求相互矛盾时，**主动指出冲突点**，给出处理对策，不要默默执行或忽略。

## M7 工具与知识

**共享跨会话记忆（titan-memory，四客户端共用）**：
- **形态**：`titan-memory/` 零依赖 MCP stdio server，6 个工具 `titan_memory_remember` / `titan_memory_recall` / `titan_memory_search` / `titan_memory_consolidate` / `memory_core_recall` / `memory_core_remember`。
- **接线**：OpenCode `opencode.json` → `mcp.titan`；Kilo Code `.kilo/kilo.json` → `mcp.titan`（env `TITAN_CLIENT=kilo`）；Cline `.cline/mcp.json` + `~/.cline/data/settings/cline_mcp_settings.json`（两处同名 `titan`，内容必须一致）；DeepSeek Harness 不接，仍用原生 8 工具。
- **存储**：四端共写同一份 `%USERPROFILE%\.dsh\storages\dsh_memory.json`。**路径必须归一**：`TITAN_WORKSPACE` 必须经 `normalizeWorkspacePath` 归一到原生反斜杠后再与 fact 的 `workspacePath` 精确比对——实测写成 `D:/TITAN_ARCHAEOLOGY`（正斜杠）会让召回静默返回 0 条。
- **强制用法**：M1 读台账之后、动手之前调一次 `titan_memory_recall`；收尾前把可复用结论用 `titan_memory_remember` 落盘。翻历史会话用 `titan_memory_search`。
- **Core memory**：`titan-memory/core/CORE.md`（≤3000 字符常驻核心记忆）+ `notes/*.md`（长尾笔记），纯 markdown、零网络、可 git 版本管理。客户端启动时可选注入 CORE.md。
- **边界**：记忆是补充，**不是**台账替代——状态机仍以 `ISSUE_REGISTRY.json` 为准。
- **回归**：`node titan-memory/test.mjs` → 46/46；`node titan-memory/verify-cline.mjs` → 14/14。

**工具感知（本机增强工具，主动用，不等用户提醒）**：
- **ripgrep**：`D:\TITAN_ARCHAEOLOGY\bin\rg.exe`（15.2.0，2026-10-15 装）。搜代码/大日志**优先用 rg**：`& D:\TITAN_ARCHAEOLOGY\bin\rg.exe -n -i "pattern" <路径>`；rg 缺席才退 Select-String。
- **GitHub 操作**：`gh` CLI（`bin/gh.exe`）+ token 均已装（2026-10-15 现状）。提 issue/PR 走 CDP 浏览器（chrome-cdp-profile 持有已登录 GitHub 会话，账号 czfygc）+ cdp-drv/Playwright 表单提交（实证 anomalyco/opencode#55509）。
- **dsh-ops-bridge**：`dsh-ops-bridge/server.mjs`（零依赖 MCP stdio），6 工具 `ops_inspect` / `ops_grep` / `ops_glob` / `ops_replace` / `ops_pdf_text` / `ops_html2md`——把 dsh-ops 的 Rust worker 工具 + pdf/html2md 桥接给 OpenCode/Cline/Kilo 三客户端（Harness 用原生 DSH 插件无需桥接）。接线同 titan-memory（三客户端 mcp 段加 `dsh-ops`）。
- **实战落盘义务**：每次实战操作收尾前，把可复用要点与踩坑用 `titan_memory_remember` 落盘（事实/决定类，≤2000 字，打关键词标签）——与 M1 第 2 步构成闭环：**开工必 recall，收尾必 remember**。
- **发布树同步账本（T-125）**：`PUBLISH_SYNC.json`（本地仓根目录，四客户端共读）记录发布树路径/远端/上次同步的发布提交、来源本地提交、文件数与内容指纹（sha256）。**想知道"该从哪开始更新发布树"，只跑一条命令**：`node orchestrator/publish-sync.mjs status` → 打印待同步清单（改了什么/新增了什么）、未发布的本地提交数、发布树是否被手工改动过、下一步命令；`plan` 只看清单、`apply --yes` 执行同步（默认不推送）、`verify` 校验指纹。发布集 = 发布树已跟踪文件（不按目录猜测），新文件必须显式 `--include`；工具内置密钥扫描（`titan_secrets.env`/AIza/ghp_/sk-/私钥等）命中即拦截不发布。
- **禁推政策（T-126，用户拍板）**：**必同步 = V2 流水线完整逻辑链（脱敏后）；禁同步 = 与 V2 无关的 + 与 V2 有关但非必需的**。禁推清单写死在 `orchestrator/publish-sync.mjs` 的 `NEVER_PUBLISH`（含 `ISSUE_REGISTRY.json` 类台账、实例记忆 `titan-memory/core/CORE.md`、内部 SOP 技能自身、`*.log`、本地专属目录）；apply 会**自动剔除**已跟踪的禁推文件（`git rm --cached` + 登记 `.git/info/exclude`），`--include` 指定禁推文件会被拒收。判定口诀："这是 V2 流水线跑起来必需的逻辑链吗？"

## M8 开源专项

**目标**：把 `D:\TITAN_ARCHAEOLOGY` 的四客户端共用仓库做成可开源的工具栈（规划书 `OPEN_SOURCE_PREP_PLAN.md`，Phase A-D 已提交）。

**禁忌（红线）**：
- 密钥/令牌永不进 URL、命令行、公开文件（走 env 或已忽略的密钥文件）。
- 内部路径脱敏：机器路径用 `%USERPROFILE%` / `%LOCALAPPDATA%` / 环境变量，禁出现个人桌面/用户名路径。
- 禁推清单（`NEVER_PUBLISH`）永不外发：`ISSUE_REGISTRY.json` 类台账、实例记忆、内部 SOP 技能自身、`*.log`、本地专属目录。
- 公开仓历史重写属修宪级，须用户明确授权；本地仓按 M5 永不重写。

**调用专用技能**：涉及发布/同步/推 GitHub → 加载技能 `titan-publish-sync`（SOP 在 `.agents/skills/titan-publish-sync/SKILL.md`，含必同步/禁同步清单与五步流程）。