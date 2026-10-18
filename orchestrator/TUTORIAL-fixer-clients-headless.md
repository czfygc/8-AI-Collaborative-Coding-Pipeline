# 修理工客户端后台调用教程（OpenCode / Cline headless）

> 依据：orchestrator/fixer-pool.mjs（224 行）+ orchestrator/adapters.json + orchestrator/limits.json 实测源码。
> 场景：跑测流水线（autopilot / fixer-pool）时，如何在后台无人值守地驱动 OpenCode 和 Cline 干活。

---

## 0. 一句话总览

```
work-orders.json（in_progress + target_cmd + base_commit）
        │
        ▼
fixer-pool.mjs 串行循环（池锁 + 每日计数 + 主树指纹 fpBefore）
        │  slotFor(owner): fixer-cline→fixerA, fixer-opencode→fixerB
        ▼
cloneFor(): git clone 到 %TEMP%/titan-fix-<WO>（5 道隔离处理）
        │
        ▼
buildPrompt(): 拼任务 prompt（锚点/验收/禁止清单/提交信息）
        │
        ▼
runFixer(): 分两路 spawn（见 §3/§4）—— 这就是"后台干活"的核心
        │
        ▼
判定：hasCommit(克隆内有提交) + checkTarget(target_cmd 过) + 指纹未漂移
        │
        ├─ 成功 → git fetch 取回 fix/<WO> 分支进主仓
        └─ 失败 → 克隆内 reset --hard 回 base → 换 fallback 模型重试
```

---

## 1. 前置条件

| 项 | 实际值 / 位置 | 说明 |
|---|---|---|
| cline 二进制 | `<SB>/node_modules/.bin/cline.cmd` | SB=sandbox 目录（fixer-pool.mjs L33）|
| opencode 二进制 | `<SB>/node_modules/opencode-windows-x64/bin/opencode.exe` | 必须显式装 opencode-windows-x64，postinstall 自动解析本机会失败（L34 + adapters conditions）|
| 模型 API key | env `FREELLMAPI_API_KEY` | L46 从 Windows User 环境变量自动读取注入进程；密钥不进 URL/命令行 |
| 槽位/模型/超时 | orchestrator/limits.json → fixer_scheduler.slots | pin + fallback 链、attempt_timeout_ms=600000（10 分钟）|
| 客户端用法约定 | orchestrator/adapters.json → clients | headless_entry、run flags、已知坑的权威记录 |

当前槽位配置（limits.json）：

```json
"fixerA": { "client": "cline", "pin": "claude-sonnet-5", "fallbacks": ["mistral-code"] }
"fixerB": { "client": "cline", "pin": "mistral-code",  "fallbacks": ["deepseek-v4.1-flash"] }
```

注意：fixerB 原本是 opencode，**因隔离失效（git pull 误用、超时、绝对路径越界）已整体替换为 cline**。代码里 opencode 分支（runFixer else 分支）仍保留备用。

---

## 2. 什么决定走 Cline 还是 OpenCode？

`slotFor(owner)`（fixer-pool.mjs L80-81）：

- 工单 owner = `fixer-cline` → 槽位 fixerA
- 工单 owner = `fixer-opencode` → 槽位 fixerB
- 槽位的 `client` 字段决定实际 CLI（现在两槽都是 "cline"）

即：**工单 owner 决定槽位，槽位配置决定客户端和模型**。改 limits.json 就能换档，代码不用动。

---

## 3. Cline 后台调用（当前主力，两槽都在用）

### 3.1 为什么不能直接 spawn

Windows 下 `spawnSync("cline.cmd", ...)` 实测 status=null 秒退 —— **Node 无法直接执行 .cmd**。解法：PowerShell 包装。

### 3.2 三步机制（fixer-pool.mjs L109-117）

**第 1 步：prompt 落临时文件**（避开命令行引号转义地狱）

```javascript
const pf = join(tmpdir(), "titan-fixer-prompt-" + Date.now() + "-" + Math.random().toString(36).slice(2,8) + ".txt");
writeFileSync(pf, prompt, "utf8");
```

**第 2 步：拼 PowerShell 命令**

```powershell
$p = Get-Content -Raw "<prompt临时文件>"
& '<cline.cmd路径>' $p --auto-approve true -P openai -m '<模型>' -c '<克隆目录>' --data-dir '<.cline-data>' 2>&1 | Out-String
```

参数含义：

| 参数 | 作用 | 为什么这么设 |
|---|---|---|
| prompt 走 `Get-Content -Raw` 读入变量 | 传给 cline 的第 1 位置参数 | 避免多行 prompt 在命令行里被引号截断 |
| `--auto-approve true` | 自动批准工具调用 | 实测 false 时连只读操作都会停下请示 → 无人值守必挂；安全靠隔离 + prompt 禁令 + 指纹校验 |
| `-P openai` | 走 OpenAI-compatible provider | 指向本地 FreeLLMAPI 网关 |
| `-m <模型>` | **每次显式 pin 具体模型 id** | pin 审计红线：禁 auto、禁依赖客户端缺省（auto 实测路由到 codestral-latest）|
| `-c <cwd>` | 工作目录 = 隔离克隆 | 绝不能传主仓（L103-105 有红线检查直接抛 [ISOLATION]）|
| `--data-dir` | 独立数据目录 `.cline-data` | 不污染交互式 Cline 的会话状态 |
| `2>&1 | Out-String` | stderr 并入 stdout | cline 输出为 NDJSON 且有 stderr 混入行，合并后逐行 try 解析 |

**第 3 步：spawnSync 同步等待（带超时）**

```javascript
return spawnSync("powershell", ["-NoProfile", "-Command", ps], {
  encoding: "utf8",
  timeout: timeoutMs,   // limits.json: attempt_timeout_ms = 600000（10 分钟）
  cwd,                  // = 隔离克隆目录
  stdio: ["ignore", "pipe", "pipe"]
});
```

### 3.3 一次性 auth（首次配置时）

```powershell
cline auth -p openai -k $env:FREELLMAPI_API_KEY -m claude-sonnet-5 \
  -b http://127.0.0.1:3001/v1 --data-dir <dataDir>
```

注意：auth 的 `-m` 也必须具体 id（pin 审计），每次运行仍须在命令行显式传 `-m`。

---

## 4. OpenCode 后台调用（备用分支）

机制简单得多，直接 spawnSync .exe，prompt 作为 argv（fixer-pool.mjs L120-122）：

```javascript
const cmd = OPENCODE_EXE;
const parts = ["run", prompt, "--format", "json", "-m", "freellmapi/" + m, "--pure", "--auto"];
return spawnSync(cmd, parts, { encoding: "utf8", timeout: timeoutMs, cwd, stdio: ["ignore","pipe","pipe"] });
```

参数含义：

| 参数 | 作用 |
|---|---|
| `run <prompt>` | headless 单次任务 |
| `--format json` | NDJSON 输出（7/7 可解析实测）|
| `-m freellmapi/<模型>` | 显式 pin（provider/模型 两段式）|
| `--pure` | 纯净模式，不加载项目配置干扰 |
| `--auto` | 自动批准工具 |

### 4.1 OpenCode 特有的 4 个坑（adapters.json probe1 记录）

1. 平台二进制必须**显式**装 `opencode-windows-x64`（postinstall 自动解析本机失败）
2. prompt 必须**显式禁止 git push**（沙箱无 remote 时它 push 失败后不退出）
3. **外层必须 timeout + 进程清理**（run 完成后 opencode.exe 常驻不退出）
4. `FREELLMAPI_API_KEY` 必须注入进程环境（配置里是 `{env:...}`）

---

## 5. 隔离五道防线（调用前 fixer-pool 自动做，教程复述以防手工跑丢）

调用**绝不能直接在主仓 cwd 跑**，否则就是 v1 隔离 breach。fixer-pool 的 `cloneFor()`（L126-138）：

1. `git clone --no-hardlinks` → `%TEMP%/titan-fix-<WO>`（每次重建）
2. `checkout -B fix/<WO> <base_commit>`
3. `rename .agents → .agents_fixer_off`（**屏蔽 workspace skills**：cline 自动加载 titan-four-party-consult 会把修理工带跑偏，v4.1 两跑实证）
4. `git remote remove origin`（**堵 r3 越界根因**：origin 泄露主仓绝对路径，模型 `git remote -v` 就能拿到并写主树）
5. `runFixer()` 入口红线：cwd 等于主仓直接抛 `[ISOLATION] 拒绝在主仓执行修理工`（L101-105，实测漏传 cwd 出过事故）

外加：跑前记录主树指纹 `fpBefore`（sha256 + git status），跑后比对，漂移即 **ISOLATION_BREACH 停链**。

---

## 6. Prompt 怎么拼（buildPrompt L85-98）

固定结构（数组 join）：

1. `源问题（<source_delta>）：<instruction>`
2. `目标：最小修复；锚点文件 <anchor.file> 第 N 行附近，匹配模式 <anchor.pattern>`
3. `验收（必须自己在本目录跑过且通过再提交）：1) <verify_cmd>  2) <target_cmd>`
4. `本地提交，提交信息严格为：[T-12] fix: <标题>（<delta id>）`
5. 改法提示：先定位【现状代码行】再替换，**目标写法只是示意，别拿它当 oldString 搜索**（防死循环）
6. 绝对禁止：改 cwd 之外文件 / git remote / fetch pull push / checkout reset restore stash / 只加注释充数
7. 尾行标注：`（当前槽位: fixerA，模型: claude-sonnet-5）`

---

## 7. 判定、回滚与取回（一整轮的收尾）

| 判定 | 依据 | 代码 |
|---|---|---|
| 有没有干活 | `hasCommit(clone, base)`：`rev-list --count base..HEAD > 0` | L151-156 |
| 干得对不对 | `checkTarget(clone, target_cmd)`：在克隆里跑 target_cmd，env 注入 `D_TITAN_ROOT=<clone>` | L141-149 |
| 有没有越界 | 指纹 fpBefore vs fpNow | L18-22 |

收尾：

- 成功 → `git fetch <clone> refs/heads/fix/<WO>:refs/heads/fix/<WO> -f` 取回主仓（L207）
- 失败 → 克隆内 `git reset --hard base` + `git clean -qfd`（L200-201）→ 换 fallback 模型重试（主挂降 fallback，双挂才 unavailable）
- 日志 → `orchestrator/audit-evidence/autopilot/fixer-logs/<WO>-<slot>-<model>.log`（截断 200KB，L188）

---

## 8. 手动单跑一次（教程实操）

```powershell
# 1) 演练（不真跑、不写状态）
node orchestrator/fixer-pool.mjs --dry-run

# 2) 真跑单条工单（需工单 status=in_progress + target_cmd + base_commit）
node orchestrator/fixer-pool.mjs --wo <WO-ID>

# 3) 看结果日志
Get-Content orchestrator/audit-evidence/autopilot/fixer-logs/<WO>-fixerA-*.log -Tail 50
```

前置检查：

1. FreeLLMAPI 网关活着（`http://127.0.0.1:3001/v1`，需 FREELLMAPI_API_KEY）
2. 池锁未被占（fixer-pool 有 PID 锁，双开会 exit 2）
3. 每日配额未满（fixer_tasks_per_client=4，计数在 `reviews/_autopilot/counters/<date>.json`）
4. 主树状态稳定（指纹基准要干净；limits/work-orders 自身改动属预期）

---

## 9. 常见坑速查表

| 症状 | 根因 | 解法 |
|---|---|---|
| spawn 秒退 status=null | Windows 直接 spawn .cmd | 走 PowerShell 包装（§3）|
| prompt 引号错乱 | 多行文本进命令行 | prompt 落临时文件（§3 第 1 步）|
| cline 停下来请示 | auto-approve=false | `--auto-approve true`（安全靠隔离层）|
| 修理工跑题去会诊 | clone 里 .agents 被加载 | rename .agents 屏蔽（§5 第 3 条）|
| 模型路由到 codestral-latest | 依赖 auto 缺省 | 每次显式 `-m <具体 id>`（pin 审计红线）|
| opencode 跑完进程不退 | opencode.exe 常驻 | spawnSync timeout 强杀 + 清理（§4.1-3）|
| 修理工改了主树 | cwd 传错 / 绝对路径越界 | 红线检查 + 删 origin + 指纹监视（§5）|
| 同文件两单互相覆盖 | 无区域锁 | 串行分组 + REFIX≤2（当前为串行机制验证阶段）|

---

**与 v2 关系**：本教程描述的是 v1 fixer-pool 路径（克隆隔离 + work-order）。v2 的 titan-execute 计划放弃克隆改主树串行执行 —— 届时 §3/§4 的 spawn 机制可直接复用，但 §5 的隔离层要换方案（详见 design-specs/V2-feasibility-20261003.md §4）。

生成：2026-10-03 ｜ 依据 fixer-pool.mjs / adapters.json / limits.json 实测源码