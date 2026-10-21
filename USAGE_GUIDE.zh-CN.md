# 使用说明——多 AI 协作流水线：不写代码，让多个 AI 帮你把项目做出来

> 本文写给**不懂代码**的人。你不需要会编程，但需要能照着做下面这几步（全程约 30 分钟准备）。

---

## 1. 这是什么

这是一个 **多 AI 协作的流水线**：

- 若干**网页 AI 评审专家**（Gemini、DeepSeek、Qwen，外加 ChatGPT 做最终裁决）——负责出方案、拆解任务、审查结果
- 若干**本地编码客户端**（deepseek Harness、OpenCode、Cline、Kilo Code）——负责真正写出代码

> 席位数按需编排：网页席负责评审、本地席负责实现，另有热备席吸收网页 AI 的波动。**具体席位数是部署选择，不是固定承诺。**

你只需要**用大白话描述你想做什么**，流水线负责拆解、设计、写代码、复核。

## 2. 诚实的前提（先看这个）

当前是 **Alpha 版**，请你先确认能接受：

- ✅ 你**不需要会写代码**
- ✅ 你不需要自己写文档、画架构图
- ⚠️ 但你需要会做 4 件小事：①双击安装一个软件 ②下载源码包解压 ③在终端敲两行命令 ④打开一个 AI 客户端用中文说话
- ⚠️ 网页 AI 需要你**自己注册免费账号**（各约 1 分钟）
- ⚠️ 目前主要在 **Windows** 上运行

## 3. 一次性准备（约 30 分钟）

### 第 1 步：装 Node.js

1. 打开官网 <https://nodejs.org>
2. 下载 **LTS 版**（左边那个），双击安装，一路"下一步"即可

### 第 2 步：下载本项目源码

1. 打开仓库首页 <https://github.com/czfygc/multi-ai-collaboration-pipeline>
2. 点 **Code** 按钮 → **Download ZIP**
3. 解压到你喜欢的位置，例如 `D:\myproject`

### 第 3 步：在终端装依赖

1. 打开解压后的文件夹，在地址栏输入 `cmd` 回车（Windows 会打开终端）
2. 输入并回车：

```powershell
npm install
```

等它跑完（显示 `added ... packages` 就成功了）。

### 第 4 步：启动"浏览器司机"

流水线要操作浏览器去和网页 AI 对话，需要一个带远程调试端口的 Chrome：

1. 双击 `orchestrator\启动 CDP 浏览器.bat`
2. 会打开一个 Chrome 窗口（请保持它开着，别关）

### 第 5 步：登录网页 AI

在这个 Chrome 窗口里，分别打开并登录（没有账号就各注册一个）：

| 网站 | 用途 |
|---|---|
| <https://gemini.google.com> | 评审专家 1（架构） |
| <https://chat.deepseek.com> | 评审专家 2（正确性） |
| <https://chat.qwen.ai> | 评审专家 3（找漏洞） |
| <https://chatgpt.com> | 最终裁决 |

登录后**保持登录状态**，不要退出。

## 4. 开始你的第一个项目（10 分钟）

以"我想做一个宠物领养小程序"为例：

1. 打开任一本地 AI 客户端（OpenCode、Cline、Kilo Code 三选一）——它相当于你的"助手"
2. 用大白话告诉它：

> 帮我用这个流水线做一个宠物领养小程序：用户能浏览待领养的宠物、提交领养申请，管理员能审核通过或拒绝。请先拆解任务、设计好再写代码，最后做全票复核。

3. 剩下交给流水线：网页 AI 出方案 → 拆解任务 → 本地客户端写代码 → 全票复核通过后合并。

> 提示：需求描述越具体，结果越好。可以加上"用什么技术栈（比如网页版）"、"要不要登录功能"、"界面风格"等。

## 5. 怎么知道它做完了

- **过程记录**：每次会诊的原始回复和裁决都存在 `reviews/` 目录
- **实际代码**：写在你的项目目录里，像普通项目一样可以打开查看
- **任务状态**：每个任务都有清晰状态 `todo → claimed → in_progress → verifying → done`，`done` 就是完成

## 6. 卡住了怎么办（常见问题）

| 现象 | 原因 | 解决办法 |
|---|---|---|
| 网页 AI 一直没回复 | 那个 AI 掉线或遇到验证码 | 在浏览器里刷新，重新登录一次 |
| 提示 `127.0.0.1:9222` 连不上 | CDP 浏览器被关了 | 重新双击 `启动 CDP 浏览器.bat` |
| 提示"配额耗尽 / 次数用完" | 免费 AI 有每日次数限制 | 明天再试，或换另一个 AI |
| 命令报 `node 不是内部或外部命令` | Node.js 没装好 | 重装 Node.js 后**重新打开终端** |
| 想给作者反馈 | — | 在仓库 **Issues** 里发帖即可（作者能看到） |

## 7. 这不是魔法（边界与诚实声明）

- **Alpha 版**：复杂需求可能需要多轮沟通和微调，不是一句话就能完美交付
- **网页 AI 会变**：这些网站经常改版、掉线、限流，流水线会尽量自动恢复，但偶尔需要你手动刷新登录
- **你需要基础操作能力**：能装软件、解压、开终端、注册账号——这些都能在 10 分钟学会
- **代码质量**：会经过全票复核，但 Alpha 阶段仍建议你自己或找懂行的人过目后再上线使用

## 8. 进阶（可选）：用手机上的 Telegram 发指令

不想开电脑？可以直接在 Telegram 里给自己的机器人发一条消息来跑任务：

1. 在 Telegram 里找 **@BotFather**，发 `/newbot` 创建机器人，拿到一串 token（形如 `123456789:AA...`）。
2. 把 token 写进项目根目录的 `titan_secrets.env`（这个文件已被 git 忽略，不会被上传）：
   `TITAN_BOT_TOKEN=你拿到的token`
3. 查你自己的 Telegram 数字 ID（随便搜一个 "get id" 机器人即可），填进 `orchestrator/start-titan-bot.ps1` 里的 `TITAN_ALLOWED_USER_IDS`。**只填你自己的 ID**——不在名单里的人发指令会被直接拒绝，这是安全底线。
4. 确认第 4 步的"浏览器司机"还开着，然后在终端运行：
   `powershell -File orchestrator\start-titan-bot.ps1`
5. 回到 Telegram，对你的机器人发一条：
   `!titan 你好，这是一次链路自检`
6. 机器人会**先**回一句"已收到任务"，几分钟后把执行状态发回来（含 DispatchId、退出码、结果摘要）。

注意：

- **需要先装 Python 3**（Windows 去 <https://www.python.org/downloads/> 下载安装，安装时勾上 "Add python.exe to PATH"）——这一步本指南前 7 节用不到，只有本节要用
- 前缀必须是 `!titan `（感叹号 + 空格），否则机器人只回复用法提示
- 发消息别太频繁（建议 10 条/分钟以内），否则 Telegram 会限流甚至封机器人
- 停止：结束那个 `python` 进程即可；重新启动会自动跳过停机期间积压的旧消息

## 9. 验收你拿到的东西（产物级闸门）

下载了发布压缩包、或者想知道某个目录"到底做完没有"，跑闸门即可。闸门很诚实：**通过 / 失败 / 未知**三态分明——**"未知"永远不算通过**。

```powershell
# 1. 产物清单（文件 + 大小 + SHA256）与一致性校验
node orchestrator/artifact-gate.mjs manifest       --root <目录> --out manifest.json
node orchestrator/artifact-gate.mjs verify-manifest --root <目录> --manifest manifest.json

# 2. 第三方署名（LICENSE + NOTICE 必须在，且覆盖每个运行时依赖）
node orchestrator/artifact-gate.mjs license         --root <目录>

# 3. 发布附件的匿名可下载性（地址 + 期望字节数 + SHA-256）
node orchestrator/artifact-gate.mjs anon-download   --page <发布页> --download <附件地址> --sha256 <hex> --bytes <n>

# 4. 总判：代码 / 产物 / 发布三段独立判定
node orchestrator/artifact-gate.mjs stage-gate      --root <目录> --manifest manifest.json --code PASS
```

退出码：`0 = PASS`、`1 = FAIL`、`3 = UNKNOWN`、`2 = 用法错误`。

另外两个实用工具：

```powershell
# 此刻哪些模型真能用，以及哪类任务该派给哪一档（低档优先，稀缺额度留给强档）
node orchestrator/model-health.mjs --task mechanical
node orchestrator/model-health.mjs --all --no-probe --json   # 离线视图，不烧额度

# 长任务别再"关掉终端就没了"：装成计划任务常驻（Windows）
node orchestrator/supervisor.mjs add my-job -- node my-job.mjs
node orchestrator/supervisor.mjs install
node orchestrator/supervisor.mjs status
```

---

*有任何问题或建议，欢迎到仓库 Issues 反馈。*
