# titan-cleanup — 整合清理（大扫除）技能

> 适用：TITAN 工作区定期/空间紧张时的整合清理。目标：腾磁盘空间 + 整理知识库 + 不丢规则。
> 触发词：大扫除 / 整合清理 / 腾空间 / 清理硬盘 / cleanup。
> 修宪级纪律：执行前 `git status` 确认无冲突；清理**可逆项**（缓存/临时文件）优先，**不可逆项**（记忆/会话）需用户确认；M4 交叉验证。

---

## 0. 清理哲学（四问）

1. **能重建吗？** → 能重建的（npm 缓存、浏览器 Cache、Temp）放心删
2. **有备份吗？** → 没备份的（共享记忆、会话日志）先备份再删
3. **测试依赖吗？** → 测试夹具（`_fixture_*`）**不删**
4. **被台账引用吗？** → 引用的证据进 `archive/evidence/`；一次性探针/驱动删；`tmp/` 永远只放一次性文件

## 1. 清理清单（按释放量排序）

| 优先级 | 目标 | 命令/位置 | 释放量 | 风险 |
|---|---|---|---|---|
| P0 | npm 缓存 | `npm cache clean --force` | ~1-2 GB | 零（可重建） |
| P0 | chrome-cdp-profile 缓存 | 删 `Default\Code Cache`/`Cache`/`Service Worker`/`GPUCache`/`Dawn*` + 顶层 `Safe Browsing`/`GPUPersistentCache`/`extensions_crx_cache`/`Crashpad`/`CertificateRevocation`/`component_crx_cache` | ~1.5 GB | 零（自动重建，不丢登录态） |
| P1 | 旧会话日志 | 删 `~/.dsh/sessions/**/*.zst` 中 >7 天的 | ~50 MB | 低（活跃会话保留） |
| P1 | Temp 旧文件 | 删 `Temp` 下 `*-updater-*`/`node-compile-cache`/旧日志 | ~100-700 MB | 零 |
| P2 | C 盘 Chrome 遗留 | 删 `AppData\Local\Google\Chrome`（若 D:\chrome 自有 Data） | ~8 MB | 零 |
| P2 | 共享记忆去重 | 物理删除 100% 重复 loser（先备份 `.bak`） | KB 级 | 中（不可逆，需用户确认） |
| P2 | dsh/profiles .bak | 删 `profiles/**/*.bak*`（不碰 node_modules/） | ~0.2 MB | 低 |
| P2 | reviews 审查扫描史 | hex/`scan-*`/`t59*`/`legacy` 按 mtime 留最近 N，基础设施不动 | ~40 MB | 低（用户授权可覆盖证据保留规则） |
| P2 | 根目录过时报告/状态快照 | 无引用或过时 MD → `archive/reports/`；HARNESS 文件 → `HARNESS/` | KB | 零（git mv 可回溯） |

## 2. 红线（禁止删除）

- **登录态**：chrome-cdp-profile 的 `Cookies`/`IndexedDB`/`Local Storage`/`Login Data`
- **DSH 运行**：`~/.dsh/profiles/*/node_modules/`（@dsh-ops worker 载荷 684MB 必需）
- **活跃会话**：`~/.dsh/sessions/**/*.zst` 中 ≤7 天的
- **测试夹具**：`reviews/_fixture_*`（orchestrator 测试依赖）
- **reviews 基础设施**：`_autopilot`（活跃状态）、`_final_evidence`（验收证据）、`_samples`（台账引用）——修剪 reviews 时这些**不是测试史**
- **审计件**：`OPEN_SOURCE_SECRET_AUDIT`、`FREEZE_RECORD` 只读不改；其对已删文件的提及=历史事实记录，**不算悬空引用**
- **用户数据**：`D:\chrome\Data`（用户自有 Chrome User Data 942MB）
- **git 历史**：永不 `reset --hard`/`clean -fd`/`checkout -- .`

## 3. 执行模板（PowerShell）

```powershell
# P0: npm 缓存
npm cache clean --force

# P0: chrome-cdp-profile 缓存
$cdp='D:\TITAN_ARCHAEOLOGY\chrome-cdp-profile'
@('Default\Code Cache','Default\Cache','Default\Service Worker','Default\GPUCache','Default\DawnWebGPUCache','Default\DawnGraphiteCache') | ForEach-Object { Remove-Item "$cdp\$_" -Recurse -Force -ErrorAction SilentlyContinue }
@('Safe Browsing','GPUPersistentCache','extensions_crx_cache','Crashpad','CertificateRevocation','component_crx_cache') | ForEach-Object { Remove-Item "$cdp\$_" -Recurse -Force -ErrorAction SilentlyContinue }

# P1: 旧会话（>7 天）
$s='C:\Users\Administrator\.dsh\sessions'
Get-ChildItem $s -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\.zst' -and $_.LastWriteTime -lt (Get-Date).AddDays(-7) } | Remove-Item -Force

# P1: Temp 旧 updater
$temp='C:\Users\Administrator\AppData\Local\Temp'
Get-ChildItem $temp -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'updater|node-compile-cache' } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

# P2: 共享记忆去重（先备份！）
# 用 titan_memory_consolidate 找重复 → 物理删除 loser → 备份 .bak

# P2: dsh/profiles .bak
Get-ChildItem 'C:\Users\Administrator\.dsh\profiles' -Recurse -Filter '*.bak*' -File -ErrorAction SilentlyContinue | Remove-Item -Force
```

## 4. 验证

```powershell
# 空间释放
Get-PSDrive C | Select-Object @{N='FreeGB';E={[math]::Round($_.Free/1GB,2)}}

# 记忆系统仍正常（从 titan-memory 目录跑！）
cd D:\TITAN_ARCHAEOLOGY\titan-memory; node test.mjs   # 期望 46/46

# chrome-cdp-profile 大小
$cdp='D:\TITAN_ARCHAEOLOGY\chrome-cdp-profile'; $t=0; function s($d){foreach($f in Get-ChildItem $d){$p=Join-Path $d $f;if(Test-Path $p -PathType Container){s $p}else{$script:t+=(Get-Item $p).Length}}}; s $cdp; "{0:N0} MB" -f ($t/1MB)
```

**M4 交叉验证姿势（2026-10-18 实证最稳）**：验证逻辑写成 node 脚本落盘（如 `tmp/ofm-verify-*.mjs`），Kilo 只跑**单条 `node <脚本>` 命令**并贴原始输出——零引号模板一次过（13/13）。别给 Kilo 传 PowerShell `-Command`（`$` 被其工具层展开、中文 GBK 乱码，见坑表）。

## 5. 常见坑

| 症状 | 根因 → 解法 |
|---|---|
| 删了 `_fixture_*` 后 orchestrator 测试挂 | `_fixture_decision_api` 被 `test-decision-api-idempotency.mjs` 依赖 → 不删 fixture |
| 共享记忆删了匹配变多 | memory_forget 是软删除（archived 保留文件）→ 要腾空间需**物理删除** JSON 条目 |
| 清 chrome-cdp-profile 丢登录态 | 删了 Cookies/IndexedDB → 只删 Cache/Code Cache/GPUCache 等可重建目录 |
| npm 缓存清了下次 npx 慢 | 正常（重新下载），网络可达即可 |
| 共享记忆路径写成正斜杠召回 0 条 | `TITAN_WORKSPACE` 必须经 `normalizeWorkspacePath` 归一到反斜杠 |
| Start-Process 重定向 stdin 失败 | npx 不能直接重定向 stdin → 用 PowerShell 管道 `Get-Content -Raw x.txt \| npx ...` |
| Harness headless 冷启动慢/卡计算 | 已知坑 → 大任务可自己执行 + Harness 验证 |
| **staged 文件被并行提交扫走（三次实锤）** | 四客户端共享 `.git/index`，任何全量 `git commit` 会带走你已 staged 的**全部**文件（含别的会话的） | **staged 后秒提交，绝不隔并行窗口**；提交前 `git status` 逐项核对暂存清单，别人的未暂存 WIP 别 `add -A` |
| 从仓库根跑 titan-memory 测试**销毁真 CORE.md** | `WS=process.cwd()` 定位 core 路径 → 测试先用 selftest 覆写真文件再被 cleanup 删除（T-101 真凶） | 已修（启动快照+逐文件字节级写回）；本地验证仍优先 `cd titan-memory` 跑；**凡有跨文件副作用的测试必须先快照后清理** |
| Kilo 验证时 `$` 被吃掉+中文乱码 | Kilo 工具层先展开 `-Command` 内变量；GBK 误解码 UTF-8 | 验证逻辑写 node 脚本落盘，Kilo 只跑单条 `node <script>` |
| 修剪 reviews 把基础设施删了 | `_autopilot`/`_final_evidence`/`_samples`/`_fixture_*` 不是测试史 | 只删 hex/`scan-*`/`legacy`/`t59*` 扫描史，留最近 N + 四类基础设施 |
| 报告"被引用"不敢清 | docstring 提及=历史注释、审计表格=事实记录（M5 只读），均非运行依赖 | 报告类归位 `archive/reports/`（引用改路径或留作历史注释）；审计件不改，不追历史记录里的"悬空引用" |

## 6. 知识库关联

- 共享记忆：`titan-memory` MCP（remember/recall/search/consolidate + core 两件套）
- 核心记忆：`titan-memory/core/CORE.md`（常驻）
- 台账：`ISSUE_REGISTRY.json` **只放活状态**（todo/claimed/in_progress/verifying/blocked）；done 一律迁 `ISSUE_ARCHIVE.json`（查历史 T-xx 去这里）
- 流水线知识库：`orchestrator/`（代码+计划）、`archive/evidence/`（归档证据，被台账 description 引用的都该在这）、`archive/reports/`（归档报告）