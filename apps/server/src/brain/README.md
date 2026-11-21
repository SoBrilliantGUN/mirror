# brain/ 交接速查

这是「对话大脑」目录，包了 L3（决策）、L4（安全）、L5（状态/记忆）三层。L 编号来自 `docs/技术方案.md` 的分层，代码里注释也引用它们——**先把 L 编号映射到文件**，读起来会快很多：

| L 层 | 含义 | 文件 |
|---|---|---|
| L3 | 情绪打分 / 判定 / 生成 | `decide.ts`（打分 `scoreAffect`）+ `emotion.ts`（判定 `decideMode/Stance/Emotion` + 心境 `updateMood`）、`turn.ts`（一轮决策 `planTurn`）、`assemble.ts`（召回+装配）、`generate.ts`（流式出句）、`generationGate.ts`（代际中止门：哪次生成还作数）、`topicSwitch.ts`（不感兴趣/敷衍→换话题）、`prompts.ts`（系统提示词）、`context.ts`（分层 user prompt）、`coach.ts`（教练意图+Frame 状态机） |
| L4 | 安全红线 | `safety.ts`（危机+过度依赖，独立小模型）、`crisisResources.ts`（热线资源） |
| L5 | 状态 / 会话 / 记忆 | `modeTracker.ts`、`mood.ts`、`compress.ts`（历史压缩）、`recentSummary.ts`（跨通话概要）、`timeAnchor.ts`/`timeAware.ts`/`holiday.ts`/`timezone.ts`（时间感知）、`ontology.ts`（好奇心维度） |
| 记忆「写」 | 后台巩固（不进热路径） | `consolidate/`（`index.ts` 总入口 consolidateAfterTurn · memoryTurn · goalTurn · selfAddTurn · dream · reflect） |

**情绪概念 5 连**：`Affect`（本轮瞬时分）→ `MoodState`（多轮 EMA）→ `Mode`（casual/careful）→ `Stance`（陪/引）→ `EmotionTag`（TTS 语气）。详见 `packages/contracts/src/affect.ts` 顶部对照表。

**情绪状态怎么流转**（从打分到出句，落地在 `turn.ts` 的 `planTurn`）：

```
text + acoustic + vocalizations
        │  scoreAffect（call1，LLM 一次，融合文本+副语言+哭/笑）
        ▼
     Affect（本轮瞬时三维分，一次性）
        │
        ├─► updateMood ─────────────► MoodState（多轮 EMA，会话级轨迹）
        ├─► decideMode + ModeTracker ► Mode（casual/careful，带防抖）
        ├─► decideStance ───────────► Stance（陪 accompany / 引 guide）
        └─► decideEmotion(+dominantVocal) ► EmotionTag（喂 TTS 的语气）

  正交轴：Frame（friend/coach）← classifyCoachCue + CoachTracker（教练意图，与 Mode 无关）
  安全轴：SafetyGuard.check → SafetyAction（危机）/ DependenceAction（依赖），前置并行
```

**存储实现在哪**：`brain/*` 里只有「纯函数 + 接口类型」，真正的 Postgres 实现都在 `store/`（`memory.ts` 等）。`MemoryStore` 等接口契约在 `packages/contracts`。

**地板控制状态机**：`conversationFlow.ts`（`ConversationFlowController`）把「谁来说、何时说、打断、静默、道别」建模成显式状态机——`FloorPhase`（`idle / thinking / speaking / interruptGrace`）+ 纯 reducer `reducePhase` + 薄 driver（时钟/副作用）。关键纪律：**state = 离散控制流位置；计数/时间戳（`noReplyStreak`、`lastVocalRespondAt`、`reanswerCount`）是 context，不建模成状态**（否则状态爆炸）。`speaking`/`agentAudible` 由相位派生，不再散在 `CallSession` 里。打断/宽限/重答等迁移可单测，见 `test/conversationFlow.selftest.ts`。

**四个「分类器」**（LLM 判 → 抽 JSON → 解析 → 兜底）共用 `classify.ts` 的 `classifyJson` 骨架：`farewell.ts`（道别）、`coach.ts`（教练意图）、`memoryClassifier.ts`（记忆分类）；`segmentEmotion.ts`（逐句情绪）是「只出一个词」的非 JSON 输出，单独实现。

**「LLM 调用 + 解析」其实有 5 种形状**（不止 `classifyJson` 一种），接手时先认全，别以为统一了：

| 形状 | 落点 | 为什么不走 `classifyJson` |
|---|---|---|
| JSON 单字段分类 | `farewell.ts` / `coach.ts` / `memoryClassifier.ts` | 标准形状，走 `classifyJson` |
| JSON 多字段打分 | `decide.ts` 的 `scoreAffect` | 输出 4 个字段、要 clamp，非单字段 |
| 单标签（正则抽） | `segmentEmotion.ts` | 非 JSON，只出一个词 |
| 自由文本纠错 | `asrCorrect.ts` | 输出就是纠正后的原文，非 JSON |
| 安全评分（独立小模型） | `safety.ts` 的 `SafetyGuard.check` | 带超时兜底 + episode 去抖，用独立 `parseJsonish` |

> 注意：`parseJsonish`（`parse.ts`）是「剥 fence → 找第一个 `{…}` → JSON.parse」的唯一容错入口，各分类器都要复用它；`safety.ts` 的 `parseSafetyJson` 也已统一走它。

**热路径（每轮）**：`planTurn`（安全+打分+道别+教练意图并行）→ 召回（`recallContext`）→ 装配（`buildTurnMessages`）→ 流式出句（`streamMessages`）。记忆的「写」全部 fire-and-forget，不在热路径。

---

## 两处命名陷阱（新人必读）

**1. `L` 编号只有一套：架构分层 L0–L8。**
根 README 定义了 L0–L8 架构分层（L3=对话大脑、L4=安全红线、L5=状态/会话/记忆、L6=角色卡…）。代码注释里的 `L3/L4/L5` 一律指这套。
曾经的「上下文窗口块」也用过一套 L0–L5（L0=system、L1=[STATE]、L2=[MEMORY]、L4=[REMINDER]、L5=历史），**两套 L 语义不同、现已合一**：窗口块统一改用 `[块名]` 指代（`[STATE]`/`[MEMORY]`/`[REMINDER]`/「历史」）。所以看到 `[X]` 是 prompt 里的块位置，看到 `L3/L4/L5` 是架构层。

**2. 「人设」词根有四个义，别混（权威表见根 `GLOSSARY.md`）。**
- `Persona`（`contracts/persona.ts`）= 陪伴者角色（程书衡等）；`personaName` = 它的中文名，同时是「人物隔离」维度。中文名就叫「人设」。
- `profile`（记忆类型）= **关于用户**的稳定特质，中文名「**特质**」，与 `Persona` 无关。
- `IdentityField`（`store/identity.ts`，结构化身份）= **关于用户**的基本信息（名字/性别/职业），字段单值覆盖，中文名「身份」。
- `SelfAdded`（表名 `self_additions`）= **关于陪伴者自己**的软细节，独立于用户长期记忆，中文名「人设增补」。

一句话：`profile`（特质）记「用户是怎么样的人」，`IdentityField`（身份）记「用户是谁」，`SelfAdded`（人设增补）记「陪伴者自己是怎么样的人」，三者都跟 `Persona`（角色）无直接关系。
