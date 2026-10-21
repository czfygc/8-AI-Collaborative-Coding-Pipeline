# 工具输出沙箱（T-145 原型）使用说明

**一句话**：大输出先在本地落盘，模型上下文里只放"摘要 + 证据路径"，需要细节时按行检索。

- 库：`orchestrator/lib/output-sandbox.mjs`
- CLI：`orchestrator/sandbox.mjs`
- 测试：`orchestrator/test/output-sandbox.test.mjs`
- 实测：`archive/evidence/T-145/measurement-20261021.md`（4 个真实样本，合计 2.9 MB → 7.9 KB，99.73%）

---

## 1. 什么时候用

| 场景 | 做法 |
|---|---|
| 命令可能输出很多（`rg --files`、`git log`、目录扫描、构建日志） | `sandbox.mjs run ...` |
| 已经有现成大文件/日志 | `sandbox.mjs file <路径>` |
| 摘要里看到异常，需要具体行 | `sandbox.mjs search <artifact> <关键词>` |
| 想知道累计省了多少上下文 | `sandbox.mjs stats` |

不适合：输出本来就很小（摘要开销反而更大）；需要逐字精确内容的场景（直接读文件）。

## 2. CLI

```powershell
# 执行命令：stdout/stderr 全量落盘，只打印摘要
node orchestrator/sandbox.mjs run --label <名字> [--dir <目录>] [--max-bytes N] [--timeout-ms N] -- <命令> [参数...]

# 已有文件：落盘 + 摘要
node orchestrator/sandbox.mjs file <文件路径> [--label <名字>] [--dir <目录>] [--max-bytes N]

# 检索原始输出（默认子串、忽略大小写；--regex 用正则）
node orchestrator/sandbox.mjs search <artifact路径> <关键词> [--max N] [--context N] [--regex]

# 账本聚合
node orchestrator/sandbox.mjs stats [--dir <目录>]
```

- 默认目录：`archive/sandbox/`（已 gitignore）；产物在 `artifacts/`，账本为 `ledger.jsonl`。
- 默认摘要预算：4096 B（`--max-bytes` 可调，最小 512 B）。
- `run` 的退出码跟随子命令（子命令失败 = 1），便于脚本串联。

## 3. 摘要里有什么

```
[SANDBOX DIGEST] label=big source=...
bytes=279518 lines=27 sha256=xxxxxxxxxxxx budget=4096
signals: error=3 warn=1 urls=6 paths=12
head:
1| ...
tail:
23| ...
error-samples:
- ...
top-repeats:
12x ERROR request # failed: connection timed out
```

- `signals`：错误/告警行数、URL 与路径计数。
- `top-repeats`：把数字/长十六进制归一后折叠同一类日志，`Nx` 显示重复次数。
- `sha256` 前 12 位：与 artifact 对应，可校验没被改。
- 超预算时截断，并提示 `full output at artifact, use search`；摘要本身不会再膨胀。

## 4. 库 API（脚本/流水线内用）

```js
import { sandboxOutput, searchArtifact, readLedger, summarizeLedger } from './lib/output-sandbox.mjs';

const r = sandboxOutput({ content: out, label: 'build', source: 'npm run build' });
r.digest.text;        // 摘要文本（送上下文）
r.meta.artifact;      // 原始输出路径（证据）
r.measured;           // { originalBytes, digestBytes, savedBytes, savingPct }
```

`storeArtifact` / `digestContent` / `measure` / `recordRun` 可单独组合。

## 5. 已知边界

1. 只治理"拿到的输出"，不做 hooks 强制拦截；需要在调用侧养成 `run/file` 优先的习惯。
2. 摘要按行截断（240 字符/行），超长单行内容靠 `search` 取回。
3. `search` 为线性扫描，未建索引；100 MB 级产物需要再加索引层。
4. artifact 里可能含敏感信息（日志中的令牌等）：默认目录已 gitignore，外发前仍需人工脱敏。
