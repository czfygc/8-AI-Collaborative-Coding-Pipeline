# TITAN 工程工作流技能（T-146）

五个从 `mattpocock/skills` 借鉴、按 TITAN 约定重写的技能。**只吸收机制，不导入插件**：全部是纯 Markdown，无脚本、无网络、无权限声明。

## 技能清单

| 技能 | 调用层 | 什么时候用 | 上游来源（MIT） |
|---|---|---|---|
| `titan-grilling` | 模型可调用 | 需求/设计有歧义，开工前把设计树问穿 | `productivity/grilling` |
| `titan-tdd` | 模型可调用 | 新功能或修 bug 的测试先行循环 | `engineering/tdd` |
| `titan-diagnosing-bugs` | 模型可调用 | 难 bug / 性能回归，先造红色反馈回路 | `engineering/diagnosing-bugs` |
| `titan-code-review` | 模型可调用 | 对固定点以来的 diff 做双轴评审 | `engineering/code-review` |
| `titan-handoff` | 用户触发 | 会话收尾/换会话，压缩成交接文档 | `productivity/handoff` |

上游许可：MIT License, Copyright (c) 2026 Matt Pocock。
每个技能文件顶部注明来源；改写幅度足以适配 TITAN，但仍保留原许可署名。

## 职责分工（防与 M1-M7 打架）

| 层面 | 权威来源 | 说明 |
|---|---|---|
| 做什么、谁在做、进度 | `ISSUE_REGISTRY.json` + AGENTS M1 | 台账永远是任务状态的唯一事实 |
| 流程法（认领/验收/中断/写盘/密钥） | AGENTS M1-M7 | 技能不得放宽或绕过 |
| 技术做法（TDD 循环、诊断阶段、评审两轴、盘问轮次） | 本目录各技能 | 技能只规定"怎么做得靠谱" |
| 检查怎么跑、证据放哪 | AGENTS M2 + 各技能落地约定 | 命令与目录两处一致 |

**冲突时的优先级**：AGENTS.md（宪法层）> ISSUE_REGISTRY（状态层）> 技能（方法层）。
技能里出现与 AGENTS 冲突的写法，按 AGENTS 执行并提 issue 修技能。

## 串联方式

```
需求含糊 ──titan-grilling──> 决定清单/设计文档 ──M1 认领──>
   ├── 新功能 ──titan-tdd──> 红绿循环 ──┐
   └── 难 bug ──titan-diagnosing-bugs──> 修复+回归 ──┤
                                                    v
                              titan-code-review（双轴）──> M2 非作者验收 ──> 台账 done
                                                    |
                                         会话收尾 ──titan-handoff + 共享记忆
```

- 盘问产出决定，不产出代码；确认后才认领任务。
- TDD 与诊断都要求"先有会红的证据"，两者共用 `orchestrator/test/` 与 `archive/evidence/T-xx/`。
- 双轴评审是**自检**；M2 的最终判定仍必须由非作者客户端给出。
- 交接不是结束：M3 要求 WIP 已提交或台账已回退，M7 要求记忆已落盘。

## 维护规则

1. **目录名 = frontmatter `name`**，文件名固定 `SKILL.md`；新增技能必须能被 `orchestrator/test/skills-frontmatter.test.mjs` 校验通过。
2. **一个技能一件事**：超过 ~150 行先想是否该拆；细节放同目录附件，SKILL.md 只做路由（渐进披露）。
3. **不写死模型名/客户端**：需要后台调客户端时引用 `titan-headless-clients`，不在本目录复制命令模板。
4. **英文关键词 + 中文说明**：description 里同时放触发词（中文口语 + 英文术语），便于各客户端匹配。
5. **不重复 AGENTS**：只写 AGENTS 没规定的技术步骤；流程条款给指针。
6. **变更要过闸**：改 `.agents/skills/` 后跑 `node --test orchestrator/test/skills-frontmatter.test.mjs` 与 `node orchestrator/verify-gate.mjs`。
