---
name: titan-unknown-exploration
description: Use when you need to learn something that is not already in this repo — unknown APIs, new services, video/document content, unfamiliar tools, or a design decision with no precedent. Provides a numbered SOP from cheap local lookups through search engines, browser/CDP evidence extraction (including signed-URL and subtitle tricks), multi-source cross-verification, escalation to the 5-seat web council (4 reviewers + ChatGPT architect), and the write-back discipline. 未知事物探寻 SOP：本地→搜索引擎→站点取证→交叉验证→五席会诊→沉淀落盘。
version: 1.0.0
requires: cdp-browser-9222, yt-dlp
tests: manual: 对一个未知对象走完五级证据阶梯
provenance: original
---

# 未知事物探寻 SOP（弱模型也能照做）

> 目标：**把"我不知道 X"变成"我有带出处的 X"**，并且最终把结论沉淀成技能/记忆，让下次不用重来。
> 适用：陌生服务、陌生 API、视频/文档内容抓取、未有先例的架构设计、跨领域选型。

---

## 0. 铁律（5 条，违反即返工）

1. **不许凭记忆下结论**。所有事实必须有出处：命令输出 / 页面原文 / 官方文档 / 视频原字幕。
2. **先便宜后昂贵**：本地文件 → 搜索引擎 → 站点取证 → 会诊席。**不得跳级**（例如连本地 grep 都没做就开会诊）。
3. **单源不算结论**。关键事实至少 **2 个独立来源**交叉；冲突时以**官方/一手/实测**为准，并记录分歧。
4. **每一步都要留下可复现产物**（文件/日志/命令输出），不能只在脑子里过。
5. **不确定就标 UNKNOWN**，不许用"应该是/大概"填空。

---

## 1. 主流程（严格按序，每步都有出口）

### S1 明确问题边界（5 分钟）
- 把"未知"拆成可回答的小问题：`X 是什么 / 能不能用 X 做 Y / 怎么用 X 做 Y / 有什么坑`。
- 写清**用途**和**成功判据**（例："拿到 Muse 注册的前置条件清单"= 成功；"了解 Muse"= 失败）。
- 出口：问题能被"是/否/步骤/清单"回答。仍太大 → 拆到最小可回答单元。

### S2 本地优先（10 分钟）
```powershell
& <workspace>\bin\rg.exe -n "关键词" --glob '!node_modules/**' .   # 仓库内是否已有
git log --oneline -20 -- <路径>                                             # 是否做过
```
- 命中已有实现/记录 → **直接复用**，不重新研究。
- 出口：确定"本地无"或"本地已有 X"，写进工作记录。

### S3 搜索引擎（20 分钟）
- 优先 **DuckDuckGo html 版**（`https://html.duckduckgo.com/html/?q=...`）、Bing、Google。
- **被挡时的替代序**（实测 2026-10-21）：
  1. DDG 返回 "bots use DuckDuckGo too / Select all squares containing a duck" → **换 Bing/Google**；
  2. 仍挡 → **用本机 CDP 浏览器**（127.0.0.1:9222，已登录）打开 Google 搜索页，用 `Runtime.evaluate` 抓 `div.MjjYud`/`h3` 结构取标题+URL+摘要（`playwright_browser_navigate` + `browser_evaluate`）。
- 查询词构造：`对象 + 动作 + 症状`，中英各试一遍；把站点限定词加上（`site:github.com`、`site:x.com`）。
- 出口：拿到 ≥3 个候选来源，**列出待取证清单**（哪条结论靠哪条来源证实）。

### S4 站点取证（30–90 分钟，本 SOP 的核心）
按"难度"从低到高逐级尝试，**每级失败才升级**：

| 级 | 方法 | 适用 | 关键点 |
|---|---|---|---|
| L1 | 官方 raw 直链 | GitHub README/LICENSE | `raw.githubusercontent.com/<owner>/<repo>/<branch>/<file>`；**API 403 限流时 raw 仍可用**（T-143 实证） |
| L2 | `webfetch` 抓文章页 | 博客/文档/新闻 | 抓正文，剥导航噪声；只信正文段落 |
| L3 | CDP 浏览器读**内嵌 JSON** | SPA 页面 | `window.ytInitialPlayerResponse` / `__NEXT_DATA__` 等，比读 DOM 稳；`videoDetails` 常含标题/时长/简介 |
| L4 | CDP 浏览器**网络面板取签名直链** | 需 token 的资源 | 资源直链返回 200 但**长度 0** → 是缺签名参数；从**网络面板**取播放器自己发出的那条完整 URL（含 `signature`/`pot`/`xorb`），再页内 `fetch` |
| L5 | **字幕/音频转写** | 视频内容 | 见下方 §2 |
| L6 | 换源 | 同一事实找第二来源 | 单源不可信时必做 |

**YouTube 字幕取证（实证 2026-10-21，yt-dlp 三道墙）**：
1. `yt-dlp --cookies-from-browser brave` → 报 `Sign in to confirm you're not a bot`（本机 Brave 无 YouTube 登录态时必现）
2. `--extractor-args "youtube:player_client=web_safari"` → 报 `The page needs to be reloaded`（client 被拒）；若改成 `Requested format is not available` 说明**已拿到流**
3. `--write-auto-subs` → **HTTP 429** 限流；直链 fetch → **200 但长度 0**（缺 `signature`/`pot`）
4. ✅ 走通路径：**CDP 浏览器打开视频页 → 网络面板找 `timedtext` 请求 → 取带 `signature`+`pot` 的完整 URL → 页内 `fetch(url)` 解析 `fmt=json3` → 按 `events[].tStartMs` 切片取指定时间段**（同 startTime 多行要合并）
5. 音频流 `streamingData.adaptiveFormats[].url` 常为 `null`（YouTube 新版 SABR 流保护）→ 字幕不可得时才需另找带签名音频直链 + 本地 Whisper（`http://127.0.0.1:3001/v1/audio/transcriptions`，model `whisper-1`）

**动态页取证通则**：先找**内嵌 JSON**（L3）→ 再找**接口响应**（L4）→ 最后才读 DOM 文本。DOM 文本常常是壳。

### S5 交叉验证（20 分钟）
- 每个关键结论标注来源编号；**至少 2 源**才能写成结论，单源写"据单一来源（未交叉）"。
- 冲突处理优先级：**官方文档 > 一手实测 > 社区帖 > 视频口述**。视频口述只作**线索**，不作为最终事实。
- 出口：结论表（结论 / 来源 / 置信度 / 已知缺口）。

### S6 升级到 5 席会诊（**仅在以下情况**）
触发条件（任一）：
- 要做**没有先例的架构/选型决策**（"怎么设计 X"）；
- S3–S5 后仍有 **≥2 个未决分歧**，或结论置信度不足；
- 需要**反方视角**找自己方案的盲点。

执行（照 `.agents/skills/titan-four-party-consult/SKILL.md` 的协议）：
- 席位 = **`reviewers.yaml` 的 `reviewers_role` 4 席（gemini/deepseek/qwen/grok）+ architect 1 席（ChatGPT 裁决）= 5 席**；`enabled:true` 才算在席。
- **网页席有每日额度**（发附件/消息都计）→ 开会诊前先查额度，把问题**一次性问全**，别多轮试探。
- 送审材料必须是**自足**的（结论表 + 证据原文 + 明确要决策的点），不是"你懂我的意思吧"。
- 产出：Layer A 各席 raw → delta.md（去重汇总）→ ChatGPT 逐条 accept/reject/defer 裁决。
- 关键实现坑（2026-10-21 实证）：`--architect` 只吃 8 位 hex dispatchId，`scan-*` 需放行；ChatGPT 会把用户气泡渲染成 `You said:` 引用块混进 innerText，需 marker 剥离；判定词要允许同行 `DELTA-001: accept` 格式。

### S7 产出与沉淀（**不可省**）
1. **写报告**到 `design-specs/<主题>-<YYYYMMDD>.md`：结论先行 → 事实与出处 → 风险/边界 → 待用户拍板项。
2. **开台账**（`orchestrator/edit-issue.mjs`）：结论、可执行的下一步、阻塞条件。
3. **落共享记忆**（`titan_memory_remember`）：一句话事实 + 关键词标签（供下次 `titan_memory_recall` 命中）。
4. **回写技能**：本次新学到的坑/手法 → 追加到对应 `SKILL.md`（授权：用户长期允许自主新增/更新技能文档并提交）。
5. **风险动作不执行**：凡涉及"注册/下单/付费/提交不可逆表单"的动作，**只出方案与前置条件清单，不代为执行**（见 §3）。

---

## 2. 弱模型执行提示（照做即可，不必推理）

- 严格按 S1→S7 顺序，**一次只做一步**，做完再进下一步。
- 每步产出物固定：S1 问题清单 → S2 本地命中/未命中 → S3 候选来源表 → S4 取证原文 → S5 结论表 → S6 裁决（可选）→ S7 报告+台账+记忆+技能。
- 遇到"要不要再搜一下"：**S4 里同一方法最多试 2 次**，仍失败就升到下一级；不要在同一条路上磨。
- 遇到"要不要问用户"：出现**不可逆动作**、**需要付费/账号**、**分歧无解** → 停，列选项 + 推荐项，问用户。
- 记不住细节就回查本文件；**不要凭印象补全**。
- 完成后自检 4 问：① 每个结论有出处吗？② 关键结论 ≥2 源吗？③ 报告/台账/记忆/技能四件都落了吗？④ 有没有把不可逆动作替用户做了？

---

## 3. 边界与红线

- **不可逆/有代价的动作**（注册账号、绑卡、下单、提交带身份信息的表单、批量发消息）：**只调研 + 出前置条件清单，等用户拍板再执行**。
  - 尤其：某平台"注册失败即占用该资源"（例：注册失败后该邮箱不能再注册）→ **必须先满足全部前置条件再提交**，不许拿唯一资源试错。
- **不代为执行规避平台风控/地区限制/身份验证的操作**；可以整理公开信息、给出合规路径与风险。
- 密钥、令牌、账号凭据：走环境变量或已忽略的 `titan_secrets.env`，**不进命令行、不进 URL、不进仓库**（M5）。
- 抓取只读公开内容；不绕过登录/付费墙；不刷接口（会触发反爬并浪费额度）。
- 引用他人内容时注明出处与许可状态；不确定许可 → 只做"设计参考"，不复制原文入库（参 T-148 的 M5 审查流程）。

---

## 4. 关联技能

| 场景 | 用哪个 |
|---|---|
| 会诊协议（送审/分层/裁决解析） | `titan-four-party-consult`（5 席 = role 4 + ChatGPT 裁决） |
| 浏览器/CDP/反爬/动态页取证 | `titan-cdp-browser-ops`（§12 有 YouTube 字幕取证法） |
| 查错通道选型 | `titan-review-channels` |
| 记忆读写 | `titan-cross-session-memory` |
| 台账编辑 | `titan-registry-edit` |

---

*创建：2026-10-21（opencode）· 来源：T-159 Muse AI 注册调研实战（YouTube 反爬字幕取证 + Google 检索 + 三源交叉）与 T-71/T-72 网页席实战。*
