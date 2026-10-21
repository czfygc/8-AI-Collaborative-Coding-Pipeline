---
name: titan-tdd
description: "Use when building a feature or fixing a bug test-first, or when the user says 'TDD' / '红绿重构' / '先写测试' / '加回归测试'. TITAN red-green-refactor: confirm seams, one vertical slice per cycle, tests land in orchestrator/test/ and are listed in SUITES.md; every fix commit carries a regression test (R1)."
version: 1.0.0
requires: node
tests: manual: 走一次红绿重构并确认测试已进 SUITES.md
provenance: adapted:mattpocock/skills#unversioned-MIT
---

# TITAN TDD（红-绿-重构）

一个循环：**先写会失败的测试（红）→ 只写到通过（绿）→ 重构交给 code-review**。
本技能规定"什么算好测试、测试放哪、循环怎么走"，每一轮都适用。

来源：改写自 mattpocock/skills 的 `tdd`（MIT, Copyright (c) 2026 Matt Pocock），按 TITAN 仓库约定重写。

## 与 TITAN 流程的分工

| 事项 | 归属 |
|---|---|
| 这个任务该不该做、谁在做 | `ISSUE_REGISTRY.json`（M1） |
| 测试放哪、怎么写、循环规则 | 本技能 |
| 验收由谁做 | AGENTS M2：作者不许自己验收 |
| 写盘安全、体量纪律 | AGENTS M4（反斜杠通道、50 KiB 拆分线） |

## 好测试的标准

测试验证**行为**，不验证实现细节。代码可以整体重写，测试不该跟着改。
好的测试读起来像规格：`T-145 沙箱：大日志被压到预算内且保留关键信号` 一眼知道能力边界。

反面典型：

- **耦合实现**：mock 内部协作者、测私有函数、绕过接口查数据库。特征：重构就红，行为没变。
- **同义反复**：期望值用和被测代码同样的算法算出来（`expect(add(a,b)).toBe(a+b)`），永远不可能失败。期望值必须来自独立来源：已知字面量、手工算例、规格原文。
- **横切**：先写一大批测试再写实现。那是在测"想象的行为"。要**纵向切片**：一个测试 → 一个实现 → 下一轮。

## 接缝（seam）：测试写在哪

接缝 = 你观察行为的**公开边界**。测接缝，不测内部。

- 动手前先写下本次要测的接缝，并用一句话说明"能抓到什么 / 抓不到什么"。
- 新增/变更公开接口时，先和用户确认接缝（M6：给 2-3 个选项 + 推荐）。
- 测试选点优先级：关键路径 > 复杂逻辑 > 边界情况。不可能全覆盖，别假装能。

## 循环规则

- **红在绿前**：先让测试因正确的原因失败，贴出失败输出作为证据（M2）。
- **一次一片**：一个接缝、一个测试、一个最小实现。
- **不预支未来**：不写"以后可能要用"的测试或参数。
- **重构不占循环**：行为不变的结构调整放到 code-review 阶段做。

## TITAN 落地约定

1. **位置**：`orchestrator/test/<模块>.test.mjs`；用 `node:test` + `node:assert/strict`，零外部依赖。
2. **登记**：新测试文件必须加进 `orchestrator/test/SUITES.md` 的表格（Suite / 文件 / 覆盖）。
3. **跑法**：`node --test orchestrator/test/<文件>`；全量 `node --test orchestrator/test/`；闸门 `node orchestrator/verify-gate.mjs` 的 ④ 段会自动跑全量。
4. **临时目录**：`mkdtempSync(join(tmpdir(), 'prefix-'))`，`finally` 里 `rmSync(dir, { recursive: true, force: true })`，不污染仓库。
5. **确定性**：不依赖当前时间、随机数、网络、机器语言环境；需要时先播种/冻结输入。
6. **密钥**：fixture 里不放真实 token（M5）；日志类输入先脱敏。
7. **回归债 R1**：任何 fix 提交至少携带 1 个新测试；bug 修复先有红灯测试。
8. **证据**：把红灯与绿灯两次运行的原始输出摘录写进 `archive/evidence/T-xx/`，台账填 `evidence`。
9. **代码风格**：不加注释（除非用户要求）；错误信息给可操作的事实，不写空话。

## 完成判据

- [ ] 接缝已确认并记录
- [ ] 每个切片：红 → 绿，失败/通过输出都留证
- [ ] 新测试已登记 SUITES.md
- [ ] `node --test orchestrator/test/` 全绿，`verify-gate` 全绿
- [ ] 重构项已列出，交给 code-review（不在本循环内做）
