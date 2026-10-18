---
name: titan-review-channels
description: "Use when choosing an error-hunting or review channel: '四方会诊' (web 4 AI seats) vs '本地验证' (local 4 clients, ordered calls) vs '8方查错' (both combined) — 查错通道选型 / 派谁去评审或验收 / 要不要派网页席或本地客户端 / 四方会诊 vs 本地验证 vs 8方查错。Gives the taxonomy, local call order, and red-line pointers (details live in the linked skills)."
---

# 查错通道三档（2026-10-08 用户拍板，T-42 落盘）

| 档 | 构成 | 何时用 | 挂载 |
|---|---|---|---|
| **四方会诊**（网页 4 AI） | Gemini=架构 / DeepSeek=正确性 / Qwen=对抗 / ChatGPT=整合裁决，CDP 网页席（名单以 reviewers.yaml enabled 为准；grok 备胎） | 跨模型独立评审、新设计与大改争议、需要视角分工的会诊 | 协议=技能 `titan-four-party-consult`（Layer A/B + 补漏 + 整合）；资源位=scan-flow 网页 4 席（`--review` / `--scan`） |
| **本地验证**（本地 4 客户端） | OpenCode + Kilo + Cline + Harness，同仓库真实文件与工具 | 日常改码复核、M4 交叉验收、执行链派发（titan-execute） | 命令模板=技能 `titan-headless-clients`；调用序见下 |
| **8方查错** | 网页 4 + 本地 4 全部 | 重大 artifact 合入前的全量扫错 | `node orchestrator/orchestrate.mjs --scan <file>`（plan §8.1 八方并行流水线） |

## 本地验证调用序（按自带免费模型用量与稳定性定序；M4 仍要求作者≠验证者）

1. **OpenCode 主力**——已加重模型配置（Zen 免费强档 + freellmapi，记忆 a77bf8d4）。改码/审查首选；**当 OpenCode 是作者时自动让位**（M4）。
2. **Kilo 第一调用**——自带免费模型用量仅次于 OpenCode（`kilo run --model yysd/auto`）。**编辑工具缺 filePath 实测不可改码 → 只当 finder / 验证者**。
3. **Cline 第二调用**——自带免费用量次于 Kilo。`cline.exe ... -P openai-compatible -m <具体id> --data-dir <隔离目录>`；**隔离 data-dir 必须预种 providers.json 的 baseUrl=http://127.0.0.1:3001/v1（env OPENAI_BASE_URL 不生效）**；验收 pin 具体模型禁 auto。
4. **Harness 排最后**——无自带免费模型且 bug 多（GPO SecurityException、瞬时 503、NVIDIA key 404、冷启动 180s）。前三档不可用才上；**先冒烟见 final 再派真活**。

## 防踩坑红线速查（每条标出处，详情回对应文件）

- 修的人不许自己验收（M4）；证据（命令+原始输出）填台账 `cross_validation`（出处：AGENTS.md M4）。
- 期望值只给判定、不写进子代理 prompt（防照抄伪造）；子代理一次一个、同步返回、禁 `interrupt_agent`；验收输出认最后一行 `VERDICT: PASS|FAIL`（出处：`titan-headless-clients/SKILL.md` §2b 第 5 条，L50）。
- 网页席 prompt 禁「无问题输出 []」毒句；发送后核 textLen，未清空走升级重试（enter/button 切换）（出处：`titan-four-party-consult/四方会诊_SOP.md` §5 坑表，L93-95）。
- 网页席派发看日限：`orchestrator/limits.json` `dispatch_cdp=2/日`，派发日志有 `[LIMITS] dispatch cdp N/2` 行可核（出处：limits.json + orchestrate.mjs 派发输出）。
- headless 一律绝对路径，三 CLI 不在 PATH（出处：`titan-headless-clients/SKILL.md` §1 路径表）。

**选型口诀**：日常复核=本地验证（Kilo→Cline）；争议/新设计=四方会诊；合入前=8方查错。
