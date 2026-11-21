# 术语表（统一语言 / Ubiquitous Language）

> **铁律：一词多义 = bug。** 新增或改动任何术语，先查本表；发现一个词在本表之外被用了第二个意思，改掉代码里的用法。
>
> 本表是项目**唯一权威词汇表**（Single Source of Truth）。`docs/`、`packages/contracts` 注释、prompt、前端 UI 里的术语都以这里为准——那些地方只放「就近简表 + 指针」，不再各自定义。

## 怎么用

1. 写代码 / prompt / 文档时，用词先在这里查。
2. 要引入新术语 → 加到本表（一词一义，标所属上下文）。
3. 发现某词被用了第二个意思 → 这是 bug，改代码里的用法，别改表（除非表本身错了）。

## 限界上下文（先画界）

| 上下文 | 落点 | 领域词 |
|---|---|---|
| 陪伴 / 对话 | `brain/turn` + `session` + `conversationFlow` | 轮次、Mode、Stance、EmotionTag |
| 成长 / 教练 | `brain/coach` + `store/goals` | Frame、GROW、课题 |
| 记忆 | `store/memory` + `brain/consolidate` | 六型 constraint/fact/state/preference/episodic/profile |
| 身份 | `store/identity` | IdentityField（结构化身份，单值覆盖） |
| 角色 | `persona/` + `character/` | Persona、角色卡、voiceTint |
| 安全 | `brain/safety` | 危机、过度依赖、转介 |
| 语音 | `speech/` | ASR / TTS / 哭·笑检测 |

## 一词一义（撞过车的重点记）

| 词 | 唯一定义 | 所属上下文 | 曾误用 |
|---|---|---|---|
| **人设** | 陪伴者角色（Persona）的性格 / 说话方式 / 语气底色 | 角色 | 曾把记忆类型 profile 也叫「人设」，已改为「特质」 |
| **特质** | 关于**用户**的稳定性格 / 价值观 / 长期模式 / 洞察（`profile`） | 记忆 | 曾叫「人设」 |
| **身份** | 关于**用户**的基本信息（名字/性别/职业…），字段单值覆盖（`IdentityField`） | 身份 | — |
| **人设增补** | 陪伴者**自己**长出的软细节（`SelfAdded`） | 角色 | — |
| **Mode** | 情绪强度 casual / careful | 陪伴/对话 | 别和口语「模式」混 |
| **Stance** | **单轮**内「陪(accompany) / 引(guide)」姿态，由支配度驱动 | 陪伴/对话 | 别和 Frame 混（都含「陪/引」，层级不同） |
| **Frame** | **整段**对话「朋友(friend) / 教练(coach)」框架，走 GROW | 成长/教练 | 别和 Stance 混 |

## 六型长期记忆（唯一分类定义）

> 完整分类 prompt 见 `apps/server/src/brain/memoryTaxonomy.ts`；这里只记「中文名 → 含义」的权威版。

1. **constraint（约束）** —— 硬规则 / 红线 / 禁令，无条件在场。
2. **fact（事实）** —— 关于用户的**稳定**事实（持久、非身份非特质，entity 覆盖）。
3. **state（近况）** —— 关于用户的**可变**近况 / 当前状态 / 计划（会过时，entity 覆盖）。
4. **preference（偏好）** —— 软性偏好 / 习惯。
5. **episodic（情节）** —— 发生过的具体事件（动词 + 了/过/完；30 天软衰减）。
6. **profile（特质）** —— 关于用户的稳定性格 / 价值观 / 长期模式 + 高层洞察，强制在场。

> 身份基本信息（名字/性别/职业）**不归 profile**，归「结构化身份」（`store/identity.ts`，单值覆盖）。

## 情绪概念链（L3）

> 完整对照见 `packages/contracts/src/affect.ts` 头注释。

`Affect`（本轮瞬时三维分）→ `MoodState`（多轮 EMA）→ `Mode`（情绪强度，防抖）→ `Stance`（单轮陪/引）→ `EmotionTag`（喂 TTS 的语气）。

另：`Frame`（friend/coach）与 `Mode` 正交——一个是「交互框架」，一个是「情绪强度」。
