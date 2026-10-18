---
name: titan-search-then-interrogate
description: "Use when hitting an unknown error/problem during TITAN work ('为什么报错'/'这什么坑'/'先搜后问'), or the user says '先 Google 搜'/'把网页 AI 都问一遍'/'交叉审问'. Workflow: ① search engine first (DuckDuckGo html via webfetch, Google via CDP), collect leads from community threads > official docs; ② if inconclusive, cross-interrogate ALL logged-in web AI seats in the CDP browser (DeepSeek/Qwen/Gemini/ChatGPT/Grok) with the same facts-first prompt; ③ synthesize consensus vs conflict; ④ decide. Mandatory research channel per user directive 2026-10-11. Includes seat table, prompt template, secret-scrubbing red lines, and the 2026-10-11 cf2-522 worked example."
user-invocable: true
---

# 先搜后问：未知问题研究通道（用户钦定必备技能）

> 用户长期规则（2026-10-11 钦定，延用到任何项目）："我遇到问题先找 google 搜，再不行就把一批网页 AI
> 全部交叉审问一遍。" 本技能把它固化为标准研究通道。

## 1. 何时用

- 撞到**未知报错/怪现象**，本地工具（tail/日志/API）已给事实但给不出根因；
- 需要**社区经验**（坑库帖、他人踩过）或**多方知识交叉**（多模型共识）时；
- 与 `titan-review-channels` 的分工：那个管"**查错验收**"（对已完成产物的审查选型），
  本技能管"**未知问题根因研究**"（对未知现象的调查）。

## 2. 通道一：搜索引擎先行（必走第一关）

1. **DuckDuckGo html 版**（首选，scrape 友好）：
   `webfetch https://html.duckduckgo.com/html/?q=<url编码查询词>` → 结果摘要直接可读。
2. **Google**（需要时）：CDP 浏览器开新 tab 导航 google.com/search?q=…（勿动已登录 tab）。
3. 查询词带**错误码+环境限定**：`<错误码> <技术> <关键限定>`（如 `Workers custom domain 522 free plan`）。
4. **优先级排序**：社区实测帖（community.cloudflare.com / stackoverflow / answeroverflow）
   > 官方文档（developers.cloudflare.com）> 营销性教程站。
5. 每条线索**当场全文抓取**（webfetch 原帖），不要只看搜索摘要——机理藏在回帖里
   （实证：IDN-522 帖的 Staff 回复给出"改用 Worker Route"工作区，摘要里看不到）。

## 3. 通道二：网页 AI 席交叉审问（搜索无果/需验证时）

### 3.1 席位（CDP 浏览器 `127.0.0.1:9222`，persistent profile 持登录态）

| 席位 | URL 子串 | 备注 |
|---|---|---|
| DeepSeek | chat.deepseek.com | |
| Qwen | chat.qwen.ai | 现役对抗席（2026-10-12 T-57 起） |
| Gemini | gemini.google.com/app | |
| ChatGPT | chatgpt.com | |
| Grok（备胎） | grok.com | enabled:false——导航超时+强模型收费，已被 Qwen 顶替，仅历史参考 |

> 席位名单唯一事实源 = `orchestrator/reviewers.yaml`（enabled:true）；本表仅为速查。

驱动方法见技能 `titan-cdp-browser-ops`（`tmp/cdp-drv.mjs` v2 + `@文件` 模式；
重型用 playwright-core/Playwright MCP `connectOverCDP`）。**正式的评审协议**（Layer A/B/裁决）走
`titan-four-party-consult`；本技能是**轻量问询**：不冻结 artifact、不做 dispatch lineage，
但保留其两条核心纪律——席间隔离（A 的回答不进 B 的 prompt）+ 原文无损落盘。
**席位"沉默"先排除捕获时序**：raw 短/侧栏垃圾 ≠ 席位死——按 截图→会话历史→raw 顺序复核
（T-57 实证：gemini 表面沉默，实际完整答案已在对话里）。

### 3.2 问询模板（facts-first，全部席位同一份）

```
[技术咨询] <一句话现象>
事实清单（全部实测，非猜测）：
- <事实1（含证据类型：tail/HTTP码/DNS/API返回）>
- <事实2> ...
已排除：
- <已证伪的假设>（让 AI 不走死路）
搜索线索（可选附）：
- <Google/DDG 已发现的社区帖要点>
问题：1) 最可能根因排序？2) 每条的验证方法（一条命令/一个实验）？3) 已知规避方案？
要求：直接给结论与验证步骤，不要反问。
```

### 3.3 收集与合成

- 每席回答**原文落盘** `tmp/<问题>-consult/<seat>.txt`（Layer A 精神：无损，不改写）；
- 合成表：**共识**（≥2 席同结论）→ 优先行动；**分歧**（席间冲突）→ 设计判别实验裁决；
  **独有洞见**（单席提出且未被搜索命中）→ 用低成本实验验证后再信；
- AI 回答是**线索不是证据**——任何结论落地前必须有本地实测（curl/tail/API）复现确认。

## 4. 红线

1. **脱敏**：prompt 不携带密钥/token/UUID/订阅 URL/账号邮箱——网页 AI 是第三方。
   域名只给到"某免费二级域 zone"级别即可问出机理（实证：本次 522 问询不需要暴露 UUID）。
2. **不污染**：勿在登录态 tab 里导航无关站点；勿把一个席位生成的答案粘贴进另一个席位
   （除非明确标注"另一 AI 意见，请批判"）。
3. **不重复灌**：同一席位同一 prompt 禁止重发（配额是资源）；修正后再发须带新事实。
4. CDP 断连 = 浏览器被关：让用户跑 `orchestrator\启动 CDP 浏览器.bat`，勿自启。

## 5. 实战案例（2026-10-11，cf2-522）

现象：B 账号 Worker 绑 custom domain `cf2.<免费二级域>`，API 显示 enabled+cert 已发，
DNS/TLS 正常，但 HTTP 522；`wrangler tail` 零事件；同 worker 在 workers.dev 可达（后测 500
是另一独立问题）。用户独立部署的第二个 worker 同 zone 也 522。

- **DDG 搜索**命中 `community.cloudflare.com/t/idn-custom-domain-fails-to-connect-to-worker`：
  同签名（custom domain "Active" 但 522，workers.dev 正常）——证明这是一个**已知故障家族**；
- **判别实验链**（搜索引擎给方向，本地实验给证据）：
  ① tail 零事件 → 请求未达 worker（排除 worker 代码）；
  ② workers.dev 开启（注意 TOML 坑：`workers_dev=true` 必须在顶层，写在 `[[routes]]` 后会被吞进 routes）→ 请求可达；
  ③ 同 zone 第二个 worker（用户部署）同样 522 → **zone 级系统性**，与单 worker 无关；
- 结论方向：免费二级子域 zone 上 Workers custom domain 边缘路由不生效（用户另购一级域名解决）。
- 坑补记：wrangler `tail` 在该账号出现"连接成功但零事件"异常，异常文本改走 dashboard Live Logs 抓取。

## 6. 维护

由 opencode 会话创建（2026-10-11，用户授权固化）。新坑/新席位/新模式照抄本文件格式更新并提交。
