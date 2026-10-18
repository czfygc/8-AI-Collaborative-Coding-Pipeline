# titan-memory — 四客户端共用的跨会话持久记忆

让 **DeepSeek Harness / Cline / OpenCode / Kilo Code** 读写**同一份**长期记忆。

| 客户端 | 接法 | 工具名 | 状态 |
|---|---|---|---|
| DeepSeek Harness | 原生 `dsh-native-memory` 插件（**未改动**） | `memory_remember` 等 8 个 | 本来就有 |
| OpenCode | `opencode.json` → `mcp.titan` | `titan_memory_remember` 等 6 个 | 本次接通 |
| Cline | `.cline/mcp.json` + `~/.cline/data/settings/cline_mcp_settings.json` | `titan_memory_remember` 等 6 个 | 本次接通 |
| Kilo Code | `.kilo/kilo.json` → `mcp.titan`（env `TITAN_CLIENT=kilo`） | `titan_memory_remember` 等 6 个 | 已接通 |
| 兜底 | `node titan-memory/cli.mjs <cmd> [json]` | 6 个子命令 | 任一能跑 shell 的客户端可用 |

**共享的是存储，不是进程。** 四方都读写同一个文件：

```
~/.dsh/storages/dsh_memory.json
```

Harness 继续用它自己的八个工具（含 `memory_edit` / `memory_forget` / `memory_profile` / `memory_import`），
另外三家用本目录的 MCP server。因为指向同一份 JSON，A 客户端存的 B 客户端读得到。

## 本目录提供的 6 个工具

刻意少于 Harness 的 8 个 —— 只做**不依赖 DSH 运行时**的那部分：

| 工具 | 说明 |
|---|---|
| `memory_remember` | 增/改一条 fact。`text` 必填非空；`kind` ∈ preference\|fact\|convention\|decision；`tags` 自由；传 `id` 即更新。≤2000 字符、每工作区 ≤300 条 active |
| `memory_recall` | 确定性关键词扫描。三层打分：**精确标签 +3 → 模糊标签 +1 → 忽略大小写文本子串 +2**，多词短语再 +4；同分按 `updatedAt` 新者优先。不传 query 列最新。返回 fact id |
| `memory_search` | 扫**过往会话日志**（`~/.dsh/sessions/` 下的 zstd JSONL），字面匹配，每会话取一段摘录。覆盖"从没被提升成 fact"的原始对话 |
| `memory_consolidate` | 只读报告：剩余容量 + 近重复合并候选（token 集 Jaccard ≥0.55，取前 5） |
| `memory_core_recall` | **dsh-core-memory 风格本地检索**（纯 markdown 文件，与 DSH fact 表共存不冲突）：读 `<ws>/titan-memory/core/CORE.md`（核心记忆，≤3000 字符，每轮常驻候选）+ 关键词打分 `core/notes/*.md` 长尾笔记。零网络请求；关键词非语义，同义改写可能漏 |
| `memory_core_remember` | 写核心记忆 markdown（`CORE.md`，≤3000 字符）；传 `note=<id>` 写长尾笔记（`notes/<id>.md`，≤8000 字符/条）。文件可 git 版本管理 |

### 为什么只有 4 个（MCP 侧）+ 2 个 core 工具

- `memory_edit` / `memory_forget` / `memory_profile` —— 纯表操作，**留给 Harness**，避免两边功能重复。
- `memory_import` —— 需要 DSH 的 session-query 句柄。
- `memory_search` 的 DSH 版本走 sqlite FTS（`session-search.sqlite` ~200MB）。本目录的实现改为直接解日志，**结果排序与 Harness 不完全一致，但能力等价**。
- `memory_core_*` —— 2026-10-17 用户指令：dsh-core-memory（GitHub 404）思路落地为**共存增强**（不替换 titan-memory 也不替换 DSH fact 表）：纯 markdown + Node 原生 fs、零构建零依赖离线可用、数据即文件可 git 版本管理。检索本地打分，代价自述：关键词检索不是语义检索。

## 关键实现事实（踩过的坑）

1. **会话日志是一个文件里拼接几千个 zstd frame**，不是单个 frame。
   `zstdDecompressSync` 和流式解压**都只吃第一帧**（10MB 文件解出 199 字节）。
   因此按 magic `28 B5 2F FD` 定位帧起点逐帧解码，解不出或不以 JSON 开头的丢弃。
2. **`workspacePath` 必须显式给**。MCP server 的 cwd 由客户端决定，而 fact 表按工作区精确分域 —— cwd 错一位就召回 0 条。
   所以四份配置里都写死了 `TITAN_WORKSPACE=D:/TITAN_ARCHAEOLOGY`。
3. **DSH 可能不认我写的 fact**。写盘前 `assertShape()` 逐字段校验 DSH 的 `FactSchema`
   （id/workspacePath/kind/text/tags/sessionId/seq/createdAt/updatedAt/state），
   任何一个不合法就**拒绝整次写入** —— 一行坏数据会让 Harness 的插件打不开整个 domain。
4. **并发**：我们自己的写入者用 `*.titanlock` 文件锁（陈旧 10s 自动抢、5s 超时抢）。
   DSH 不参与这把锁 —— 实测它只在真正操作记忆时才写文件（挂了 6 小时 mtime 不动），窗口很小。
   每次写盘前先留 `.bak`，写入走 `tmp + rename` 原子替换。
5. **打分/去重算法是逐行复刻** `dsh-native-memory`（MIT, highland0971）的纯函数，
   保证同一个 query 在 Harness 和 MCP 两侧给出相同排序。

## 环境变量

| 变量 | 作用 | 缺省 |
|---|---|---|
| `TITAN_WORKSPACE` | fact 表的 workspace 域 | `process.cwd()` |
| `TITAN_CLIENT` | 写入 fact 的来源标记 `mcp:<client>` | `unknown` |
| `TITAN_MEMORY_FILE` | 存储文件路径 | `~/.dsh/storages/dsh_memory.json` |
| `TITAN_SESSIONS_DIR` | 会话日志根目录 | `~/.dsh/sessions` |

## 验证

```powershell
cd D:\TITAN_ARCHAEOLOGY
node titan-memory\test.mjs          # 46/46：协议协商、往返、DSH schema、core memory、错误路径、清理不留痕
node titan-memory\verify-cline.mjs  # 14/14：Cline 接线回归
node titan-memory\cli.mjs recall '{"query":"10810","limit":5}'
node titan-memory\cli.mjs consolidate
```

`test.mjs` 会真实写入再**自行删除**测试 fact，跑完 `active facts` 数量复原。

## 文件

| 文件 | 职责 |
|---|---|
| `store.mjs` | 文件锁、读写、FactSchema 校验、recall 打分、consolidate |
| `search.mjs` | 会话日志定位 + 多 frame zstd 解码 + 字面扫描 |
| `core-store.mjs` | core memory + 长尾笔记（纯 markdown，dsh-core-memory 思路） |
| `server.mjs` | 零依赖 MCP stdio server（换行分隔 JSON-RPC 2.0） |
| `cli.mjs` | shell 兜底，同语义 |
| `test.mjs` | 端到端测试 |

**零 npm 依赖** —— 本机没有 `@modelcontextprotocol/sdk`，且 M7 要求不装用不上的东西。
`zstd` 用 Node 24 内置的 `node:zlib`。
