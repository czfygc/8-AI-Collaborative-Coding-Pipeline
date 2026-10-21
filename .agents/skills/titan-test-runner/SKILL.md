---
name: titan-test-runner
description: "Use when you need to run a project's tests and read only a compact structured result instead of the whole raw output (改代码→跑测试→修 的快闭环). Auto-detects vitest / jest / pytest / node:test / npm test, runs the suite, and returns pass-fail counts plus the failing case names and error lines as JSON or a short text summary. Use when the user says 跑测试 / 跑一下测试 / 测试失败 / test_run / 看看测试结果, or when you are fixing a failing test and want the failure list without scrolling megabytes of log. Works from any of the 4 TITAN clients (OpenCode / Cline / Kilo / DeepSeek Harness)."
user-invocable: true
version: 1.0.0
requires: node, git
tests: node --test orchestrator/test/run-tests.test.mjs
provenance: adapted:suimi8/dsh-test-runner#unversioned-MIT
---

# titan-test-runner —— 四客户端共享测试运行器

## 一句话

```powershell
node orchestrator/run-tests.mjs
```

**只回结构化摘要**（通过/失败统计 + 失败用例名与错误行 + 输出尾部），不倒整段原始测试输出——省 token、省一轮往返。

## 为什么需要它

原始 `node --test` / `pytest` 输出动辄几百上千行，模型要读完整个输出才能知道"哪几个用例挂了、为什么挂"。本工具把它压成一页摘要：

```
test_run framework=node exit=1 0.9s
command: node --test
SUMMARY: 42 tests -> 41 passed, 1 failed, 0 skipped
1) bad case
   AssertionError [ERR_ASSERTION]: Expected values to be strictly equal
```

## 参数

| 参数 | 说明 |
|---|---|
| `--cwd <目录>` | 在哪个目录跑（默认仓库根） |
| `--framework auto\|vitest\|jest\|pytest\|node\|npm-test` | 缺省 auto：package.json 依赖 → scripts.test → pyproject/pytest.ini/conftest → test 目录或 *.test.* |
| `--target <模式>` | 跑哪个文件/目录/用例（如 `tests/t.py::test_login`）；多个用空格分隔 |
| `--last-failed` | 只重跑上次失败（vitest `--lastFailed` / jest `--onlyFailures` / pytest `--lf`） |
| `--timeout <ms>` | 超时（默认 120000） |
| `--command <命令>` | 完全自定义命令（跳过框架探测与默认命令构造） |
| `--json` | 输出 JSON（给脚本/其它客户端消费） |
| `--tail <字符数>` | 输出尾部保留长度（默认 800） |
| `--max-failures <n>` | 摘要里最多列几个失败用例（默认 8） |

退出码：`0` = 全绿；`1` = 有失败/超时/执行错误；`2` = 用法错误。

## 典型闭环（写代码 → 改 → 测 → 验）

1. 改完代码，跑 `node orchestrator/run-tests.mjs --target orchestrator/test/<你的用例>.mjs`。
2. 只看摘要里的失败用例名 + 错误行——**不用**去翻原始输出。
3. 修完再跑一次；全绿再进 verify-gate 复核。

```powershell
# 一步到位：本仓全量回归（35+ 测试文件）
node orchestrator/run-tests.mjs --cwd <workspace> --framework node
```

## 三条硬约束（别绕过）

1. **target 不安全字符会被拒**（只允许路径/glob/`::` 用例名；`& ; $ \` >` `..` 等一律拒绝）——不可信文本不进 shell。
2. **解析失败必须退化安全**：只回 `exitCode` + 输出尾部，**绝不谎报通过**。看到 `note: 未解析到框架摘要` 就是没解析到，按 exitCode 判断。
3. **不改被测项目任何文件**：只读 + 执行测试命令。

## 边界（如实说明）

- 解析器覆盖 vitest / jest / pytest / node:test 的**默认 reporter 输出**；框架改版或自定义 reporter → 退化为 exitCode + 尾部。
- `go test` / `cargo test` 等没有专用解析器 → 走通用关键字统计，失败用例名可能拿不到（只有统计）。
- `last_failed` 在 node / npm-test 下不支持（会忽略并跑全量，输出里有 note 提示）。
- 本工具**不替代** verify-gate：verify-gate 是"过闸判定"（语法/导入/CLI/测试/自检/体量/动态 import 七段），本工具是"跑测试拿摘要"。改完 orchestrator 代码的规矩仍是 `node orchestrator/verify-gate.mjs` 全绿才允许提交。

## 出处与许可

思路借鉴 DeepSeek Harness 插件 [suimi8/dsh-test-runner](https://github.com/suimi8/dsh-test-runner)（MIT）——自动探测框架 + 只回结构化摘要。本技能是**仓内重写**：零依赖、客户端无关、可被四客户端共用，代码在 `orchestrator/lib/test-runner.mjs` + `orchestrator/run-tests.mjs`，测试在 `orchestrator/test/run-tests.test.mjs`。
