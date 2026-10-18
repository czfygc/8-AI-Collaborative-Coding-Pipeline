---
name: titan-cross-session-memory
description: "Use for cross-conversation persistent memory in TITAN: save a named memory ('做跨对话持久记忆，命名X' / '记住X' / '持久记忆X') with memory_remember, or load/recall it in any later session ('加载X' / '调出X' / '用跨对话持久记忆加载X') with memory_recall. Works regardless of model."
user-invocable: true
---

# Cross-Session Persistent Memory（跨对话持久记忆）

让一条命名记忆跨会话存活。两种模式，按用户消息判定，不依赖任何外部文档。

## 工具名按客户端不同（同一个存储）

| 客户端 | 工具名 |
|---|---|
| DeepSeek Harness | `memory_remember` / `memory_recall`（原生 8 工具） |
| OpenCode / Cline | `titan_memory_remember` / `titan_memory_recall`（MCP `titan`） |

读不到本表里的工具名就**换另一个名字试**，再不行改用兜底命令
`node titan-memory/cli.mjs recall '{"query":"X"}'`。三方写的是同一份
`~/.dsh/storages/dsh_memory.json`，A 存的 B 读得到。

## SAVE — 保存命名记忆

触发：用户说「做跨对话持久记忆，命名X」「记住X」「持久记忆X」「把这段存成 X」。

1. 提取记忆名 X（「命名」「记住」后面的标识符，如 `yyds`）。
2. 确定记忆内容：
   - 用户给了明确文本 → 直接用那段文本。
   - 用户没给 → 把当前会话里值得留到下次的东西压缩成一段（结论 / 状态 / 待办 / 禁忌），不得臆造。
3. 调用：
   `memory_remember(target="fact", kind="decision", tags=["cross-session-memory", "<X>"], text="<内容>")`
4. 把返回的 fact id 报给用户，并确认记忆名 X 已入库。

## LOAD — 加载命名记忆

触发：用户说「用跨对话持久记忆加载X」「加载X」「调出X」「读取记忆X」。

1. 提取记忆名 X。
2. 调用 `memory_recall(query="<X>")`。tag 命中优先，字面子串其次。
3. 命中 → 完整复述内容，附上 fact id。
4. 多条命中 → 列成清单让用户选。
5. 没命中 → 明确说「工作区里没有名为 X 的记忆」，不得编造内容。可提示检查拼写，或确认新会话是否还在同一个工作区。

## 硬边界（不可违反）

- 记忆是**工作区级**：绑定当前项目目录。新会话不在同一工作区，记忆就调不出来——这不是 bug。
  MCP 侧的工作区由 `TITAN_WORKSPACE` 固定（不是进程 cwd），所以换目录启动不会丢记忆。
- `memory_recall` 是**字面匹配**，不是语义匹配。query 必须用记忆里实际出现的词；记忆名本身最可靠，中英文都试。
  打分是三层：精确标签 → 模糊标签 → 文本子串；**模糊层会把 `titan` 当成 `titan-mcp-selftest` 的子串**，长 query 可能捞出不相干的旧条目，命中太多时改用记忆名本身。
- 容量：每工作区 300 条 fact，单条 ≤2000 字符。满了先 `memory_consolidate` 清理近重复。
- 内容不可臆造：`recall` 没结果就报没有，禁止凭记忆名猜内容。
- 默认写 `target="fact"`。只有用户明确要求「每次会话自动注入」才写 profile，且 profile 只有 8 条额度——**profile 只有 Harness 能写**，OpenCode/Cline 没这个工具。
