# consolidate/ —— 记忆后台巩固

一轮对话结束后，记忆的「写」都在这里，全部 fire-and-forget、不进热路径。三个词别混（触发时机不同）：

| 动词 | 入口 | 触发时机 | 干什么 |
|---|---|---|---|
| **consolidate** | `index.ts` 的 `consolidateAfterTurn` | **每轮结束后**（`session.ts` 的 `recordTurnOutcome`） | 抽记忆 + 分类落库 + 课题巩固 + 人设增补，主写 `consolidateTurn` await 拿结果，其余后台跑 |
| **reflect** | `reflect.ts` 的 `reflectOnMemory` | **被 dream 调用**（空闲时） | 抽象升级：episodic → fact + 结构化身份 + 软特质 profile |
| **dream** | `dream.ts` 的 `dreamOnMemory` | **空闲时**（`server.ts` 每 3 分钟扫一次、无通话才跑） | 一整包：抽象升级（复用 reflect）+ 合并去重 + 清理矛盾 |

一句话：**consolidate 是「每轮的写」，dream 是「空闲时的酿」，reflect 是 dream 里的其中一步（抽象升级）。**

`memoryTurn.goalTurn.selfAddTurn` 三个 `*Turn.ts` 是 consolidate 的分步实现（记忆 / 成长课题 / 人设增补），各管一摊。
