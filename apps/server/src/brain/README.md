# brain/ 交接速查

这是「对话大脑」目录，包了 L3（决策）、L4（安全）、L5（状态/记忆）三层。L 编号来自 `docs/技术方案.md` 的分层，代码里注释也引用它们——**先把 L 编号映射到文件**，读起来会快很多：

| L 层 | 含义 | 文件 |
|---|---|---|
| L3 | 情绪打分 / 判定 / 生成 | `decide.ts`（打分+判定）、`turn.ts`（一轮决策 `planTurn`）、`assemble.ts`（召回+装配）、`generate.ts`（流式出句）、`generationGate.ts`（代际中止门：哪次生成还作数）、`topicSwitch.ts`（不感兴趣/敷衍→换话题）、`prompts.ts`（系统提示词）、`context.ts`（分层 user prompt）、`mood.ts`（心境 EMA）、`coach.ts`（教练意图+Frame 状态机）、`modeTracker.ts`（mode 防抖） |
| L4 | 安全红线 | `safety.ts`（危机+过度依赖，独立小模型）、`crisisResources.ts`（热线资源） |
| L5 | 状态 / 会话 / 记忆 | `modeTracker.ts`、`mood.ts`、`compress.ts`（历史压缩）、`recentSummary.ts`（跨通话概要）、`timeAnchor.ts`/`timeAware.ts`/`holiday.ts`/`timezone.ts`（时间感知）、`ontology.ts`（好奇心维度） |
| 记忆「写」 | 后台巩固（不进热路径） | `consolidate/`（memoryTurn / goalTurn / selfAddTurn / dream / reflect / afterTurn） |

**情绪概念 5 连**：`Affect`（本轮瞬时分）→ `MoodState`（多轮 EMA）→ `Mode`（casual/careful）→ `Stance`（陪/引）→ `EmotionTag`（TTS 语气）。详见 `packages/contracts/src/affect.ts` 顶部对照表。

**存储实现在哪**：`brain/*` 里只有「纯函数 + 接口类型」，真正的 Postgres 实现都在 `store/`（`memory.ts` 等）。`MemoryStore` 等接口契约在 `packages/contracts`。

**四个「分类器」**（LLM 判 → 抽 JSON → 解析 → 兜底）共用 `classify.ts` 的 `classifyJson` 骨架：`farewell.ts`（道别）、`coach.ts`（教练意图）、`memoryClassifier.ts`（记忆分类）；`segmentEmotion.ts`（逐句情绪）是「只出一个词」的非 JSON 输出，单独实现。

**热路径（每轮）**：`planTurn`（安全+打分+道别+教练意图并行）→ 召回（`recallContext`）→ 装配（`buildTurnMessages`）→ 流式出句（`streamMessages`）。记忆的「写」全部 fire-and-forget，不在热路径。
