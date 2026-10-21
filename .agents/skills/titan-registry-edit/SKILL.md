---
name: titan-registry-edit
description: "在 ISSUE_REGISTRY.json 中新增/更新台账条目，自动处理 JSON 转义、逗号、括号、时间戳，四客户端统一调用，避免手工拼接 JSON 导致的语法错误。配合 orchestrator/pre-commit-check.mjs 做提交前校验。Works from any of the 4 clients."
user-invocable: true
version: 1.0.0
requires: node
tests: node orchestrator/pre-commit-check.mjs
provenance: original
---

# titan-registry-edit —— 台账条目自动编辑技能

## 问题背景

`ISSUE_REGISTRY.json` 是四客户端（OpenCode / Cline / Kilo / Harness）共享的单一任务台账（M0/M1）。历史上多次因手工 `editor` 替换 JSON 片段，导致 trailing comma、括号不匹配、引号转义错乱、重复条目等语法错误，整个文件不可解析，需反复修复（单条目编辑曾耗时 40 分钟）。

本技能统一通过脚本编辑台账，消除手工拼接 JSON 的语法错误。

## 1. 核心脚本：orchestrator/edit-issue.mjs

输入字段，自动生成条目并写回 `ISSUE_REGISTRY.json`，自动处理：
- JSON 转义（通过 `JSON.stringify`，无需手工转义引号/反斜杠）
- 逗号插入与括号闭合（通过对象方式 `root.issues[id] = entry` + `JSON.stringify`，无条目间逗号问题）
- 时间戳填充（claimed_at / in_progress_at / done_at，按状态自动）
- 合法性校验（type/status 必须在允许集合；id 不可重复）
- 写回前二次 `JSON.parse` 校验（防御性）

### 用法

```powershell
node orchestrator/edit-issue.mjs `
  --id T-131 `
  --title "示例条目标题" `
  --type fix `
  --status claimed `
  --owner cline `
  --description "条目说明文字" `
  --files ISSUE_REGISTRY.json `
  --files design-specs/xxx.md `
  --branch main
```

参数：
- `--id`（必填）：如 `T-131`
- `--title`（必填）
- `--type`（必填）：feat/fix/docs/chore/refactor/test/research
- `--status`（必填）：todo/claimed/in_progress/verifying/done/blocked
- `--owner`（必填）：客户端名（opencode/cline/kilo/harness）
- `--description`（必填）：条目说明
- `--files`（可重复）：涉及的文件路径
- `--branch`（可选，默认 `main`）
- `--registry`（可选，默认 `ISSUE_REGISTRY.json`）
- `--verifier`（可选，done 后填交叉验证者）

退出码：0=成功，1=运行时错误，2=参数错误，3=JSON 校验失败。

### T-153 起：台账写入走「高风险写确认闸」

台账属高风险目标，`edit-issue.mjs` 内部已内置写闸（`orchestrator/lib/write-gate.mjs`）：

- 默认 **attested 确认**：调用方用 `--by <客户端名>` 署名（缺省取环境变量 `TITAN_ACTOR`），工具自动提案 → 打 diff 摘要 → 落盘，并把提案写进 run 事件账本（`orchestrator/run-events/`，运行期数据）。
- `--reason "<理由>"`：写进提案与账本（审计用）。
- `--defer`：**只提案不落盘**（打印 proposal id 与三步命令），需要人工过 diff 再写时用：

```powershell
node orchestrator/edit-issue.mjs --id T-131 ... --defer
node orchestrator/run-gate.mjs diff    --proposal <proposal_id>
node orchestrator/run-gate.mjs confirm --proposal <proposal_id> --by <确认人>
node orchestrator/run-gate.mjs apply   --proposal <proposal_id>
```

闸门红线：落盘前会二次校验目标哈希——提案生成后台账被他人改过就拒写，必须重新提案。

### 示例（认领新任务）

```powershell
node orchestrator/edit-issue.mjs --id T-131 --title "xx修复" --type fix --status claimed --owner kilo --description "说明..." --files ISSUE_REGISTRY.json
```

## 2. 提交前校验：orchestrator/pre-commit-check.mjs

任何提交 `ISSUE_REGISTRY.json` 前，必须先运行：

```powershell
node orchestrator/pre-commit-check.mjs
```

校验项：
- 文件可 `JSON.parse`
- 存在 `issues` 对象
- 每条条目具备全部必填字段（id/title/type/status/owner/description/files/evidence/cross_validation）
- `type`/`status` 在允许集合
- 条目 `id` 与对象键一致（无重复）

CI 已在 `.github/workflows/ci.yml` 中追加 `ISSUE_REGISTRY JSON 校验` 步骤，脏提交会被 CI 拦截。

## 3. 四客户端统一调用（M0/M1）

| 客户端 | 调用方式 |
|---|---|
| OpenCode | 终端执行 `node orchestrator/edit-issue.mjs ...` |
| Cline | 终端/PowerShell 执行 `node orchestrator/edit-issue.mjs ...` |
| Kilo | 终端执行 `node orchestrator/edit-issue.mjs ...` |
| Harness | `pwsh` 或 `bash` 执行 `node orchestrator/edit-issue.mjs ...` |

所有客户端共用同一个脚本与同一份 `ISSUE_REGISTRY.json`，无客户端特有分支。

## 4. 红线

1. **禁止直接手工编辑 `ISSUE_REGISTRY.json`**（通过 `editor` 替换片段），必须走 `edit-issue.mjs` + `pre-commit-check.mjs`。
2. 提交 `ISSUE_REGISTRY.json` 前必须先运行 `pre-commit-check.mjs`，且 CI 必须绿。
3. 只暂存/提交自己的文件（`git add <路径>`），不使用 `git add -A` 除非逐项确认。
4. 提交信息格式：`[T-xx] 类型: 描述`。
5. **不得绕过写闸**（T-153）：台账写入必须经 `edit-issue.mjs`（内含提案+署名确认），高风险文件（AGENTS.md / 发布树 / 密钥）必须经 `orchestrator/run-gate.mjs` 提案→确认→落盘；密钥类目标永不经过该闸落盘。

## 5. P2：JSONL 拆分评估（已评估，暂不执行）

`ISSUE_REGISTRY.json` 是四客户端共享的单一事实源，所有客户端的读写逻辑都基于单一 JSON 对象。拆分为 JSONL（每行一个条目）虽可让单条编辑不破坏整体，但会：
- 改变所有客户端的读写逻辑（需统一迁移，有撕裂风险）
- 破坏现有跨客户端对文件的一致性预期
- 在条目数较少时（当前 34 条）收益有限

**结论：暂不拆分。** 以 `edit-issue.mjs` + `pre-commit-check.mjs` 消除手工编辑错误即可。若未来条目数显著增长（如超过 200 条）或并发编辑冲突频发，再重新评估 JSONL 拆分。
