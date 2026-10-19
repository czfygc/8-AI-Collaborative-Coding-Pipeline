# 8-AI Collaborative Coding Pipeline — 不写代码，也能把项目从设计做到落地

> **[English](README.md) | [简体中文](README.zh-CN.md)**

## 解决什么问题？

你有项目想法，但不会写代码——或者不想花几个月时间亲自写。

8-AI Collaborative Coding Pipeline 是一条**多方 AI 会诊 + 实现流水线**：从**项目设计到可运行代码**全程走完——网页 AI 席位独立设计方案、拆解项目，本地客户端落地代码，最后由八方复核全票通过才合并。不懂代码的人通过**人机语言交互**、用自然语言描述目标，流水线驱动其余一切。

Alpha 阶段，非生产级——但整条回路真实可跑、可审计。

## 怎么运转——9 席，3 阶段

> 「8-AI」指一个周期内实际干活的 8 个 AI：网页 4 评审 + 本地 4 客户端。第 9 席是网页 AI 替补——它吸收改版/掉线等不确定性，保证评审席位永不缺员，但不参与每一轮评审。

```
 阶段1 · 设计与拆解                  阶段2 · 代码落地                阶段3 · 复核闸门
┌─────────────────────────────┐    ┌──────────────────────────────┐    ┌──────────────────────────┐
│  网页 5 席                   │    │  本地 4 客户端                │    │  8 方复核                 │
│  ├ 4 个评审席：              │───▶│  deepseek Harness            │───▶│  网页 4 评审 + 本地 4      │
│  │  出方案、                 │    │  OpenCode                    │    │  = 必须全票通过           │
│  │  把项目拆成可验证工作项   │    │  Cline                       │    │  才允许合并               │
│  └ 1 个专职替补席            │    │  Kilo Code                   │    │                          │
│    （消化网页 AI 不确定性）  │    │  写出真实代码                │    │                          │
└─────────────────────────────┘    └──────────────────────────────┘    └──────────────────────────┘
```

1. **网页 5 席出方案拆解**：4 个互相独立的网页 AI 评审席产出方案，把项目拆成可验证的工作项；**第 5 席是专职替补**——网页 AI 天生不稳定（改版、验证码、掉线），替补席吸收这些意外，保证评审席位永不缺员。
2. **本地 4 客户端代码落地**：deepseek Harness、OpenCode、Cline、Kilo Code 在本工作区领取拆解后的工作项，按 `orchestrator/` 纪律（认领 → 实现 → 验证 → 提交）写出真实代码。
3. **八方复核达标**：网页 4 评审 + 本地 4 客户端独立复核，全票通过才合并；证据全部落盘，可回归验证。

## 核心特质

- **Layer A + Layer B 会诊架构**：自动识别席位间的共识、互补与事实冲突，输出可审计的裁决记录（`delta.md`）。
- **M1–M7 钢铁纪律**：自包含多客户端协作契约，含 50 KiB 源码体量冰封线、反斜杠安全写盘通道、严格状态机的共享任务台账。
- **Verify-Gate 验证闸门**：语法 / 导入 / CLI / 测试 / 自检 / 体量 / 动态 import 全闸，`main` 始终可运行。
- **外部工具可接入**：可对接 freellmapi / OpenClaw / sing-box 等外部开源工具（见"外部依赖"），本仓不内含其源码或配置。

## 仓库结构（本次发布）

| 路径 | 用途 |
|---|---|
| `orchestrator/` | 流水线本体：编排、CDP 浏览器驱动、审查流，含 `verify-gate.mjs`（语法/导入/CLI/测试/自检/体量/动态 import） |
| `orchestrator/lib/` | 拆分后的职责模块（`scan-entry.mjs`、`analyze-core.mjs`、`architect.mjs`、`reviewers.mjs` 等） |
| `orchestrator/test/` | 21 个 gate 测试用例 |
| `titan-memory/` | 跨客户端共享记忆 MCP 服务器（零依赖） |
| `.agents/` | 评审协议技能（四方会诊、评审通道选型） |
| `AGENTS.md` | 四客户端协作契约（必加载，自包含） |

**不包含在本仓库的部分**（本地配置与部署产物，属流水线运行环境而非发布内容）：

- `freellmapi-src/` — FreeLLMAPI 本地网关（<https://github.com/neclomin/freellmapi>）

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

- 编排器已拆分至 `lib/` 职责模块，单文件体量 50 KiB 以下（`orchestrate.mjs` ~46 KB）；`verify-gate` 全绿（syntax 40/40、import 14/14、CLI 4/4、test 21/21）。
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

`orchestrator/` 通过标准 HTTP/gRPC 接口与已接入的 FreeLLMAPI / sing-box 交互。OpenClaw 是用于人机语言交互的外部开源项目——**本版本尚未集成，列入路线图**。集成后它将作为**手机端入口**：OpenClaw 是运行在你自己的设备上的个人 AI 助手，出现在你已用的聊天渠道里（Telegram、WhatsApp、Discord、iMessage 等 20+ 渠道 + 手机原生 App），因此可以从手机上用 TG 对话驱动流水线。具体配置留在本地。

## 贡献

详见 `CONTRIBUTING.md`。外部贡献者走 **fork + PR**；合并由维护者通过 CI + review 管控。

## 安全

漏洞报告渠道见 `SECURITY.md`。密钥不进 URL、命令行或对话；走环境变量或本地（已 gitignore）密钥文件。

## 许可

采用 **Apache-2.0**（宽松、专利授权、企业友好）。见 `LICENSE`。

---

*维护者：TITAN_ARCHAEOLOGY <titan@archaeology.local>（化名，不暴露个人身份）*