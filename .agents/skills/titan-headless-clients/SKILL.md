---
name: titan-headless-clients
description: "Use when background-invoking any of the four TITAN clients from another client ('后台调用 Cline/OpenCode/Kilo/Harness' / 'headless 跑一下客户端' / '让 X 客户端在后台执行、扫描、验收'). Gives binary paths, tested command lines, cross-invocation matrix and red lines so no session has to rediscover them. Works from any of the 4 clients."
user-invocable: true
---

# 四客户端后台互调（headless invocation）

四客户端（OpenCode / Cline / Kilo Code / DeepSeek Harness）共读本文件。调用方只需 shell 工具（OpenCode=bash、Cline=终端、Kilo=终端、Harness=pwsh/bash）即可拉起其余三者；三个本地 CLI 均**不在 PATH**，一律用绝对路径。

## 1. 二进制（实测存在，2026-10-08；env 可覆盖）

| 客户端 | 路径 | 覆盖 env |
|---|---|---|
| OpenCode | `D:\TITAN_ARCHAEOLOGY\test-projects\landmine-001\node_modules\opencode-windows-x64\bin\opencode.exe` | `TITAN_OPENCODE_BIN` |
| Cline | `D:\TITAN_ARCHAEOLOGY\cline-local\node_modules\@cline\cli-windows-x64\bin\cline.exe`（`.cmd` 变体须 PowerShell 包装） | `TITAN_CLINE_BIN` |
| Kilo | `C:\Users\Administrator\.vscode\extensions\kilocode.kilo-code-7.8.8-win32-x64\bin\kilo.exe`（VSCode 扩展升级会变路径，取不到时查 `.vscode\extensions` 最新版本） | `TITAN_KILO_BIN` |
| Harness | `npx @deepseek-ai/dsh@0.1.6-alpha.2 --profile headless` | — |

## 2. 命令模板（scan-flow.mjs / TUTORIAL / T-41 实测）

**OpenCode**（只读扫描实测）：
`<exe> run --pure --format json -m freellmapi/deepseek-v4-pro "<prompt>"` → NDJSON，取 `type:"text"` 的 `part.text` 拼回复。
坑：当前版本 `opencode run` **无 `--auto` 标志**（T-41 实测，executor-profiles 待修）；run 完进程常驻不退 → 外层 timeout + `taskkill /pid <pid> /T /F`；prompt 必须显式禁 git push；`FREELLMAPI_API_KEY` 注入进程 env。

**Cline**（T-41 已验用法）：
prompt 落临时文件，PowerShell 包装：
`$p=Get-Content -Raw prompt.txt; & '<cline.exe>' $p --json --auto-approve true -P openai-compatible -m <具体id> -c <cwd> --data-dir <dir>`（2026-10-16 起新方法**通常省略 `-m`**，见下）
env 带 `OPENAI_API_KEY=$FREELLMAPI_API_KEY`；**`OPENAI_BASE_URL` env 实测不生效**（T-40 ⑥）。
坑：**隔离 `--data-dir` 必须预种 `<data-dir>/settings/providers.json`** 的 `openai-compatible.settings = { baseUrl: "http://127.0.0.1:3001/v1", apiKey, protocol: "openai-chat", client: "openai-compatible", contextWindow, capabilities }`，否则 cline 打到 `api.openai.com` → ConnectionRefused（模板抄 `~/.cline/data/settings/providers.json`）；输出 NDJSON 且 stderr 混入 → 逐行 try 解析；`--auto-approve false` 连只读操作都会停下请示，无人值守必 true；Windows 下 node 直接 spawn `.cmd` 秒退（status=null）。

**新方法（2026-10-16 T-67/68/69 M4 实战打通，dots3-note-preview）**：
- **模型名用裸目录名、预种进 providers.json 的 `openai-compatible.model`，运行时不传 `-m`**：`-m` 必须 `modelType/model` 恰好一斜杠（两斜杠报 `invalid model format`），而 Cline 会把 `-m` **整串含前缀**原样作为 model 字段发给网关 → 本地网关按目录精确匹配 404；`-m` 值还会被**回写进 providers.json**（编辑前须重读文件）。
- 本地网关 `http://127.0.0.1:3001/v1` 的 `/v1/models` 720 项，裸名 `dots3-note-preview` 实 serving=`dots-studio/dots-3-note-preview:free`；候选 `dots-studio/dots-3-note-preview:free` 也通；`dots-3-note-preview`（缺前缀）与无分隔拼接 404。OpenRouter 全名 `dots-studio/dots-3-note-preview:free` 单斜杠无法寻址 → 弃用。
- M4 战果：T-67/68/69 三命令自跑 `VERDICT: PASS`（证据 orchestrator/audit-evidence/t67-t69-m4-cline-dots3-20261016.txt）；prompt 作位置参数直传即可。
- **（2026-10-16 打通）Cline 轮换第二模型 Nemotron 3.5 Super VL free**：网关裸名 `nvidianemotron-3.5-super-vlfree`（serving=`nvidia/nemotron-3.5-super-vl:free`，ctx 1M）。**用户拍板长期轮换 Nemotron 3.5 Super VL free ↔ dots3-note-preview**；切换=改隔离 providers.json 的 `openai-compatible.model` 裸名，运行时不带 `-m`。冒烟 PASS：自跑 `node` 命令回 `SMOKE:NEMO_OK`（证据 orchestrator/audit-evidence/cline-nemo-supervl-smoke-20261016.txt）。
- **坑（打通经过，再遇"no tool-calling support"照此修）**：Cline agent 循环曾报 `All models exhausted: 1 route checked (1 model lacks tool-calling)`——**根因不是上游**，是 freellmapi 库 `models.supports_tools=0` 陈旧（OpenRouter 官方该模型 `supported_parameters` 实际含 `tools/tool_choice/parallel_tool_calls`；判据先查 https://openrouter.ai/api/v1/models）。修复=在 `freellmapi-src/freellmapi.config.json` 顶层 `models` 数组该条目补 `"contextWindow":1000000,"supportsTools":true`（声明式 model edit；catalog-sync 刷新基线后**会重放 override**，持久有效）。**config 仅启动时应用** → 需重启网关：杀 3001 监听 PID，按 watchdog 姿势 `Start-Process cmd /c "node dist/index.js >> boot.log 2>&1"`（cwd=`freellmapi-src\server`）。验证：boot.log 见 `[config] applied ... N model edits`，`/v1/models` 该模型 supported_parameters 含 `tools`。
- 席位注记：2026-10-16 用户把**桌面 Cline 切到 Nemotron 3.5 Super VL (free)**（默认配置勿动；headless 走隔离 data-dir，轮换不受桌面席位影响）。

**Kilo**（T-39 实测 63 findings）：
`<kilo.exe> run --model yysd/codestral "<prompt>"`（T-55 起 pin Mistral codestral；旧例 `yysd/auto` 会路由到 codestral-latest=同家族撞车，且 minimax-m2.7 经 M4 实测上游不稳已弃用）。
**编辑工具缺 filePath 实测不可改码 → 只当 finder**；要改码换 opencode/cline。
**坑（2026-10-14 实测，7.8.8）**：无头 `kilo run` 对 bash / external_directory 权限请求**自动拒绝**（`permission requested: bash ...; auto-rejecting`，T-53 时行为不同）→ 无审批通道下做不了要 shell 的验证任务。
**转折（2026-10-16 实测，同 7.8.8）**：简单命令（`echo`）直接放行；`git`/`node` 等被 auto-reject 且报错自带出路 `pass --auto for autonomous use` → **加 `--auto` 后 bash 全放行**（`git -C ... log --oneline -3`、`node orchestrator/verify-gate.mjs` 实测均真执行），且不改 `.kilo/kilo.json`、不影响交互会话。**M4 默认 verifier 复位**：`kilo run --auto --model yysd/codestral "<prompt>"`（T-70 M4 实测 PASS，三命令逐项自证；此前临时改派 cline 的理由已不成立）。纪律仍用 §2c（死命令模板、纯 ASCII 命令、逐项自证、两轮协议）。

**Harness = dsh headless**：
`npx @deepseek-ai/dsh@0.1.6-alpha.2 --profile headless "<task>"`（或 stdin：`echo "<task>" | ... --profile headless`）；`--json` 出事件流，终态 `{"type":"final","text":...}`；`--session-id <id>` 续会话。
坑：冷启动慢——曾 180s 无输出（plan2 DEPLOY_LOG）；2026-10-08 冒烟出现 `turn_end reason=error 503 SERVER`（模型后端瞬时挂）→ **先派小任务冒烟，见到 final 再派真活**；诊断走 stderr。
坑：**pwsh 必撞 GPO `SecurityException`（受限令牌读注册表策略被拒）** ——根因 settings.yaml `permission.defaultPreset=workspace-write` 下所有沙箱化 shell（父直跑与子代理同样中招，RAND 探针实测子代理报 NO_EXEC_TOOL）。解法 = `defaultPreset: danger-full-access`（preset 自带 approval=never，headless 无审批通道也直接放行）。**2026-10-08 用户拍板长期开**（T-40/T-41 等任务未清；全部任务完成后可恢复 `workspace-write`，备份 `settings.yaml.bak-permission-20261008`）。env `DSH_PERMISSION_MODE` **不生效**（被 settings 值覆盖，别再试）。danger 下**父进程直跑 pwsh 已实测可用**（RAND 直出 `RAND:0.349…`），子代理不再是 shell 的必要载体，仅用于打包长命令/并行。判别能否真执行：`node -e "console.log('RAND:'+Math.random())"`（编造不出随机数）。
坑（模型通道）：**默认 `nvida/z-ai/glm-5.3` 对 NVIDIA key 404**（在 /v1/models 列表但 chat 404，flash 版才 200）→ `agent-default-model` 现为 `freellmapi/nemotron-3-ultra-550b`（T-55 家族去重 pin：四客户端五家族互不重复，见计划-收口修复 §5；备份 `settings.yaml.bak-defaultmodel-20261008`、`settings.yaml.bak-t55-20261012`）。**禁 auto**：auto 路由不确定（实测曾落 codestral-latest），席位家族会漂移。

**子代理调用纪律（四轮实测踩坑，用子代理时必读）**：①必须 `run_in_background:false`（同步返回才有结果，后台模式取不到）；②一条消息只发一个工具调用，一次一个子代理（并行批量会互相踩）；③子代理上限 8（active child limit）；④`job_output` 是后台 job 的 API，**子代理 id 在那里全是 unknown job**，取结果只认同步返回 / `list_agents` 看状态；⑤禁止 `interrupt_agent`（掐死未完成子代理 → 误判 FAIL）；⑥子代理会幻觉拒绝（"无工具/深度限制"）→ 原样重起最多 3 次；⑦**期望值别写进子代理 prompt**（会被照抄伪造结果）；⑧一个 mega 子代理打包全部命令 > 分散多子代理；⑨子代理会往仓库根写垃圾文件（实测 waiting.txt/report.txt）→ prompt 明令禁写文件、报告只进 final 文本（M5）。

## 2b. dsh headless 派发操作模板（2026-10-08 四单实战验证）

1. **prompt 落盘**（M9 字节通道，UTF-8 无 BOM）：`[IO.File]::WriteAllText("$env:TEMP\x.txt", $text, [Text.UTF8Encoding]::new($false))`，stdin 传入 `Get-Content -Raw x.txt | & npx … --profile headless --json 2> err.txt | Out-File out.jsonl -Encoding utf8`。
2. **派发即返回 + 独立短轮询**：`Start-Process pwsh -ArgumentList … -PassThru` 立刻结束派发命令；另起 ≤120s 的轮询命令查 `out.jsonl`（数行数/`"type":"final"`）。反例：派发命令里 `WaitForExit(20min)` 长挂 → 被外层 harness `ChildProcess.kill` 连坐杀掉（实测发生 3 次）。
3. **PowerShell 引号三坑**：①外层双引号字符串里的 `$env:VAR` 会被**本层插值吃掉** → 反引号转义 `` `$env:VAR `` 或干脆在**调用进程**设 env；②`Start-Process -ArgumentList` 会**剥掉内嵌引号** → env/带空格参数走进程继承，别塞进 `-Command` 字符串；③嵌套引号命令优先拼变量再传。
4. **读结论**：`Get-Content out.jsonl | Where-Object { $_ -match '"type":"final"' } | % { ($_|ConvertFrom-Json).text }`；审计细节看 `tool_call`/`tool_result` 事件。
5. **派发 prompt 必带纪律块**（模板）：只读红线（禁改文件/禁 git 写/禁跑 titan-execute）、一次一工具调用、单子代理同步、禁 interrupt、禁写文件、期望值只给判定不给子代理、末行固定 `VERDICT:` 格式。
6. **先冒烟再派真活**（见到 final 再上量）；收尾校验产物：glob 新落盘文件 mtime、`git status` 查垃圾。

## 2c. Kilo headless 派发纪律（M4 验收清单派发必读；2026-10-11 T-53 两轮 14 项实测）

1. **清单给死命令模式**：Kilo 的模型会自创 `Invoke-RestMethod <url> | ConvertFrom-Json`——Invoke-RestMethod 已自动解析 JSON，再管道二次解析必报 `Unexpected character encountered while parsing value: @`。凡 HTTP 检查，prompt 直接给模板 `$r = Invoke-RestMethod '<url>'; $r.<prop>`，不让其自由发挥。
2. **非 ASCII 一律走 .py 探针**：Kilo 命令层的中文/emoji 会被 GBK 误解码（实测 '糖果'→'绯栨灉'，靠字节巧合才仍能匹配，极脆弱）。探针必须纯 ASCII 写盘（中文/emoji 用 `\uXXXX`/`\UXXXXXXXX` 转义字面量）再 `python` 执行；勿在命令行内联非 ASCII 模式串。
3. **证据逐项自证**：未实际执行的检查项会照抄上一项的报错充当证据（实测 3 项共用同一报错，见 tmp/t53-kilo-verify/kilo-out-run1.txt）。prompt 必须写死"每项 CHECK 的证据必须是该项自己命令的原始输出摘录"。
4. **两轮协议**：首轮 FAIL 先定性——被验物缺陷 vs 验证器命令缺陷（后者不算被验物 FAIL）；修正命令模板后补测轮只重跑缺陷项；两轮原始输出都入库为证。prompt 骨架模板：`tmp/t53-kilo-verify/prompt-round{1,2}.txt`。
5. **死命令模板零引号复杂度**（2026-10-16 T-82/T-83 M4 三轮教训）：Kilo 会擅自改写复杂命令（实测把 `import()` 绝对路径换成不存在的文件、`rg` 换成不在 PATH 的裸命令）——模板越简单越不易被改；Windows 下 `node -e` 动态 import **必须 `file:///` URL**（无 scheme 的 `D:/` → ERR_UNSUPPORTED_ESM_URL_SCHEME）；`rg` 字面量模式含 `{}` 等元字符**必加 `-F`**（否则 regex parse error）。**被改写的执行轮输出作废**（不算证据），修正模板后只重跑缺陷项；作废轮也原样入库留审计（先例：orchestrator/audit-evidence/t82-t83-m4-kilo-20261016.txt 三轮结构）。

## 3. 相互调用矩阵与选型

四个客户端互调全部 ✅（任一方有 shell 即可 spawn 另外三方）。

| 任务 | 选谁 |
|---|---|
| 改码修复 | opencode 或 cline（kilo 不可写） |
| 只读扫描/找茬 | kilo（免费模型，findings 产出实测最强） |
| M4 交叉验证 | 任选**非作者**客户端 |
| 非关键路径（复检/测试/小杂活） | Harness |
| 禁区 | Harness **禁写** titan-execute.mjs / OpenClaw 配置 / executor profile / CDP 链路（AGENTS 分工矩阵） |

## 4. 红线（所有调用方共用）

1. 密钥只走 env `FREELLMAPI_API_KEY`，不进 URL、不进命令行（M7）。
2. 改码任务必须隔离（fixer-pool 五道防线：clone → rename `.agents` 屏蔽 skills → 删 origin → cwd 红线 → 跑前后主树指纹比对），**禁止在主树 cwd 直接跑修理工**。
3. prompt 含反斜杠 / `$` / 反引号 → prompt 落临时文件或 `orchestrator/safe-write.mjs` 字节通道，禁拼 shell `-e` 字符串层（M8#6 + M9）。
4. 必带超时 + `taskkill ... /T /F`；输出设上限（scan-flow stdout 8MB 截断；CLI 落盘 50MB 硬上限）。
5. 模型 pin：所有席位（含只读扫描）一律显式 `-m <具体id>`（T-55 家族分离落地，scan-flow 缺省已改 pin：opencode=deepseek-v4-pro/cline=glm-5.3/kilo-codestral/harness=nemotron-550b；auto 路由不确定且实测落 codestral-latest=撞 Kilo 家族）。**Cline headless M4 例外**：pin 写在预种 providers.json 的 `model` 字段（裸名），运行时省 `-m`——传 `-m` 整串会 404，见 §2 Cline 新方法。
6. 改 `orchestrator/` 代码后必跑 `node orchestrator/verify-gate.mjs`（M8#7）。

## 5. 坑速查

| 症状 | 根因 → 解法 |
|---|---|
| spawn 秒退 status=null | node 不能直跑 `.cmd` → PowerShell 包装 |
| 多行 prompt 引号错乱 | prompt 落临时文件（`Get-Content -Raw` 传入） |
| cline 卡住请示 | `--auto-approve true`（安全靠隔离层+prompt 禁令） |
| cline `-m` 两斜杠报 invalid model format、带前缀整串又 404 | `-m` 必须单斜杠但 Cline 把 `-m` 整串原样发网关 → 裸模型名预种 providers.json、运行省 `-m`（§2 Cline 新方法） |
| opencode 跑完不退出 | 外层 timeout 强杀 + 进程清理 |
| 模型路由到 codestral-latest | 没 pin → 每次显式 `-m` 具体 id |
| kilo 改不了码 | 已知局限（finder only），换执行器接力 |
| dsh headless 无输出/503 | 冷启动慢或后端瞬时挂 → 冒烟先行，看 `--json` 的 final 事件 |
| dsh 模型 404 PI_AI_ERROR | 默认 nvida 模型对该 key 未开通 → agent-default-model 换 freellmapi/auto |
| dsh 子代理 pwsh GPO SecurityException | 受限令牌沙箱（workspace-write 下父子同中招）→ defaultPreset=danger-full-access（**2026-10-08 起长期开**，任务清完再恢复 workspace-write） |
| dsh 子代理"无工具/深度限制"拒绝 | 幻觉拒绝 → 原样重起 ×3；RAND 探针判真伪 |
| dsh 后台子代理取不到结果 | job_output 不认子代理 id → run_in_background:false 同步取 |
| 派发命令报 ChildProcess.kill | 派发里长 WaitForExit 被连坐杀 → 派发即返回 + 独立 ≤120s 短轮询 |
| `$env:VAR` 在命令里变空 | 外层双引号把它插值吃掉 → 反引号转义或调用进程设 env（子进程继承） |
| Start-Process 参数引号丢失 | ArgumentList 剥内嵌引号 → env/带空格参数走进程继承，别进 -Command 串 |
| 子代理往仓库根写垃圾文件 | 违反 M5（实测 waiting.txt/report.txt）→ prompt 明令禁写、报告只进 final |
| 子代理结果"太符合期望" | 期望值进 prompt 被照抄伪造 → RAND 探针 + 原始输出逐行审计 |
| Kilo 把 Invoke-RestMethod 再管道 ConvertFrom-Json | 双重解析（对象 ToString 成 `@{...}`）必报 Unexpected character @ → 清单给死命令模式（§2c-1） |
| Kilo 命令行中文/emoji 模式串乱码 | 其命令层按 GBK 解码 UTF-8（'糖果'→'绯栨灉'） → 纯 ASCII .py 探针 \u 转义再执行（§2c-2） |
| Kilo 未执行项照抄他项报错当证据 | 模型偷懒（实测 3 项共用同一报错） → 逐项自证纪律 + 两轮协议（§2c-3/4） |
| Kilo 无头权限 auto-reject | 7.8.8 起 bash 请求无审批即拒，但报错提示 `pass --auto` → **加 `--auto` 即全放行**（2026-10-16 实测 git/node 真执行）；别再改 .kilo/kilo.json 或弃派 |
| 网关模型报 `no tool-calling support` / `1 model lacks tool-calling` | 网关库 `supports_tools=0` 陈旧（上游真支持 tools，先查 OpenRouter supported_parameters）→ config model edit 补 `supportsTools:true` + 重启网关（§2 Cline 轮换段） |
| Kilo 擅自改写验证命令（换路径/换裸命令） | 模板零引号复杂度 + 声明逐字复制；被改写轮输出作废并入库标注（§2c-5） |
| node -e 动态 import 报 ERR_UNSUPPORTED_ESM_URL_SCHEME | Windows 绝对路径缺 scheme → 用 `file:///D:/...` |
| rg 模式含 `{}` 报 regex parse error | 字面量模式加 `-F`（repetition quantifier 误读） |

v1 修理工路径详版（克隆隔离 + work-order 全流程）：`orchestrator/TUTORIAL-fixer-clients-headless.md`。
