# 多 AI 协作流水线 —— 不写代码，也能把项目从设计做到落地

> **[English](README.md) | [简体中文](README.zh-CN.md)**

## 解决什么问题？

你有项目想法，但不会写代码——或者不想花几个月时间亲自写。

多 AI 协作流水线是一条**多方 AI 会诊 + 实现流水线**：从**项目设计到可运行代码**全程走完——网页 AI 席位独立设计方案、拆解项目，本地客户端落地代码，最后由全票复核通过才合并。不懂代码的人通过**人机语言交互**、用自然语言描述目标，流水线驱动其余一切。

Alpha 阶段，非生产级——但整条回路真实可跑、可审计。

## 怎么运转——多席协作，3 阶段

> 席位数按需编排：网页 AI 席负责设计与复核，本地客户端席负责实现，另设网页 AI 热备席吸收改版/掉线等不确定性，保证评审席位永不缺员（热备席不参与每一轮评审）。具体席位数是部署选择，不是固定承诺。

```
 阶段1 · 设计与拆解                  阶段2 · 代码落地                阶段3 · 复核闸门
┌─────────────────────────────┐    ┌──────────────────────────────┐    ┌──────────────────────────┐
│  网页席（多席）              │    │  本地客户端席                │    │  全票复核                 │
│  ├ 评审席：                  │───▶│  deepseek Harness            │───▶│  网页席 + 本地席            │
│  │  出方案、                 │    │  OpenCode                    │    │  = 必须全票通过           │
│  │  把项目拆成可验证工作项   │    │  Cline                       │    │  才允许合并               │
│  └ 专职替补席                │    │  Kilo Code                   │    │                          │
│    （消化网页 AI 不确定性）  │    │  写出真实代码                │    │                          │
└─────────────────────────────┘    └──────────────────────────────┘    └──────────────────────────┘
```

1. **网页席出方案拆解**：互相独立的网页 AI 评审席产出方案，把项目拆成可验证的工作项；**另设专职替补席**——网页 AI 天生不稳定（改版、验证码、掉线），替补席吸收这些意外，保证评审席位永不缺员。
2. **本地客户端代码落地**：deepseek Harness、OpenCode、Cline、Kilo Code 在本工作区领取拆解后的工作项，按 `orchestrator/` 纪律（认领 → 实现 → 验证 → 提交）写出真实代码。
3. **全票复核达标**：网页席与本地席独立复核，全票通过才合并；证据全部落盘，可回归验证。

## 核心特质

- **Layer A + Layer B 会诊架构**：自动识别席位间的共识、互补与事实冲突，输出可审计的裁决记录（`delta.md`）。
- **M1–M7 钢铁纪律**：自包含多客户端协作契约，含 50 KiB 源码体量冰封线、反斜杠安全写盘通道、严格状态机的共享任务台账。
- **Verify-Gate 验证闸门**：语法 / 导入 / CLI / 测试 / 自检 / 体量 / 动态 import 全闸，`main` 始终可运行。
- **产物级闸门（新增）**：四道交付闸门——`artifact-manifest`（文件 + 大小 + SHA256）、`license-notice-check`（第三方署名）、`anon-download-verify`（匿名可下载）、`stage-gate`（**代码 / 产物 / 发布三段独立判定，过了前段不等于过了后段**）。
- **任务卡纪律（新增）**：每个任务带范围 / 验收 / 禁止事项 / 证据要求；证据分 `firsthand`（亲验）/ `local_report`（自报）/ `unverified`（未验证）三档，且**作者不许自己验收**。
- **按任务分档派活（新增）**：任务档（`mechanical` / `bounded_code` / `architecture` / `review` / `long_run`）映射模型档（`light` / `medium` / `heavy`）；共享探针 + TTL 健康视图告诉你哪个模型此刻真能用——便宜但够用的模型干"错了会被机器抓住"的活，稀缺额度留给强档。
- **外部工具可接入**：可对接 freellmapi / OpenClaw / sing-box 等外部开源工具（见"外部依赖"），本仓不内含其源码或配置。

## 产物级闸门、任务卡与模型分档（今天就能跑）

```powershell
# 任务卡纪律检查（范围 / 验收 / 禁止事项 / 证据分级）
node orchestrator/task-card.mjs <T-xx>

# 产物四闸：清单、第三方署名、匿名可下载、阶段总判
node orchestrator/artifact-gate.mjs manifest       --root <产物目录> --out manifest.json
node orchestrator/artifact-gate.mjs verify-manifest --root <产物目录> --manifest manifest.json
node orchestrator/artifact-gate.mjs license         --root <产物目录>
node orchestrator/artifact-gate.mjs anon-download   --page <url> --download <url> --sha256 <hex> --bytes <n>
node orchestrator/artifact-gate.mjs stage-gate      --root <产物目录> --manifest manifest.json --code PASS

# 模型健康 + 派活推荐（共享探针，TTL 缓存）
node orchestrator/model-health.mjs --task mechanical --kind summarize
node orchestrator/model-health.mjs --all --no-probe --json      # 离线视图，不烧额度

# 长任务子进程：跨会话不掉线（Windows 计划任务常驻）
node orchestrator/supervisor.mjs add <jobId> -- <cmd> [args...]
node orchestrator/supervisor.mjs install            # 装成计划任务
node orchestrator/supervisor.mjs status
```

退出码统一：`0 = PASS`、`1 = FAIL`、`3 = UNKNOWN`（**显式未知不算通过**）、`2 = 用法错误`。

## 仓库结构（本次发布）

| 路径 | 用途 |
|---|---|
| `orchestrator/` | 流水线本体：编排、CDP 浏览器驱动、审查流，含 `verify-gate.mjs`（语法/导入/CLI/测试/自检/体量/动态 import） |
| `orchestrator/lib/` | 拆分后的职责模块（`scan-entry.mjs`、`analyze-core.mjs`、`architect.mjs`、`reviewers.mjs`、`task-card.mjs`、`stage-gate.mjs`、`model-health.mjs`、`supervisor.mjs` 等） |
| `orchestrator/test/` | 46 个 gate 测试文件（`node --test orchestrator/test/`） |
| `titan-memory/` | 跨客户端共享记忆 MCP 服务器（零依赖） |
| `.agents/` | 评审协议技能（四方会诊、评审通道选型、并行委派、TDD、诊断等） |
| `AGENTS.md` | 公开版协作契约（必加载，自包含，不含本机路径） |
| `NOTICE` | 运行时第三方依赖的署名清单 |

**不包含在本仓库的部分**（本地配置与部署产物，属流水线运行环境而非发布内容）：

- `freellmapi-src/` — FreeLLMAPI 本地网关（<https://github.com/neclomin/freellmapi>）
- 内部任务台账、实例记忆与发布同步账本 —— 私有工作区资产，永不外发（见 `AGENTS.md` 第 13 节）

## 下载

- **源码**：克隆本仓库，或从发布页下载压缩包：
  <https://github.com/czfygc/multi-ai-collaboration-pipeline/releases>（每个 Release 附带一份已发布树的 `.zip`）。
- **校验你下载的东西**：`node orchestrator/artifact-gate.mjs anon-download --page <发布页> --download <附件地址> --sha256 <hex> --bytes <n>`。

## 环境准备

```powershell
# 0. 前置：Node.js (>=18) 与 npm

# 1. 安装流水线依赖（playwright-core、@playwright/mcp、js-yaml）
npm install
```

基础验证只需要 `npm install`。CDP 浏览器**仅**在运行网页 AI 审查流（阶段 1 / 阶段 3 的网页席）时才需要：

```powershell
# 2. 可选——仅网页 AI 审查流需要
#    以远程调试模式启动 Chrome/Edge，监听 9222 端口：
#    chrome.exe --remote-debugging-port=9222 --user-data-dir="<本地目录>"
#    user-data-dir（chrome-cdp-profile）是本地运行时数据，不在本仓库。
```

## 快速开始

> **不懂代码？从这里开始：[使用说明（中文）](USAGE_GUIDE.zh-CN.md) / [Usage Guide (English)](USAGE_GUIDE.md)** —— 从安装到做出第一个项目，全步骤讲解，无需写代码。

```powershell
# 1. 语法检查（全库 .mjs）
node --check orchestrator/orchestrate.mjs

# 2. 完整验证闸门（语法+导入+CLI+测试+自检+体量）
node orchestrator/verify-gate.mjs

# 3. 跑 gate 测试
node --test orchestrator/test/
```

预期：`verify-gate.mjs` 退出码 `0`，`[GATE] RESULT: OK`。全部基础验证（语法、导入、CLI、测试、自检、体量）**无需任何浏览器**——CDP 浏览器仅网页 AI 审查流（`--review` / `--scan` 的网页席）需要。

## 当前状态（Alpha / 未生产级）

- 编排器已拆分至 `lib/` 职责模块，单文件体量 50 KiB 以下；`verify-gate` 全绿（syntax / import / CLI / test / self-check / size / 动态 import；46 个测试文件）。
- 本仓库**不含任何真实 API key / 密钥值**；模型路由配置、交易研究、浏览器运行时数据均已刻意排除。
- 下方"已知问题"如实披露——采用前请先读。

## 已知问题（如实披露，不粉饰）

| 编号 | 问题 | 说明 |
|---|---|---|
| D-1 | 时序缺口 | 某分段间事件时序未完全闭环，见 `orchestrator/` 相关注释 |
| D-2 | `markers.mjs` HIGH 并发串扰 | 高并发下标记串扰风险，已登记，待专项修复 |
| D-3 | 观察态非生产级 | 当前观测/埋点为原型级 |

## 外部依赖（仅接入，不内嵌）

| 工具 | 用途 | 仓库 |
|---|---|---|
| FreeLLMAPI | 本地 LLM 网关，多模型路由 | <https://github.com/neclomin/freellmapi> |
| sing-box | 代理与分流 | <https://github.com/SagerNet/sing-box> |
| OpenClaw | 人机语言交互（手机端：Telegram、WhatsApp 等） | <https://github.com/openclaw/openclaw> |

`orchestrator/` 通过标准 HTTP/gRPC 接口与已接入的 FreeLLMAPI / sing-box 交互。

**Telegram 入口（本版本已可用）**：在 Telegram 里给自己的机器人发一条 `!titan <任务>`，流水线会在同一个会话里回你执行状态。链路是 `orchestrator/titan_telegram_bot.py` → 本地网关 `orchestrator/titan-gateway.mjs`（127.0.0.1:5301，仅放行白名单 Telegram 用户 ID）→ `orchestrate.mjs --run` → 网页 AI 席位 → 状态回传 Telegram。Token 只存在本地已 gitignore 的 `titan_secrets.env`（绝不进 URL、不进命令行），入口只派发白名单内的任务，**不提供 Shell 或仓库文件访问权**。配置步骤见 `USAGE_GUIDE.zh-CN.md` 第 8 节。

OpenClaw 是用于人机语言交互的外部开源项目——**列入路线图，本版本尚未集成**。集成后它会把上面这个手机端入口扩展得更宽：OpenClaw 是运行在你自己的设备上的个人 AI 助手，出现在你已用的聊天渠道里（Telegram、WhatsApp、Discord、iMessage 等 20+ 渠道 + 手机原生 App），因此可以从手机上用 TG 对话驱动流水线。具体配置留在本地。

## 贡献

详见 `CONTRIBUTING.md`。外部贡献者走 **fork + PR**；合并由维护者通过 CI + review 管控。

## 安全

漏洞报告渠道见 `SECURITY.md`。密钥不进 URL、命令行或对话；走环境变量或本地（已 gitignore）密钥文件。

## 许可

采用 **Apache-2.0**（宽松、专利授权、企业友好）。见 `LICENSE`；运行时第三方依赖的署名见 `NOTICE`（`@playwright/mcp` MIT、`playwright-core` Apache-2.0、`js-yaml` MIT，均未内嵌进本仓）。

---

*维护者：TITAN_ARCHAEOLOGY（化名，不暴露个人身份）。联系方式：本仓库 GitHub Issues。*