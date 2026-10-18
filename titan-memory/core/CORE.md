# TITAN 核心记忆（CORE.md ≤3000 字符，每轮常驻）

> 本文件由 `memory_core_remember` 工具写入，客户端启动时可选注入。
> 长尾事实存 `notes/*.md` 按需检索。数据即文件，可 git 版本管理。
>
> （发布版说明：原始核心记忆含本地工作区路径与内部研究方向等专属信息，不随仓库发布；本文件保留机制说明与通用示例，供新使用者参考。请看 `titan-memory/README.md`。）

## 用途

- 每轮常驻的核心记忆快照，≤3000 字符；超出部分写长尾笔记 `core/notes/*.md`（≤8000 字符/条）。
- 客户端可用 `memory_core_recall` 检索本文件与 `notes/`；用 `memory_core_remember` 写入。

## 常用命令

```powershell
node titan-memory/test.mjs          # 46/46
node orchestrator/verify-gate.mjs   # 语法+导入+自检
```